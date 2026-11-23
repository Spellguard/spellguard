// SPDX-License-Identifier: Apache-2.0

/**
 * Management Server Reporter
 *
 * Buffers audit log entries from message processing and periodically
 * sends them in batches to the Management Server's /v1/internal/logs endpoint.
 * This keeps agent statistics (messages sent/received, blocked, flagged) up to date.
 */

import type { AuditCommitment } from '@spellguard/amp';
import { getActiveProfile } from '../profile/registry';
import type { PolicyCheckResult } from '../proxy/policy-evaluator';
import { loadAuditSigningKey, signAuditEntry } from './audit-signing';
import { getAgentAuditBinding, refreshAgentAuditBinding } from './policy-cache';
import { signRequest } from './request-signer';

/**
 * Wraps `getActiveProfile()` so callers in the audit hot path can call
 * it without worrying about init-order: if the profile registry hasn't
 * been seeded yet (startup race or test harness), we just return null
 * and let the caller skip the metadata stamp. The dashboard's
 * per-Verifier badge still works as a fallback.
 */
function getActiveProfileOrNull(): ReturnType<typeof getActiveProfile> | null {
  try {
    return getActiveProfile();
  } catch {
    return null;
  }
}

interface AuditLogEntry {
  id: string;
  agentId: string;
  agentBindingToken?: string;
  direction: 'inbound' | 'outbound';
  messageHash: string;
  senderId: string;
  senderBindingToken?: string;
  recipientId: string;
  recipientBindingToken?: string;
  timestamp: string;
  attestationLevel: string;
  correlationId?: string;
  policyChecks: PolicyCheckResult[];
  responseLevel: string;
  verifierId: string;
  /**
   * `ed25519:<key id>:<signature hex>` once signed at flush time; until then,
   * and when no audit signing key is configured, the old placeholder.
   */
  verifierSignature: string;
  /** The exact text signed (packages/audit-verify/SPEC.md, "Signed records"). */
  signedRecord?: string;
  commitmentTxId?: string;
  eventType?: string;
  needsReview?: boolean;
  archiveRef?: string;
  /**
   * Structured event metadata.  Tool-check entries carry
   * `{ toolName: string }` so the dashboard viz can synthesize
   * tool nodes without re-fetching the original message.  Other
   * event types may add their own keys here.
   */
  metadata?: Record<string, unknown>;
}

let managementUrl: string | null = null;
let verifierId: string | null = null;

// `buffer` accumulates entries waiting to be flushed upstream to management.
// `auditRing` is a separate ring of the most recent entries used by the
// dev-mode-only `/logs/audit-events` endpoint. They diverge because flushBuffer()
// splices `buffer` empty on each upload — observability needs to survive
// that, so we keep a second copy.
const buffer: AuditLogEntry[] = [];
const auditRing: AuditLogEntry[] = [];
const refreshRequiredEntryIds = new Set<string>();
const malformedInvalidAttempts = new Map<string, number>();
const invalidQuarantine: AuditLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight: Promise<void> | null = null;
let activeBatchSize = 0;
let isolationBatchSize: number | null = null;
let overflowDroppedCount = 0;

const FLUSH_INTERVAL_MS = 500; // 500ms for sub-second visualization latency
const MAX_BUFFER_SIZE = 100;
const MAX_REPORTER_QUEUE_SIZE = 1_000;
const MAX_INVALID_QUARANTINE_SIZE = 100;
const MAX_MALFORMED_INVALID_RETRIES = 3;
const AUDIT_RING_SIZE = 200;

/**
 * Initialize the management reporter.
 * Call this at Verifier startup if MANAGEMENT_URL is configured.
 */
export function initManagementReporter(): boolean {
  managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '') || null;
  verifierId =
    process.env.VERIFIER_ID || `verifier-${crypto.randomUUID().slice(0, 8)}`;

  if (!managementUrl) {
    console.log(
      '[ManagementReporter] MANAGEMENT_URL not set, reporting disabled',
    );
    return false;
  }

  console.log(
    `[ManagementReporter] Reporting to ${managementUrl} as Verifier ${verifierId}`,
  );

  // Start periodic flush
  flushTimer = setInterval(() => {
    flushBuffer().catch((err) =>
      console.error('[ManagementReporter] Flush failed:', err),
    );
  }, FLUSH_INTERVAL_MS);

  return true;
}

