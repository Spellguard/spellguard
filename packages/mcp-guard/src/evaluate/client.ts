// SPDX-License-Identifier: Apache-2.0

import type { AuthClient } from '../auth/client';
import type {
  Detection,
  EvaluateBatchRequest,
  EvaluateBatchResponse,
  EvaluateRequest,
  EvaluateResponse,
  Redaction,
} from '../types';
import {
  VERDICT_NONCE_HEADER,
  VERDICT_SIGNATURE_HEADER,
  checkVerdictSignature,
  newVerdictNonce,
} from './verdict-signature';

const VERDICTS = new Set(['allow', 'block', 'flag']);

/** A 401 on a token younger than this is a refusal, not an expiry. */
export const FRESH_TOKEN_MS = 60_000;

/**
 * Why a check produced no Verifier verdict.
 * - `unreachable`: network error, timeout or a 5xx. Fail-open applies.
 * - `refused`: a 4xx, a configuration problem. Always blocks.
 * - `malformed`: a 2xx the guard can't read as a verdict. Always blocks.
 * - `unverified`: a 2xx no attested Verifier signed. Always blocks: it is
 *   what an impostor answering in the Verifier's place looks like.
 */
export type CheckFailureKind =
  | 'unreachable'
  | 'refused'
  | 'malformed'
  | 'unverified';

export class CheckFailure extends Error {
  constructor(
    readonly kind: CheckFailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** A block the guard decides itself, in the Verifier's verdict shape. */
export function guardBlock(policy: string, detail: string): EvaluateResponse {
  return {
    result: 'block',
    detections: [{ engine: 'mcp-guard', policy, confidence: 1, detail }],
    redactions: [],
    source: 'guard',
  };
}

function isDetections(value: unknown): value is Detection[] {
  return (
    Array.isArray(value) &&
    value.every(
      (d) =>
        d !== null &&
        typeof d === 'object' &&
        typeof (d as Detection).policy === 'string',
    )
  );
}

function isRedactions(value: unknown): value is Redaction[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as Redaction).start === 'number' &&
        typeof (r as Redaction).end === 'number',
    )
  );
}

/**
 * Read one verdict strictly. Anything that isn't a known verdict with
 * detection and redaction arrays is malformed, and a malformed verdict blocks
 * (#1501: a 200 with no `result` used to be forwarded).
 */
export function parseVerdict(
  body: unknown,
): Omit<EvaluateResponse, 'source'> | null {
  if (body === null || typeof body !== 'object') return null;
  const v = body as Record<string, unknown>;
  if (typeof v.result !== 'string' || !VERDICTS.has(v.result)) return null;
  const detections = v.detections ?? [];
  const redactions = v.redactions ?? [];
  if (!isDetections(detections) || !isRedactions(redactions)) return null;
  return {
    result: v.result as EvaluateResponse['result'],
    detections,
    redactions,
  };
}

/**
 * Read a batch verdict strictly: exactly one valid verdict per message sent,
 * matched by id.
 */
export function parseBatchVerdict(
  body: unknown,
  messageIds: string[],
): EvaluateBatchResponse['results'] | null {
  if (body === null || typeof body !== 'object') return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length !== messageIds.length) {
    return null;
  }
  const expected = new Set(messageIds);
  const seen = new Set<string>();
  const parsed: EvaluateBatchResponse['results'] = [];
  for (const entry of results) {
    const id = (entry as { messageId?: unknown } | null)?.messageId;
    if (typeof id !== 'string' || !expected.has(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
    const verdict = parseVerdict(entry);
    if (!verdict) return null;
    parsed.push({ messageId: id, ...verdict });
  }
  return parsed;
}

/** A 2xx answer's body, exactly as sent, for the signature check. */
async function readAnswer(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CheckFailure(
      'unreachable',
      `the Verifier's answer was cut off: ${message}`,
    );
  }
}

export class EvaluateClient {
  constructor(
    private authClient: AuthClient,
    private options: { failOpen: boolean; timeout: number },
  ) {}

