// SPDX-License-Identifier: Apache-2.0

import { generateKeyPair, sign, verify } from '@spellguard/ctls';
import { describe, expect, it } from 'vitest';
import {
  addAdminKey,
  resetAdminKeys,
  verifyAdminSignature,
} from '../src/admin-auth';
import {
  checkReplayDefense,
  checkReplayDefensePersistent,
  formatEvaluationSummary,
  getRequesterIp,
  parseAdminEvaluateRequest,
  sanitizeEvaluationSummary,
} from '../src/admin-evaluate';

describe('admin-evaluate helpers', () => {
  // ── parseAdminEvaluateRequest ───────────────────────────────────

  it('parses a valid inbound request', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: 'dashboard:alice@example.com',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n1',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.direction).toBe('inbound');
      expect(parsed.value.targetAgentId).toBe('agent-a');
      expect(parsed.value.senderId).toBe('dashboard:alice@example.com');
    }
  });

  it('parses a valid outbound request', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-b',
      message: 'outgoing message',
      direction: 'outbound',
      timestamp: Date.now(),
      nonce: 'n2',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.direction).toBe('outbound');
      expect(parsed.value.senderId).toBeUndefined();
    }
  });

  it('rejects missing direction', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      timestamp: Date.now(),
      nonce: 'n3',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects invalid direction', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      direction: 'sideways',
      timestamp: Date.now(),
      nonce: 'n4',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
  });

  it('rejects invalid timestamp types', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      direction: 'inbound',
      timestamp: 'not-a-number',
      nonce: 'n5',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
  });

  // ── SG-05: Input bounds ─────────────────────────────────────────

  it('rejects targetAgentId exceeding 128 chars', () => {
    const raw = JSON.stringify({
      targetAgentId: 'a'.repeat(129),
      message: 'hello',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n6',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('exceeds maximum length');
    }
  });

  it('rejects targetAgentId with path traversal chars', () => {
    const raw = JSON.stringify({
      targetAgentId: '../etc/passwd',
      message: 'hello',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n7',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('invalid characters');
    }
  });

  it('rejects message exceeding 10,000 chars', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'x'.repeat(10_001),
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n8',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('exceeds maximum length');
    }
  });

  it('rejects nonce with invalid characters', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'bad nonce value',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('invalid characters');
    }
  });

  it('rejects senderId exceeding 256 chars', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: 'x'.repeat(257),
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n9',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('exceeds maximum length');
    }
  });

  // ── SG-05: senderId format validation ──────────────────────────

  it('accepts senderId with allowed special chars (dashboard:user@example.com)', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: 'dashboard:alice@example.com',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n10',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(true);
  });

  it('rejects senderId with shell metacharacters', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: 'user;rm -rf /',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n11',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('invalid characters');
    }
  });

  it('rejects senderId with angle brackets', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: '<script>alert(1)</script>',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n12',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain('invalid characters');
    }
  });

  it('accepts senderId with hyphens and underscores', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      senderId: 'agent-proxy_v2',
      direction: 'inbound',
      timestamp: Date.now(),
      nonce: 'n13',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(true);
  });

  it('accepts undefined senderId (optional field)', () => {
    const raw = JSON.stringify({
      targetAgentId: 'agent-a',
      message: 'hello',
      direction: 'outbound',
      timestamp: Date.now(),
      nonce: 'n14',
    });

    const parsed = parseAdminEvaluateRequest(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.senderId).toBeUndefined();
    }
  });

  // ── checkReplayDefense (in-memory Map) ──────────────────────────

  it('enforces timestamp window and duplicate nonce protection', () => {
    const now = Date.now();
    const seen = new Map<string, number>();

    const stale = checkReplayDefense({
      timestamp: now - 10 * 60 * 1000,
      nonce: 'stale',
      now,
      seenNonces: seen,
      nonceTtlMs: 10 * 60 * 1000,
      nonceMax: 10_000,
    });
    expect(stale?.code).toBe('REPLAY_DETECTED');

    const first = checkReplayDefense({
      timestamp: now,
      nonce: 'fresh',
      now,
      seenNonces: seen,
      nonceTtlMs: 10 * 60 * 1000,
      nonceMax: 10_000,
    });
    expect(first).toBeNull();

    const duplicate = checkReplayDefense({
      timestamp: now + 1_000,
      nonce: 'fresh',
      now: now + 1_000,
      seenNonces: seen,
      nonceTtlMs: 10 * 60 * 1000,
      nonceMax: 10_000,
    });
    expect(duplicate?.code).toBe('REPLAY_DETECTED');
  });

  // ── checkReplayDefensePersistent (NonceStore) ───────────────────

  it('rejects expired timestamps with persistent store', async () => {
    const now = Date.now();
    const mockStore = {
      insertIfAbsent: () => true,
      evictExpired: () => 0,
    };

    const err = await checkReplayDefensePersistent({
      timestamp: now - 10 * 60 * 1000,
      nonce: 'stale',
      now,
      nonceStore: mockStore,
      nonceTtlMs: 10 * 60 * 1000,
    });
    expect(err?.code).toBe('REPLAY_DETECTED');
  });

  it('rejects duplicate nonces with persistent store', async () => {
    const now = Date.now();
    const mockStore = {
      insertIfAbsent: () => false, // duplicate
      evictExpired: () => 0,
    };

    const err = await checkReplayDefensePersistent({
      timestamp: now,
      nonce: 'dup',
      now,
      nonceStore: mockStore,
      nonceTtlMs: 10 * 60 * 1000,
    });
    expect(err?.code).toBe('REPLAY_DETECTED');
  });

  it('accepts fresh nonce with persistent store', async () => {
    const now = Date.now();
    const mockStore = {
      insertIfAbsent: () => true,
      evictExpired: () => 0,
    };

    const err = await checkReplayDefensePersistent({
      timestamp: now,
      nonce: 'fresh',
      now,
      nonceStore: mockStore,
      nonceTtlMs: 10 * 60 * 1000,
    });
    expect(err).toBeNull();
  });

  // ── sanitizeEvaluationSummary ───────────────────────────────────

  it('returns allowed text for allow response level', () => {
    expect(sanitizeEvaluationSummary('allow', [])).toBe(
      'Allowed — no policy violations',
    );
  });

  it('returns sanitized summary with only detection types', () => {
    const text = sanitizeEvaluationSummary('block', [
      {
        policyName: 'pii-detector',
        decision: 'deny',
        responseLevel: 'block',
        detections: [{ type: 'ssn-pattern' }],
      },
    ]);
    expect(text).toContain('Blocked');
    expect(text).toContain('pii-detector');
    expect(text).toContain('ssn-pattern');
  });

  // ── formatEvaluationSummary (internal, unsanitized) ─────────────

  it('includes detection messages in internal format', () => {
    const text = formatEvaluationSummary('block', [
      {
        policyName: 'pii-detector',
        decision: 'deny',
        responseLevel: 'block',
        detections: [
          { type: 'ssn-pattern', message: 'SSN found: ***-**-6789' },
        ],
      },
    ]);
    expect(text).toContain('SSN found');
  });

  // ── getRequesterIp ──────────────────────────────────────────────

  it('extracts requester IP from x-forwarded-for', () => {
    const headers = new Map<string, string>([['x-forwarded-for', '1.2.3.4']]);
    const ip = getRequesterIp({
      get: (name) => headers.get(name),
    });
    expect(ip).toBe('1.2.3.4');
  });

  it('extracts first requester IP when x-forwarded-for has multiple entries', () => {
    const headers = new Map<string, string>([
      ['x-forwarded-for', '1.2.3.4, 5.6.7.8'],
    ]);
    const ip = getRequesterIp({
      get: (name) => headers.get(name),
    });
    expect(ip).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip', () => {
    const headers = new Map<string, string>([['x-real-ip', '5.6.7.8']]);
    const ip = getRequesterIp({
      get: (name) => headers.get(name),
    });
    expect(ip).toBe('5.6.7.8');
  });

  it('returns local when trustProxy is disabled', () => {
    const headers = new Map<string, string>([['x-forwarded-for', '1.2.3.4']]);
    const ip = getRequesterIp(
      {
        get: (name) => headers.get(name),
      },
      false,
    );
    expect(ip).toBe('local');
  });

  it('returns unknown when no headers present', () => {
    const ip = getRequesterIp({
      get: () => undefined,
    });
    expect(ip).toBe('unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SG-10: Key Rotation Tests
// ═══════════════════════════════════════════════════════════════════

describe('admin-auth key rotation (SG-10)', () => {
  it('accepts signature from primary key', async () => {
    resetAdminKeys();
    const { privateKey, publicKey } = await generateKeyPair();
    addAdminKey(publicKey);

    const body = 'test-body-primary';
    const sig = await sign(body, privateKey);
    const err = await verifyAdminSignature(sig, undefined, body);
    expect(err).toBeNull();
  });

  it('rejects signature from unknown key', async () => {
    resetAdminKeys();
    const { publicKey } = await generateKeyPair();
    addAdminKey(publicKey);

    // Sign with a completely different key
    const other = await generateKeyPair();
    const body = 'test-body-unknown';
    const sig = await sign(body, other.privateKey);
    const err = await verifyAdminSignature(sig, undefined, body);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('UNAUTHORIZED');
  });

  it('accepts signature from previous (non-expired) rotation key', async () => {
    resetAdminKeys();
    const primary = await generateKeyPair();
    const previous = await generateKeyPair();

    addAdminKey(primary.publicKey);
    // Previous key expires 1 hour from now — should be accepted
    addAdminKey(previous.publicKey, Date.now() + 3_600_000);

    const body = 'test-body-rotation-overlap';
    const sig = await sign(body, previous.privateKey);
    const err = await verifyAdminSignature(sig, undefined, body);
    expect(err).toBeNull();
  });

  it('rejects signature from expired rotation key', async () => {
    resetAdminKeys();
    const primary = await generateKeyPair();
    const previous = await generateKeyPair();

    addAdminKey(primary.publicKey);
    // Previous key expired 1 second ago — should be rejected
    addAdminKey(previous.publicKey, Date.now() - 1_000);

    const body = 'test-body-expired-key';
    const sig = await sign(body, previous.privateKey);
    const err = await verifyAdminSignature(sig, undefined, body);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('UNAUTHORIZED');
  });

  it('accepts signature with matching key ID', async () => {
    resetAdminKeys();
    const { privateKey, publicKey } = await generateKeyPair();
    const keyId = addAdminKey(publicKey);

    const body = 'test-body-keyid';
    const sig = await sign(body, privateKey);
    const err = await verifyAdminSignature(sig, keyId, body);
    expect(err).toBeNull();
  });

  it('rejects signature with wrong key ID', async () => {
    resetAdminKeys();
    const { publicKey } = await generateKeyPair();
    addAdminKey(publicKey);

    const other = await generateKeyPair();
    const body = 'test-body-wrong-keyid';
    const sig = await sign(body, other.privateKey);
    const err = await verifyAdminSignature(sig, 'nonexistent000000', body);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('UNAUTHORIZED');
  });

  it('returns EVALUATION_FAILED when no keys are configured', async () => {
    resetAdminKeys();
    const body = 'test-body-no-keys';
    const sig = 'a'.repeat(128);
    const err = await verifyAdminSignature(sig, undefined, body);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('EVALUATION_FAILED');
    expect(err?.status).toBe(422);
  });

  it('returns UNAUTHORIZED when signature is missing', async () => {
    resetAdminKeys();
    const { publicKey } = await generateKeyPair();
    addAdminKey(publicKey);

    const err = await verifyAdminSignature(undefined, undefined, 'body');
    expect(err).not.toBeNull();
    expect(err?.code).toBe('UNAUTHORIZED');
    expect(err?.status).toBe(401);
  });
});