/**
 * Stop the management reporter and flush remaining entries.
 */
export async function stopManagementReporter(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
}

/**
 * Report an audit event from a bilateral message (both agents registered).
 */
export function reportBilateralEvent(
  commitment: AuditCommitment,
  responseLevel = 'allow',
  policyChecks?: PolicyCheckResult[],
  direction: 'outbound' | 'inbound' = 'outbound',
  agentId?: string,
  eventType?: string,
  metadata?: Record<string, unknown>,
): void {
  // The commitment always has the original message's sender/recipient.
  // For "inbound" entries (the response leg), swap them so the audit log
  // reflects who actually sent vs received in that direction.
  const reportAgent = agentId ?? commitment.sender;
  const isResponse =
    direction === 'inbound' && reportAgent === commitment.sender;
  const senderId = isResponse ? commitment.recipient : commitment.sender;
  const recipientId = isResponse ? commitment.sender : commitment.recipient;
  const localBinding = getAgentAuditBinding(reportAgent);
  const senderBinding = getAgentAuditBinding(senderId);
  const recipientBinding = getAgentAuditBinding(recipientId);

  const entry: AuditLogEntry = {
    id: crypto.randomUUID(),
    agentId: reportAgent,
    agentBindingToken: localBinding?.agentBindingToken,
    direction,
    messageHash: commitment.hash,
    senderId,
    senderBindingToken: senderBinding?.agentBindingToken,
    recipientId,
    recipientBindingToken: recipientBinding?.agentBindingToken,
    timestamp: new Date(commitment.timestamp).toISOString(),
    attestationLevel: commitment.attestationLevel || 'bilateral',
    correlationId: commitment.correlationId,
    policyChecks: policyChecks || [],
    responseLevel,
    verifierId: verifierId || '',
    verifierSignature: `sig_${commitment.hash.slice(0, 16)}`,
    commitmentTxId: undefined,
    eventType: eventType || 'message',
    archiveRef: commitment.messageId,
    metadata,
  };

  addToBuffer(entry);
}

/**
 * Report an audit event from a unilateral message (one-sided attestation).
 */
export function reportUnilateralEvent(
  commitment: AuditCommitment,
  direction: 'outbound' | 'inbound',
  agentId: string,
  responseLevel = 'allow',
  policyChecks?: PolicyCheckResult[],
  eventType?: string,
  metadata?: Record<string, unknown>,
): void {
  const entry: AuditLogEntry = {
    id: crypto.randomUUID(),
    agentId,
    direction,
    messageHash: commitment.hash,
    senderId: commitment.sender,
    recipientId: commitment.recipient,
    timestamp: new Date(commitment.timestamp).toISOString(),
    attestationLevel: commitment.attestationLevel || 'unilateral',
    correlationId: commitment.correlationId,
    policyChecks: policyChecks || [],
    responseLevel,
    verifierId: verifierId || '',
    verifierSignature: `sig_${commitment.hash.slice(0, 16)}`,
    commitmentTxId: undefined,
    eventType: eventType || 'message',
    archiveRef: commitment.messageId,
    metadata,
  };

  addToBuffer(entry);
}

/**
 * Obligation-to-event-type mapping.
 */
const OBLIGATION_EVENT_MAP: Record<
  string,
  { eventType: string; needsReview: boolean }
> = {
  notify_owner: { eventType: 'obligation-notify', needsReview: false },
  log_for_review: { eventType: 'obligation-review', needsReview: true },
};

/**
 * Dispatch obligation audit entries from policy check results.
 *
 * Collects obligations from all checks that had detections (detections.length > 0),
 * deduplicates by (obligation, direction), and creates a separate audit log entry
 * for each unique obligation.
 */
interface ObligationDescriptor {
  type: string;
  eventType: string;
  needsReview: boolean;
}

