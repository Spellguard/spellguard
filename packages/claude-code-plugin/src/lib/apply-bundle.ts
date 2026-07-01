// SPDX-License-Identifier: Apache-2.0

/**
 * OFFLINE credential-apply mode for the Spellguard CLI's "sub-5s setup".
 *
 * The Spellguard CLI now receives the agent identity + GitHub credential(s)
 * directly in an HTTP response and hands the plugin a JSON "bundle" on STDIN
 * (NOT argv — the agent secret + scoped token must never hit the process table).
 * This module writes EXACTLY the same on-disk surfaces the managed-bootstrap
 * frame handler writes — but with NO agent-control WebSocket and NO network
 * call — by REUSING the canonical writers:
 *
 *   1. the base identity config (agentId / agentSecret / spellguardBaseUrl /
 *      expiresAt) via `writeConfig` — mirroring `runManagedFlow`'s placeholder
 *      shape so `readConfig` validates it; and
 *   2. the GitHub credential surfaces (config.json `githubCredentials`, the
 *      `git-tokens` TSV, the `CLAUDE_ENV_FILE` git-config exports, and the
 *      per-agent `gh/<agentId>/hosts.yml`) via the EXISTING
 *      `handleCredentialUpdate`, fed a synthesized `credential_delivered` frame.
 *
 * Nothing here is a reimplementation of a writer — every byte lands through the
 * same code path a real `credential_delivered{cause:'bootstrap'}` frame drives.
 */

import type {
  CredentialDeliveredFrame,
  GithubCredentialDescriptor,
} from '@spellguard/agent-control';
import {
  defaultConfigDir,
  defaultConfigPath,
  markConfigRevoked,
  readConfig,
  writeConfig,
} from './config-store';
import { handleCredentialUpdate } from './credential-handlers';
import { ensureStableHelper } from './env-file-writer';
import { ghConfigDirPath } from './gh-config-dir';

/** One GitHub credential as delivered in the CLI's HTTP-response bundle. */
export interface BundleGithubCredential {
  provider: 'github';
  credential_id: string;
  scoped_token_id?: string;
  scoped_token: string;
  /** ISO-8601 expiry of this issuance. */
  expires_at: string;
  github_org_login?: string;
  installation_id?: number;
  scope_summary: { repos: string[] };
  /** Flat author identity — nested into `provider_data` below. */
  git_author_name: string;
  git_author_email: string;
}

/** The full bundle the CLI pipes to `--apply-bundle` on STDIN. */
export interface CredentialBundle {
  agent_id: string;
  agent_secret: string;
  spellguard_base_url: string;
  credentials: BundleGithubCredential[];
}

export interface ApplyBundleResult {
  agentId: string;
  credentialIds: string[];
}

