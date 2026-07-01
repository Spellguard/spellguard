// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer-side getter API. The OpenClaw plugin's tools, adapters, and any
 * downstream git/HTTP surface read credentials via this module — no one
 * else should touch the store directly. The narrow surface lets the
 * legacy-config-file fallback inject identical-shaped values without the
 * consumer caring which path populated the store.
 */

import type { ProviderCredEntry } from './credential-store';
import { readCredentialStore } from './credential-store';
import { credentialStorePath } from './credential-store-paths';

export interface ActiveProviderCredential {
  provider: string;
  kind: 'issued' | 'manual' | 'auto-created' | 'provisioned';
  credentialId: string;
  secrets: Record<string, string>;
}

export interface ActiveGithubCredential {
  scopedToken: string;
  scopedTokenId: string;
  expiresAt: string;
  repos: string[];
}

export interface AuthorIdentity {
  name: string;
  email: string;
}

export function getActiveProviderCredential(
  provider: string,
  opts: { storePath?: string } = {},
): ActiveProviderCredential | null {
  const r = readCredentialStore(opts.storePath ?? credentialStorePath());
  const entry: ProviderCredEntry | undefined = r.store?.providers?.[provider];
  if (!entry || entry.revoked) return null;
  return {
    provider,
    kind: entry.kind,
    credentialId: entry.credentialId,
    secrets: entry.secrets,
  };
}

export function getActiveGithubCredential(
  opts: { storePath?: string } = {},
): ActiveGithubCredential | null {
  const r = readCredentialStore(opts.storePath ?? credentialStorePath());
  // The Task-5 back-compat shim guarantees providers.github is populated for
  // legacy GitHub-shaped stores, so we can rely solely on the providers map.
  const entry = r.store?.providers?.github;
  if (!entry || entry.revoked) return null;
  const { scopedToken, scopedTokenId, expiresAt } = entry;
  if (!scopedToken || !scopedTokenId || !expiresAt) return null;
  return {
    scopedToken,
    scopedTokenId,
    expiresAt,
    repos: entry.scopeSummary?.repos ?? [],
  };
}

export function getAuthorIdentity(
  opts: { storePath?: string } = {},
): AuthorIdentity | null {
  const r = readCredentialStore(opts.storePath ?? credentialStorePath());
  if (!r.store || !r.store.gitAuthorName || !r.store.gitAuthorEmail) {
    return null;
  }
  return { name: r.store.gitAuthorName, email: r.store.gitAuthorEmail };
}