function collectObligations(
  checks: PolicyCheckResult[],
  direction: 'inbound' | 'outbound',
): ObligationDescriptor[] {
  const seen = new Set<string>();
  const out: ObligationDescriptor[] = [];
  for (const check of checks) {
    if (check.detections.length === 0) continue;
    for (const obligation of check.obligations) {
      const key = `${obligation}:${direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mapping = OBLIGATION_EVENT_MAP[obligation];
      if (mapping) out.push({ type: obligation, ...mapping });
    }
  }
  return out;
}

export function dispatchObligations(
  checks: PolicyCheckResult[],
  direction: 'inbound' | 'outbound',
  commitment: AuditCommitment,
  agentId?: string,
): void {
  const obligations = collectObligations(checks, direction);

  for (const ob of obligations) {
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      agentId: agentId ?? commitment.sender,
      direction,
      messageHash: commitment.hash,
      senderId: commitment.sender,
      recipientId: commitment.recipient,
      timestamp: new Date(commitment.timestamp).toISOString(),
      attestationLevel: commitment.attestationLevel || 'bilateral',
      correlationId: commitment.correlationId,
      policyChecks: [],
      responseLevel: 'allow',
      verifierId: verifierId || '',
      verifierSignature: `sig_${commitment.hash.slice(0, 16)}`,
      commitmentTxId: undefined,
      eventType: ob.eventType,
      needsReview: ob.needsReview || undefined,
      archiveRef: commitment.messageId,
    };

    addToBuffer(entry);
  }
}

function addToBuffer(entry: AuditLogEntry): void {
  // Stamp the active AGNTCY layer triple on the entry so the dashboard can
  // render a per-request topology cue on each audit row — which transport
  // carried it (SLIM gateway vs direct HTTP), which directory resolved the
  // recipient (AGNTCY `dir` vs A2A well-known), and which identity layer
  // issued the credential (AGNTCY VC vs CTLS). Reads from the profile
  // registry singleton; if it hasn't been initialised yet (very-early
  // startup race) we leave the fields unset and the dashboard falls back to
  // the per-Verifier badge.
  const bundle = getActiveProfileOrNull();
  if (bundle) {
    entry.metadata = {
      ...(entry.metadata ?? {}),
      transport: bundle.transport.name,
      profile: bundle.profile,
      directory: bundle.directory.name,
      identity: bundle.identity.name,
    };
  }

  // Observability ring: always retains the most recent entries regardless
  // of whether/when the upstream flush runs.
  auditRing.push(entry);
  if (auditRing.length > AUDIT_RING_SIZE) {
    auditRing.splice(0, auditRing.length - AUDIT_RING_SIZE);
  }

  if (managementUrl) {
    if (buffer.length + activeBatchSize >= MAX_REPORTER_QUEUE_SIZE) {
      overflowDroppedCount++;
      if (overflowDroppedCount === 1) {
        console.error('[ManagementReporter] Audit queue capacity reached', {
          component: 'management_reporter',
          signal: 'audit_queue_overflow',
          capacity: MAX_REPORTER_QUEUE_SIZE,
          droppedCount: 1,
          overflowPolicy: 'drop_newest',
        });
      }
      return;
    }
    buffer.push(entry);
    if (buffer.length < MAX_BUFFER_SIZE) return;
    flushBuffer().catch((err) =>
      console.error('[ManagementReporter] Flush failed:', err),
    );
    return;
  }

  // Without Management, retain only the public ring's batch-sized OSS
  // fallback. The separately bounded auditRing remains the visible surface.
  buffer.push(entry);
  buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
}

/**
 * Snapshot of the audit ring. Read by the dev-mode-only `/logs/audit-events`. Survives
 * upstream flushes so callers can inspect what just happened regardless of
 * the management deployment topology.
 */
export function getAuditEventBuffer(): readonly AuditLogEntry[] {
  return [...auditRing];
}

/**
 * Force an immediate flush of the reporter buffer.
 * Used by integration tests via POST /internal/reporter/flush.
 */
export async function flushReporterBuffer(): Promise<number> {
  const count = buffer.length;
  await flushBuffer();
  return count;
}

async function flushBuffer(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  const pending = flushNextBatch();
  flushInFlight = pending;
  try {
    await pending;
  } finally {
    if (flushInFlight === pending) flushInFlight = null;
  }
}

async function flushNextBatch(): Promise<void> {
  const target = getReporterTarget();
  if (!target || buffer.length === 0) return;

  const batchSize = Math.min(
    isolationBatchSize ?? MAX_BUFFER_SIZE,
    MAX_BUFFER_SIZE,
  );
  isolationBatchSize = null;
  const entries = buffer.splice(0, batchSize);
  activeBatchSize = entries.length;

  try {
    if (!(await prepareEntriesForDelivery(entries))) {
      buffer.unshift(...entries);
      return;
    }
    await signEntries(entries);
    const bodyStr = JSON.stringify({
      entries,
      verifierId: target.verifierId,
      batchSignature: `batch_${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const url = `${target.managementUrl}/v1/internal/logs`;
    const headers = await signRequest('POST', url, bodyStr);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
    });

    await handleManagementResponse(response, entries);
  } catch (err) {
    console.error('[ManagementReporter] Network error:', err);
    // Put entries back in buffer for retry
    buffer.unshift(...entries);
  } finally {
    activeBatchSize = 0;
    if (buffer.length < MAX_REPORTER_QUEUE_SIZE) {
      overflowDroppedCount = 0;
    }
  }
}

