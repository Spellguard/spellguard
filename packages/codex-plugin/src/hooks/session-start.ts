// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import {
  type GithubCredentialDescriptor,
  type GithubCredentialScope,
  createManagementClient,
  describeGithubCredentialScope,
  isAgentGoneStatus,
  isManagedBox,
} from '@spellguard/agent-control';
import { probeCodexHooksFlag } from '../lib/codex-config-probe';
import { installCodexCredentialHelper } from '../lib/codex-credential-helper-install';
import {
  type ReadConfigResult,
  type SpellguardConfig,
  defaultConfigDir,
  defaultConfigPath,
  markConfigRevoked,
  readConfig,
} from '../lib/config-store';
import {
  type DaemonResult,
  ensureCredentialDaemonRunning,
  readDaemonHealth,
} from '../lib/daemon-spawn';
import { ensureStableHelper } from '../lib/env-file-writer';
import { ghConfigDirPath } from '../lib/gh-config-dir';
import { isSshRewriteEnabled } from '../lib/git-insteadof-rules';
import {
  type GitVersion,
  detectGitVersion,
  isGitVersionSupported,
} from '../lib/git-version-check';
import { healLeakedGlobalGitConfig } from '../lib/heal-leaked-global-gitconfig';
import { migrateLegacyConfig } from '../lib/migrate-legacy-config';
import { type PlatformInfo, isPlatformSupported } from '../lib/platform-check';
import { syncFrameworkIdentity } from '../lib/plugin-sync';
import { renderMessage } from '../lib/render-message';
import {
  type SshDetectionResult,
  detectSshRemote,
  detectSshRemoteAfterRewrite,
  repoIdentityFromSshDetection,
} from '../lib/ssh-remote-detect';

// The canonical wire shape is defined in @spellguard/agent-control
// (packages/agent-control/src/protocol.ts).
// `StatusResponse` follows the descriptor verbatim — `/status`
// omits the raw scoped_token, hence `scoped_token` is optional on the
// descriptor).
export type StatusResponse = GithubCredentialDescriptor;

// Daemon spawn machinery lives in `../lib/daemon-spawn` (shared with the
// setup CLI since 2026-06-11). Re-exported here for existing importers of
// the hook module.
export type { DaemonResult } from '../lib/daemon-spawn';

export interface SessionStartDeps {
  platformInfo?: PlatformInfo;
  gitVersion?: GitVersion | null;
  cwd?: string;
  sshDetect?: (cwd: string) => SshDetectionResult;
  /**
   * Backstop probe: re-detect SSH remotes with the session-scoped SSH->HTTPS
   * `insteadOf` rewrite applied. Override for tests; defaults to
   * `detectSshRemoteAfterRewrite`.
   */
  sshDetectAfterRewrite?: (cwd: string) => SshDetectionResult;
  readConfigImpl?: () => ReadConfigResult;
  markConfigRevokedImpl?: () => void;
  writeEnvFileImpl?: (helperPath?: string) => void;
  claudeEnvFile?: string;
  fetchImpl?: typeof fetch;
  /**
   * Daemon spawn: override for tests — inject a mock spawn function.
   * The production path (no override) calls `child_process.spawn` with
   * `detached: true, stdio: 'ignore'` and immediately `.unref()`s the child
   * so the hook process can exit cleanly.
   *
   * Test callers supply a `vi.fn()` here; assertions check the argv and
   * config-dir args rather than the in-process client construction.
   */
  spawnDaemon?: (
    execPath: string,
    args: string[],
    opts: SpawnOptions,
  ) => ChildProcess | undefined;
  /** Test seam for daemon lifecycle outcomes and diagnostics. */
  ensureDaemonRunning?: typeof ensureCredentialDaemonRunning;
  /**
   * Override the config directory used for PID file resolution. Defaults to
   * `defaultConfigDir()`. Tests pass an isolated temp dir.
   */
  configDir?: string;
  /**
   * R3-4/R3-5/R3-6: positive managed-mode gate. Defaults to the real R3-1 marker
   * reader (`isManagedBox()` from `@spellguard/agent-control`, which reads the
   * SHARED root's `.managed`). TRUE ⇒ a genuinely Spellguard-provisioned managed
   * box: the global-gitconfig healer (R3-5) AND the per-session scoped
   * config.toml credential injection (R3-4) stand down (the global placement is
   * authoritative there). FALSE (the default everywhere — absent OR corrupt
   * marker) ⇒ both stay active (fail-closed — R3-6). The SOLE signal is the
   * marker file, NEVER ambient env (NEG-7). Injected so tests can pin a temp
   * root (`() => isManagedBox(root)`) and never touch the real
   * `~/.config/spellguard` / `~/.gitconfig`.
   */
  isManagedBox?: () => boolean;
  /**
   * Poll the local config file until it shows an `expiresAt` value newer than
   * `initialExpiresAt`, or until `timeoutMs` elapses.
   *
   * Returns the fresh `SpellguardConfig` if one appears, or `null` on timeout.
   *
   * Injected via deps so tests can stub it without real filesystem/timer
   * dependencies. The production default polls every 500 ms.
   */
  pollForFreshCredential?: (
    initialExpiresAt: string,
    timeoutMs: number,
  ) => Promise<SpellguardConfig | null>;
}

