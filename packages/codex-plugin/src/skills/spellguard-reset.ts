// SPDX-License-Identifier: Apache-2.0

/**
 * /spellguard-reset — clean machine teardown (plan Task 0.2, I10).
 *
 * Until now there was NO way to cleanly tear an agent down from a machine:
 * local teardown meant kill-the-daemon + rm-the-config by hand, and the
 * server side needed manual SQL. This command does, in order:
 *
 *   1. `DELETE /v1/agents/self` (agent-secret auth) — soft-deletes the
 *      agent server-side, revokes its credentials, fans out
 *      credential_revoked frames. MUST run first: it needs the secret that
 *      step 3 deletes. 401/404/network failures are tolerated — the server
 *      side may already be gone (dashboard delete, env reset).
 *   2. Stop local credential daemons (pidfile-driven SIGTERM).
 *   3. Delete the local config.
 *
 * Idempotent and lost-secret tolerant by design: every step degrades to a
 * no-op rather than failing the teardown.
 */

import {
  type AuthSupersededCloseReason,
  createManagementClient,
} from '@spellguard/agent-control';
import { clearCodexCredentialHelper } from '../lib/codex-credential-helper-install';
import {
  type ReadConfigResult,
  clearConfig,
  defaultConfigPath,
  markConfigSuperseded,
  readConfig,
} from '../lib/config-store';
import { clearGhSessionConfig } from '../lib/gh-config-dir';
import { renderMessage } from '../lib/render-message';
import { stopLocalDaemons } from '../lib/stop-daemons';

/**
 * Cause-specific message persisted on a self-wipe (P2-T6 / FR-10). Selected
 * from the 4409 close `cause` and written to `config.revokedMessage` so the
 * next SessionStart re-surfaces it.
 *
 * FR-10/FR-15/UT-008: `undefined` (absent or unrecognized cause) returns the
 * GENERIC message rather than the attached_elsewhere copy — the server sent a
 * code we don't recognise, so we must not assume which specific event occurred.
 */
export function supersededMessage(
  cause: AuthSupersededCloseReason | undefined,
): string {
  if (cause === 'reassigned') {
    return 'This agent was reassigned to another user; its local credentials were cleared and you no longer own it.';
  }
  if (cause === 'attached_elsewhere') {
    return 'This machine was disconnected because this agent was attached on another machine. Its local credentials were cleared — run @spellguard-setup and select it to use it here again.';
  }
  // cause === undefined: absent or unrecognized — generic message (UT-008).
  return "This agent's credentials were cleared — run @spellguard-setup to reconnect.";
}

export interface SupersededWipeArgs {
  cause: AuthSupersededCloseReason | undefined;
  /** Path to config.json (tests inject an isolated temp path). */
  configPath?: string;
  /**
   * Accepted for call-site parity with the Claude Code plugin's daemon (which
   * passes `CLAUDE_ENV_FILE` here). Codex has no per-session env file — it
   * clears its credential surface via `clearCodexCredentialHelper`
   * (`~/.codex/config.toml`) instead — so this is intentionally IGNORED.
   */
  envFilePath?: string;
  /** Per-agent gh session dir whose pinned hosts.yml is cleared. */
  ghConfigDir?: string;
  /** Override `~/.codex` / CODEX_HOME (tests). */
  codexHome?: string;
  /** Override the credential-wipe core (tests). */
  markConfigSupersededImpl?: (message: string) => void;
  /** Override the codex config.toml credential-helper clear (tests). */
  clearCodexCredentialHelperImpl?: (args?: { codexHome?: string }) => void;
  /** Override the gh-session clear (tests). */
  clearGhSessionConfigImpl?: (dir: string) => void;
}

/**
 * NON-INTERACTIVE self-wipe of THIS machine's per-agent credentials, invoked
 * by the credential daemon from `onCredentialSuperseded` (the ONLY trigger —
 * close code 4409, NR-3). Unlike `runSpellguardReset` this performs NO server
 * deregistration (the server already superseded us — the move/reassign was
 * server-initiated) and NO daemon-stop (the daemon is the caller and closes
 * its own socket); it only clears the local credential surfaces the consuming
 * app reads and persists the cause message.
 *
 * Reuses the same wipe internals as the interactive reset
 * (`markConfigSuperseded` → `writeConfig`/`writeGitTokensFile`,
 * `clearCodexCredentialHelper` — the Codex `~/.codex/config.toml`
 * shell-env-policy block — and `clearGhSessionConfig`) rather than
 * re-implementing the wipe. Wipes ONLY this agent's credentials (identity is
 * preserved so `@spellguard-setup` can re-attach this machine).
 */