/**
 * Signs each entry not yet signed, after its metadata is final and just before
 * it leaves this Verifier (audit-signing.ts). An entry keeps its signature
 * across retries. Without a key, entries go unsigned.
 */
async function signEntries(entries: AuditLogEntry[]): Promise<void> {
  const key = await loadAuditSigningKey();
  if (!key) return;
  for (const entry of entries) {
    if (entry.signedRecord) continue;
    try {
      const signed = await signAuditEntry(entry, key);
      entry.signedRecord = signed.signedRecord;
      entry.verifierSignature = signed.verifierSignature;
    } catch (err) {
      console.error(
        '[ManagementReporter] Could not sign an audit entry; reporting it unsigned:',
        err,
      );
    }
  }
}

function getReporterTarget(): {
  managementUrl: string;
  verifierId: string;
} | null {
  return managementUrl && verifierId ? { managementUrl, verifierId } : null;
}

async function prepareEntriesForDelivery(
  entries: AuditLogEntry[],
): Promise<boolean> {
  if (!entries.some((entry) => refreshRequiredEntryIds.has(entry.id))) {
    return true;
  }
  return refreshEntryBindings(entries);
}

async function handleManagementResponse(
  response: Response,
  entries: AuditLogEntry[],
): Promise<void> {
  if (response.ok) {
    const result = (await response.json()) as {
      accepted: number;
      rejected?: number;
      errors?: Array<{ index: number; reason: string }>;
    };
    console.log(
      `[ManagementReporter] Reported ${result.accepted} entries (${result.rejected || 0} rejected)`,
    );
    // A 200 that rejected entries is still a LOSS: those entries are dropped
    // below (`clearEntryRetryState` + no re-buffer) because a rejection is
    // deterministic — retrying an unstorable entry only loses it more slowly.
    // Management already returns a per-entry reason; discarding it turned
    // silent audit-trail loss into a bare count in a log nobody reads, which
    // is not acceptable in an audit product. The reasons are structural
    // (`messageHash must be a hex-encoded digest`), never payload.
    if (result.rejected && result.rejected > 0) {
      console.error(
        `[ManagementReporter] Management REJECTED ${result.rejected} of ${entries.length} audit entries; they are dropped, not retried.`,
        {
          component: 'management_reporter',
          signal: 'audit_entries_rejected',
          rejectedCount: result.rejected,
          batchSize: entries.length,
          errors: result.errors ?? [],
        },
      );
    }
    clearEntryRetryState(entries);
    return;
  }
  const batchError = await readManagementBatchError(response);
  console.error(
    `[ManagementReporter] Failed to send logs: status=${response.status} code=${batchError.code}`,
  );
  if (isExpiredBindingResponse(response.status, batchError.code)) {
    for (const entry of entries) refreshRequiredEntryIds.add(entry.id);
    buffer.unshift(...entries);
    return;
  }
  if (
    response.status === 422 &&
    batchError.code === 'VERIFIER_BINDING_INVALID'
  ) {
    handleInvalidBindingResponse(entries, batchError.invalidEntryIds);
    return;
  }
  buffer.unshift(...entries);
}

function isExpiredBindingResponse(status: number, code: string): boolean {
  return status === 409 && code === 'VERIFIER_BINDING_EXPIRED';
}

