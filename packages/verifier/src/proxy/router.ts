// SPDX-License-Identifier: Apache-2.0

// Import from @spellguard/ctls
import {
  type RegisteredAgent,
  getAgent,
  getAgentByToken,
  getSessionPublicKey,
  registerAgent,
} from '@spellguard/ctls';

import { decryptPayload } from '../crypto/encrypt';
import {
  encryptForManagement,
  isManagementEncryptionEnabled,
} from '../crypto/management-encrypt';

// Import from @spellguard/amp
import {
  type AuditCommitment,
  type SecureMessage,
  archiveMessage as archiveToBackend,
  generateCommitment,
  getArchiveBackendName,
  getCommitmentBackendName,
  getOrCreateChannel,
  logCommitment as logToBackend,
  updateChannelActivity,
} from '@spellguard/amp';

// Local imports
import { resolveAgentCard } from '../discovery/resolver';
import { getAgentPolicies } from '../management/policy-cache';
import {
  dispatchObligations,
  reportBilateralEvent,
} from '../management/reporter';
import {
  handleQuarantine,
  shouldQuarantineFromChecks,
} from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { addMessage, getRecentMessages } from './message-buffer';
import type { PolicyCheckResult } from './policy-evaluator';
import { evaluatePolicies, filterByScope } from './policy-evaluator';
import type { ResolvedPolicyConfig } from './policy-evaluator-types';
import {
  applyRedaction,
  buildQuarantineReason,
  deriveResponseLevel,
} from './policy-helpers';
import { checkVisibility } from './visibility-checker';

/** Maximum number of hops a message may traverse before the Verifier rejects it.
 *  Prevents infinite routing loops (e.g. A→B→A→B→…). Configurable via
 *  the MAX_MESSAGE_HOPS env var; defaults to 3. */
const MAX_MESSAGE_HOPS = Number(process.env.MAX_MESSAGE_HOPS) || 3;

interface RouteResult {
  success: boolean;
  response?: unknown;
  error?: string;
  responseLevel?: ResponseLevel;
  retryAfter?: number;
  warnings?: string[];
}

/**
 * Verify the sender is authenticated and owns the channel token.
 */
function verifySender(
  message: SecureMessage,
  senderChannelToken: string,
): { valid: true; agent: RegisteredAgent } | { valid: false; error: string } {
  const tokenOwner = getAgentByToken(senderChannelToken);
  if (!tokenOwner) {
    return { valid: false, error: 'Invalid or expired channel token' };
  }

  if (tokenOwner.agentId !== message.sender) {
    return { valid: false, error: 'Sender does not match channel token owner' };
  }

  const senderAgent = getAgent(message.sender);
  if (!senderAgent) {
    return { valid: false, error: 'Sender not registered' };
  }

  return { valid: true, agent: senderAgent };
}

/**
 * Resolve recipient agent, discovering via A2A if not registered.
 */
async function resolveRecipient(
  recipientId: string,
): Promise<
  { found: true; agent: RegisteredAgent } | { found: false; error: string }
> {
  const existingAgent = getAgent(recipientId);
  if (existingAgent) {
    return { found: true, agent: existingAgent };
  }

  console.log(
    `[Router] Recipient ${recipientId} not registered, attempting A2A discovery...`,
  );
  const agentCard = await resolveAgentCard(recipientId);

  if (!agentCard) {
    return { found: false, error: `Recipient not found: ${recipientId}` };
  }

  const tempChannelToken = `temp_${crypto.randomUUID()}`;
  const discoveredAgent: RegisteredAgent = {
    agentId: recipientId,
    codeHash: 'discovered-via-a2a',
    endpoint: `${agentCard.url}/_spellguard/receive`,
    agentCardUrl: `${agentCard.url}/.well-known/agent.json`,
    channelToken: tempChannelToken,
    registeredAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
  };

  registerAgent(discoveredAgent);
  console.log(`[Router] Auto-registered ${recipientId} via A2A discovery`);

  return { found: true, agent: discoveredAgent };
}

