// SPDX-License-Identifier: Apache-2.0

const DEFAULT_LOCAL_TOXICITY_SEMANTIC_ENDPOINT =
  'http://127.0.0.1:3110/evaluate';
const DEFAULT_LOCAL_TOXICITY_SEMANTIC_HEALTH = 'http://127.0.0.1:3110/health';
const LOCAL_DISCOVERY_TIMEOUT_MS = 250;
const LOCAL_DISCOVERY_SUCCESS_TTL_MS = 30_000;
const LOCAL_DISCOVERY_FAILURE_TTL_MS = 1_000;

export const DEFAULT_TOXICITY_SEMANTIC_TIMEOUT_MS = 3000;
export const TOXICITY_SEMANTIC_ENDPOINT_ENV =
  'SPELLGUARD_TOXICITY_SEMANTIC_ENDPOINT';
export const TOXICITY_SEMANTIC_TIMEOUT_ENV =
  'SPELLGUARD_TOXICITY_SEMANTIC_TIMEOUT';

type DiscoveryCache = {
  available: boolean;
  checkedAt: number;
};

let localDiscoveryCache: DiscoveryCache | null = null;

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function localAutodiscoveryEnabled(): boolean {
  return (
    process.env.VERIFIER_MOCK_MODE === 'true' ||
    process.env.NODE_ENV !== 'production'
  );
}

function discoveryCacheFresh(cache: DiscoveryCache): boolean {
  const ttl = cache.available
    ? LOCAL_DISCOVERY_SUCCESS_TTL_MS
    : LOCAL_DISCOVERY_FAILURE_TTL_MS;
  return Date.now() - cache.checkedAt < ttl;
}

async function probeDefaultLocalEndpoint(): Promise<boolean> {
  if (localDiscoveryCache && discoveryCacheFresh(localDiscoveryCache)) {
    return localDiscoveryCache.available;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      LOCAL_DISCOVERY_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(DEFAULT_LOCAL_TOXICITY_SEMANTIC_HEALTH, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const available = response.ok;
    localDiscoveryCache = { available, checkedAt: Date.now() };
    return available;
  } catch {
    localDiscoveryCache = { available: false, checkedAt: Date.now() };
    return false;
  }
}

export function getConfiguredToxicitySemanticEndpoint(): string | null {
  return normalizeEndpoint(process.env[TOXICITY_SEMANTIC_ENDPOINT_ENV]);
}

export async function resolveToxicitySemanticEndpoint(
  explicitEndpoint?: unknown,
): Promise<string | null> {
  const configuredEndpoint =
    normalizeEndpoint(explicitEndpoint) ??
    getConfiguredToxicitySemanticEndpoint();
  if (configuredEndpoint) {
    return configuredEndpoint;
  }

  if (!localAutodiscoveryEnabled()) {
    return null;
  }

  return (await probeDefaultLocalEndpoint())
    ? DEFAULT_LOCAL_TOXICITY_SEMANTIC_ENDPOINT
    : null;
}

export function resolveToxicitySemanticHealthUrl(
  endpoint: string,
): string | null {
  try {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/evaluate\/?$/, '/health');
    if (!url.pathname.endsWith('/health')) {
      url.pathname = '/health';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function noteToxicitySemanticEndpointHealthy(endpoint: string): void {
  if (endpoint === DEFAULT_LOCAL_TOXICITY_SEMANTIC_ENDPOINT) {
    localDiscoveryCache = { available: true, checkedAt: Date.now() };
  }
}

export function noteToxicitySemanticEndpointUnhealthy(endpoint: string): void {
  if (endpoint === DEFAULT_LOCAL_TOXICITY_SEMANTIC_ENDPOINT) {
    localDiscoveryCache = { available: false, checkedAt: Date.now() };
  }
}

export function resetToxicitySemanticEndpointDiscoveryCache(): void {
  localDiscoveryCache = null;
}
