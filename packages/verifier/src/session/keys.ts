// SPDX-License-Identifier: Apache-2.0

/**
 * Correlation ids on the wire, and the session key built from one.
 *
 * Every leg that accepts a caller-supplied correlation id (the tool check,
 * MCP evaluate, content evaluate) validates it with `readCorrelationId`, so
 * the same value is accepted or refused everywhere.
 */

export const CORRELATION_ID_MAX_LENGTH = 128;

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CORRELATION_ID_MAX_LENGTH &&
    CORRELATION_ID_PATTERN.test(value)
  );
}

export const CORRELATION_ID_ERROR = `correlationId must be 1-${CORRELATION_ID_MAX_LENGTH} characters of [A-Za-z0-9._:-]`;

/**
 * Read an OPTIONAL correlation id field. Absent (`undefined`) is fine and
 * yields no id; anything present must be a valid id, `null` included.
 */
export function readCorrelationId(
  value: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (isValidCorrelationId(value)) return { ok: true, value };
  return { ok: false, error: CORRELATION_ID_ERROR };
}

/**
 * The key of one agent's session inside one correlation.
 *
 * The agent id is percent-encoded so the FIRST `:` always separates it from
 * the correlation id (which may itself contain `:`). Without that, agent
 * `a:b` in correlation `c` and agent `a` in correlation `b:c` would share a
 * ledger. Ordinary agent ids (letters, digits, `-`, `_`, `.`) encode to
 * themselves, so the key reads as `agentId:correlationId`.
 */
export function sessionKey(agentId: string, correlationId: string): string {
  if (agentId.length === 0) throw new Error('sessionKey: empty agentId');
  if (!isValidCorrelationId(correlationId)) {
    throw new Error(`sessionKey: ${CORRELATION_ID_ERROR}`);
  }
  return `${encodeURIComponent(agentId)}:${correlationId}`;
}