/**
 * Collect warnings about logging/archival failures.
 */
function collectWarnings(
  commitResult: PromiseSettledResult<string | null>,
  archiveResult: PromiseSettledResult<string | null>,
): string[] {
  const warnings: string[] = [];
  if (commitResult.status === 'rejected' || commitResult.value == null) {
    warnings.push(
      `${getCommitmentBackendName()} logging unavailable or failed`,
    );
  }
  if (archiveResult.status === 'rejected' || archiveResult.value == null) {
    warnings.push(`${getArchiveBackendName()} archival unavailable or failed`);
  }
  return warnings;
}

/**
 * Run outbound policy checks. Returns the denied policy name if blocked, null otherwise.
 */
async function runOutboundPolicyChecks(
  message: SecureMessage,
  accumulator: PolicyCheckResult[],
  orgContext?: { senderOrgId?: string; recipientOrgId?: string },
): Promise<{
  denied: string | null;
  policies: Awaited<ReturnType<typeof getAgentPolicies>>;
  decryptedContent: string | null;
}> {
  let decryptedContent: string | null = null;
  try {
    decryptedContent = decryptPayload(message.encryptedPayload);
  } catch {
    // Decryption failed — use raw payload for policy checking (e.g. dev/test
    // mode where messages aren't encrypted).
    if (typeof message.encryptedPayload === 'string') {
      decryptedContent = message.encryptedPayload;
    }
  }

  const senderPolicies = await getAgentPolicies(message.sender);
  if (!senderPolicies) {
    // MANAGEMENT_URL unset → policy enforcement disabled, pass through.
    // MANAGEMENT_URL set but fetch returned null → server unreachable, fail closed.
    if (!process.env.MANAGEMENT_URL) {
      return { denied: null, policies: null, decryptedContent };
    }
    return {
      denied: 'policy_data_unavailable',
      policies: senderPolicies,
      decryptedContent,
    };
  }
  // Get recent message history for loop detection
  const recentMessages = getRecentMessages(message.sender);

  const checks = await evaluatePolicies(
    filterByScope(senderPolicies.outbound, 'messages'),
    decryptedContent ?? '',
    {
      agentId: message.sender,
      direction: 'outbound',
      recentMessages,
      agentStatus: senderPolicies.agentStatus,
      senderOrgId: orgContext?.senderOrgId ?? senderPolicies.organizationId,
      recipientOrgId: orgContext?.recipientOrgId,
      identity: senderPolicies.identityContext,
    },
  );
  accumulator.push(...checks);

  const deniedCheck = checks.find((c) => c.decision === 'deny');
  return {
    denied: deniedCheck ? deniedCheck.policyName : null,
    policies: senderPolicies,
    decryptedContent,
  };
}

/**
 * Run recipient inbound policy checks. Returns the denied policy name if blocked, null otherwise.
 */
async function runRecipientInboundPolicyChecks(
  recipientId: string,
  decryptedContent: string,
  accumulator: PolicyCheckResult[],
  recipientPolicies?: ResolvedPolicyConfig,
  orgContext?: { senderOrgId?: string; recipientOrgId?: string },
): Promise<{ denied: string | null }> {
  const policies = recipientPolicies ?? (await getAgentPolicies(recipientId));
  if (!policies) {
    // MANAGEMENT_URL unset → policy enforcement disabled, pass through.
    // MANAGEMENT_URL set but fetch returned null → server unreachable, fail closed.
    if (!process.env.MANAGEMENT_URL) {
      return { denied: null };
    }
    return { denied: 'policy_data_unavailable' };
  }
  // Check quarantine status before early return — quarantined recipients
  // must be denied even when they have no inbound bindings (CR-002).
  if (policies.agentStatus === 'quarantined') {
    accumulator.push({
      policyId: '__quarantine_precheck',
      policyName: 'quarantine-precheck',
      policyLevel: 'system',
      decision: 'deny',
      responseLevel: 'quarantine',
      detections: [
        {
          type: 'quarantined',
          confidence: 1.0,
          message: 'Recipient agent is quarantined',
        },
      ],
      obligations: [],
      durationMs: 0,
    });
    return { denied: 'quarantine-precheck' };
  }

  if (policies.inbound.length === 0) {
    return { denied: null };
  }

  // Get recent message history for loop detection
  const recentMessages = getRecentMessages(recipientId);

  const checks = await evaluatePolicies(
    filterByScope(policies.inbound, 'messages'),
    decryptedContent,
    {
      agentId: recipientId,
      direction: 'inbound',
      recentMessages,
      agentStatus: policies.agentStatus,
      senderOrgId: orgContext?.senderOrgId,
      recipientOrgId: orgContext?.recipientOrgId ?? policies.organizationId,
      identity: policies.identityContext,
    },
  );
  accumulator.push(...checks);

  const deniedCheck = checks.find((c) => c.decision === 'deny');
  return { denied: deniedCheck ? deniedCheck.policyName : null };
}