async function refreshEntryBindings(
  entries: AuditLogEntry[],
): Promise<boolean> {
  const agentIds = [
    ...new Set(
      entries.flatMap((entry) => [
        entry.agentId,
        entry.senderId,
        entry.recipientId,
      ]),
    ),
  ];
  const refreshed = await Promise.all(
    agentIds.map(async (agentId) => ({
      agentId,
      binding: await refreshAgentAuditBinding(agentId),
    })),
  );
  if (refreshed.some(({ binding }) => !binding)) return false;
  const bindings = new Map(
    refreshed.map(({ agentId, binding }) => [agentId, binding]),
  );
  for (const entry of entries) {
    entry.agentBindingToken = bindings.get(entry.agentId)?.agentBindingToken;
    entry.senderBindingToken = bindings.get(entry.senderId)?.agentBindingToken;
    entry.recipientBindingToken = bindings.get(
      entry.recipientId,
    )?.agentBindingToken;
  }
  return true;
}

interface ManagementBatchError {
  code: string;
  invalidEntryIds?: unknown;
}

async function readManagementBatchError(
  response: Response,
): Promise<ManagementBatchError> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; invalidEntryIds?: unknown };
    };
    const code = body.error?.code;
    return {
      code:
        typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
          ? code
          : 'unknown',
      invalidEntryIds: body.error?.invalidEntryIds,
    };
  } catch {
    return { code: 'unknown' };
  }
}

function handleInvalidBindingResponse(
  entries: AuditLogEntry[],
  candidateIds: unknown,
): void {
  const invalidIds = validateInvalidEntryIds(entries, candidateIds);
  if (!invalidIds) {
    isolateMalformedInvalidBatch(entries);
    return;
  }
  const remainder: AuditLogEntry[] = [];
  for (const entry of entries) {
    if (invalidIds.has(entry.id)) {
      refreshRequiredEntryIds.delete(entry.id);
      malformedInvalidAttempts.delete(entry.id);
    } else {
      remainder.push(entry);
    }
  }
  buffer.unshift(...remainder);
}

function validateInvalidEntryIds(
  entries: AuditLogEntry[],
  candidateIds: unknown,
): Set<string> | null {
  if (
    !Array.isArray(candidateIds) ||
    candidateIds.length === 0 ||
    candidateIds.length > entries.length
  ) {
    return null;
  }
  const sentIds = new Set(entries.map((entry) => entry.id));
  const invalidIds = new Set<string>();
  for (const candidate of candidateIds) {
    if (
      typeof candidate !== 'string' ||
      !sentIds.has(candidate) ||
      invalidIds.has(candidate)
    ) {
      return null;
    }
    invalidIds.add(candidate);
  }
  return invalidIds;
}

function isolateMalformedInvalidBatch(entries: AuditLogEntry[]): void {
  if (entries.length > 1) {
    isolationBatchSize = Math.max(1, Math.floor(entries.length / 2));
    buffer.unshift(...entries);
    return;
  }
  const [entry] = entries;
  if (!entry) return;
  const attempts = (malformedInvalidAttempts.get(entry.id) ?? 0) + 1;
  if (attempts < MAX_MALFORMED_INVALID_RETRIES) {
    malformedInvalidAttempts.set(entry.id, attempts);
    isolationBatchSize = 1;
    buffer.unshift(entry);
    return;
  }
  malformedInvalidAttempts.delete(entry.id);
  refreshRequiredEntryIds.delete(entry.id);
  invalidQuarantine.push(entry);
  if (invalidQuarantine.length > MAX_INVALID_QUARANTINE_SIZE) {
    invalidQuarantine.splice(
      0,
      invalidQuarantine.length - MAX_INVALID_QUARANTINE_SIZE,
    );
  }
  console.error('[ManagementReporter] Quarantined malformed invalid entry', {
    component: 'management_reporter',
    signal: 'invalid_binding_response_quarantine',
    quarantinedCount: 1,
    capacity: MAX_INVALID_QUARANTINE_SIZE,
  });
}

function clearEntryRetryState(entries: AuditLogEntry[]): void {
  for (const entry of entries) {
    refreshRequiredEntryIds.delete(entry.id);
    malformedInvalidAttempts.delete(entry.id);
  }
}
