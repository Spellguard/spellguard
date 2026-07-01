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
import { beginDelivery, endDelivery } from '../recycle-guard';
import {
  buildAgentDeliveryBody,
  decryptRecipientReply,
  encryptResponseForRequester,
} from './delivery-encryption';

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
import { getActiveProfile } from '../profile/registry';
import {
  deriveAgentSlimName,
  ensureGatewayRegistered,
  invalidateGatewayRegistration,
} from '../slim/managed-delivery';
import { sendMessageToAgentOverSlim } from '../slim/send-to-agent';
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
    // Agntcy profile delivers over SLIM for ALL recipients. A locally-cached
    // entry without a slimName (registered before the stamp, or via a non-SLIM
    // path) would otherwise slip back to HTTP — derive its slimName and make
    // sure the gateway is subscribed (its endpoint is the HTTP callback) first.
    const cachedProfile = getActiveProfile();
    if (
      cachedProfile?.profile === 'agntcy' &&
      !existingAgent.slimName &&
      existingAgent.endpoint?.startsWith('http')
    ) {
      const httpBase = existingAgent.endpoint.replace(
        /\/_spellguard\/receive\/?$/,
        '',
      );
      await ensureGatewayRegistered(recipientId, httpBase);
      const stamped: RegisteredAgent = {
        ...existingAgent,
        slimName: deriveAgentSlimName(recipientId),
      };
      registerAgent(stamped, { allowEndpointUpdate: true });
      return { found: true, agent: stamped };
    }
    return { found: true, agent: existingAgent };
  }

  // When the slim profile is active, AGNTCY dir is the registry. On a dir hit
  // we return immediately. On a dir miss/error the behaviour splits:
  //   • No-Management (OSS export): dir is the SOLE registry — fail loudly, no
  //     A2A fallback, so a slim deployment is guaranteed on the AGNTCY stack.
  //   • Managed: fall through to the Management/A2A resolver below (mirrors the
  //     original profile's Verifier→Management resolution) and back-fill the
  //     resolved agent into dir, so dir converges and future lookups hit it.
  const profile = getActiveProfile();
  if (profile?.profile === 'agntcy') {
    const resolved = await profile.directory
      .resolve(recipientId)
      .then((a) => ({ ok: true as const, address: a }))
      .catch((err: unknown) => ({ ok: false as const, err: err as Error }));
    const address = resolved.ok ? resolved.address : null;
    if (address) {
      // Slim profile delivers verifier→gateway→agent over SLIM (managed AND
      // no-Management). Derive the recipient's slimName and make sure the
      // gateway is subscribed to it, holding the agent's HTTP callback — the
      // recipient stays a plain HTTP agent; the gateway proxies SLIM → POST.
      const slimName = deriveAgentSlimName(address.agentId);
      const httpBase = address.url ? address.url.replace(/\/$/, '') : null;
      if (httpBase) await ensureGatewayRegistered(address.agentId, httpBase);
      const discoveredAgent: RegisteredAgent = {
        agentId: address.agentId,
        codeHash: 'discovered-via-dir',
        // `endpoint` is kept HTTP-shaped so log lines + audit trail stay
        // readable AND so the delivery retry can re-register the gateway;
        // SLIM-native delivery is signalled by `slimName` and routed through
        // sendMessageToAgentOverSlim in forwardToRecipient.
        endpoint: httpBase
          ? `${httpBase}/_spellguard/receive`
          : `slim://${slimName}`,
        agentCardUrl: httpBase ? `${httpBase}/.well-known/agent.json` : '',
        channelToken: `temp_${crypto.randomUUID()}`,
        registeredAt: Date.now(),
        expiresAt: Date.now() + 60 * 60 * 1000,
        slimName,
      };
      registerAgent(discoveredAgent);
      console.log(
        `[Router] Resolved ${recipientId} via AGNTCY dir → SLIM delivery (slimName=${slimName})`,
      );
      return { found: true, agent: discoveredAgent };
    }
    const dirProblem = resolved.ok
      ? 'not found in AGNTCY dir'
      : `dir lookup failed: ${resolved.err.message}`;
    if (!process.env.MANAGEMENT_URL) {
      // No-Management: dir is authoritative; no silent fallback.
      return {
        found: false,
        error: `Recipient ${recipientId} ${dirProblem} (no-Management slim — fallback disabled)`,
      };
    }
    console.log(
      `[Router] ${recipientId} ${dirProblem}; managed slim — resolving via Management and back-filling dir`,
    );
  }

  console.log(
    `[Router] Recipient ${recipientId} not registered, attempting A2A discovery...`,
  );
  const agentCard = await resolveAgentCard(recipientId);

  if (!agentCard) {
    return { found: false, error: `Recipient not found: ${recipientId}` };
  }

  const tempChannelToken = `temp_${crypto.randomUUID()}`;
  const httpBase = agentCard.url.replace(/\/$/, '');

  // Managed agntcy mode reaches here only on a dir miss (see the agntcy branch
  // above) — typically a PURE recipient that never self-registers (e.g. a
  // the demo fleet receiver), so the gateway has no slimName for it yet. Register
  // it with the gateway now (slimName → HTTP callback) so it's delivered over
  // SLIM like every other agntcy recipient, then stamp the slimName so
  // forwardToRecipient takes the SLIM path.
  let slimName: string | undefined;
  if (profile?.profile === 'agntcy') {
    await ensureGatewayRegistered(recipientId, httpBase);
    slimName = deriveAgentSlimName(recipientId);
  }

  const discoveredAgent: RegisteredAgent = {
    agentId: recipientId,
    codeHash: 'discovered-via-a2a',
    endpoint: `${httpBase}/_spellguard/receive`,
    agentCardUrl: `${httpBase}/.well-known/agent.json`,
    channelToken: tempChannelToken,
    registeredAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000,
    slimName,
  };

  registerAgent(discoveredAgent);
  console.log(
    `[Router] Auto-registered ${recipientId} via A2A discovery${slimName ? ` → SLIM delivery (slimName=${slimName})` : ''}`,
  );

  // Back-fill the Management-resolved endpoint into AGNTCY dir so the next
  // lookup resolves from dir directly — dir converges to the full agent set
  // without re-querying Management each time. Best-effort.
  if (profile?.profile === 'agntcy') {
    profile.directory
      .publish?.({ agentId: recipientId, endpoint: httpBase, skills: [] })
      .then(() =>
        console.log(
          `[Router] Back-filled ${recipientId} into AGNTCY dir (endpoint ${httpBase})`,
        ),
      )
      .catch((err) =>
        console.warn(
          `[Router] dir back-fill failed for ${recipientId}: ${(err as Error).message}`,
        ),
      );
  }

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
  // In-flight accounting so the proactive self-recycle (recycle-guard) never
  // exits the process mid-delivery — only in an idle gap.
  beginDelivery();
  try {
    return await routeMessageImpl(message, senderChannelToken);
  } finally {
    endDelivery();
  }
}

