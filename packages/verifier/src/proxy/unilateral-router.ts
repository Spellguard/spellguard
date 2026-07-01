// SPDX-License-Identifier: Apache-2.0

/**
 * Unilateral Router - Routes messages to A2A-only agents (unilateral attestation).
 *
 * Provides unilateral attestation: the sending agent is Spellguard-attested,
 * but the receiving agent only supports standard A2A protocol.
 *
 * Both outbound requests and inbound responses are logged to the audit trail
 * with correlationId linking them together.
 */

// Import from @spellguard/ctls
import {
  type RegisteredAgent,
  getAgentByToken,
  getAllAgents,
  getSessionPublicKey,
} from '@spellguard/ctls';

import { decryptPayload } from '../crypto/encrypt';
import { encryptForManagement } from '../crypto/management-encrypt';
import { beginDelivery, endDelivery } from '../recycle-guard';

// Import from @spellguard/amp
import {
  type A2ARequest,
  type A2AResponse,
  type AuditCommitment,
  type SecureMessage,
  type UnilateralSendRequest,
  type UnilateralSendResult,
  archiveMessage as archiveToBackend,
  generateUnilateralCommitment,
  getArchiveBackendName,
  getCommitmentBackendName,
  logCommitment as logToBackend,
} from '@spellguard/amp';

// Local imports
import { resolveAgentCard } from '../discovery/resolver';
import { getAgentPolicies } from '../management/policy-cache';
import {
  dispatchObligations,
  reportUnilateralEvent,
} from '../management/reporter';
import { normalizeAgentUrl } from '../url-normalize';
import {
  handleQuarantine,
  resolveResponseLevel,
  shouldQuarantineFromChecks,
} from './effect-handlers';
import {
  type InboundPolicy,
  type OutboundPolicy,
  createDefaultInboundPolicy,
  createDefaultOutboundPolicy,
  enforceInboundPolicy,
  enforceOutboundPolicy,
} from './policy';
import type { PolicyCheckResult } from './policy-evaluator';
import { evaluatePolicies, filterByScope } from './policy-evaluator';
import {
  applyRedaction,
  buildQuarantineReason,
  deriveResponseLevel,
} from './policy-helpers';
import { checkVisibility } from './visibility-checker';

/**
 * Generate a unique correlation ID for linking request/response.
 */
function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `ext_${timestamp}_${random}`;
}

/**
 * Generate a unique message ID.
 */
function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `msg_${timestamp}_${random}`;
}

/**
 * Verify the sender is authenticated and owns the channel token.
 */
function verifySender(
  senderId: string,
  senderChannelToken: string,
): { valid: true; agent: RegisteredAgent } | { valid: false; error: string } {
  const tokenOwner = getAgentByToken(senderChannelToken);
  if (!tokenOwner) {
    return { valid: false, error: 'Invalid or expired channel token' };
  }

  if (tokenOwner.agentId !== senderId) {
    return { valid: false, error: 'Sender does not match channel token owner' };
  }

  return { valid: true, agent: tokenOwner };
}

/**
 * Convert payload to A2A JSON-RPC format.
 */
function toA2ARequest(
  payload: unknown,
  method: 'tasks/send' | 'tasks/get',
): A2ARequest {
  // Generate a task ID
  const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;

  // Convert payload to text
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>;
    // Try to extract text from common message formats
    if (typeof obj.text === 'string') {
      text = obj.text;
    } else if (typeof obj.prompt === 'string') {
      text = obj.prompt;
    } else if (typeof obj.message === 'string') {
      text = obj.message;
    } else {
      text = JSON.stringify(payload);
    }
  } else {
    text = String(payload);
  }

  return {
    jsonrpc: '2.0',
    id: taskId,
    method,
    params: {
      id: taskId,
      message: {
        role: 'user',
        parts: [{ type: 'text', text }],
      },
    },
  };
}

const IS_DEV_MODE =
  process.env.VERIFIER_MOCK_MODE === 'true' ||
  process.env.NODE_ENV !== 'production';

/**
 * Reject URLs targeting private/reserved IP ranges to prevent SSRF.
 * Checks the hostname against known private IPv4 ranges and metadata endpoints.
 * In dev/mock mode, private addresses are allowed (agents run locally).
 */
function validateOutboundUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SSRF blocked: non-HTTP scheme '${parsed.protocol}'`);
  }
  const host = parsed.hostname;
  // Block cloud metadata endpoints (always, even in dev)
  if (host === '169.254.169.254' || host === 'metadata.google.internal') {
    throw new Error('SSRF blocked: cloud metadata endpoint');
  }
  // In dev mode, allow private/reserved addresses for local agents
  if (IS_DEV_MODE) return;
  // Block private/reserved IPv4 ranges
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith('169.254.') ||
    host.startsWith('fd') ||
    host.startsWith('fc')
  ) {
    throw new Error('SSRF blocked: private/reserved address');
  }
}

/**
 * Send a request to an A2A agent's endpoint.
 */
async function sendToA2AAgent(
  agentUrl: string,
  request: A2ARequest,
): Promise<{
  success: boolean;
  response?: A2AResponse;
  error?: string;
  httpStatus?: number;
}> {
  // Determine the A2A endpoint URL
  const a2aEndpoint = agentUrl.endsWith('/')
    ? `${agentUrl}a2a`
    : `${agentUrl}/a2a`;

  try {
    validateOutboundUrl(a2aEndpoint);
    const response = await fetch(a2aEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    const httpStatus = response.status;

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `A2A agent returned ${httpStatus}: ${errorText}`,
        httpStatus,
      };
    }

    const a2aResponse = (await response.json()) as A2AResponse;
    return {
      success: true,
      response: a2aResponse,
      httpStatus,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to reach A2A agent: ${error instanceof Error ? error.message : String(error)}`,
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
      `[UnilateralRouter] Failed to log to ${getCommitmentBackendName()}: ${error}`,
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
      `[UnilateralRouter] Failed to archive to ${getArchiveBackendName()}: ${error}`,
    );
    return null;
  }
}

/**
 * Create a SecureMessage for unilateral interactions.
 */
function createSecureMessage(
  sender: string,
  recipient: string,
  payload: string,
): SecureMessage {
  return {
    id: generateMessageId(),
    sender,
    recipient,
    encryptedPayload: payload, // For unilateral, we store the serialized payload
    timestamp: Date.now(),
  };
}

/**
 * Route a message to an A2A-only agent (unilateral attestation).
 *
 * Flow:
 * 1. Verify sender authentication
 * 2. Fetch external agent card via A2A discovery
 * 3. Enforce outbound policy
 * 4. Generate correlation ID
 * 5. Create and log outbound commitment
 * 6. Convert payload to A2A JSON-RPC format
 * 7. POST to external agent's /a2a endpoint
 * 8. If response received, enforce inbound policy and log commitment
 * 9. If unreachable, log outbound with reachable=false
 * 10. Return result with commitment IDs
 */

/**
 * Extract the originator's `_spellguardCorrelationId` from a decrypted
 * unilateral payload, falling back to the supplied default. Exposed for
 * unit testing the cross-org session-graph linkage; see
 * `tests/correlation-id-cross-org.test.ts`.
 *
 * Returns the stamp when:
 *  - payload is a non-array plain object, AND
 *  - `_spellguardCorrelationId` is a non-empty string
 *
 * Otherwise returns `fallback` (typically a freshly minted correlation id).
 */
export function extractStampedCorrelationId(
  payload: unknown,
  fallback: string,
): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return fallback;
  }
  const stamp = (payload as Record<string, unknown>)._spellguardCorrelationId;
  if (typeof stamp === 'string' && stamp.length > 0) return stamp;
  return fallback;
}

export async function routeUnilateral(
  request: UnilateralSendRequest,
  senderChannelToken: string,
  options?: {
    outboundPolicy?: OutboundPolicy;
    inboundPolicy?: InboundPolicy;
  },
): Promise<UnilateralSendResult> {
  // In-flight accounting so the proactive self-recycle never exits mid-delivery.
  beginDelivery();
  try {
    return await routeUnilateralImpl(request, senderChannelToken, options);
  } finally {
    endDelivery();
  }
}

