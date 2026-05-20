// SPDX-License-Identifier: Apache-2.0

export type AdminEvaluateError = {
  code: string;
  message: string;
  status: number;
};
export type AdminEvaluateRequest = {
  targetAgentId: string;
  message: string;
  senderId?: string;
  direction: 'inbound' | 'outbound';
  timestamp: number;
  nonce: string;
};

// SG-05: Input validation bounds
const MAX_TARGET_AGENT_ID_LENGTH = 128;
const MAX_SENDER_ID_LENGTH = 256;
const MAX_NONCE_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 10_000;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_:-]+$/;
// SG-05: senderId allows @, ., and other chars common in identifiers like "dashboard:alice@example.com"
const SAFE_SENDER_ID_PATTERN = /^[a-zA-Z0-9_:@.\-]+$/;

export function getRequesterIp(
  headers: {
    get(name: string): string | null | undefined;
  },
  trustProxy = true,
): string {
  if (!trustProxy) return 'local';

  const xff = headers.get('x-forwarded-for');
  if (typeof xff === 'string' && xff.trim().length > 0) {
    const firstIp = xff.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const realIp = headers.get('x-real-ip');
  if (typeof realIp === 'string' && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return 'unknown';
}

export function parseAdminEvaluateRequest(
  rawBody: string,
):
  | { ok: true; value: AdminEvaluateRequest }
  | { ok: false; error: AdminEvaluateError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON body',
        status: 400,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Body must be a JSON object',
        status: 400,
      },
    };
  }

  const body = parsed as Record<string, unknown>;

  if (
    typeof body.targetAgentId !== 'string' ||
    body.targetAgentId.trim() === ''
  ) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'targetAgentId is required',
        status: 400,
      },
    };
  }

  if (body.targetAgentId.length > MAX_TARGET_AGENT_ID_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'targetAgentId exceeds maximum length',
        status: 400,
      },
    };
  }

  if (!SAFE_ID_PATTERN.test(body.targetAgentId)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'targetAgentId contains invalid characters',
        status: 400,
      },
    };
  }

  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'message is required',
        status: 400,
      },
    };
  }

  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'message exceeds maximum length',
        status: 400,
      },
    };
  }

  if (body.direction !== 'inbound' && body.direction !== 'outbound') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'direction is required and must be inbound or outbound',
        status: 400,
      },
    };
  }

  if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'timestamp must be a valid number',
        status: 400,
      },
    };
  }

  if (typeof body.nonce !== 'string' || body.nonce.trim() === '') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'nonce is required',
        status: 400,
      },
    };
  }

  if (body.nonce.length > MAX_NONCE_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'nonce exceeds maximum length',
        status: 400,
      },
    };
  }

  if (!SAFE_ID_PATTERN.test(body.nonce)) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'nonce contains invalid characters',
        status: 400,
      },
    };
  }

  if (body.senderId !== undefined && typeof body.senderId !== 'string') {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'senderId must be a string',
        status: 400,
      },
    };
  }

  if (
    typeof body.senderId === 'string' &&
    body.senderId.length > MAX_SENDER_ID_LENGTH
  ) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'senderId exceeds maximum length',
        status: 400,
      },
    };
  }

  if (
    typeof body.senderId === 'string' &&
    body.senderId.length > 0 &&
    !SAFE_SENDER_ID_PATTERN.test(body.senderId)
  ) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'senderId contains invalid characters',
        status: 400,
      },
    };
  }

  return {
    ok: true,
    value: {
      targetAgentId: body.targetAgentId,
      message: body.message,
      senderId: body.senderId,
      direction: body.direction,
      timestamp: body.timestamp,
      nonce: body.nonce,
    },
  };
}

