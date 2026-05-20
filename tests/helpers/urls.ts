// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized service URLs for tests.
 *
 * Every URL reads from `process.env` first so that the same test suite can be
 * pointed at a remote deployment:
 *
 *   VERIFIER_URL=https://verifier.example.com pnpm run test
 */

export const VERIFIER_URL = process.env.VERIFIER_URL || 'http://localhost:3000';
export const MANAGEMENT_URL =
  process.env.MANAGEMENT_URL || 'http://localhost:3001/v1';
export const MANAGEMENT_ROOT =
  process.env.MANAGEMENT_ROOT || 'http://localhost:3001';
export const AGENT_A_URL = process.env.AGENT_A_URL || 'http://localhost:8787';
export const AGENT_B_URL = process.env.AGENT_B_URL || 'http://localhost:8788';
export const AGENT_C_URL = process.env.AGENT_C_URL || 'http://localhost:8789';

/**
 * Force the Verifier management reporter to flush its buffer immediately,
 * then wait briefly for the management server to persist the entries.
 * Falls back to a fixed 8s wait if the flush endpoint isn't available.
 */
export async function flushVerifierReporter(
  verifierUrl: string,
): Promise<void> {
  try {
    const res = await fetch(`${verifierUrl}/internal/reporter/flush`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      // Brief pause for management to persist the flushed entries
      await new Promise((r) => setTimeout(r, 2_000));
      return;
    }
  } catch {
    // endpoint not available — fall through
  }
  // Fallback: wait for the periodic 5s flush + buffer
  await new Promise((r) => setTimeout(r, 8_000));
}

/**
 * Returns `true` when the service at `url` responds with HTTP 2xx on `path`.
 */
export async function checkServerRunning(
  url: string,
  path = '/health',
): Promise<boolean> {
  try {
    const response = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
