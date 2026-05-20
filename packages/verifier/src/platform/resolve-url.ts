// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the Verifier's externally-reachable URL based on platform.
 *
 * Priority:
 *   1. VERIFIER_EXTERNAL_URL env var (explicit override)
 *   2. VERIFIER_PLATFORM auto-detection (e.g. "phala")
 *   3. Fallback: http://{host}:{port}
 */

const PHALA_DEFAULT_DOMAIN = 'dstack-pha-prod5.phala.network';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * When VERIFIER_PLATFORM=phala, use DstackClient.info() to discover the CVM's
 * app_id and construct the external URL. The dstack socket may not be ready
 * immediately after boot, so we retry up to MAX_RETRIES times.
 */
async function resolvePhalaUrl(port: number): Promise<string> {
  const domain = process.env.PHALA_GATEWAY_DOMAIN || PHALA_DEFAULT_DOMAIN;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { DstackClient } = await import('@phala/dstack-sdk');
      const client = new DstackClient();
      const info = await client.info();
      const appId = info.app_id;

      if (!appId) {
        throw new Error('DstackClient.info() returned no app_id');
      }

      const url = `https://${appId}-${port}.${domain}`;
      console.log(`[Verifier] Resolved Phala external URL: ${url}`);
      return url;
    } catch (err) {
      console.warn(
        `[Verifier] Phala URL resolution attempt ${attempt}/${MAX_RETRIES} failed: ${err}`,
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `Failed to resolve Phala external URL after ${MAX_RETRIES} attempts. Ensure /var/run/dstack.sock is mounted and dstack is running.`,
  );
}

/**
 * Resolve the Verifier's external URL.
 *
 * @param host - Bind host (e.g. "0.0.0.0")
 * @param port - Bind port (e.g. 3000)
 * @returns The externally-reachable URL for this Verifier instance
 */
export async function resolveExternalUrl(
  host: string,
  port: number,
): Promise<string> {
  // 1. Explicit override always wins
  const explicit = process.env.VERIFIER_EXTERNAL_URL;
  if (explicit) {
    console.log(`[Verifier] Using explicit VERIFIER_EXTERNAL_URL: ${explicit}`);
    return explicit;
  }

  // 2. Platform auto-detection
  const platform = process.env.VERIFIER_PLATFORM?.toLowerCase();
  if (platform === 'phala') {
    return resolvePhalaUrl(port);
  }

  if (platform === 'nitro') {
    // Nitro Enclaves require VERIFIER_EXTERNAL_URL (the ALB hostname).
    // If we reach here, the explicit check above didn't fire, meaning
    // VERIFIER_EXTERNAL_URL is not set — which is a deployment error.
    throw new Error(
      'VERIFIER_PLATFORM=nitro requires VERIFIER_EXTERNAL_URL to be set to the ALB hostname ' +
        '(e.g. https://verifier.example.com). Typically injected via EC2 user-data.',
    );
  }

  if (platform === 'internal') {
    // Internal-mode verifiers require VERIFIER_EXTERNAL_URL since there is
    // no platform-specific auto-discovery mechanism.
    throw new Error(
      'VERIFIER_PLATFORM=internal requires VERIFIER_EXTERNAL_URL to be set ' +
        '(e.g. https://verifier.internal.example.com).',
    );
  }

  // 3. Fallback
  const fallback = `http://${host}:${port}`;
  console.log(`[Verifier] Using fallback URL: ${fallback}`);
  return fallback;
}