/**
 * Route a message from sender to recipient through the Verifier.
 *
 * Flow:
 * 1. Verify sender is authenticated
 * 2. Resolve recipient endpoint
 * 3. Decrypt payload and run outbound policy checks
 * 4. Generate commitment (hash, not plaintext)
 * 5. Log commitment to configured backend (Rekor, etc.)
 * 6. Archive to configured backend (S3, etc.)
 * 7. Forward to recipient's callback endpoint
 * 8. Run inbound policy checks on response
 * 9. Report with policyChecks
 */
export async function routeMessage(
  message: SecureMessage,
  senderChannelToken: string,
): Promise<RouteResult> {
  const outboundChecks: PolicyCheckResult[] = [];

  // Step 1: Verify sender authentication
  const senderResult = verifySender(message, senderChannelToken);
  if (!senderResult.valid) {
    return { success: false, error: senderResult.error };
  }

  // Step 2: Resolve recipient
  const recipientResult = await resolveRecipient(message.recipient);
  if (!recipientResult.found) {
    return { success: false, error: recipientResult.error };
  }
  const recipientAgent = recipientResult.agent;

  // Establish channel early so all audit events share a correlationId.
  // `correlationId` defaults to channel.id (per-(sender, recipient)
  // pair) and is upgraded to the client-supplied
  // `_spellguardCorrelationId` once the payload is decrypted (a few
  // dozen lines below) so every audit_logs row in the same logical
  // conversation lands under one trace id.
  const channel = getOrCreateChannel(message.sender, message.recipient);
  let correlationId: string = channel.id;

  // Fetch recipient policies once — reused by internal-mode guard, visibility
  // check, and inbound policy evaluation.
  const recipientConfig = await getAgentPolicies(message.recipient);

  // Step 2c: Visibility check — block before running any policy engines.
  // MANAGEMENT_URL unset → policy enforcement disabled, skip visibility.
  // MANAGEMENT_URL set but fetch returned null → server unreachable, fail
  // closed. Mirrors the unilateral router's unmanaged-recipient path.
  if (!recipientConfig && process.env.MANAGEMENT_URL) {
    console.log(
      `[Router] Policy data unavailable for recipient ${message.recipient} — blocking (fail-closed)`,
    );
    const commitment = generateCommitment(message);
    commitment.correlationId = correlationId;
    reportBilateralEvent(
      commitment,
      'block',
      [],
      'outbound',
      undefined,
      'visibility-denied',
    );
    return {
      success: false,
      error: 'Blocked: recipient policy data unavailable (fail-closed)',
    };
  }
  if (recipientConfig?.visibility) {
    // Fail-closed: if sender config is unavailable, block entirely
    const senderConfig = await getAgentPolicies(message.sender);
    if (!senderConfig) {
      console.log(
        `[Router] Visibility check failed (no sender config) for message ${message.id} — blocking (fail-closed)`,
      );
      const commitment = generateCommitment(message);
      commitment.correlationId = correlationId;
      reportBilateralEvent(
        commitment,
        'block',
        [],
        'outbound',
        undefined,
        'visibility-denied',
      );
      return {
        success: false,
        error:
          'Blocked: unable to verify sender identity for visibility check (fail-closed)',
      };
    }

    const senderContext = {
      agentId: message.sender,
      organizationId: senderConfig.organizationId ?? '',
      groupIds: senderConfig.visibility?.groups?.map((g) => g.id) ?? [],
    };

    const visResult = checkVisibility(
      senderContext,
      recipientConfig.visibility,
    );
    if (!visResult.allowed) {
      console.log(
        `[Router] Visibility denied message ${message.id}: ${visResult.reason}`,
      );
      const commitment = generateCommitment(message);
      commitment.correlationId = correlationId;
      reportBilateralEvent(
        commitment,
        'block',
        [],
        'outbound',
        undefined,
        'visibility-denied',
      );
      return {
        success: false,
        error: 'Message delivery blocked by visibility rules',
      };
    }
  }

  // Step 3: Outbound policy checks (sender's outbound policies)
  // senderOrgId omitted — runOutboundPolicyChecks already derives it from
  // the senderPolicies it fetches internally (see policy-evaluator line 178).
  const orgContext = {
    recipientOrgId: recipientConfig?.organizationId,
  };
  const {
    denied: outboundDenied,
    policies: senderPolicies,
    decryptedContent,
  } = await runOutboundPolicyChecks(message, outboundChecks, orgContext);

  // Extract trace context from the decrypted outbound payload.  The
  // client library stamps `_spellguardCorrelationId` (originating
  // trace id) and `_spellguardHops` (depth counter) on every send
  // when its hop-context ALS is populated.  The correlation id, if
  // present, takes precedence over channel.id so that all messages
  // in a single conversation across multiple (sender, recipient)
  // pairs land in audit_logs with the same correlation_id and the
  // dashboard's "View Related Messages" can render them as one
  // multi-party session instead of a series of 2-party diagrams.
  if (decryptedContent) {
    try {
      const parsed = JSON.parse(decryptedContent);
      if (
        typeof parsed?._spellguardCorrelationId === 'string' &&
        parsed._spellguardCorrelationId.length > 0
      ) {
        correlationId = parsed._spellguardCorrelationId as string;
      }
    } catch {
      // Not JSON — no client trace id to use; fall back to channel.id.
    }
  }
  if (outboundDenied) {
    console.log(
      `[Router] Outbound policy denied message ${message.id}: ${outboundDenied}`,
    );
    // CR-005: If no checks were produced (e.g. fail-closed synthetic denial),
    // force 'block' level instead of deriving 'allow' from empty array.
    const outboundLevel =
      outboundChecks.length === 0
        ? 'block'
        : deriveResponseLevel(outboundChecks);
    // Quarantine is an agent-state concern, orthogonal to the resolved
    // message-level response level — see shouldQuarantineFromChecks.
    if (shouldQuarantineFromChecks(outboundChecks)) {
      // CR-027: Await quarantine and log failure, but don't block the deny
      // response — the message is already denied by the policy check above.
      const quarantineOk = await handleQuarantine(
        message.sender,
        buildQuarantineReason(outboundChecks),
      );
      if (!quarantineOk) {
        console.error(
          `[Router] CRITICAL: Failed to quarantine agent ${message.sender} — message is still denied`,
        );
      }
    }

    const commitment = generateCommitment(message);
    commitment.correlationId = correlationId;

    // Archive blocked content for post-mortem analysis
    if (decryptedContent) {
      const envelope = await encryptForManagement(
        JSON.stringify({
          sender: message.sender,
          recipient: message.recipient,
          content: decryptedContent,
          timestamp: new Date(message.timestamp).toISOString(),
          direction: 'outbound',
          attestationLevel: 'bilateral',
        }),
      );
      if (envelope) {
        archiveMessage(message, commitment, { encryptedEnvelope: envelope });
      }
    }

    reportBilateralEvent(commitment, outboundLevel, outboundChecks, 'outbound');
    dispatchObligations(outboundChecks, 'outbound', commitment);

    // CR-008: Return structured rate-limit error with retryAfter when applicable
    if (outboundLevel === 'rate_limit') {
      const retryAfter =
        outboundChecks.find((c) => c.retryAfter)?.retryAfter ?? 60;
      return {
        success: false,
        error: `Rate limit exceeded. Try again in ${retryAfter} seconds`,
        responseLevel: outboundLevel,
        retryAfter,
      };
    }

    return {
      success: false,
      error: `Blocked by outbound policy: ${outboundDenied}`,
      responseLevel: outboundLevel,
    };
  }

  // Step 3a: Apply outbound redaction if any checks resolved to 'redact'
  let contentForForwarding = decryptedContent;
  if (decryptedContent) {
    contentForForwarding = applyRedaction(decryptedContent, outboundChecks);
  }

  // Step 3a-ii: Hop limit check — prevent infinite routing loops.
  // The _spellguardHops field is set by the client library to reflect the
  // current depth of the message chain.  The Verifier increments it when
  // forwarding so that the receiving agent's context carries the updated
  // count for any further outbound sends.
  let currentHops = 0;
  if (decryptedContent) {
    try {
      const parsed = JSON.parse(decryptedContent);
      if (typeof parsed?._spellguardHops === 'number') {
        currentHops = parsed._spellguardHops;
      }
    } catch {
      // Not valid JSON — treat as 0 hops
    }
  }

  if (currentHops >= MAX_MESSAGE_HOPS) {
    console.log(
      `[Router] Message ${message.id} rejected: hop limit exceeded (${currentHops} >= ${MAX_MESSAGE_HOPS})`,
    );
    const commitment = generateCommitment(message);
    commitment.correlationId = correlationId;
    reportBilateralEvent(
      commitment,
      'block',
      outboundChecks,
      'outbound',
      undefined,
      'hop-limit-exceeded',
    );
    return {
      success: false,
      error: `Message hop limit exceeded (${currentHops} hops, max ${MAX_MESSAGE_HOPS})`,
      responseLevel: 'block',
    };
  }

  // Buffer the outbound message for loop detection history, so that
  // subsequent policy checks (recipient inbound, response inbound)
  // see the correct message history.
  if (decryptedContent) {
    addMessage(message.sender, decryptedContent);
  }

  // Step 3b: Recipient inbound policy checks (recipient's inbound policies)
  // CR-004: Gate on null/undefined, not truthiness, so empty strings are still evaluated
  const recipientInboundChecks: PolicyCheckResult[] = [];
  if (contentForForwarding != null) {
    const { denied: inboundDenied } = await runRecipientInboundPolicyChecks(
      message.recipient,
      contentForForwarding,
      recipientInboundChecks,
      recipientConfig ?? undefined,
      orgContext,
    );
    if (inboundDenied) {
      console.log(
        `[Router] Recipient inbound policy denied message ${message.id}: ${inboundDenied}`,
      );

      // Quarantine is an agent-state concern, orthogonal to the resolved
      // message-level response level — see shouldQuarantineFromChecks.
      const recipientInboundLevel = deriveResponseLevel(recipientInboundChecks);
      if (shouldQuarantineFromChecks(recipientInboundChecks)) {
        // CR-027: Await and log quarantine result
        const quarantineOk = await handleQuarantine(
          message.recipient,
          buildQuarantineReason(recipientInboundChecks),
        );
        if (!quarantineOk) {
          console.error(
            `[Router] CRITICAL: Failed to quarantine recipient ${message.recipient} — message is still denied`,
          );
        }
      }

      const commitment = generateCommitment(message);
      commitment.correlationId = correlationId;

      // Archive blocked content for post-mortem analysis
      if (contentForForwarding ?? decryptedContent) {
        const envelope = await encryptForManagement(
          JSON.stringify({
            sender: message.sender,
            recipient: message.recipient,
            content: contentForForwarding ?? decryptedContent,
            timestamp: new Date(message.timestamp).toISOString(),
            direction: 'outbound',
            attestationLevel: 'bilateral',
          }),
        );
        if (envelope) {
          archiveMessage(message, commitment, { encryptedEnvelope: envelope });
        }
      }

      // Report to recipient (Agent B): their inbound policy blocked the message
      reportBilateralEvent(
        commitment,
        recipientInboundLevel,
        recipientInboundChecks,
        'inbound',
        message.recipient,
      );
      // Report to sender (Agent A): outbound message was blocked by recipient policy
      reportBilateralEvent(commitment, 'block', outboundChecks, 'outbound');
      // Dispatch obligations from both directions even when blocked
      dispatchObligations(outboundChecks, 'outbound', commitment);
      dispatchObligations(
        recipientInboundChecks,
        'inbound',
        commitment,
        message.recipient,
      );
      return {
        success: false,
        error: `Blocked by recipient inbound policy: ${inboundDenied}`,
        responseLevel: recipientInboundLevel,
      };
    }
  }

  // Step 4: Generate commitment
  const commitment = generateCommitment(message);
  commitment.correlationId = correlationId;

  // Step 5 & 6: Log and archive (in parallel)
  // When management encryption is available, encrypt the decrypted content
  // so management can retrieve and decrypt it on demand for incident analysis.
  let archiveOptions: { encryptedEnvelope: string } | undefined;
  if (decryptedContent) {
    const envelope = await encryptForManagement(
      JSON.stringify({
        sender: message.sender,
        recipient: message.recipient,
        content: contentForForwarding ?? decryptedContent,
        timestamp: new Date(message.timestamp).toISOString(),
        direction: 'outbound',
        attestationLevel: 'bilateral',
      }),
    );
    archiveOptions = envelope ? { encryptedEnvelope: envelope } : undefined;
  }

  const [commitResult, archiveResult] = await Promise.allSettled([
    logCommitment(commitment),
    archiveMessage(message, commitment, archiveOptions),
  ]);

  // Step 7: Forward to recipient
  updateChannelActivity(channel.id);

  const warnings = collectWarnings(commitResult, archiveResult);
  const warningsArray = warnings.length > 0 ? warnings : undefined;

  try {
    // Pass redacted content to forwardToRecipient if outbound was redacted
    const outboundWasRedacted =
      contentForForwarding !== null &&
      contentForForwarding !== decryptedContent;
    const response = await forwardToRecipient(
      recipientAgent.endpoint,
      message,
      recipientAgent.channelToken,
      outboundWasRedacted ? contentForForwarding : undefined,
      currentHops + 1,
      correlationId,
    );

    // Step 8: Run inbound policy checks on response
    let inboundChecks: PolicyCheckResult[] = [];
    let finalResponse = response;
    if (senderPolicies) {
      const responseContent =
        typeof response === 'string' ? response : JSON.stringify(response);
      const recentMessages = getRecentMessages(message.sender);
      inboundChecks = await evaluatePolicies(
        filterByScope(senderPolicies.inbound, 'messages'),
        responseContent,
        {
          agentId: message.sender,
          direction: 'inbound',
          recentMessages,
          agentStatus: senderPolicies.agentStatus,
          senderOrgId: orgContext.recipientOrgId,
          recipientOrgId: senderPolicies.organizationId,
          identity: senderPolicies.identityContext,
        },
      );

      // Apply inbound redaction if any checks resolved to 'redact'
      const redactedResponse = applyRedaction(responseContent, inboundChecks);
      if (redactedResponse !== responseContent) {
        try {
          finalResponse = JSON.parse(redactedResponse);
        } catch {
          finalResponse = redactedResponse;
        }
      }
    }

    // Quarantine the sender if any inbound response check fired a
    // quarantine-effect binding — independent of the message-level
    // disposition derived across outbound+inbound. See
    // shouldQuarantineFromChecks.
    if (shouldQuarantineFromChecks(inboundChecks)) {
      // CR-027: Await and log quarantine result
      const quarantineOk = await handleQuarantine(
        message.sender,
        buildQuarantineReason(inboundChecks),
      );
      if (!quarantineOk) {
        console.error(
          `[Router] CRITICAL: Failed to quarantine sender ${message.sender} — response delivery continues`,
        );
      }
    }

    console.log(
      `[Router] Message ${message.id} routed: ${message.sender} -> ${message.recipient}`,
    );

    // Archive the response content under a separate message ID so
    // inbound audit entries can link to the actual response text.
    let responseCommitment = commitment;
    if (senderPolicies) {
      const responseContent =
        typeof finalResponse === 'string'
          ? finalResponse
          : JSON.stringify(finalResponse);
      const responseMsg = {
        ...message,
        id: generateMessageId(),
        sender: message.recipient,
        recipient: message.sender,
      };
      responseCommitment = generateCommitment(responseMsg);
      responseCommitment.correlationId = correlationId;

      const respEnvelope = await encryptForManagement(
        JSON.stringify({
          sender: message.recipient,
          recipient: message.sender,
          content: responseContent,
          timestamp: new Date().toISOString(),
          direction: 'inbound',
          attestationLevel: 'bilateral',
        }),
      );
      if (respEnvelope) {
        archiveMessage(responseMsg, responseCommitment, {
          encryptedEnvelope: respEnvelope,
        });
      }
    }

    // Report audit log entries for both agents
    // Sender (Agent A): outbound (sent message) + inbound (received response)
    reportBilateralEvent(
      commitment,
      deriveResponseLevel(outboundChecks),
      outboundChecks,
      'outbound',
    );
    if (inboundChecks.length > 0) {
      reportBilateralEvent(
        responseCommitment,
        deriveResponseLevel(inboundChecks),
        inboundChecks,
        'inbound',
        message.sender, // Agent A receives the response
      );
    }
    // Recipient (Agent B): inbound (received message) + outbound (sent response)
    reportBilateralEvent(
      commitment,
      deriveResponseLevel(recipientInboundChecks),
      recipientInboundChecks,
      'inbound',
      message.recipient,
    );
    reportBilateralEvent(
      responseCommitment,
      'allow',
      [],
      'outbound',
      message.recipient,
    );

    // Dispatch obligations from all directions
    dispatchObligations(outboundChecks, 'outbound', commitment);
    if (inboundChecks.length > 0) {
      dispatchObligations(
        inboundChecks,
        'inbound',
        responseCommitment,
        message.sender,
      );
    }
    dispatchObligations(
      recipientInboundChecks,
      'inbound',
      commitment,
      message.recipient,
    );

    return {
      success: true,
      response: finalResponse,
      warnings: warningsArray,
    };
  } catch (error) {
    console.error(`[Router] Failed to forward message: ${error}`);

    // Report failed delivery to Management Server
    const failedLevel = deriveResponseLevel(outboundChecks);
    reportBilateralEvent(commitment, failedLevel, outboundChecks, 'outbound');
    dispatchObligations(outboundChecks, 'outbound', commitment);

    return {
      success: false,
      error: `Failed to deliver to recipient: ${error}`,
      responseLevel: failedLevel,
      warnings: warningsArray,
    };
  }
}