export interface SessionStartResult {
  ok: boolean;
  reason?: string;
  /**
   * Daemon: result of the credential daemon spawn attempt.
   * Undefined when session-start fails before reaching the daemon step.
   * The commit watcher now runs inside this daemon process, so
   * `daemonResult` is the only handle callers need — the watcher
   * lifecycle is tied to the daemon's lifecycle.
   */
  daemonResult?: DaemonResult;
}

export async function runSessionStart(
  deps: SessionStartDeps = {},
): Promise<SessionStartResult> {
  const ensureDaemonRunning =
    deps.ensureDaemonRunning ?? ensureCredentialDaemonRunning;
  // One-shot banner: warn the user if Codex hooks are disabled. This hook
  // only fires if hooks are enabled, so emit() is only reached when the
  // feature flag is in fact on — but we still probe for the "unknown"
  // case (config.toml present but no codex_hooks key) which surfaces a
  // helpful info message on first use.
  const hooksFlag = probeCodexHooksFlag();
  if (hooksFlag.state === 'disabled') {
    renderMessage({
      level: 'warn',
      message:
        'Spellguard: detected `codex_hooks = false` in ~/.codex/config.toml. ' +
        'Enable it with `[features] codex_hooks = true` so SessionStart / ' +
        'PreToolUse / PostToolUse hooks fire.',
    });
  }

  const platformInfo = deps.platformInfo ?? {
    platform: process.platform,
    release: (await import('node:os')).release(),
  };
  const platformOk = isPlatformSupported(platformInfo);
  if (!platformOk.ok) {
    renderMessage({
      level: 'error',
      message: platformOk.message ?? 'Spellguard: unsupported platform.',
    });
    return { ok: false, reason: 'platform_unsupported' };
  }

  const gitVersion =
    deps.gitVersion === undefined ? detectGitVersion() : deps.gitVersion;
  if (!gitVersion) {
    renderMessage({
      level: 'error',
      message: 'Spellguard: git is not installed or not on PATH.',
    });
    return { ok: false, reason: 'git_missing' };
  }
  if (!isGitVersionSupported(gitVersion)) {
    renderMessage({
      level: 'error',
      message: `Spellguard requires git 2.31 or later (current: ${gitVersion.major}.${gitVersion.minor}.${gitVersion.patch}).`,
    });
    return { ok: false, reason: 'git_version_too_old' };
  }

  // R3-1/R3-5/R3-6: the SOLE managed-mode signal is the marker file (never
  // ambient env — NEG-7). Resolve it once, up front, since it gates both the
  // healer (R3-5, immediately below) and the per-session scoped injection (R3-4,
  // further down). Absent OR corrupt marker → non-managed → both stay active
  // (fail-closed).
  const managed = (deps.isManagedBox ?? isManagedBox)();

  // One-time heal of the OLD global-gitconfig leak (pre-2026-06-15): a prior
  // Codex plugin version wrote a spellguard helper + a (Spellguard:)-suffixed
  // identity into the machine-global ~/.gitconfig, which bricked plain-shell git
  // on revoke. Runs before the config read (safe even when unconfigured — it
  // only removes entries unmistakably ours) and at most once (marker file).
  //
  // R3-5 standdown: on a MANAGED box the global-gitconfig footprint is
  // INTENTIONAL, so the healer is gated OFF. Note (spec review): on managed we
  // place the git helper into `/etc/gitconfig`, NOT `~/.gitconfig`, so the healer
  // (which strips `~/.gitconfig`) can never neutralize the managed placement —
  // gating it here is a precautionary CONSISTENCY measure that keeps "global
  // footprint is intentional on managed" a single, explicit marker-keyed rule.
  // It stays fully active on every non-managed / self-hosted box.
  if (!managed) {
    healLeakedGlobalGitConfig(
      join(
        deps.configDir ?? defaultConfigDir(),
        '.codex-global-gitconfig-healed',
      ),
    );
  }

  // One-time legacy→framework config migration (B2): move a pre-isolation
  // `<root>/config.json` into this framework's subdir before the disk read, so
  // an upgraded machine keeps its identity. Only when reading REAL on-disk
  // config — a mocked `readConfigImpl` means the test isn't exercising disk, so
  // skip the (real-filesystem) migration entirely.
  if (!deps.readConfigImpl) migrateLegacyConfig();

  const readResult = (deps.readConfigImpl ?? readConfig)();
  if (!readResult.config) {
    if (readResult.reason === 'malformed') {
      // A malformed-but-present config must be LOUD — treating it as
      // "not configured" masks the problem entirely (plan Task 2.5).
      renderMessage({
        level: 'error',
        message: `Spellguard: config file exists but is malformed (failing field: ${readResult.malformedField ?? 'unknown'}). A .bak snapshot sits next to ~/.config/spellguard/config.json — inspect/restore it, or delete the file and re-run \`@spellguard-setup\`.`,
      });
      return { ok: false, reason: 'malformed' };
    }
    if (readResult.reason === 'wrong_permissions') {
      // This machine IS configured — the file just could not be read at a safe
      // mode, and `readConfig` could not tighten it (another uid owns it).
      // Reporting that as "not configured" sent operators straight at the one
      // destructive command while their agent identity sat intact on disk.
      renderMessage({
        level: 'error',
        message: `Spellguard: ${defaultConfigPath()} has mode ${readResult.foundMode ?? 'other than 0600'} and is owned by another user, so it could not be read or repaired. Your agent identity is intact — fix the owner/mode (\`chown\` it back to you, then \`chmod 600\`) rather than re-running \`@spellguard-setup\`.`,
      });
      return { ok: false, reason: 'wrong_permissions' };
    }
    renderMessage({
      level: 'info',
      message:
        'Spellguard not configured — run `@spellguard-setup` to provision a credential.',
    });
    return { ok: false, reason: readResult.reason ?? 'missing' };
  }

  if (readResult.permissionsHealed) {
    // Loud but non-fatal: the config was readable after Spellguard tightened a
    // drifted mode back to 0600 in place.
    renderMessage({
      level: 'warn',
      message: `Spellguard: ${defaultConfigPath()} had unsafe permissions; Spellguard restored mode 0600 automatically.`,
    });
  }

  // REQ-FI (reliable framework reconciliation): fire the plugin-sync the moment
  // we have a valid agent identity — BEFORE the SSH / revoked / identity-only /
  // expired early-returns below. Those previously short-circuited past the sync,
  // so an agent that never reached the GitHub-ready path (e.g. identity-only, or
  // a revoked credential) stayed stuck at the server's creation-time framework
  // (a Codex agent shown as claude-code). Fire-and-forget; never blocks startup;
  // depends only on identity (agentId + baseUrl + agentSecret), not on GitHub.
  if (
    readResult.config.agentId &&
    readResult.config.spellguardBaseUrl &&
    readResult.config.agentSecret
  ) {
    void syncFrameworkIdentity({
      agentId: readResult.config.agentId,
      managementUrl: readResult.config.spellguardBaseUrl,
      agentSecret: readResult.config.agentSecret,
      fetchImpl: deps.fetchImpl,
    });
  }

  // SSH-remote handling — runs BEFORE the env-file/credential-helper write.
  // An SSH GitHub remote uses SSH keys, so it bypasses the HTTPS credential
  // helper and the Spellguard scoped token never gets used. Instead of
  // hard-stopping, we inject session-scoped git `insteadOf`/`pushInsteadOf` rules
  // (alongside the credential helper, below) that transparently rewrite SSH
  // github.com URLs to HTTPS for THIS session's git operations — without touching
  // the user's stored remote or global git config. We also out-specify a user's
  // global force-SSH rule with full-repo-path IDENTITY rules so we WIN longest-
  // prefix arbitration (fetch AND push). The detector is kept as a SHRUNKEN
  // BACKSTOP: we re-probe the EFFECTIVE remote with the full rule set applied;
  // if it is STILL SSH (an exotic same-specificity force-SSH rule, or an SSH host
  // alias like git@github-work: that doesn't map to github.com), or the rewrite
  // is disabled, we fall back to the explicit "switch your remote" error. See
  // `git-insteadof-rules.ts`.
  const cwd = deps.cwd ?? process.cwd();
  const sshDetectFn = deps.sshDetect ?? detectSshRemote;
  const sshResult = sshDetectFn(cwd);
  // Origin repo identity (case-preserved) for the full-repo-path IDENTITY rules
  // (3 & 4). Populated only when we proceed with an SSH-remote rewrite below; it
  // is threaded into the env writes so the rules out-specify a force-SSH rule for
  // this exact repo.
  let sshRewriteRepo: { owner: string; repo: string } | undefined;
  if (sshResult.hasSsh) {
    // Single source of truth for the repo identity (rules 3/4) — the daemon's
    // rotation path derives it the same way via `resolveSshRewriteRepo`.
    const repoIdentity = repoIdentityFromSshDetection(sshResult);
    const rewriteEnabled = isSshRewriteEnabled();
    const afterRewrite = rewriteEnabled
      ? (deps.sshDetectAfterRewrite ?? detectSshRemoteAfterRewrite)(
          cwd,
          repoIdentity,
        )
      : sshResult;
    if (!rewriteEnabled || afterRewrite.hasSsh) {
      // Backstop: the rewrite is off, or it would NOT convert this remote to
      // HTTPS. Surface an actionable `git remote set-url` command.
      const httpsTarget = repoIdentity
        ? `https://github.com/${repoIdentity.owner}/${repoIdentity.repo}.git`
        : 'https://github.com/<owner>/<repo>.git';
      const why = !rewriteEnabled
        ? 'SSH remote detected'
        : 'SSH remote still resolves to SSH after the automatic HTTPS rewrite (a same-specificity force-SSH rule or an SSH host alias is overriding it)';
      renderMessage({
        level: 'error',
        message: `Spellguard requires HTTPS git remotes. ${why} (${sshResult.sshRemoteUrl ?? 'unknown'}). Run \`git remote set-url origin ${httpsTarget}\` to switch.`,
      });
      return { ok: false, reason: 'ssh_remote' };
    }
    // The rewrite will take effect — git transparently uses HTTPS this session.
    sshRewriteRepo = repoIdentity;
    renderMessage({
      level: 'info',
      message: `Spellguard: SSH GitHub remote detected (${sshResult.sshRemoteUrl ?? 'unknown'}); transparently rewriting it to HTTPS for this session so the Spellguard credential is used. Your stored git remote is unchanged.`,
    });
    // Fall through: the env-file writes below include the rewrite rules.
  }

  // CR-W-Plug-FailClosed: from here down we're committed to an HTTPS-remote
  // path where the host's credential helpers (e.g. a `gh auth setup-git`-
  // installed PAT) could otherwise serve github.com auth. Inject the
  // credential-helper override now so every failure path below (revoked,
  // status-check failed, expired) keeps git's auth flow pinned to the
  // spellguard helper. The spellguard-git-helper itself returns no
  // credentials when config is missing/revoked or the cached token is gone,
  // so git push fails clean rather than silently leaking the host PAT.
  //
  // Codex does not provide a per-session env file the way Claude Code does.
  // We install the git credential helper config directly via `git config
  // --global`, which persists across Codex sessions and is idempotent.
  // Per-agent gh session dir — pinned via GH_CONFIG_DIR (in the config.toml
  // shell_environment_policy) so the session's gh CLI resolves the scoped token.
  // The daemon maintains its hosts.yml; never the developer's real ~/.config/gh.
  const configDir = deps.configDir ?? defaultConfigDir();
  const ghConfigDir = ghConfigDirPath(configDir, readResult.config.agentId);
  const writeEnvFile = () => {
    // R3-4 standdown: skip the per-session scoped config.toml credential-helper
    // install on a managed box (the global placement is authoritative — a second
    // scoped helper conflicts). NEVER a fallback path — on non-managed this
    // always runs (R3-6 fail-closed helper pin).
    if (managed) return;
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else {
      installCodexCredentialHelper({
        gitAuthorName: readResult.config?.gitAuthorName,
        gitAuthorEmail: readResult.config?.gitAuthorEmail,
        ghConfigDir,
        helperPath: ensureStableHelper(configDir),
        sshRewriteRepo,
      });
    }
  };
  // Mask the host's helpers immediately. Re-written at the success path with
  // the post-poll activeConfig (daemon-updated if the local config was
  // expired) — bash sources last-wins, so the later block takes effect.
  writeEnvFile();

  if (readResult.config.revoked) {
    // SPAWN THE DAEMON ANYWAY. `revoked` means the SERVER disowned this agent
    // (a 4401 close → handleAuthFailedClose), or the config was latched by an
    // older build that treated a credential revoke as terminal. Returning here
    // without a daemon was the last link in a permanent brick: the only process
    // that can receive a replacement credential and clear the flag never ran,
    // so backend rotation — the lever every operator reaches for — could not
    // reach the machine. A genuinely disowned agent's daemon exits on its own
    // 4401 within seconds, so this costs nothing in the unrecoverable case and
    // heals the recoverable one on the first session after upgrading.
    //
    // A persisted `revokedMessage` (P2-T6 self-wipe — agent moved/reassigned)
    // is cause-specific; prefer it over the generic revoked banner so the next
    // SessionStart re-surfaces exactly why the credential was cleared.
    const daemonResult: DaemonResult = managed
      ? { daemon: 'skipped', reason: 'managed_box' }
      : await ensureDaemonRunning({
          config: readResult.config,
          spawnDaemon: deps.spawnDaemon,
          configDir: deps.configDir,
          cwd,
        });
    renderMessage({
      level: 'error',
      message: readResult.config.revokedMessage
        ? `Spellguard: ${readResult.config.revokedMessage}`
        : daemonResult.daemon === 'unavailable'
          ? `Spellguard: this credential has been revoked, and the credential daemon is unavailable (${daemonResult.reason}). Inspect the daemon log and installed plugin version before requesting a replacement.`
          : 'Spellguard: this credential has been revoked. Spellguard is waiting for a replacement credential; if git stays blocked, run `spellguard doctor --repair` (non-destructive) before re-running `@spellguard-setup`.',
    });
    return { ok: false, reason: 'revoked', daemonResult };
  }

  // Identity-only configs (bootstrap completed, no GitHub credential
  // yet delivered through the channel). Spawn the persistent credential
  // daemon — it's the consumer that writes `scopedToken` / `expiresAt` /
  // `scopeSummary` / `gitAuthor*` to disk when the dashboard's GitHub-App
  // install OAuth callback eventually pushes a `credential_delivered` frame.
  // Until then, session-start succeeds without git-credential injection;
  // the operator is told what to do next. Note we DO spawn the daemon
  // (vs. early-returning) so the credential lands automatically the moment
  // the operator completes the dashboard step.
  if (
    !readResult.config.scopedTokenId ||
    !readResult.config.scopedToken ||
    !readResult.config.expiresAt ||
    !readResult.config.scopeSummary
  ) {
    // Stage 4 Gap B: on a genuinely MANAGED box a single Go box-daemon
    // (`spellguard box-daemon`) owns the agent-control socket + credential
    // placement, so the per-session Node credential daemon must NOT spawn —
    // two daemons contend on the DO's single socket (4409/4429 churn). Reuse
    // the SAME `managed` value the injection/healer standdown uses above (never
    // a second detection path). NOTE: this Node daemon also carries observation,
    // so standing it down drops observation on managed boxes too — ACCEPTED for
    // the MVP and folded into the R3-7b attribution follow-up.
    const daemonResult: DaemonResult = managed
      ? { daemon: 'skipped', reason: 'managed_box' }
      : await ensureDaemonRunning({
          config: readResult.config,
          spawnDaemon: deps.spawnDaemon,
          configDir: deps.configDir,
          cwd,
        });
    renderMessage({
      level: daemonResult.daemon === 'unavailable' ? 'error' : 'info',
      message:
        daemonResult.daemon === 'unavailable'
          ? `Spellguard: agent identity is present, but GitHub is not connected and the credential daemon is unavailable (${daemonResult.reason}). Inspect the daemon log and installed plugin version. Do not request a new credential until the local process state is understood.`
          : 'Spellguard: agent identity present; GitHub not yet connected. ' +
            'Open your Spellguard dashboard and complete the GitHub App install ' +
            'on this agent. The credential owner will write the token to your ' +
            'local config when it arrives. Git operations remain unprotected ' +
            'until the credential lands.',
    });
    return { ok: true, daemonResult, reason: 'identity_only' };
  }
  // After the guard above, all four github fields are guaranteed non-undefined.
  // Capture the narrowing once so subsequent code (including the post-poll
  // `activeConfig` updates) doesn't have to re-check.
  type GithubReadyConfig = SpellguardConfig & {
    scopedToken: string;
    scopedTokenId: string;
    expiresAt: string;
    // The REAL union — an `{ repos: string[] }` annotation here would mask the
    // `mode: 'all'` arm (which carries no repo list) from the compiler, which
    // is exactly how the success-banner `.repos.length` crash shipped.
    scopeSummary: GithubCredentialScope;
  };
  const initialConfig: GithubReadyConfig =
    readResult.config as GithubReadyConfig;
  const scopedTokenId = initialConfig.scopedTokenId;

  // Reconcile before the remote status probe. A control-plane transport error
  // must not short-circuit local daemon recovery during an active session.
  const daemonResult: DaemonResult = managed
    ? { daemon: 'skipped', reason: 'managed_box' }
    : await ensureDaemonRunning({
        config: initialConfig,
        spawnDaemon: deps.spawnDaemon,
        configDir: deps.configDir,
        cwd,
      });

  const baseUrl = readResult.config.spellguardBaseUrl;
  const agentId = readResult.config.agentId;
  const agentSecret = readResult.config.agentSecret;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Status check ALWAYS runs.
  // Attach the scoped token so the server's liveness probe can detect
  // GitHub-side revocation on session start, not just on monitor ticks.
  const scopedTokenForProbe = readResult.config.scopedToken;
  const api = createManagementClient({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl,
  });
  let statusResult: Awaited<ReturnType<(typeof api)['GET']>>;
  try {
    statusResult = await api.GET('/credentials/github/status', {
      params: { query: { scoped_token_id: scopedTokenId } },
      headers: scopedTokenForProbe
        ? { 'X-Spellguard-Scoped-Token': scopedTokenForProbe }
        : undefined,
    });
  } catch {
    renderMessage({
      level: 'error',
      message:
        'Spellguard: could not verify credential status because the control-plane transport failed. The local credential state is unchanged. Inspect the daemon and retry before requesting a new credential.',
    });
    return { ok: false, reason: 'status_failed', daemonResult };
  }
  const { data, error, response } = statusResult;
  if (error) {
    // A 401/403/404/410 means the server no longer recognizes this agent or
    // its credential — most often because the credential was revoked or the
    // Spellguard environment it was provisioned against is no longer available.
    // Surface an actionable reconnect prompt instead of a bare status code.
    // Other failures (network, 5xx) are treated as transient.
    const httpStatus = response?.status;
    const needsReconnect = isAgentGoneStatus(httpStatus);
    renderMessage({
      level: 'error',
      message: needsReconnect
        ? `Spellguard: your agent is no longer recognized by the server (HTTP ${httpStatus}). This usually means the credential was revoked or the Spellguard environment was reset. Run \`@spellguard-setup\` to reconnect this agent.`
        : `Spellguard: could not verify credential status with the server (${error.error?.code ?? error.error?.message ?? 'unknown error'}). The local credential state is unchanged. Inspect the daemon and retry before requesting a new credential.`, // openapi-fetch error envelope: { error: { code, message } }
    });
    return { ok: false, reason: 'status_failed', daemonResult };
  }

  const status = (data as StatusResponse).status;

  if (status === 'revoked') {
    (deps.markConfigRevokedImpl ?? markConfigRevoked)();
    renderMessage({
      level: 'error',
      message:
        'Spellguard: this credential has been revoked. Run `@spellguard-setup` to provision a new one.',
    });
    return { ok: false, reason: 'revoked', daemonResult };
  }

  let activeConfig: GithubReadyConfig = initialConfig;

  if (status === 'near_expiry') {
    // Credential is still valid. The daemon will receive a `credential_rotated`
    // push from the server and update the local config in the background before
    // the token actually expires. No in-band action required.
    renderMessage({
      level: 'info',
      message:
        'Spellguard: credential approaching expiry; daemon will refresh in background.',
    });
  }

  // agents.framework reconciliation already fired early (right after the
  // identity was confirmed present, above) so it runs for every session
  // regardless of the GitHub-credential state below.

  if (status === 'expired') {
    // The local token is dead. The daemon (just spawned above, or already
    // running) should receive a `credential_delivered{cause:'refresh_response'}`
    // and rewrite the local config. Wait up to 5 s for the file to update.
    const pollFn = deps.pollForFreshCredential ?? defaultPollForFreshCredential;
    const fresh = await pollFn(activeConfig.expiresAt, 5000);
    if (!fresh) {
      const daemonHealth = readDaemonHealth(configDir, activeConfig.agentId);
      const daemonDetail =
        daemonResult.daemon === 'unavailable'
          ? `The credential daemon is unavailable (${daemonResult.reason}).`
          : daemonHealth?.transportState === 'error'
            ? 'The credential daemon is running, but its control-plane transport is failing.'
            : 'The credential daemon is running and the refresh is still pending.';
      renderMessage({
        level: 'error',
        message: `Spellguard: credential is expired. ${daemonDetail} No replacement arrived within 5 seconds. Inspect the daemon log and verify actual git or gh access before requesting a new credential.`,
      });
      return { ok: false, reason: 'expired_no_refresh', daemonResult };
    }
    // The poller only ever returns a github-ready config (it skips
    // identity-only states). Cast through to preserve the narrowing.
    activeConfig = fresh as GithubReadyConfig;
  }

  // Env-file injection.
  // Write with the current activeConfig (updated by daemon poll if expired).
  // Bash sources last-wins, so this block overrides the early fail-closed
  // write done above. R3-4 standdown: skipped entirely on a managed box.
  if (!managed) {
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else {
      installCodexCredentialHelper({
        gitAuthorName: activeConfig.gitAuthorName,
        gitAuthorEmail: activeConfig.gitAuthorEmail,
        ghConfigDir,
        helperPath: ensureStableHelper(configDir),
        sshRewriteRepo,
      });
    }
  }

  // Success banner
  const minutesLeft = Math.max(
    0,
    Math.floor(
      (new Date(activeConfig.expiresAt).getTime() - Date.now()) / 60000,
    ),
  );
  // Render by scope mode: an org-wide (`mode:'all'`) grant carries no repo
  // list, so `repos=<count>` only exists on the `selected` arm.
  const scopeText =
    activeConfig.scopeSummary.mode === 'all'
      ? `scope=${describeGithubCredentialScope(activeConfig.scopeSummary)}`
      : `repos=${activeConfig.scopeSummary.repos.length}`;
  renderMessage({
    level: 'info',
    message: `Spellguard: agent credentials injected — agent=${activeConfig.agentId}, ${scopeText}, expires in ${minutesLeft} minutes`,
  });

  // The commit filesystem watcher used to start here. It now lives in
  // `bin/spellguard-credential-daemon.ts`
  // which is spawned by `ensureCredentialDaemonRunning` above. The hook
  // process exits seconds after returning from runSessionStart, so hosting
  // an fs.watch here meant the watcher died with the hook and every commit
  // observation after the first ~5 seconds was silently dropped. The
  // daemon's lifetime matches the WebSocket — long enough to cover the
  // full Claude Code session.
  return { ok: true, daemonResult };
}

// ── Credential expiry poller ─────────────────────────────────────────────────

/**
 * Default implementation of `pollForFreshCredential`.
 *
 * Polls the local config file every 500 ms for up to `timeoutMs` ms, looking
 * for a config whose `expiresAt` is strictly newer than `initialExpiresAt`.
 * Returns the fresh config, or `null` if the timeout elapses first.
 */
async function defaultPollForFreshCredential(
  initialExpiresAt: string,
  timeoutMs: number,
): Promise<SpellguardConfig | null> {
  const deadline = Date.now() + timeoutMs;
  const initialTs = new Date(initialExpiresAt).getTime();

  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  while (Date.now() < deadline) {
    await delay(500);
    const result = readConfig();
    if (
      result.config?.expiresAt &&
      new Date(result.config.expiresAt).getTime() > initialTs
    ) {
      return result.config;
    }
  }
  return null;
}