  /** Check one payload. Never throws: a failure becomes a block (or unscanned when fail-open). */
  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    try {
      const body = await this.post('/v1/mcp/evaluate', request);
      const verdict = parseVerdict(body);
      if (!verdict) {
        throw new CheckFailure(
          'malformed',
          'the Verifier answered without a readable verdict',
        );
      }
      return { ...verdict, source: 'verifier' };
    } catch (err) {
      return this.failure(err);
    }
  }

  /** Check several messages in one request. Never throws. */
  async evaluateBatch(
    request: EvaluateBatchRequest,
  ): Promise<EvaluateBatchResponse> {
    const ids = request.messages.map((m) => m.messageId);
    let fallback: EvaluateResponse;
    try {
      const body = await this.post('/v1/mcp/evaluate', request);
      const results = parseBatchVerdict(body, ids);
      if (results) return { results, source: 'verifier' };
      fallback = this.failure(
        new CheckFailure(
          'malformed',
          'the Verifier answered without a verdict for every message',
        ),
      );
    } catch (err) {
      fallback = this.failure(err);
    }
    return {
      results: ids.map((messageId) => ({
        messageId,
        result: fallback.result,
        detections: fallback.detections,
        redactions: [],
      })),
      source: 'guard',
    };
  }

  /**
   * Which of these tool names the agent's approved-tools policy lets it call,
   * or null when the Verifier can't say (unreachable, refused, or an older
   * Verifier without the endpoint). Null means "show every tool": hiding is a
   * convenience, and every call is still checked when it is made.
   */
  async allowedTools(names: string[]): Promise<Set<string> | null> {
    if (names.length === 0) return new Set();
    try {
      const body = (await this.post('/v1/mcp/tools', {
        agentId: this.authClient.getAgentId(),
        tools: names,
      })) as { allowed?: unknown };
      if (
        !Array.isArray(body?.allowed) ||
        !body.allowed.every((n) => typeof n === 'string')
      ) {
        throw new CheckFailure('malformed', 'unreadable tool list');
      }
      return new Set(body.allowed as string[]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[mcp-guard] Could not read the approved-tools list (${message}); showing every tool. Each call is still checked.`,
      );
      return null;
    }
  }

  /**
   * POST to the Verifier with the management token. A 401 on a token old
   * enough to have expired (a laptop that slept through its refresh) means
   * reconnect once and retry. A 401 on a fresh token is not an expiry: the
   * Verifier doesn't trust this Spellguard's tokens, and reconnecting would
   * only open a new connection per call. That is a refusal.
   *
   * A 2xx is read only once its signature checks out (#1915). Other answers
   * aren't checked: a refusal blocks anyway, and an impostor can always
   * make the Verifier look unreachable by not answering.
   */
  private async post(path: string, body: unknown): Promise<unknown> {
    let { res, nonce } = await this.send(path, body);
    if (res.status === 401 && this.authClient.tokenAgeMs() >= FRESH_TOKEN_MS) {
      await res.body?.cancel();
      try {
        await this.authClient.reconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CheckFailure(
          'unreachable',
          `the management token expired and reconnecting failed: ${message}`,
        );
      }
      ({ res, nonce } = await this.send(path, body));
    }
    if (res.status >= 500) {
      const text = await res.text().catch(() => '');
      throw new CheckFailure(
        'unreachable',
        `the Verifier answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CheckFailure(
        'refused',
        `the Verifier refused the check (${res.status}${text ? `: ${text.slice(0, 200)}` : ''})`,
      );
    }
    const text = await readAnswer(res);
    await this.checkSignature(res, text, nonce);
    try {
      return JSON.parse(text);
    } catch {
      throw new CheckFailure(
        'malformed',
        'the Verifier answered with non-JSON',
      );
    }
  }

  /**
   * Throw unless an attested Verifier signed this answer. A signature no
   * known key matches may come from a key the Verifier rotated to since the
   * guard last asked, so ask Spellguard for the current keys once and check
   * again before refusing.
   */
  private async checkSignature(
    res: Response,
    text: string,
    nonce: string,
  ): Promise<void> {
    const check = () =>
      checkVerdictSignature({
        headerValue: res.headers.get(VERDICT_SIGNATURE_HEADER),
        nonce,
        body: text,
        keys: this.authClient.getVerifierKeys(),
      });
    let verdict = check();
    if (
      !verdict.ok &&
      (verdict.reason === 'bad_signature' || verdict.reason === 'no_keys')
    ) {
      await this.authClient.refreshVerifierKeys();
      verdict = check();
    }
    if (verdict.ok) return;
    const why = {
      no_keys: 'Spellguard names no attested Verifier to check it against',
      missing: 'it is not signed',
      malformed: 'its signature is unreadable',
      bad_signature: 'no attested Verifier signed it',
    }[verdict.reason];
    throw new CheckFailure(
      'unverified',
      `the Verifier's answer can't be trusted: ${why}`,
    );
  }

  private async send(
    path: string,
    body: unknown,
  ): Promise<{ res: Response; nonce: string }> {
    const nonce = newVerdictNonce();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout);
    try {
      const res = await fetch(`${this.authClient.getVerifierUrl()}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authClient.getToken()}`,
          [VERDICT_NONCE_HEADER]: nonce,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { res, nonce };
    } catch (err) {
      const message = controller.signal.aborted
        ? `no answer within ${this.options.timeout} ms`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new CheckFailure(
        'unreachable',
        `the Verifier is unreachable: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(err: unknown): EvaluateResponse {
    const failure =
      err instanceof CheckFailure
        ? err
        : new CheckFailure(
            'unreachable',
            err instanceof Error ? err.message : String(err),
          );
    if (failure.kind === 'unreachable' && this.options.failOpen) {
      console.error(
        `[mcp-guard] ${failure.message}; fail-open, so this passes unscanned.`,
      );
      return {
        result: 'unscanned',
        detections: [],
        redactions: [],
        source: 'guard',
      };
    }
    const policy = {
      unreachable: 'verifier-unreachable',
      refused: 'verifier-refused',
      malformed: 'malformed-verdict',
      unverified: 'unverified-verdict',
    }[failure.kind];
    return guardBlock(policy, `Blocked for safety: ${failure.message}.`);
  }
}
