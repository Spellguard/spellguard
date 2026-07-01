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
  direction: 'inbound' | 'outbound';
  messageHash: string;
  senderId: string;
  recipientId: string;
  timestamp: string;
  attestationLevel: string;
  correlationId?: string;
  policyChecks: PolicyCheckResult[];
  responseLevel: string;
  verifierId: string;
  verifierSignature: string;
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
// public `/logs/audit-events` endpoint. They diverge because flushBuffer()
// splices `buffer` empty on each upload — observability needs to survive
// that, so we keep a second copy.
const buffer: AuditLogEntry[] = [];
const auditRing: AuditLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

const FLUSH_INTERVAL_MS = 500; // 500ms for sub-second visualization latency
const MAX_BUFFER_SIZE = 100;
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

  const entry: AuditLogEntry = {
    id: crypto.randomUUID(),
    agentId: reportAgent,
    direction,
    messageHash: commitment.hash,
    senderId,
    recipientId,
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

  // Upstream flush queue: only relevant when management is configured.
  // When unset, we cap it at MAX_BUFFER_SIZE so it doesn't grow without
  // bound. (auditRing is the visible surface for OSS observability.)
  buffer.push(entry);
  if (buffer.length < MAX_BUFFER_SIZE) return;

  if (managementUrl) {
    flushBuffer().catch((err) =>
      console.error('[ManagementReporter] Flush failed:', err),
    );
    return;
  }
  buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
}

/**
 * Snapshot of the public audit ring. Read by `/logs/audit-events`. Survives
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
  if (!managementUrl || !verifierId || buffer.length === 0) return;

  const entries = buffer.splice(0, MAX_BUFFER_SIZE);

  try {
    const bodyStr = JSON.stringify({
      entries,
      verifierId,
      batchSignature: `batch_${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const headers = await signRequest(bodyStr);

    const response = await fetch(`${managementUrl}/v1/internal/logs`, {
      method: 'POST',
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[ManagementReporter] Failed to send logs: ${response.status} ${response.statusText}`,
      );
      console.error(
        `[ManagementReporter] Response body: ${body.slice(0, 500)}`,
      );
      console.error(
        `[ManagementReporter] First entry sample: ${JSON.stringify(entries[0]).slice(0, 500)}`,
      );
      // Put entries back in buffer for retry
      buffer.unshift(...entries);
    } else {
      const result = (await response.json()) as {
        accepted: number;
        rejected?: number;
      };
      console.log(
        `[ManagementReporter] Reported ${result.accepted} entries (${result.rejected || 0} rejected)`,
      );
    }
  } catch (err) {
    console.error('[ManagementReporter] Network error:', err);
    // Put entries back in buffer for retry
    buffer.unshift(...entries);
  }
}