const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/** Throw with a descriptive message when `cond` is false. */
function require_(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse + shallow-validate a bundle from raw JSON text. Throws `Error` with a
 * human-readable message on any structural problem (the caller maps it to the
 * `{"ok":false,"error":...}` line + exit 1).
 */
export function parseBundle(raw: string): CredentialBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bundle is not valid JSON: ${(err as Error).message}`);
  }
  require_(
    parsed != null && typeof parsed === 'object' && !Array.isArray(parsed),
    'bundle must be a JSON object',
  );
  const b = parsed as Record<string, unknown>;
  require_(isNonEmptyString(b.agent_id), 'bundle.agent_id must be a string');
  require_(
    isNonEmptyString(b.agent_secret),
    'bundle.agent_secret must be a string',
  );
  require_(
    isNonEmptyString(b.spellguard_base_url),
    'bundle.spellguard_base_url must be a string',
  );
  require_(Array.isArray(b.credentials), 'bundle.credentials must be an array');

  const credentials = (b.credentials as unknown[]).map((c, i) => {
    require_(
      c != null && typeof c === 'object',
      `bundle.credentials[${i}] must be an object`,
    );
    const cr = c as Record<string, unknown>;
    require_(
      cr.provider === 'github',
      `bundle.credentials[${i}].provider must be 'github'`,
    );
    require_(
      isNonEmptyString(cr.credential_id),
      `bundle.credentials[${i}].credential_id must be a string`,
    );
    require_(
      isNonEmptyString(cr.scoped_token),
      `bundle.credentials[${i}].scoped_token must be a string`,
    );
    require_(
      isNonEmptyString(cr.expires_at),
      `bundle.credentials[${i}].expires_at must be a string`,
    );
    const scope = cr.scope_summary as { repos?: unknown } | undefined;
    require_(
      scope != null &&
        typeof scope === 'object' &&
        Array.isArray(scope.repos) &&
        scope.repos.every((r) => typeof r === 'string'),
      `bundle.credentials[${i}].scope_summary.repos must be a string[]`,
    );
    require_(
      isNonEmptyString(cr.git_author_name),
      `bundle.credentials[${i}].git_author_name must be a string`,
    );
    require_(
      isNonEmptyString(cr.git_author_email),
      `bundle.credentials[${i}].git_author_email must be a string`,
    );
    return cr as unknown as BundleGithubCredential;
  });

  return {
    agent_id: b.agent_id,
    agent_secret: b.agent_secret,
    spellguard_base_url: b.spellguard_base_url,
    credentials,
  };
}

/**
 * Map a bundle credential to the `GithubCredentialDescriptor` shape
 * `handleCredentialUpdate` expects. The bundle carries a FLAT
 * `git_author_name`/`git_author_email`; nest them into `provider_data`. The
 * GitHub-identity fields (`github_user_id`/`github_login`/`github_user_email`)
 * may be absent in the bundle — the daemon's writers consume only the author
 * name/email + the token, so default them sensibly.
 */
function toDescriptor(
  agentId: string,
  c: BundleGithubCredential,
): GithubCredentialDescriptor {
  return {
    provider: 'github',
    kind: 'issued',
    credential_id: c.credential_id,
    scoped_token_id: c.scoped_token_id ?? c.credential_id,
    scoped_token: c.scoped_token,
    agent_id: agentId,
    status: 'valid',
    expires_at: c.expires_at,
    scope_summary: c.scope_summary,
    ...(c.github_org_login ? { github_org_login: c.github_org_login } : {}),
    ...(typeof c.installation_id === 'number'
      ? { installation_id: c.installation_id }
      : {}),
    provider_data: {
      github_user_id: 0,
      github_login: c.github_org_login ?? '',
      github_user_email: null,
      git_author_name: c.git_author_name,
      git_author_email: c.git_author_email,
    },
  };
}

/**
 * Apply a parsed bundle to disk — NO socket, NO network. Writes the base
 * identity config, then drives the GitHub credentials through the canonical
 * `handleCredentialUpdate`.
 *
 * @returns the agent id + the credential ids that were applied.
 */
export function applyCredentialBundle(
  bundle: CredentialBundle,
): ApplyBundleResult {
  const configPath = defaultConfigPath();
  const configDir = defaultConfigDir();

  // 1. Base identity config — mirrors `runManagedFlow`'s placeholder shape so
  //    `readConfig` validates it. `handleCredentialUpdate` overwrites the
  //    placeholder GitHub fields (scopedToken/expiresAt/…) with real values
  //    below. `knownCredentials` is seeded from the delivered creds so the
  //    daemon's first Resume does NOT diverge from the server's live row and
  //    silently rotate the just-applied token.
  writeConfig(
    {
      scopedToken: '',
      scopedTokenId: '',
      agentId: bundle.agent_id,
      agentSecret: bundle.agent_secret,
      expiresAt: new Date(Date.now() + ONE_YEAR_MS).toISOString(),
      scopeSummary: { repos: [] },
      spellguardBaseUrl: bundle.spellguard_base_url,
      knownCredentials: bundle.credentials.map((c) => ({
        provider: 'github',
        scoped_token_id: c.scoped_token_id ?? c.credential_id,
      })),
      revoked: false,
    },
    configPath,
  );

  // 2. GitHub credential surfaces via the EXISTING handler, fed a synthesized
  //    `credential_delivered{cause:'bootstrap'}` frame. `handleCredentialUpdate`
  //    reads only `frame.credentials` (cause/agent_secret are irrelevant to it),
  //    so this writes config.json githubCredentials + git-tokens + the
  //    CLAUDE_ENV_FILE exports + gh hosts.yml exactly as the daemon does.
  const frame: CredentialDeliveredFrame = {
    type: 'credential_delivered',
    cause: 'bootstrap',
    seq: '0',
    ts: new Date().toISOString(),
    credentials: bundle.credentials.map((c) =>
      toDescriptor(bundle.agent_id, c),
    ),
  };

  handleCredentialUpdate(frame, {
    // Same surface the daemon writes when CLAUDE_ENV_FILE is present; skipped
    // (per the handler's own guard) when the CLI runs without it.
    envFilePath: process.env.CLAUDE_ENV_FILE ?? '',
    writeConfigImpl: (cfg) => writeConfig(cfg, configPath),
    markConfigRevokedImpl: () => markConfigRevoked(configPath),
    readConfigImpl: () => readConfig(configPath),
    ghConfigDir: ghConfigDirPath(configDir, bundle.agent_id),
    helperPath: ensureStableHelper(configDir),
  });

  return {
    agentId: bundle.agent_id,
    credentialIds: bundle.credentials.map((c) => c.credential_id),
  };
}

/** Read all of STDIN to a UTF-8 string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * The `--apply-bundle` entry point: read the bundle from STDIN, apply it, and
 * print ONE line of JSON to stdout. `{"ok":true,...}` + exit 0 on success;
 * `{"ok":false,"error":...}` + exit 1 on any failure.
 */
export async function runApplyBundle(): Promise<void> {
  try {
    const raw = await readStdin();
    const bundle = parseBundle(raw);
    const result = applyCredentialBundle(bundle);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        agentId: result.agentId,
        credentialIds: result.credentialIds,
      })}\n`,
    );
  } catch (err) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: (err as Error)?.message ?? String(err),
      })}\n`,
    );
    process.exit(1);
  }
}