async function routeUnilateralImpl(
  request: UnilateralSendRequest,
  senderChannelToken: string,
  options?: {
    outboundPolicy?: OutboundPolicy;
    inboundPolicy?: InboundPolicy;
  },
): Promise<UnilateralSendResult> {
  // Default to a fresh id; overridden post-decryption if the client stamped
  // `_spellguardCorrelationId` on the inbound payload (see Step 4 below).
  let correlationId = generateCorrelationId();
  const warnings: string[] = [];

  // Step 1: Verify sender authentication
  const senderResult = verifySender(request.sender, senderChannelToken);
  if (!senderResult.valid) {
    return {
      success: false,
      correlationId,
      error: senderResult.error,
      commitments: { outbound: {} },
    };
  }

  // Step 2: Fetch A2A agent card via A2A discovery
  const agentCard = await resolveAgentCard(request.a2aAgentUrl);
  if (!agentCard) {
    // Even failed discovery attempts should be logged
    console.log(
      `[UnilateralRouter] Could not discover A2A agent: ${request.a2aAgentUrl}`,
    );
  }

  const a2aAgentUrl = agentCard?.url || request.a2aAgentUrl;

  // Step 2b: Visibility check — block before running any policy engines
  // Resolve the A2A URL to a registered agent ID for policy cache lookup.
  // The policy cache is keyed by management agent_id (e.g., "agent-a"), not the
  // agent card display name. Match via agentCardUrl in the CTLS registry.
  const cardUrl = agentCard?.url || a2aAgentUrl;
  const cardUrlNorm = normalizeAgentUrl(cardUrl);
  const cardUrlWithWellKnown = normalizeAgentUrl(
    `${cardUrl}/.well-known/agent.json`,
  );
  const registeredRecipient = getAllAgents().find((a) => {
    const regNorm = normalizeAgentUrl(a.agentCardUrl);
    return regNorm === cardUrlWithWellKnown || regNorm === cardUrlNorm;
  });
  const recipientAgentId = registeredRecipient?.agentId ?? null;

  // If the recipient is a managed agent, enforce visibility (fail-closed).
  // If unmanaged (not registered), skip visibility — no rules to enforce.
  const recipientConfig = recipientAgentId
    ? await getAgentPolicies(recipientAgentId)
    : null;

  if (recipientAgentId && !recipientConfig) {
    // Fail-closed: managed agent but can't fetch policies (management server unreachable)
    console.log(
      `[UnilateralRouter] Policy data unavailable for managed recipient ${recipientAgentId} — blocking (fail-closed)`,
    );

    const outboundMessage = createSecureMessage(
      request.sender,
      a2aAgentUrl,
      JSON.stringify(request.payload),
    );
    const outboundCommitment = generateUnilateralCommitment(
      outboundMessage,
      'outbound',
      correlationId,
      a2aAgentUrl,
      false,
    );

    reportUnilateralEvent(
      outboundCommitment,
      'outbound',
      request.sender,
      'block',
      [],
      'visibility-denied',
    );

    return {
      success: false,
      correlationId,
      error: 'Blocked: recipient policy data unavailable (fail-closed)',
      commitments: { outbound: {} },
    };
  }

  if (recipientConfig?.visibility) {
    // Fail-closed: if sender config is unavailable, block entirely
    const senderConfig = await getAgentPolicies(request.sender);
    if (!senderConfig) {
      console.log(
        `[UnilateralRouter] Visibility check failed (no sender config) for ${request.sender} — blocking (fail-closed)`,
      );

      const outboundMessage = createSecureMessage(
        request.sender,
        a2aAgentUrl,
        JSON.stringify(request.payload),
      );
      const outboundCommitment = generateUnilateralCommitment(
        outboundMessage,
        'outbound',
        correlationId,
        a2aAgentUrl,
        false,
      );

      reportUnilateralEvent(
        outboundCommitment,
        'outbound',
        request.sender,
        'block',
        [],
        'visibility-denied',
      );

      return {
        success: false,
        correlationId,
        error:
          'Blocked: unable to verify sender identity for visibility check (fail-closed)',
        commitments: { outbound: {} },
      };
    }

    const senderContext = {
      agentId: request.sender,
      organizationId: senderConfig.organizationId ?? '',
      groupIds: senderConfig.visibility?.groups?.map((g) => g.id) ?? [],
    };

    const visResult = checkVisibility(
      senderContext,
      recipientConfig.visibility,
    );
    if (!visResult.allowed) {
      console.log(
        `[UnilateralRouter] Visibility denied message to ${a2aAgentUrl}: ${visResult.reason}`,
      );

      const outboundMessage = createSecureMessage(
        request.sender,
        a2aAgentUrl,
        JSON.stringify(request.payload),
      );
      const outboundCommitment = generateUnilateralCommitment(
        outboundMessage,
        'outbound',
        correlationId,
        a2aAgentUrl,
        false,
      );

      reportUnilateralEvent(
        outboundCommitment,
        'outbound',
        request.sender,
        'block',
        [],
        'visibility-denied',
      );

      return {
        success: false,
        correlationId,
        error: 'Message delivery blocked by visibility rules',
        commitments: { outbound: {} },
      };
    }
  }

  // Step 3: Enforce outbound policy
  const outboundPolicy =
    options?.outboundPolicy || createDefaultOutboundPolicy();
  const outboundCheck = enforceOutboundPolicy(
    a2aAgentUrl,
    request.payload,
    outboundPolicy,
  );

  if (!outboundCheck.allowed) {
    return {
      success: false,
      correlationId,
      error: outboundCheck.reason || 'Outbound policy violation',
      commitments: { outbound: {} },
      warnings: outboundCheck.detections,
    };
  }

  // Step 4: Decrypt payload
  let decryptedPayload: unknown;
  try {
    if (typeof request.payload === 'string') {
      const decryptedJson = decryptPayload(request.payload);
      decryptedPayload = JSON.parse(decryptedJson);
    } else {
      decryptedPayload = request.payload;
    }
  } catch (error) {
    console.error(`[UnilateralRouter] Failed to decrypt payload: ${error}`);
    decryptedPayload = request.payload;
  }

  // Override correlationId with the client-stamped value if present, so
  // multi-hop conversations that dip through external A2A agents stay
  // linked under one audit_logs.correlation_id.  Mirrors the bilateral
  // pattern in router.ts (read `_spellguardCorrelationId` from the
  // decrypted payload; take precedence over the freshly-generated default).
  correlationId = extractStampedCorrelationId(decryptedPayload, correlationId);

  const outboundPayloadStr = JSON.stringify(decryptedPayload);

  // Step 5: Run management-configured outbound policy checks BEFORE sending
  const outboundPolicyChecks: PolicyCheckResult[] = [];
  const senderPolicies = await getAgentPolicies(request.sender);
  if (!senderPolicies && process.env.MANAGEMENT_URL) {
    // MANAGEMENT_URL set but fetch returned null → server unreachable, fail
    // closed. (When MANAGEMENT_URL is unset, policy enforcement is disabled
    // and we fall through to the no-checks path below.)
    console.log(
      `[UnilateralRouter] Policy data unavailable for sender ${request.sender} — blocking (fail-closed)`,
    );

    const outboundMessage = createSecureMessage(
      request.sender,
      a2aAgentUrl,
      outboundPayloadStr,
    );
    const outboundCommitment = generateUnilateralCommitment(
      outboundMessage,
      'outbound',
      correlationId,
      a2aAgentUrl,
      false,
    );

    reportUnilateralEvent(
      outboundCommitment,
      'outbound',
      request.sender,
      'block',
      [],
    );

    return {
      success: false,
      correlationId,
      error: 'Blocked: sender policy data unavailable (fail-closed)',
      commitments: { outbound: {} },
    };
  }

  if (senderPolicies) {
    const checks = await evaluatePolicies(
      filterByScope(senderPolicies.outbound, 'messages'),
      outboundPayloadStr,
      {
        agentId: request.sender,
        direction: 'outbound',
        agentStatus: senderPolicies.agentStatus,
        identity: senderPolicies.identityContext,
      },
    );
    outboundPolicyChecks.push(...checks);
  }

  const outboundHasDeny = outboundPolicyChecks.some(
    (c) => c.decision === 'deny',
  );

  // If outbound policy denies, block the message before it leaves the Verifier
  if (outboundHasDeny) {
    const deniedPolicy = outboundPolicyChecks.find(
      (c) => c.decision === 'deny',
    );
    console.log(
      `[UnilateralRouter] Outbound policy denied message: ${deniedPolicy?.policyName}`,
    );

    // Quarantine is an agent-state concern, orthogonal to the resolved
    // message-level response level — see shouldQuarantineFromChecks.
    const outboundLevel = deriveResponseLevel(outboundPolicyChecks);
    if (shouldQuarantineFromChecks(outboundPolicyChecks)) {
      // CR-027: Await and log quarantine result
      const quarantineOk = await handleQuarantine(
        request.sender,
        buildQuarantineReason(outboundPolicyChecks),
      );
      if (!quarantineOk) {
        console.error(
          `[UnilateralRouter] CRITICAL: Failed to quarantine agent ${request.sender} — message is still denied`,
        );
      }
    }

    const outboundMessage = createSecureMessage(
      request.sender,
      a2aAgentUrl,
      outboundPayloadStr,
    );
    const outboundCommitment = generateUnilateralCommitment(
      outboundMessage,
      'outbound',
      correlationId,
      a2aAgentUrl,
      false,
    );

    reportUnilateralEvent(
      outboundCommitment,
      'outbound',
      request.sender,
      outboundLevel,
      outboundPolicyChecks,
    );
    dispatchObligations(outboundPolicyChecks, 'outbound', outboundCommitment);

    return {
      success: false,
      correlationId,
      error: `Blocked by outbound policy: ${deniedPolicy?.policyName}`,
      commitments: { outbound: {} },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Step 5b: Apply outbound redaction if any checks resolved to 'redact'
  let outboundContentForSend = outboundPayloadStr;
  let outboundPayloadForSend = decryptedPayload;
  const redactedOutbound = applyRedaction(
    outboundPayloadStr,
    outboundPolicyChecks,
  );
  if (redactedOutbound !== outboundPayloadStr) {
    outboundContentForSend = redactedOutbound;
    try {
      outboundPayloadForSend = JSON.parse(redactedOutbound);
    } catch {
      outboundPayloadForSend = redactedOutbound;
    }
  }

  // Step 6: Create outbound message and commitment
  const outboundMessage = createSecureMessage(
    request.sender,
    a2aAgentUrl,
    outboundContentForSend,
  );

  // Initially mark as not reachable (will update if successful)
  const outboundCommitment = generateUnilateralCommitment(
    outboundMessage,
    'outbound',
    correlationId,
    a2aAgentUrl,
    false, // Will update after send attempt
  );

  // Step 7: Convert to A2A format and send
  const method = request.method || 'tasks/send';
  const a2aRequest = toA2ARequest(outboundPayloadForSend, method);

  console.log(`[UnilateralRouter] Sending to A2A agent: ${a2aAgentUrl}`);

  const sendResult = await sendToA2AAgent(a2aAgentUrl, a2aRequest);

  // Update reachability based on result
  outboundCommitment.reachable =
    sendResult.success || sendResult.httpStatus !== undefined;
  outboundCommitment.httpStatus = sendResult.httpStatus;

  // Step 8: Log and archive outbound commitment
  // Encrypt outbound content for management retrieval
  const outboundEnvelope = await encryptForManagement(
    JSON.stringify({
      sender: request.sender,
      recipient: a2aAgentUrl,
      content: outboundContentForSend,
      timestamp: new Date(outboundMessage.timestamp).toISOString(),
      direction: 'outbound',
      attestationLevel: 'unilateral',
    }),
  );
  const outboundArchiveOpts = outboundEnvelope
    ? { encryptedEnvelope: outboundEnvelope }
    : undefined;

  const [outboundLogResult, outboundArchiveResult] = await Promise.allSettled([
    logCommitment(outboundCommitment),
    archiveMessage(outboundMessage, outboundCommitment, outboundArchiveOpts),
  ]);

  const outboundCommitmentId =
    outboundLogResult.status === 'fulfilled' ? outboundLogResult.value : null;
  const outboundArchiveId =
    outboundArchiveResult.status === 'fulfilled'
      ? outboundArchiveResult.value
      : null;

  if (!outboundCommitmentId) {
    warnings.push(
      `${getCommitmentBackendName()} logging unavailable or failed`,
    );
  }
  if (!outboundArchiveId) {
    warnings.push(`${getArchiveBackendName()} archival unavailable or failed`);
  }

  // Determine outbound response level (for reporting — send already allowed)
  const outboundResponseLevel = sendResult.success
    ? deriveResponseLevel(outboundPolicyChecks)
    : 'block';

  // Report outbound event to Management Server
  reportUnilateralEvent(
    outboundCommitment,
    'outbound',
    request.sender,
    outboundResponseLevel,
    outboundPolicyChecks,
  );
  dispatchObligations(outboundPolicyChecks, 'outbound', outboundCommitment);

  // If send failed, return with outbound commitment only
  if (!sendResult.success) {
    console.log(
      `[UnilateralRouter] Failed to send to A2A agent: ${sendResult.error}`,
    );
    return {
      success: false,
      correlationId,
      error: sendResult.error,
      commitments: {
        outbound: {
          commitmentId: outboundCommitmentId || undefined,
          archiveId: outboundArchiveId || undefined,
        },
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Step 9: Process inbound response
  const inboundResponse = sendResult.response;
  if (!inboundResponse) {
    return {
      success: false,
      correlationId,
      error: 'Unexpected: success but no response',
      commitments: {
        outbound: {
          commitmentId: outboundCommitmentId || undefined,
          archiveId: outboundArchiveId || undefined,
        },
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const inboundPolicy = options?.inboundPolicy || createDefaultInboundPolicy();
  const inboundCheck = enforceInboundPolicy(inboundResponse, inboundPolicy);

  if (inboundCheck.detections && inboundCheck.detections.length > 0) {
    warnings.push(...inboundCheck.detections);
  }

  // Create inbound message and commitment
  const inboundPayloadStr = JSON.stringify(sendResult.response);
  const inboundMessage = createSecureMessage(
    a2aAgentUrl,
    request.sender,
    inboundPayloadStr,
  );

  const inboundCommitment = generateUnilateralCommitment(
    inboundMessage,
    'inbound',
    correlationId,
    a2aAgentUrl,
    true,
    sendResult.httpStatus,
  );

  // Step 10: Run management-configured inbound policy checks BEFORE returning
  const inboundPolicyChecks: PolicyCheckResult[] = [];
  if (senderPolicies) {
    const checks = await evaluatePolicies(
      filterByScope(senderPolicies.inbound, 'messages'),
      inboundPayloadStr,
      {
        agentId: request.sender,
        direction: 'inbound',
        agentStatus: senderPolicies.agentStatus,
        identity: senderPolicies.identityContext,
      },
    );
    inboundPolicyChecks.push(...checks);
  }

  // Apply inbound redaction if any checks resolved to 'redact'
  let inboundFinalResponse = sendResult.response;
  const redactedInbound = applyRedaction(
    inboundPayloadStr,
    inboundPolicyChecks,
  );
  if (redactedInbound !== inboundPayloadStr) {
    try {
      inboundFinalResponse = JSON.parse(redactedInbound) as A2AResponse;
    } catch {
      inboundFinalResponse = redactedInbound as unknown as A2AResponse;
    }
  }

  const inboundHasDeny = inboundPolicyChecks.some((c) => c.decision === 'deny');

  // If inbound policy denies, block the response from reaching the sender
  if (inboundHasDeny) {
    const deniedPolicy = inboundPolicyChecks.find((c) => c.decision === 'deny');
    console.log(
      `[UnilateralRouter] Inbound policy denied response: ${deniedPolicy?.policyName}`,
    );

    // Quarantine is an agent-state concern, orthogonal to the resolved
    // message-level response level — see shouldQuarantineFromChecks.
    const inboundLevel = deriveResponseLevel(inboundPolicyChecks);
    if (shouldQuarantineFromChecks(inboundPolicyChecks)) {
      // CR-027: Await and log quarantine result
      const quarantineOk = await handleQuarantine(
        request.sender,
        buildQuarantineReason(inboundPolicyChecks),
      );
      if (!quarantineOk) {
        console.error(
          `[UnilateralRouter] CRITICAL: Failed to quarantine agent ${request.sender} — response is still denied`,
        );
      }
    }

    // Log and archive the inbound commitment (for audit trail)
    const deniedInboundEnvelope = await encryptForManagement(
      JSON.stringify({
        sender: a2aAgentUrl,
        recipient: request.sender,
        content: inboundPayloadStr,
        timestamp: new Date(inboundMessage.timestamp).toISOString(),
        direction: 'inbound',
        attestationLevel: 'unilateral',
      }),
    );
    const deniedInboundOpts = deniedInboundEnvelope
      ? { encryptedEnvelope: deniedInboundEnvelope }
      : undefined;

    await Promise.allSettled([
      logCommitment(inboundCommitment),
      archiveMessage(inboundMessage, inboundCommitment, deniedInboundOpts),
    ]);

    reportUnilateralEvent(
      inboundCommitment,
      'inbound',
      request.sender,
      inboundLevel,
      inboundPolicyChecks,
    );
    dispatchObligations(inboundPolicyChecks, 'inbound', inboundCommitment);

    return {
      success: false,
      correlationId,
      error: `Blocked by inbound policy: ${deniedPolicy?.policyName}`,
      commitments: {
        outbound: {
          commitmentId: outboundCommitmentId || undefined,
          archiveId: outboundArchiveId || undefined,
        },
        inbound: {},
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // Step 11: Log and archive inbound commitment
  // Encrypt inbound response content for management retrieval
  const inboundEnvelope = await encryptForManagement(
    JSON.stringify({
      sender: a2aAgentUrl,
      recipient: request.sender,
      content: inboundPayloadStr,
      timestamp: new Date(inboundMessage.timestamp).toISOString(),
      direction: 'inbound',
      attestationLevel: 'unilateral',
    }),
  );
  const inboundArchiveOpts = inboundEnvelope
    ? { encryptedEnvelope: inboundEnvelope }
    : undefined;

  const [inboundLogResult, inboundArchiveResult] = await Promise.allSettled([
    logCommitment(inboundCommitment),
    archiveMessage(inboundMessage, inboundCommitment, inboundArchiveOpts),
  ]);

  const inboundCommitmentId =
    inboundLogResult.status === 'fulfilled' ? inboundLogResult.value : null;
  const inboundArchiveId =
    inboundArchiveResult.status === 'fulfilled'
      ? inboundArchiveResult.value
      : null;

  if (!inboundCommitmentId) {
    warnings.push(
      `${getCommitmentBackendName()} logging unavailable or failed for inbound`,
    );
  }
  if (!inboundArchiveId) {
    warnings.push(
      `${getArchiveBackendName()} archival unavailable or failed for inbound`,
    );
  }

  // Determine inbound response level using 6-value priority system
  const baseInboundLevel = inboundCheck.allowed ? 'allow' : 'flag';
  const managedInboundLevel = deriveResponseLevel(inboundPolicyChecks);
  // Pick the higher-priority level between legacy policy and managed policy checks
  const inboundResponseLevel = resolveResponseLevel([
    baseInboundLevel,
    managedInboundLevel,
  ]);

  // Report inbound event to Management Server
  reportUnilateralEvent(
    inboundCommitment,
    'inbound',
    request.sender,
    inboundResponseLevel,
    inboundPolicyChecks,
  );
  dispatchObligations(inboundPolicyChecks, 'inbound', inboundCommitment);

  console.log(
    `[UnilateralRouter] Successfully routed: ${request.sender} -> ${a2aAgentUrl} (correlation: ${correlationId})`,
  );

  return {
    success: true,
    correlationId,
    response: inboundFinalResponse,
    commitments: {
      outbound: {
        commitmentId: outboundCommitmentId || undefined,
        archiveId: outboundArchiveId || undefined,
      },
      inbound: {
        commitmentId: inboundCommitmentId || undefined,
        archiveId: inboundArchiveId || undefined,
      },
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