export function checkReplayDefense(params: {
  timestamp: number;
  nonce: string;
  now: number;
  seenNonces: Map<string, number>;
  nonceTtlMs: number;
  nonceMax: number;
}): AdminEvaluateError | null {
  const { timestamp, nonce, now, seenNonces, nonceTtlMs, nonceMax } = params;
  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return {
      code: 'REPLAY_DETECTED',
      message: 'Request timestamp out of range',
      status: 403,
    };
  }

  if (seenNonces.has(nonce)) {
    return {
      code: 'REPLAY_DETECTED',
      message: 'Duplicate request nonce',
      status: 403,
    };
  }

  seenNonces.set(nonce, now);

  if (seenNonces.size > nonceMax) {
    for (const [storedNonce, ts] of seenNonces) {
      if (now - ts > nonceTtlMs) seenNonces.delete(storedNonce);
    }

    if (seenNonces.size > nonceMax) {
      const entries = [...seenNonces.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = entries.slice(0, seenNonces.size - nonceMax);
      for (const [storedNonce] of toRemove) seenNonces.delete(storedNonce);
    }
  }

  return null;
}

/** Build a sanitized summary that only exposes detection types, not patterns/messages. */
export function sanitizeEvaluationSummary(
  responseLevel: string,
  policyChecks: Array<{
    policyName: string;
    decision: string;
    responseLevel: string;
    detections: Array<{ type: string }>;
  }>,
): string {
  if (responseLevel === 'allow') return 'Allowed — no policy violations';

  const labelMap: Record<string, string> = {
    block: 'Blocked',
    quarantine: 'Quarantined',
    rate_limit: 'Rate limited',
    redact: 'Redacted',
    flag: 'Flagged',
  };

  const triggered = policyChecks.filter((c) => c.responseLevel !== 'allow');
  if (triggered.length === 0) {
    return `${labelMap[responseLevel] || responseLevel} — policy evaluation triggered`;
  }
  const parts = triggered.map((c) => {
    const label = labelMap[c.responseLevel] || c.responseLevel;
    const types = c.detections.map((d) => d.type).join(', ');
    return `${label} — ${c.policyName}${types ? `: ${types}` : ''}`;
  });
  return parts.join('; ');
}

/** Build a human-readable summary from policy check results. */
export function formatEvaluationSummary(
  responseLevel: string,
  policyChecks: Array<{
    policyName: string;
    decision: string;
    responseLevel: string;
    detections: Array<{ type: string; message?: string }>;
  }>,
): string {
  if (responseLevel === 'allow') {
    return 'Allowed — no policy violations';
  }

  const labelMap: Record<string, string> = {
    block: 'Blocked',
    quarantine: 'Quarantined',
    rate_limit: 'Rate limited',
    redact: 'Redacted',
    flag: 'Flagged',
  };

  const triggered = policyChecks.filter((c) => c.responseLevel !== 'allow');
  if (triggered.length === 0) {
    return `${labelMap[responseLevel] || responseLevel} — policy evaluation triggered`;
  }

  const parts = triggered.map((c) => {
    const label = labelMap[c.responseLevel] || c.responseLevel;
    const details = c.detections.map((d) => d.message || d.type).join(', ');
    return `${label} — ${c.policyName}${details ? `: ${details}` : ''}`;
  });

  return parts.join('; ');
}

/** SG-09: Replay defense using persistent nonce store (SQLite or DynamoDB-backed). */
export async function checkReplayDefensePersistent(params: {
  timestamp: number;
  nonce: string;
  now: number;
  nonceStore: {
    insertIfAbsent(
      nonce: string,
      timestampMs: number,
    ): boolean | Promise<boolean>;
    evictExpired(nowMs: number, ttlMs: number): number | Promise<number>;
  };
  nonceTtlMs: number;
}): Promise<AdminEvaluateError | null> {
  const { timestamp, nonce, now, nonceStore, nonceTtlMs } = params;

  if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
    return {
      code: 'REPLAY_DETECTED',
      message: 'Request timestamp out of range',
      status: 403,
    };
  }

  const inserted = await nonceStore.insertIfAbsent(nonce, now);
  if (!inserted) {
    return {
      code: 'REPLAY_DETECTED',
      message: 'Duplicate request nonce',
      status: 403,
    };
  }

  await nonceStore.evictExpired(now, nonceTtlMs);
  return null;
}
