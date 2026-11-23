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
  RecipientDeliveryError,
  buildAgentDeliveryBody,
  decryptRecipientReply,
  encryptResponseForRequester,
  refusalReason,
} from './delivery-encryption';

// Import from @spellguard/amp
import {
  type AuditCommitment,
  type SecureMessage,
  archiveMessage as archiveToBackend,
  effectiveDocumentLimits,
  generateCommitment,
  getArchiveBackendName,
  getCommitmentBackendName,
  getOrCreateChannel,
  logCommitment as logToBackend,
  updateChannelActivity,
} from '@spellguard/amp';

// Local imports
import {
  resolveAgentCard,
  resolveRecipientEncryption,
} from '../discovery/resolver';
import { getAgentPolicies } from '../management/policy-cache';
import {
  dispatchObligations,
  reportBilateralEvent,
} from '../management/reporter';
import { getActiveProfile } from '../profile/registry';
import {
  a2aMessageOutput,
  judgesOutputs,
  replyOutput,
} from '../session/agent-output';
import {
  type AttachmentReading,
  attachmentAuditRecord,
  discardPageImages,
  ledgerMessage,
  payloadObject,
  policyMessage,
  readAttachments,
  restoreAttachments,
} from '../session/attachments';
import { gateAttachments } from '../session/document-gate';
import { isValidCorrelationId } from '../session/keys';
import { appendParts, deniedLabel, recordParts } from '../session/recording';
import { type SessionServices, openAgentSession } from '../session/runtime';
import { type SessionPart, hiddenLayerLabel } from '../session/types';
import {
  deriveAgentSlimName,
  ensureGatewayRegistered,
  invalidateGatewayRegistration,
} from '../slim/managed-delivery';
import { sendMessageToAgentOverSlim } from '../slim/send-to-agent';
import { signedDeliveryHeaders } from './delivery-signing';
import {
  handleQuarantine,
  shouldQuarantineFromChecks,
} from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { addMessage, getRecentMessages } from './message-buffer';
import type { PolicyCheckResult } from './policy-evaluator';
import {
  evaluatePolicies,
  filterByScope,
  quarantinePrecheckResult,
} from './policy-evaluator';
import type { ResolvedPolicyConfig } from './policy-evaluator-types';
import {
  STATEFUL_POLICY_TYPES,
  applyRedaction,
  buildQuarantineReason,
  deriveResponseLevel,
  evaluateResponseDisposition,
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
 * #1528: the key to encrypt to a recipient this registry does not hold. The
 * registry drops every agent's key on a session-key rotation or a restart, but
 * the key is the agent's own, so management's copy from its last registration
 * still holds. `undefined` (a legacy agent, or no key on record) delivers
 * unencrypted; a recipient that refuses that is retried once, with the key it
 * registers while refusing (`recipientAfterKeyRefusal`).
 */
async function recordedRecipientKey(
  agentId: string,
): Promise<string | undefined> {
  const encryption = await resolveRecipientEncryption(agentId);
  return encryption.mode === 'full' ? encryption.publicKey : undefined;
}

/**
 * #1528: after a recipient refused a delivery over its encryption, the
 * registration it made while refusing, if that gave it a key the failed
 * delivery did not use. `null` means do not retry: the refusal was about
 * something else, or nothing changed and a retry would be refused again.
 */
function recipientAfterKeyRefusal(
  error: unknown,
  used: RegisteredAgent,
): RegisteredAgent | null {
  if (!(error instanceof RecipientDeliveryError) || !error.isKeyRefusal) {
    return null;
  }
  const current = getAgent(used.agentId);
  if (!current?.clientPublicKey) return null;
  if (current.clientPublicKey === used.clientPublicKey) return null;
  return current;
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
      const clientPublicKey = await recordedRecipientKey(address.agentId);
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
        clientPublicKey,
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
  const [agentCard, clientPublicKey] = await Promise.all([
    resolveAgentCard(recipientId),
    recordedRecipientKey(recipientId),
  ]);

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
    clientPublicKey,
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
/**
 * The sender's outbound audit event. Its metadata says what the sender's
 * session recorded, when it has one (an agent-conduct binding opened it);
 * for any other agent the event is reported exactly as before.
 */
function reportOutboundEvent(
  commitment: AuditCommitment,
  level: string,
  checks: PolicyCheckResult[],
  senderMetadata: Record<string, unknown> | undefined,
): void {
  if (senderMetadata) {
    reportBilateralEvent(
      commitment,
      level,
      checks,
      'outbound',
      undefined,
      undefined,
      senderMetadata,
    );
  } else {
    reportBilateralEvent(commitment, level, checks, 'outbound');
  }
}

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
 * The correlation id the sender stamped on its payload, when it is one the
 * Verifier accepts (1-128 of [A-Za-z0-9._:-]), or undefined.
 */
function stampedCorrelationId(
  decryptedContent: string | null,
): string | undefined {
  if (!decryptedContent) return undefined;
  try {
    const parsed = JSON.parse(decryptedContent);
    return isValidCorrelationId(parsed?._spellguardCorrelationId)
      ? (parsed._spellguardCorrelationId as string)
      : undefined;
  } catch {
    // Not JSON: no client trace id.
    return undefined;
  }
}

/**
 * Run outbound policy checks. Returns the denied policy name if blocked, null otherwise.
 *
 * The send is the sender's own output (internal design notes
 * §3): when an `agent-conduct` binding is on the leg, it is judged against
 * the sender's session for the conversation the payload names, and recorded
 * there as `message:outbound` after its verdict. A sender with no session
 * policy opens no session and builds no output.
 */
async function runOutboundPolicyChecks(
  message: SecureMessage,
  accumulator: PolicyCheckResult[],
  orgContext?: { senderOrgId?: string; recipientOrgId?: string },
  sessionServices: SessionServices = {},
): Promise<{
  denied: string | null;
  policies: Awaited<ReturnType<typeof getAgentPolicies>>;
  decryptedContent: string | null;
  /** True when decryptedContent is the decrypted payload, not the raw one. */
  decrypted: boolean;
  /** The conversation the sender stamped, when it is a valid id. */
  stampedCorrelationId?: string;
  /** What the sender's session recorded, when it has one. */
  senderSession?: string;
}> {
  let decryptedContent: string | null = null;
  let decrypted = false;
  try {
    decryptedContent = decryptPayload(message.encryptedPayload);
    decrypted = true;
  } catch {
    // Decryption failed — use raw payload for policy checking (e.g. dev/test
    // mode where messages aren't encrypted).
    if (typeof message.encryptedPayload === 'string') {
      decryptedContent = message.encryptedPayload;
    }
  }
  const stamped = stampedCorrelationId(decryptedContent);

  const senderPolicies = await getAgentPolicies(message.sender);
  if (!senderPolicies) {
    // MANAGEMENT_URL unset → policy enforcement disabled, pass through.
    // MANAGEMENT_URL set but fetch returned null → server unreachable, fail closed.
    if (!process.env.MANAGEMENT_URL) {
      return {
        denied: null,
        policies: null,
        decryptedContent,
        decrypted,
        stampedCorrelationId: stamped,
      };
    }
    return {
      denied: 'policy_data_unavailable',
      policies: senderPolicies,
      decryptedContent,
      decrypted,
      stampedCorrelationId: stamped,
    };
  }
  // Get recent message history for loop detection
  const recentMessages = getRecentMessages(message.sender);

  const bindings = filterByScope(senderPolicies.outbound, 'messages');
  // The sender's session only for a conversation it named with a valid id:
  // the router's fresh fallback id would open an empty ledger, and a policy
  // with nothing to judge against fails on its failBehavior instead.
  const senderSession = await openAgentSession(
    sessionServices,
    message.sender,
    stamped,
    senderPolicies,
  );
  const output = judgesOutputs(bindings)
    ? a2aMessageOutput(message.recipient, decryptedContent)
    : undefined;

  // The policies judge the message without its attachments' base64 (§5 of
  // internal design notes); identical to the decrypted
  // content for a message with no attachment data.
  const checks = await evaluatePolicies(
    bindings,
    decryptedContent === null ? '' : policyMessage(decryptedContent),
    {
      agentId: message.sender,
      direction: 'outbound',
      recentMessages,
      agentStatus: senderPolicies.agentStatus,
      senderOrgId: orgContext?.senderOrgId ?? senderPolicies.organizationId,
      recipientOrgId: orgContext?.recipientOrgId,
      identity: senderPolicies.identityContext,
      ...(output
        ? {
            output,
            decisionModel: sessionServices.decisionModel,
            ...(stamped ? { correlationId: stamped } : {}),
            ...(senderSession ? { session: senderSession } : {}),
          }
        : {}),
    },
  );
  accumulator.push(...checks);

  const deniedCheck = checks.find((c) => c.decision === 'deny');

  // The sender's own output, after its verdict, marked denied when its own
  // outbound policies blocked it. Never a source: it is the sender's.
  let senderSessionStatus: string | undefined;
  if (senderSession) {
    const ledger = ledgerMessage(decryptedContent);
    senderSessionStatus = await recordParts(senderSession, [
      {
        leg: 'message:outbound',
        kind: ledger.kind,
        label: deniedCheck ? deniedLabel(message.recipient) : message.recipient,
        from: {
          agentId: message.sender,
          ...(senderPolicies.organizationId
            ? { orgId: senderPolicies.organizationId }
            : {}),
        },
        text: ledger.text,
      },
    ]);
  }

  return {
    denied: deniedCheck ? deniedCheck.policyName : null,
    policies: senderPolicies,
    decryptedContent,
    decrypted,
    stampedCorrelationId: stamped,
    ...(senderSessionStatus ? { senderSession: senderSessionStatus } : {}),
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
  documents: readonly AttachmentReading[] = [],
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
    accumulator.push(
      quarantinePrecheckResult('Recipient agent is quarantined'),
    );
    return { denied: 'quarantine-precheck' };
  }

  if (policies.inbound.length === 0) {
    return { denied: null };
  }

  // Get recent message history for loop detection
  const recentMessages = getRecentMessages(recipientId);

  const bindings = filterByScope(policies.inbound, 'messages');
  const options = {
    agentId: recipientId,
    direction: 'inbound' as const,
    recentMessages,
    agentStatus: policies.agentStatus,
    senderOrgId: orgContext?.senderOrgId,
    recipientOrgId: orgContext?.recipientOrgId ?? policies.organizationId,
    identity: policies.identityContext,
  };
  const checks = await evaluatePolicies(bindings, decryptedContent, options);

  // A second content pass per readable attachment, so the inbound policies
  // (injection above all) see a document's text and not only its base64.
  // Stateful policies are not re-run: the message already counted once.
  // Each check names its document in `evidence`.
  const documentBindings = bindings.filter(
    (b) => !STATEFUL_POLICY_TYPES.has(b.policyType),
  );
  for (const document of documents) {
    if (!document.text || documentBindings.length === 0) continue;
    const documentChecks = await evaluatePolicies(
      documentBindings,
      document.text,
      options,
    );
    for (const check of documentChecks) {
      check.evidence = { ...(check.evidence ?? {}), document: document.name };
    }
    checks.push(...documentChecks);
  }
  accumulator.push(...checks);

  const deniedCheck = checks.find((c) => c.decision === 'deny');
  return { denied: deniedCheck ? deniedCheck.policyName : null };
}

/** The synthetic check the document gate reports on the recipient's event. */
function documentReadingCheck(
  decision: 'deny' | 'permit',
  responseLevel: 'block' | 'flag',
  type: string,
  message: string,
): PolicyCheckResult {
  return {
    policyId: '__document_reading',
    policyName: 'document-reading',
    policyLevel: 'system',
    decision,
    responseLevel,
    detections: [{ type, confidence: 1, message }],
    obligations: [],
    durationMs: 0,
  };
}

type AttachmentStep =
  | {
      kind: 'deliver';
      readings: AttachmentReading[];
      inboundMetadata: Record<string, unknown>;
      /** Checks to put on the recipient's inbound event (a warning flag). */
      checks: PolicyCheckResult[];
    }
  | {
      kind: 'block';
      reasonCode: string;
      message: string;
      check: PolicyCheckResult;
      inboundMetadata: Record<string, unknown>;
    };

/**
 * Step 3a-iii. With a document reader (Cloudflare), the ingest gate
 * (session/document-gate.ts). Without one (the Node Verifier), the legacy
 * path exactly as before: 1 MiB per attachment, anything else recorded as
 * unreadable and delivered.
 */
async function readMessageAttachments(
  message: SecureMessage,
  content: string | null,
  recipientConfig: ResolvedPolicyConfig | null,
  sessionServices: SessionServices,
): Promise<AttachmentStep> {
  const payload = payloadObject(content);
  if (!sessionServices.documentReader) {
    const readings = await readAttachments(
      payload,
      sessionServices.documentExtractor,
    );
    return {
      kind: 'deliver',
      readings,
      inboundMetadata:
        readings.length > 0
          ? { attachments: readings.map(attachmentAuditRecord) }
          : {},
      checks: [],
    };
  }
  const gate = await gateAttachments({
    payload,
    reader: sessionServices.documentReader,
    recipientConfig,
    limits: effectiveDocumentLimits(recipientConfig?.documentLimits),
  });
  const inboundMetadata: Record<string, unknown> = {};
  if (gate.audit.length > 0) {
    inboundMetadata.attachments = gate.audit;
    inboundMetadata.documentReading = gate.summary;
  }
  if (gate.kind === 'block') {
    console.log(
      `[Router] Message ${message.id} blocked at the document gate: ${gate.reason}`,
    );
    return {
      kind: 'block',
      reasonCode: gate.reasonCode,
      message: gate.message,
      check: documentReadingCheck('deny', 'block', gate.reason, gate.message),
      inboundMetadata,
    };
  }
  return {
    kind: 'deliver',
    readings: gate.readings,
    inboundMetadata,
    checks: gate.flag
      ? [
          documentReadingCheck(
            'permit',
            'flag',
            'document_unreadable',
            gate.flag.message,
          ),
        ]
      : [],
  };
}

/**
 * Keep the page images each document's OCR read beside its part in the
 * recipient's session, so the decision model can look at the pages
 * (internal design notes). The images go from the
 * reading object to the session directly. Best effort: a session that keeps
 * none still has the document's text, and the audit event says what was
 * kept.
 */
async function keepPageImages(
  sessionKey: string,
  attachments: readonly AttachmentReading[],
  stored: readonly SessionPart[],
): Promise<Array<Record<string, unknown>>> {
  // One document part per attachment, in order; a session that filled up
  // stored only the first ones.
  const documents = stored.filter((p) => p.kind === 'document');
  const out: Array<Record<string, unknown>> = [];
  for (const [index, attachment] of attachments.entries()) {
    const part = documents[index];
    if (!attachment.keepImages) continue;
    if (!part) {
      await discardPageImages([attachment]);
      out.push({ name: attachment.name, kept: 0, reason: 'not_recorded' });
      continue;
    }
    try {
      const kept = await attachment.keepImages({
        sessionKey,
        partSeq: part.seq,
      });
      out.push({ name: attachment.name, partSeq: part.seq, ...kept });
    } catch (err) {
      console.warn(
        `[Router] Page images of ${attachment.name} were not kept: ${err instanceof Error ? err.message : String(err)}`,
      );
      out.push({ name: attachment.name, kept: 0, reason: 'unavailable' });
    }
  }
  return out;
}

/**
 * The documents the recipient's inbound policies read as content passes:
 * each readable document's text and, separately, the invisible text layer of
 * its scanned pages, which the agent's model may read too.
 */
function contentPassDocuments(
  readings: readonly AttachmentReading[],
): AttachmentReading[] {
  return readings.flatMap((reading) =>
    reading.hidden?.text
      ? [
          reading,
          {
            name: `${reading.name} (invisible text layer)`,
            mediaType: reading.mediaType,
            text: reading.hidden.text,
          },
        ]
      : [reading],
  );
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
  sessionServices: SessionServices = {},
): Promise<RouteResult> {
  // In-flight accounting so the proactive self-recycle (recycle-guard) never
  // exits the process mid-delivery — only in an idle gap.
  beginDelivery();
  try {
    return await routeMessageImpl(message, senderChannelToken, sessionServices);
  } finally {
    endDelivery();
  }
}

async function routeMessageImpl(
  message: SecureMessage,
  senderChannelToken: string,
  sessionServices: SessionServices,
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

  // Establish the channel early (activity tracking) and seed a correlationId
  // so all audit events for this exchange share one trace id. The default is a
  // FRESH per-request id (like the unilateral router), NOT channel.id: the
  // per-(sender, recipient) channel.id is a stable, time-independent key, so
  // reusing it would collapse unrelated sessions between the same two agents
  // into a single "session" on the dashboard (and pull in stale rows). When
  // the decrypted payload carries a client-stamped `_spellguardCorrelationId`
  // (the normal case for traced agents — any send inside a runWithHops
  // context), it takes precedence a few dozen lines below, so a real
  // multi-party session still lands under one shared id.
  const channel = getOrCreateChannel(message.sender, message.recipient);
  let correlationId: string = generateCorrelationId();

  // Fetch recipient policies once — reused by the visibility check and
  // inbound policy evaluation.
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
    decrypted,
    stampedCorrelationId: stamped,
    senderSession: senderSessionStatus,
  } = await runOutboundPolicyChecks(
    message,
    outboundChecks,
    orgContext,
    sessionServices,
  );
  // The sender's audit event says what its session recorded, when it has one.
  const senderMetadata = senderSessionStatus
    ? { session: senderSessionStatus }
    : undefined;

  // Extract trace context from the decrypted outbound payload.  The
  // client library stamps `_spellguardCorrelationId` (originating
  // trace id) and `_spellguardHops` (depth counter) on every send
  // when its hop-context ALS is populated.  The correlation id, if
  // present, takes precedence over the fresh fallback id so that all
  // messages in a single conversation across multiple (sender, recipient)
  // pairs land in audit_logs with the same correlation_id and the
  // dashboard's "View Related Messages" can render them as one
  // multi-party session instead of a series of 2-party diagrams.
  //
  // The stamp is taken only when it is a valid correlation id (1-128 of
  // [A-Za-z0-9._:-]). The id also selects the recipient's session ledger and
  // reaches the recipient's tool checks, which refuse an invalid one, so an
  // odd stamp from any sender gets the fresh id instead.
  if (stamped) correlationId = stamped;
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

    reportOutboundEvent(
      commitment,
      outboundLevel,
      outboundChecks,
      senderMetadata,
    );
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

  // Step 3a: Apply outbound redaction if any checks resolved to 'redact'.
  // The checks ran on the policy view (attachment data stripped), so their
  // spans index the view; with attachments, redact the view and put the
  // attachments' data back. Without, the view is the decrypted content.
  let contentForForwarding = decryptedContent;
  const outboundView =
    decryptedContent === null ? null : policyMessage(decryptedContent);
  if (decryptedContent && outboundView !== null) {
    const redactedView = applyRedaction(outboundView, outboundChecks);
    if (outboundView === decryptedContent) {
      contentForForwarding = redactedView;
    } else if (redactedView !== outboundView) {
      contentForForwarding = restoreAttachments(redactedView, decryptedContent);
    }
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
  // see the correct message history. Buffered as the policies saw it, without
  // attachment data.
  if (decryptedContent && outboundView !== null) {
    addMessage(message.sender, outboundView);
  }

  // Step 3a-iii: Attachments (internal design notes).
  // Read once, before the recipient's checks: each readable document's text
  // is a second content pass for those checks, and every attachment, readable
  // or not, is recorded on the recipient's audit event and in its session.
  // A runtime with a document reader gates them first: a document over the
  // limits, or one it cannot read under a binding that blocks, never reaches
  // the recipient.
  const attachmentStep = await readMessageAttachments(
    message,
    contentForForwarding,
    recipientConfig,
    sessionServices,
  );
  if (attachmentStep.kind === 'block') {
    const commitment = generateCommitment(message);
    commitment.correlationId = correlationId;
    reportBilateralEvent(
      commitment,
      'block',
      [attachmentStep.check],
      'inbound',
      message.recipient,
      attachmentStep.reasonCode,
      attachmentStep.inboundMetadata,
    );
    reportBilateralEvent(
      commitment,
      'block',
      outboundChecks,
      'outbound',
      undefined,
      attachmentStep.reasonCode,
    );
    return {
      success: false,
      error: attachmentStep.message,
      responseLevel: 'block',
    };
  }
  const attachments = attachmentStep.readings;
  const inboundMetadata = attachmentStep.inboundMetadata;

  // Step 3b: Recipient inbound policy checks (recipient's inbound policies)
  // CR-004: Gate on null/undefined, not truthiness, so empty strings are still evaluated
  const recipientInboundChecks: PolicyCheckResult[] = [
    ...attachmentStep.checks,
  ];
  if (contentForForwarding != null) {
    const { denied: inboundDenied } = await runRecipientInboundPolicyChecks(
      message.recipient,
      policyMessage(contentForForwarding),
      recipientInboundChecks,
      recipientConfig ?? undefined,
      orgContext,
      contentPassDocuments(attachments),
    );
    if (inboundDenied) {
      console.log(
        `[Router] Recipient inbound policy denied message ${message.id}: ${inboundDenied}`,
      );
      // Not delivered, so no session keeps the documents' page images.
      await discardPageImages(attachments);

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
        undefined,
        Object.keys(inboundMetadata).length > 0 ? inboundMetadata : undefined,
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

  // Step 3c: Record what the recipient is about to be given in its session
  // ledger, before forwarding, because the recipient's tool calls happen
  // while it handles this message. Only a delivered message is recorded: a
  // blocked one never reached the agent. A recipient with no session policy
  // has no session and this is skipped.
  const recipientSession = await openAgentSession(
    sessionServices,
    message.recipient,
    correlationId,
    recipientConfig,
  );
  if (recipientSession) {
    const sender = {
      agentId: message.sender,
      ...(senderPolicies?.organizationId
        ? { orgId: senderPolicies.organizationId }
        : {}),
    };
    const ledger = ledgerMessage(contentForForwarding);
    const recorded = await appendParts(recipientSession, [
      {
        leg: 'message:inbound',
        kind: ledger.kind,
        from: sender,
        text: ledger.text,
      },
      ...attachments.flatMap((document) => [
        {
          leg: 'document' as const,
          kind: 'document' as const,
          label: document.name,
          from: sender,
          text: document.text ?? '',
          ...(document.truncated ? { truncated: true } : {}),
        },
        // The invisible text layer of its scanned pages, apart from what a
        // person sees, so a policy can tell a value stated only there.
        ...(document.hidden?.text
          ? [
              {
                leg: 'document' as const,
                kind: 'hidden-layer' as const,
                label: hiddenLayerLabel(document.name),
                from: sender,
                text: document.hidden.text,
              },
            ]
          : []),
      ]),
    ]);
    inboundMetadata.session = recorded.status;
    const pageImages = await keepPageImages(
      recipientSession.key,
      attachments,
      recorded.stored,
    );
    if (pageImages.length > 0) inboundMetadata.pageImages = pageImages;
  } else {
    // No session to keep the page images in (no correlation id, no session
    // policy, or no store): the reader forgets them now.
    await discardPageImages(attachments);
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

  // The sender's outbound event is reported once: a failure after it (the
  // response's re-encryption, say) must not report it again, or its checks'
  // Clef usage would be recorded twice (#1606), as a second audit row.
  let senderReported = false;
  let senderObligationsDispatched = false;
  // Likewise the recipient's events: its inbound checks (and its OCR read)
  // ran before delivery, and its reply checks (a conduct check's Clef call)
  // may have run before a later failure. Each is reported exactly once,
  // whatever happens after it, so every paid check reaches the audit stream
  // provider cost tracking records from.
  let recipientInboundReported = false;
  let recipientObligationsDispatched = false;
  let recipientOutboundChecks: PolicyCheckResult[] = [];
  let replyChecked = false;
  let recipientOutboundReported = false;
  let replyCommitment: AuditCommitment = commitment;
  let replyMetadata: Record<string, unknown> | undefined;
  try {
    // Pass redacted content to forwardToRecipient if outbound was redacted
    const outboundWasRedacted =
      contentForForwarding !== null &&
      contentForForwarding !== decryptedContent;
    const forward = (to: RegisteredAgent) =>
      forwardToRecipient(
        to.endpoint,
        message,
        to.channelToken,
        outboundWasRedacted ? contentForForwarding : undefined,
        currentHops + 1,
        correlationId,
        to.slimName,
        to.clientPublicKey,
        // Step 3 already decrypted the payload; delivery reuses it rather than
        // decrypting a large message a second time.
        decrypted && decryptedContent !== null ? decryptedContent : undefined,
      );
    let rawResponse: unknown;
    try {
      rawResponse = await forward(recipientAgent);
    } catch (error) {
      // #1528: a recipient with no key on record refuses the plaintext it is
      // sent, registering its key as it does; deliver once more, to that key.
      const registered = recipientAfterKeyRefusal(error, recipientAgent);
      if (!registered) throw error;
      console.log(
        `[Router] ${message.recipient} refused the delivery (${(error as RecipientDeliveryError).reason}) and registered its key; delivering once more, encrypted`,
      );
      rawResponse = await forward(registered);
    }
    // Return leg: if the recipient encrypted its reply to the Verifier, decrypt
    // it so the response policies + audit below operate on plaintext.
    const response = decryptRecipientReply(rawResponse);

    // Step 8a: Run recipient outbound policy checks on the response
    // (recipient's outbound policies, applied to what the recipient is
    // sending back to the original sender). Symmetric with the sender's
    // outbound check on the request. A redact-level match is stripped in
    // place (below) and the reply still flows; a deny-family verdict
    // (block / quarantine / rate_limit) HERE — or on the sender-inbound
    // check below — WITHHOLDS the whole response from the requester via
    // evaluateResponseDisposition at the return leg. Non-deny responses keep
    // the bilateral conversation flowing (optionally redacted), while the
    // recipient's outbound bindings (e.g. PII / secrets / exfiltration) still
    // gate its own reply.
    let responseAfterRecipientOutbound: unknown = response;
    if (recipientConfig) {
      const recipientRecentMessages = getRecentMessages(message.recipient);
      const responseContent =
        typeof response === 'string' ? response : JSON.stringify(response);
      const replyBindings = filterByScope(recipientConfig.outbound, 'messages');
      // The reply is the recipient's own output: agent-conduct judges it
      // against the recipient's session (internal design notes).
      const replyAsOutput = judgesOutputs(replyBindings)
        ? replyOutput(message.sender, response)
        : undefined;
      recipientOutboundChecks = await evaluatePolicies(
        replyBindings,
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
          ...(replyAsOutput
            ? {
                output: replyAsOutput,
                correlationId,
                decisionModel: sessionServices.decisionModel,
                ...(recipientSession ? { session: recipientSession } : {}),
              }
            : {}),
        },
      );
      replyChecked = true;

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

    // The recipient's reply is its own output: recorded in its session after
    // its outbound verdict, marked denied when its policies withhold it.
    if (recipientSession) {
      const replyDenied = recipientOutboundChecks.some(
        (c) => c.decision === 'deny',
      );
      replyMetadata = {
        session: await recordParts(recipientSession, [
          {
            leg: 'message:outbound',
            kind: typeof response === 'string' ? 'text' : 'json',
            ...(replyDenied ? { label: deniedLabel(undefined) } : {}),
            from: {
              agentId: message.recipient,
              ...(recipientConfig?.organizationId
                ? { orgId: recipientConfig.organizationId }
                : {}),
            },
            text:
              typeof response === 'string'
                ? response
                : (JSON.stringify(response) ?? ''),
          },
        ]),
      };
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
        // The response is a distinct event that occurs strictly AFTER the
        // request; it must NOT inherit message.timestamp (the request time)
        // via the spread. A shared timestamp makes the request and response
        // audit rows tie, which renders them response-before-request in the
        // session table and seeds the responder (not the initiator) as the
        // leftmost lane of the sequence diagram.
        timestamp: nextResponseTimestamp(message.timestamp),
        sender: message.recipient,
        recipient: message.sender,
        // #1414: the commitment hashes this field, so it must be the response.
        // The spread would carry the request's payload over, and the response
        // rows would then commit to the request a second time. The response is
        // archived only inside the encrypted envelope below.
        encryptedPayload: responseContent,
      };
      responseCommitment = generateCommitment(responseMsg);
      responseCommitment.correlationId = correlationId;
      replyCommitment = responseCommitment;

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
    reportOutboundEvent(
      commitment,
      deriveResponseLevel(outboundChecks),
      outboundChecks,
      senderMetadata,
    );
    senderReported = true;
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
      undefined,
      Object.keys(inboundMetadata).length > 0 ? inboundMetadata : undefined,
    );
    recipientInboundReported = true;
    reportBilateralEvent(
      responseCommitment,
      deriveResponseLevel(recipientOutboundChecks),
      recipientOutboundChecks,
      'outbound',
      message.recipient,
      undefined,
      replyMetadata,
    );
    recipientOutboundReported = true;

    // Dispatch obligations from all directions
    dispatchObligations(outboundChecks, 'outbound', commitment);
    senderObligationsDispatched = true;
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
    recipientObligationsDispatched = true;
    if (recipientOutboundChecks.length > 0) {
      dispatchObligations(
        recipientOutboundChecks,
        'outbound',
        responseCommitment,
        message.recipient,
      );
    }

    // Return leg (block): a response that tripped a deny-family policy on
    // either the recipient's outbound bindings or the requester's inbound
    // bindings is WITHHELD from the requester — symmetric with the request-leg
    // block. All audit / archive / obligation / quarantine bookkeeping above
    // already recorded the disposition; here we simply refuse to hand the
    // content back. (redact/flag never reach here as a block — redaction was
    // applied in place above and the redacted reply still flows.)
    const responseDisposition = evaluateResponseDisposition(
      recipientOutboundChecks,
      inboundChecks,
    );
    if (responseDisposition.blocked) {
      console.log(
        `[Router] Response for message ${message.id} withheld — blocked by ${responseDisposition.blockedBy} policy: ${responseDisposition.policyName}`,
      );
      return {
        success: false,
        error: `Response blocked by ${responseDisposition.blockedBy} policy: ${responseDisposition.policyName}`,
        responseLevel: responseDisposition.responseLevel,
        warnings: warningsArray,
      };
    }

    // Return leg (deliver): re-encrypt the response TO the requester's key
    // (gateway-opaque) when it registered one; the requester's client decrypts
    // it. Legacy requesters (no key) get plaintext.
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

    // Report failed delivery to Management Server, unless the sender's
    // event already went out before the failure.
    const failedLevel = deriveResponseLevel(outboundChecks);
    if (!senderReported) {
      reportOutboundEvent(
        commitment,
        failedLevel,
        outboundChecks,
        senderMetadata,
      );
    }
    if (!senderObligationsDispatched) {
      dispatchObligations(outboundChecks, 'outbound', commitment);
    }
    // The recipient's inbound checks ran (and any document was read for it)
    // before delivery failed: report them, with the reading's usage.
    if (!recipientInboundReported) {
      reportBilateralEvent(
        commitment,
        deriveResponseLevel(recipientInboundChecks),
        recipientInboundChecks,
        'inbound',
        message.recipient,
        undefined,
        Object.keys(inboundMetadata).length > 0 ? inboundMetadata : undefined,
      );
    }
    if (!recipientObligationsDispatched) {
      dispatchObligations(
        recipientInboundChecks,
        'inbound',
        commitment,
        message.recipient,
      );
    }
    // Its reply checks ran before the failure: report them too.
    if (replyChecked && !recipientOutboundReported) {
      reportBilateralEvent(
        replyCommitment,
        deriveResponseLevel(recipientOutboundChecks),
        recipientOutboundChecks,
        'outbound',
        message.recipient,
        undefined,
        replyMetadata,
      );
    }

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
  alreadyDecrypted?: string,
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
      `[Router] Forwarding redacted message from ${message.sender} (${redactedContent.length} chars)`,
    );
  } else {
    try {
      const decryptedJson =
        alreadyDecrypted ?? decryptPayload(message.encryptedPayload);
      decryptedPayload = JSON.parse(decryptedJson);
      // CR-019: Log message metadata only, not content
      console.log(
        `[Router] Decrypted message from ${message.sender} (${decryptedJson.length} chars)`,
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
    let lastStatus: number | undefined;
    let lastReason: string | undefined;
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
      lastStatus = result.status;
      lastReason = result.reason;
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
    const failure = `SLIM delivery to ${message.recipient} (${slimName}) failed: ${lastError}`;
    // The recipient answered (through the gateway): carry its status and
    // reason the way the HTTP path below does.
    if (lastStatus !== undefined) {
      throw new RecipientDeliveryError(failure, lastStatus, lastReason);
    }
    throw new Error(failure);
  }

  // #1244: sign exactly the bytes the recipient receives.
  const deliveryBody = JSON.stringify(
    buildAgentDeliveryBody(decryptedPayload, message, recipientPublicKey),
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Spellguard-Channel-Token': channelToken,
      ...(await signedDeliveryHeaders(
        message.recipient,
        channelToken,
        deliveryBody,
      )),
    },
    body: deliveryBody,
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
    let reason: string | undefined;
    try {
      const bodyText = await response.text();
      if (bodyText) {
        // #1528: keep the recipient's machine reason (`plaintext_refused`):
        // the sender's error names it, and the caller retries on a key refusal.
        reason = refusalReason(bodyText);
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
    throw new RecipientDeliveryError(
      `Recipient returned ${response.status}: ${detail}${reason ? ` (${reason})` : ''}`,
      response.status,
      reason,
    );
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

/**
 * Generate a fresh, unique correlation ID for a bilateral exchange that has no
 * client-stamped `_spellguardCorrelationId`. Mirrors the unilateral router's
 * id minting. Used instead of the per-(sender, recipient) channel.id so
 * unrelated sessions between the same two agents never collapse into one
 * dashboard "session" (channel.id is stable + time-independent, so it would).
 *
 * The id also selects the recipient's session ledger, so it must not be
 * guessable: anyone who predicts a recipient's id can stamp it on a message
 * and put text into that ledger. It comes from crypto.randomUUID(), not
 * Math.random(), which is a predictable generator.
 */
export function generateCorrelationId(): string {
  return `sess_${crypto.randomUUID()}`;
}

/**
 * Timestamp (epoch ms) for the response (inbound) leg of a bilateral exchange.
 *
 * The response happens strictly after the request, so it must never inherit
 * the request's timestamp. We stamp `now`, clamped to at least
 * `requestTimestamp + 1` so that even if a sender's clock runs ahead of the
 * Verifier, the response can never sort before its own request.
 */
export function nextResponseTimestamp(
  requestTimestamp: number,
  now: number = Date.now(),
): number {
  return Math.max(requestTimestamp + 1, now);
}