async function routeMessageImpl(
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
    const rawResponse = await forwardToRecipient(
      recipientAgent.endpoint,
      message,
      recipientAgent.channelToken,
      outboundWasRedacted ? contentForForwarding : undefined,
      currentHops + 1,
      correlationId,
      recipientAgent.slimName,
      recipientAgent.clientPublicKey,
    );
    // Return leg: if the recipient encrypted its reply to the Verifier, decrypt
    // it so the response policies + audit below operate on plaintext.
    const response = decryptRecipientReply(rawResponse);

    // Step 8a: Run recipient outbound policy checks on the response
    // (recipient's outbound policies, applied to what the recipient is
    // sending back to the original sender). Symmetric with the sender's
    // outbound check on the request. Mirrors the "responses don't block,
    // but can redact and surface obligations" precedent that the
    // sender-inbound check below already follows — keeps the bilateral
    // conversation flowing while still applying the recipient's outbound
    // bindings (e.g. PII / secrets / exfiltration) to its own response.
    let recipientOutboundChecks: PolicyCheckResult[] = [];
    let responseAfterRecipientOutbound: unknown = response;
    if (recipientConfig) {
      const recipientRecentMessages = getRecentMessages(message.recipient);
      const responseContent =
        typeof response === 'string' ? response : JSON.stringify(response);
      recipientOutboundChecks = await evaluatePolicies(
        filterByScope(recipientConfig.outbound, 'messages'),
        responseContent,
        {
          agentId: message.recipient,
          direction: 'outbound',
          recentMessages: recipientRecentMessages,
          agentStatus: recipientConfig.agentStatus,
          // On the response, the recipient is the "sender" of the
          // response and the original sender is the "recipient". Flip
          // the org-context fields accordingly.
          senderOrgId: recipientConfig.organizationId,
          recipientOrgId: senderPolicies?.organizationId,
          identity: recipientConfig.identityContext,
        },
      );

      const redactedFromRecipient = applyRedaction(
        responseContent,
        recipientOutboundChecks,
      );
      if (redactedFromRecipient !== responseContent) {
        try {
          responseAfterRecipientOutbound = JSON.parse(redactedFromRecipient);
        } catch {
          responseAfterRecipientOutbound = redactedFromRecipient;
        }
      }
    }

    // Quarantine the recipient if any of its outbound bindings on this
    // response fired a quarantine effect. Independent of the message-
    // level disposition derived from the outbound+inbound mix.
    if (shouldQuarantineFromChecks(recipientOutboundChecks)) {
      const quarantineOk = await handleQuarantine(
        message.recipient,
        buildQuarantineReason(recipientOutboundChecks),
      );
      if (!quarantineOk) {
        console.error(
          `[Router] CRITICAL: Failed to quarantine recipient ${message.recipient} after outbound policy fired quarantine — response delivery continues`,
        );
      }
    }

    // Step 8: Run inbound policy checks on response
    // The sender's inbound bindings see whatever the recipient's
    // outbound bindings produced — including any redactions applied
    // above — so a single redacted span is reflected in both audit
    // entries and in the response that lands back on Agent A.
    let inboundChecks: PolicyCheckResult[] = [];
    let finalResponse = responseAfterRecipientOutbound;
    if (senderPolicies) {
      const responseContent =
        typeof responseAfterRecipientOutbound === 'string'
          ? responseAfterRecipientOutbound
          : JSON.stringify(responseAfterRecipientOutbound);
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
      deriveResponseLevel(recipientOutboundChecks),
      recipientOutboundChecks,
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
    if (recipientOutboundChecks.length > 0) {
      dispatchObligations(
        recipientOutboundChecks,
        'outbound',
        responseCommitment,
        message.recipient,
      );
    }

    // Return leg: re-encrypt the response TO the requester's key (gateway-opaque)
    // when it registered one; the requester's client decrypts it. Legacy
    // requesters (no key) get plaintext.
    return {
      success: true,
      response: encryptResponseForRequester(
        finalResponse,
        getAgent(message.sender)?.clientPublicKey,
      ),
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
  slimName?: string,
  recipientPublicKey?: string,
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

  // SLIM-native delivery: when the recipient has a slimName, publish the
  // message to that slimName over the AGNTCY data plane (Task 27). The
  // gateway — subscribed to the recipient's slimName on the agent's behalf
  // (the registry entry the Verifier pushed at registration, Task 28) —
  // receives it, POSTs the body to the agent's /_spellguard/receive callback,
  // and publishes the agent's response back as the SLIM reply. There is NO
  // HTTP fallback here: in agntcy profile a slimName recipient is delivered over
  // SLIM or it fails loudly, so an agntcy deployment is guaranteed to actually be
  // on the AGNTCY stack rather than silently dropping to the original path.
  const profile = getActiveProfile();
  if (slimName && profile?.profile === 'agntcy') {
    // The agent's HTTP callback base — re-register target for the retry below.
    // Only available when endpoint is HTTP (managed / back-filled recipients).
    const httpBase = endpoint.startsWith('http')
      ? endpoint.replace(/\/_spellguard\/receive\/?$/, '')
      : null;
    const MAX_ATTEMPTS = 3;
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await sendMessageToAgentOverSlim(
        slimName,
        message,
        decryptedPayload,
        channelToken,
        recipientPublicKey,
      );
      if (result.ok) return result.response;
      lastError = result.error ?? 'unknown';
      // Retry ONLY a `session-failed` send: createSession found no subscriber,
      // so the gateway's subscription is still propagating (first delivery to a
      // freshly-registered recipient) or the gateway restarted and lost its
      // registry. Either way the message did NOT reach the agent, so re-delivery
      // is safe. Any other failure may already have reached the agent — fail
      // loud rather than risk a double-delivery. (Still no silent HTTP fallback:
      // a slim deployment delivers over SLIM or fails.)
      if (result.errorCode !== 'session-failed' || attempt === MAX_ATTEMPTS) {
        break;
      }
      if (httpBase) {
        invalidateGatewayRegistration(message.recipient);
        await ensureGatewayRegistered(message.recipient, httpBase);
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    throw new Error(
      `SLIM delivery to ${message.recipient} (${slimName}) failed: ${lastError}`,
    );
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Spellguard-Channel-Token': channelToken,
    },
    body: JSON.stringify(
      buildAgentDeliveryBody(decryptedPayload, message, recipientPublicKey),
    ),
    // Bound the delivery to the recipient. This fetch awaits the recipient
    // agent's FULL turn (it may run an LLM), so it's legitimately long —
    // but WITHOUT a deadline a hung/cold cross-org agent holds this socket
    // (and a SLIM routeMessage chain) open for minutes (observed 273-301s
    // live), piling up on the verifier's single event loop until /ready +
    // heartbeat starve and ECS recycles the task. Cap just under the SLIM
    // reply budget (120s) so a zombie turn fails cleanly at ~110s instead.
    signal: AbortSignal.timeout(
      Number(process.env.SPELLGUARD_VERIFIER_FORWARD_TIMEOUT_MS) || 110_000,
    ),
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