export function wipeSupersededCredentials(args: SupersededWipeArgs): void {
  const message = supersededMessage(args.cause);
  const configPath = args.configPath ?? defaultConfigPath();
  // 1. Clear the credential material + persist the cause message (same write
  //    path as a revoke; drops the git-tokens companion when no usable token
  //    remains).
  (
    args.markConfigSupersededImpl ??
    ((m: string) => markConfigSuperseded(m, configPath))
  )(message);
  // 2. Clear the Codex git+gh credential-helper block in
  //    `~/.codex/config.toml` so the next git op fails closed rather than
  //    presenting a stale token. (Codex's analog of Claude Code's env-file.)
  try {
    (args.clearCodexCredentialHelperImpl ?? clearCodexCredentialHelper)({
      codexHome: args.codexHome,
    });
  } catch {
    /* best-effort — config.toml may already be clean */
  }
  // 3. Clear the per-agent gh session pin so `gh` stops presenting the token.
  if (args.ghConfigDir) {
    try {
      (args.clearGhSessionConfigImpl ?? clearGhSessionConfig)(args.ghConfigDir);
    } catch {
      /* best-effort — dir may already be gone */
    }
  }
}

export interface ResetArgs {
  fetchImpl?: typeof fetch;
  readConfigImpl?: () => ReadConfigResult;
  clearConfigImpl?: () => void;
  stopDaemons?: (opts?: { configDir?: string }) => number[];
  configDir?: string;
}

export interface ResetResult {
  ok: boolean;
  reason?: string;
  /** True when the server acknowledged the deregistration. */
  deregistered: boolean;
  /** PIDs of daemons that were SIGTERMed. */
  stoppedDaemons: number[];
}

export async function runSpellguardReset(
  args: ResetArgs = {},
): Promise<ResetResult> {
  const readResult = (args.readConfigImpl ?? readConfig)();
  const stopDaemons = args.stopDaemons ?? stopLocalDaemons;

  if (!readResult.config) {
    // No config — still reap any stray daemons, then done. (A daemon
    // without a config dies on its own, but don't leave it to chance.)
    const stoppedDaemons = stopDaemons({ configDir: args.configDir });
    renderMessage({
      level: 'info',
      message: `Spellguard: nothing to reset — no local credential found.${stoppedDaemons.length > 0 ? ` Stopped ${stoppedDaemons.length} stray daemon(s).` : ''}`,
    });
    return {
      ok: true,
      reason: 'no_config',
      deregistered: false,
      stoppedDaemons,
    };
  }

  const cfg = readResult.config;

  // 1. Server-side deregistration FIRST (needs the secret we delete below).
  let deregistered = false;
  try {
    const api = createManagementClient({
      baseUrl: cfg.spellguardBaseUrl,
      agentId: cfg.agentId,
      agentSecret: cfg.agentSecret,
      fetchImpl: args.fetchImpl,
    });
    // The route declares only a 200, so openapi-fetch types `error` as `never`;
    // read the HTTP status off `response` (always a `Response`) and treat any
    // non-2xx as un-confirmed, preserving the legacy `res.ok`/`res.status` logic.
    const { response } = await api.DELETE('/agents/self');
    if (response.ok) {
      deregistered = true;
    } else {
      // A non-200 does NOT confirm the agent is gone. It could be a genuinely
      // already-deleted agent (benign) OR a server/routing problem where the
      // agent is STILL ACTIVE with a live token (2026-06-12: a routing leak
      // 401'd this exact call, leaving an orphaned credential the user never
      // knew about). The client can't tell which, so it must NOT reassure —
      // it tells the user to verify/revoke from the dashboard. Local cleanup
      // proceeds regardless (the un-brick guarantee).
      renderMessage({
        level: 'warn',
        message: `Spellguard: the server did NOT confirm deregistration (HTTP ${response.status}). If this agent still appears in your dashboard, revoke it there — its credential may still be active. Continuing with local cleanup.`,
      });
    }
  } catch (err) {
    renderMessage({
      level: 'warn',
      message: `Spellguard: could not reach the server to deregister (${(err as Error)?.message ?? err}). The agent may still be active server-side — revoke it from the dashboard once reachable. Continuing with local cleanup.`,
    });
  }

  // 2. Stop local daemons before deleting the config they read.
  const stoppedDaemons = stopDaemons({ configDir: args.configDir });

  // 3. Delete the local credential.
  (args.clearConfigImpl ?? clearConfig)();

  renderMessage({
    level: deregistered ? 'info' : 'warn',
    message: deregistered
      ? `Spellguard: machine disconnected — server deregistration confirmed, ${stoppedDaemons.length} daemon(s) stopped, local credential deleted. Run @spellguard-setup to reconnect.`
      : `Spellguard: machine disconnected LOCALLY — but the server did NOT confirm the agent was removed. If it still appears in your dashboard, revoke it there. ${stoppedDaemons.length} daemon(s) stopped, local credential deleted. Run @spellguard-setup to reconnect.`,
  });
  return { ok: true, deregistered, stoppedDaemons };
}