/**
 * Log commitment to the configured backend.
 */
async function logCommitment(
  commitment: AuditCommitment,
): Promise<string | null> {
  try {
    return await logToBackend(commitment);
  } catch (error) {
    console.error(
      `[Router] Failed to log to ${getCommitmentBackendName()}: ${error}`,
    );
    return null;
  }
}

/**
 * Archive message to the configured backend.
 */
async function archiveMessage(
  message: SecureMessage,
  commitment: AuditCommitment,
  options?: { encryptedEnvelope?: string },
): Promise<string | null> {
  try {
    return await archiveToBackend(message, commitment, options);
  } catch (error) {
    console.error(
      `[Router] Failed to archive to ${getArchiveBackendName()}: ${error}`,
    );
    return null;
  }
}

/**
 * Forward message to recipient's callback endpoint.
 * If redactedContent is provided, it will be used instead of decrypting the original payload.
 * The hop count is injected into the forwarded payload so the receiving agent's
 * client library can propagate it on any further outbound sends.
 */
async function forwardToRecipient(
  endpoint: string,
  message: SecureMessage,
  channelToken: string,
  redactedContent?: string | null,
  hops?: number,
  correlationId?: string,
): Promise<unknown> {
  // Use redacted content if provided, otherwise decrypt the payload
  let decryptedPayload: unknown;
  if (redactedContent != null) {
    try {
      decryptedPayload = JSON.parse(redactedContent);
    } catch {
      decryptedPayload = redactedContent;
    }
    // CR-019: Do not log decrypted/redacted message content to console
    console.log(
      `[Router] Forwarding redacted message from ${message.sender} (${typeof decryptedPayload === 'string' ? decryptedPayload.length : JSON.stringify(decryptedPayload).length} chars)`,
    );
  } else {
    try {
      const decryptedJson = decryptPayload(message.encryptedPayload);
      decryptedPayload = JSON.parse(decryptedJson);
      // CR-019: Log message metadata only, not content
      console.log(
        `[Router] Decrypted message from ${message.sender} (${JSON.stringify(decryptedPayload).length} chars)`,
      );
    } catch (error) {
      console.error(`[Router] Failed to decrypt payload: ${error}`);
      // Fall back to forwarding encrypted payload
      decryptedPayload = message.encryptedPayload;
    }
  }

  // Inject hop count + correlation id so the receiving client
  // library re-establishes the same trace context.  hop-context.ts
  // on the receive side reads both, calls runWithHops(hops, fn,
  // correlationId), and any nested outbound send carries the same
  // values forward — keeping multi-hop conversations under one
  // audit_logs.correlation_id.
  if (typeof decryptedPayload === 'object' && decryptedPayload !== null) {
    if (hops != null) {
      (decryptedPayload as Record<string, unknown>)._spellguardHops = hops;
    }
    if (correlationId) {
      (decryptedPayload as Record<string, unknown>)._spellguardCorrelationId =
        correlationId;
    }
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Spellguard-Channel-Token': channelToken,
    },
    body: JSON.stringify({
      message: decryptedPayload,
      senderId: message.sender,
      messageId: message.id,
      timestamp: message.timestamp,
    }),
  });

  if (!response.ok) {
    // Read the response body and surface whatever detail the
    // recipient included.  The spellguard middleware returns
    // `{ error, details }` on 500s, where `details` is the
    // underlying exception message from the agent's onMessage —
    // exactly what the operator needs to debug a "Failed to deliver"
    // entry in the dashboard.  Without this, the Verifier strips
    // the body and the operator only sees the status code.
    let detail = response.statusText;
    try {
      const bodyText = await response.text();
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText) as {
            error?: unknown;
            details?: unknown;
          };
          // Prefer `details` (the underlying exception) when
          // present, then `error` (the high-level kind), then the
          // raw body — falling through layers of structure so we
          // never lose information.
          if (typeof parsed.details === 'string' && parsed.details) {
            detail = `${response.statusText}: ${parsed.details}`;
          } else if (typeof parsed.error === 'string' && parsed.error) {
            detail = `${response.statusText}: ${parsed.error}`;
          } else {
            detail = `${response.statusText}: ${bodyText.slice(0, 500)}`;
          }
        } catch {
          // Body wasn't JSON — include the raw text (truncated so
          // a giant HTML error page can't blow up the audit log).
          detail = `${response.statusText}: ${bodyText.slice(0, 500)}`;
        }
      }
    } catch {
      // .text() itself failed — keep the bare statusText.
    }
    throw new Error(`Recipient returned ${response.status}: ${detail}`);
  }

  return response.json();
}

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `msg_${timestamp}_${random}`;
}
