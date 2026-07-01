// SPDX-License-Identifier: Apache-2.0

import type { SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  AGENT_CONTROL_CLOSE_CODES,
  AgentControlClient,
  type AgentControlClientOptions,
  type CredentialDeliveredFrame,
  type CredentialDescriptor,
  type GithubCredentialDescriptor,
} from '@spellguard/agent-control';
import {
  type SpellguardConfig,
  defaultConfigDir,
  markConfigRevoked,
  readConfig,
  writeConfig,
} from '../lib/config-store';
import {
  type DaemonResult,
  ensureCredentialDaemonRunning,
} from '../lib/daemon-spawn';
import { FRAMEWORK } from '../lib/plugin-sync';
import { probeAgentIdentity } from '../lib/probe-identity';
import { renderMessage } from '../lib/render-message';
import { ensureSqliteBackend } from '../lib/sqlite-self-install';
import { stopLocalDaemons } from '../lib/stop-daemons';

/**
 * Fallback base URL used when SPELLGUARD_BASE_URL is not set. Set
 * SPELLGUARD_BASE_URL (or pass --base-url) to point the plugin at a different
 * Spellguard environment.
 */
const DEFAULT_SPELLGUARD_BASE = (() => {
  const v = process.env.SPELLGUARD_BASE_URL;
  if (!v)
    throw new Error(
      'SPELLGUARD_BASE_URL is not set. Set it to your Spellguard console URL, e.g. export SPELLGUARD_BASE_URL=https://your-spellguard-console.example.com',
    );
  return v;
})();

/**
 * Poll GET /v1/bootstrap/channel-token/:nonce until the dashboard-side
 * /bootstrap/context call has minted the HMAC-signed channel token, then
 * return the pair the plugin needs to open the production WebSocket.
 *
 * The bootstrap WS route requires ?ct=&userId= when
 * BOOTSTRAP_CHANNEL_SECRET is set (production). The plugin has no way to
 * acquire those server-side, so it polls the endpoint every 2 s up to
 * 10 minutes.
 *
 * Exported for unit testing.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: long-poll loop with error handling + abort + retry
export async function pollChannelToken(
  apiBaseUrl: string,
  nonce: string,
  opts: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxAttempts?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{
  channelToken: string;
  userId: string;
  /** Real org ID returned by the server. Always present — the lobby
   *  validates ?orgId= against organization_members. */
  orgId: string;
  agentName: string;
  reason?: string;
  /** C9: bound EXISTING agent UUID on a select-existing reattach. When present,
   *  the channel MUST be opened with THIS id (not the locally-generated one) or
   *  the lobby's attach-upgrade rejects the URL/bound mismatch with a 401. */
  agentId?: string;
}> {
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 300; // ~10 minutes at 2 s
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBaseUrl.replace(/\/$/, '');
  const url = `${base}/v1/bootstrap/channel-token/${encodeURIComponent(nonce)}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const res = await fetchImpl(url).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as {
        channelToken?: string;
        userId?: string;
        orgId?: string;
        agentName?: string;
        reason?: string;
        agentId?: string;
      };
      // Require orgId — the server always returns it. Without it the
      // lobby's ?orgId= validation fails 403 before bootstrap_request lands.
      if (body.channelToken && body.userId && body.orgId && body.agentName) {
        return {
          channelToken: body.channelToken,
          userId: body.userId,
          orgId: body.orgId,
          agentName: body.agentName,
          reason: body.reason,
          agentId: body.agentId,
        };
      }
      // Successful response without required fields — treat as transient,
      // keep polling (matches previous behaviour).
    } else if (res && res.status !== 404) {
      // Fail fast on any non-2xx that isn't 404 (not-yet-minted).
      // 410 Gone (one-shot consumed) and all other terminal statuses must
      // stop the poll loop immediately.
      let errText = '';
      try {
        errText = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(
        `channel-token poll failed: ${res.status}${errText ? ` ${errText}` : ''}`,
      );
    }
    // Network error or 404 → continue polling (404 is the normal state
    // while the user hasn't yet visited /setup OR hasn't filled the form).
    if (attempt < maxAttempts - 1) {
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }
  }
  throw new Error(
    'Channel token not minted within 10 minutes — user may not have visited /setup in their browser or submitted the agent name form.',
  );
}

function generateNonce(): string {
  // 256-bit random nonce encoded as URL-safe base64 (43 chars, no padding).
  return randomBytes(32).toString('base64url');
}

/**
 * The initiating framework this plugin asserts at nonce-mint (P2-T7 / D17) is
 * just this plugin's canonical wire/DB slug ({@link FRAMEWORK}, underscore) —
 * the SAME value sent on the bootstrap_request frame. Recorded server-side on
 * the nonce via POST /v1/bootstrap/register-framework and used to scope the
 * dashboard's "select existing agent" list (FR-7) to same-framework agents
 * owned by the authenticated user. Plugin-asserted, NOT user-typed.
 */
const INITIATING_FRAMEWORK = FRAMEWORK;

/**
 * Record this plugin's initiating framework on the freshly-minted nonce so the
 * dashboard's "select existing agent" door can scope its list to same-framework
 * agents (P2-T7 / D17, FR-7). Best-effort: the framework drives ONLY the
 * select-existing affordance; a failure here must NOT block the create-new
 * bootstrap path (the dashboard simply shows the empty/create-new fallback).
 *
 * @internal Exported for unit testing.
 */
export async function registerInitiatingFramework(
  baseUrl: string,
  nonce: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, '');
  try {
    await fetchImpl(`${base}/v1/bootstrap/register-framework`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce, framework: INITIATING_FRAMEWORK }),
    });
  } catch {
    // Best-effort — never block bootstrap on the select-existing affordance.
  }
}

function dashboardUrl(baseUrl: string, nonce: string): string {
  // The dashboard's /setup page only consumes the
  // `bootstrap` (and legacy `error`) query params. An earlier revision
  // appended `additional_agent=true` for the three-way menu's option-2, but
  // the dashboard never read it and the exchange handler already supports
  // multi-agent provisioning via the agent-name field. The param is dropped
  // here to avoid implying a UX contract that does not exist.
  return `${baseUrl.replace(/\/$/, '')}/setup?bootstrap=${encodeURIComponent(nonce)}`;
}

/**
 * Menu choices.
 * 1 — print current identity and exit cleanly (no provisioning)
 * 2 — provision additional agent (browser flow; new row, existing config stays)
 * 3 — re-authorize (current replacement path; new config overwrites existing)
 */
export type ExistingConfigChoice =
  | 'print_identity'
  | 'provision_additional'
  | 'reauthorize';

export async function promptExistingConfigChoice(opts: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  promptFn?: (question: string) => Promise<string>;
}): Promise<ExistingConfigChoice> {
  const question = [
    'Spellguard: an existing credential is present. Choose an action:',
    '  1) Print current identity and exit',
    '  2) Provision an additional agent (the server keeps the existing agent; the credential stored on THIS machine is replaced)',
    '  3) Re-authorize (re-binds the same agent identity; only the secret rotates)',
    'Enter 1, 2, or 3: ',
  ].join('\n');

  // Without a promptFn we rely on readline over
  // stdin, which will hang indefinitely when stdin is not a TTY (e.g. piped
  // input, CI, non-interactive shells — including the skill, which ALWAYS
  // runs the wrapper without a TTY). Fail fast with the safest default —
  // 'print_identity' does not mutate server state — and tell the operator
  // how to act non-interactively (I14).
  if (!opts.promptFn && !process.stdin.isTTY) {
    renderMessage({
      level: 'warn',
      message:
        'Spellguard: an existing credential is present and no interactive terminal is available. Printing the current identity. To act on it non-interactively, re-run with --choice reauthorize | additional | print, or use /spellguard-reset to disconnect this machine.',
    });
    return 'print_identity';
  }

  const ask = opts.promptFn
    ? opts.promptFn
    : (q: string): Promise<string> => {
        const rl = createInterface({
          input: opts.input ?? process.stdin,
          output: opts.output ?? process.stdout,
        });
        return new Promise<string>((resolve) => {
          rl.question(q, (answer) => {
            rl.close();
            resolve(answer);
          });
        });
      };

  // Up to 3 retries on bad input before defaulting to print_identity
  // (the safest option — doesn't mutate server state).
  for (let i = 0; i < 3; i++) {
    const raw = (await ask(question)).trim();
    if (raw === '1') return 'print_identity';
    if (raw === '2') return 'provision_additional';
    if (raw === '3') return 'reauthorize';
    renderMessage({
      level: 'warn',
      message: `Spellguard: unrecognized choice "${raw}". Enter 1, 2, or 3.`,
    });
  }
  renderMessage({
    level: 'warn',
    message:
      'Spellguard: no valid choice after 3 attempts. Defaulting to "print identity and exit".',
  });
  return 'print_identity';
}

/**
 * Validate a `credential_delivered` frame and pull
 * out the GitHub credential + device token. Extracted from the main setup
 * flow so `runSpellguardSetup` stays under the cognitive-complexity budget
 * and so the structural validation has its own focused unit-test surface.
 *
 * Returns flattened fields rather than the descriptor itself so callers
 * don't need a non-null assertion on `scoped_token` (which the helper has
 * already verified is present).
 *
 * @internal Exported for unit testing only. Production callers should not
 * import this — use `runSpellguardSetup` instead.
 */
export type ExtractedBootstrapIdentity =
  | {
      ok: true;
      agentSecret: string;
      // Present only when a GitHub descriptor happens to be in the bootstrap
      // frame. The provider-agnostic protocol ships `credentials:
      // []` at bootstrap and delivers every provider credential later via
      // dedicated `credential_delivered` frames; for GitHub that channel-side
      // delivery is handled by the persistent `spellguard-credential-daemon`
      // (`handleCredentialUpdate` in agent-control/credential-handlers.ts).
      // When the daemon receives a GitHub descriptor through that path, it
      // writes the same `scopedToken` / `gitAuthorName` / `gitAuthorEmail`
      // fields this CLI used to write at bootstrap. Setup completes regardless
      // of whether the GitHub credential is present yet.
      ghCred?: GithubCredentialDescriptor;
    }
  | {
      ok: false;
      reason: 'malformed_credentials_array' | 'missing_agent_secret';
      message: string;
    };

/**
 * @internal Exported for unit testing only.
 *
 * Extract the bootstrap identity (agent_secret) from the bootstrap delivery
 * frame. A GitHub credential descriptor MAY also be present — this is the
 * legacy bootstrap-bundled path — and is returned alongside the identity for
 * the caller to persist. When absent (the default), the caller
 * writes the minimal identity-only config and the persistent credential
 * daemon will pick up the GitHub credential later when it arrives via a
 * dedicated `credential_delivered` frame.
 *
 * Defends against two malformed-response classes:
 *   1. `credentials` is not an array (wire-level corruption).
 *   2. Missing `agent_secret` on the bootstrap envelope (the server always
 *      sets it; absence means an out-of-date server build).
 */
export function extractBootstrapIdentity(frame: {
  credentials: ReadonlyArray<CredentialDescriptor>;
  agent_secret?: string;
}): ExtractedBootstrapIdentity {
  // Defend against `credentials` being non-array. The wire-level
  // type is `unknown` (the WebSocket frame is JSON.parse()'d), so a server
  // bug or middlebox could yield a malformed envelope. Without this check
  // the `.find(...)` below would throw a TypeError; we surface the typed
  // error instead so the setup CLI can render a helpful message.
  const rawCreds = (frame as { credentials?: unknown }).credentials;
  if (!Array.isArray(rawCreds)) {
    return {
      ok: false,
      reason: 'malformed_credentials_array',
      message:
        'Spellguard: bootstrap frame was malformed (missing credentials array). Re-run /spellguard-setup.',
    };
  }
  // agent_secret is required on bootstrap delivery — the server always
  // sets it. Absence means the plugin is talking to a pre-auth-consolidation
  // server build.
  if (!frame.agent_secret) {
    return {
      ok: false,
      reason: 'missing_agent_secret',
      message:
        'Spellguard: server bootstrap response missing agent_secret — out-of-date server version. Please upgrade the server and re-run /spellguard-setup.',
    };
  }
  // Optional GitHub descriptor — present only on legacy servers that still
  // bundle credentials with the bootstrap frame. Guard the read of
  // `.provider` against null/non-object entries in a malformed payload.
  const ghMaybe = rawCreds.find(
    (c): c is GithubCredentialDescriptor =>
      typeof c === 'object' &&
      c !== null &&
      (c as { provider?: unknown }).provider === 'github',
  );
  // An opt-in github descriptor is only usable if it carries the
  // structural fields the daemon expects. Otherwise we silently drop it
  // here and rely on the steady-state channel to deliver a well-formed
  // descriptor later; we never write partial garbage to the config.
  const pd = ghMaybe?.provider_data as
    | GithubCredentialDescriptor['provider_data']
    | null
    | undefined;
  const ghWellFormed =
    ghMaybe?.scoped_token &&
    pd &&
    typeof pd.git_author_name === 'string' &&
    pd.git_author_name.length > 0 &&
    typeof pd.git_author_email === 'string' &&
    pd.git_author_email.length > 0;
  return {
    ok: true,
    agentSecret: frame.agent_secret,
    ...(ghWellFormed ? { ghCred: ghMaybe } : {}),
  };
}

export interface SetupArgs {
  baseUrl?: string;
  /**
   * Override the WebSocket implementation used by AgentControlClient.
   * Preserved for backward compatibility with tests that pass it; forwarded
   * to AgentControlClientOptions.WebSocketImpl.
   */
  WebSocketImpl?: AgentControlClientOptions['WebSocketImpl'];
  /** Called each progress tick with elapsed seconds (test seam). */
  onProgress?: (elapsedSeconds: number) => void;
  /** Progress tick interval in ms (default 30 s). */
  intervalMs?: number;
  /** Test seam: override fetch for the channel-token poll. */
  fetchImpl?: typeof fetch;
  /** Test seam: override poll interval. */
  pollIntervalMs?: number;
  /** Test seam: cap poll attempts. */
  pollMaxAttempts?: number;
  /**
   * Override the three-way menu prompt for tests. When provided, the
   * setup flow does NOT read from stdin and instead calls this resolver.
   * Production callers leave this undefined and the skill uses `readline`.
   */
  existingConfigChoice?: () => Promise<ExistingConfigChoice>;
  /**
   * Override the agent UUID generated for the bootstrap. Useful in
   * integration tests so the caller can pass a pre-seeded agent UUID. When
   * omitted, a new UUIDv4 is generated via `crypto.randomUUID()`.
   */
  agentIdOverride?: string;
  /**
   * Test seam — forwarded to `ensureCredentialDaemonRunning`. Production
   * callers leave this undefined (detached `child_process.spawn` + unref).
   */
  spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => void;
  /**
   * Test seam — PID-file directory for the daemon spawn. Defaults to the
   * real config dir.
   */
  daemonConfigDir?: string;
  /**
   * How long to wait (ms) for the GitHub credential to land on disk after
   * the daemon is started. The dashboard wizard's "Connect GitHub" step
   * usually completes within a minute or two of bootstrap, so waiting lets
   * setup end with positive confirmation instead of a promise. `0` disables
   * the wait. Default: 5 minutes. Timing out is NOT a failure — identity
   * bootstrap already succeeded and the daemon keeps listening.
   */
  credentialWaitMs?: number;
  /** Poll interval for the credential wait (default 2 s). */
  credentialPollIntervalMs?: number;
  /**
   * Test seam — stale-daemon stop performed right before the new config is
   * written. Defaults to `stopLocalDaemons` (pidfile-driven SIGTERM).
   */
  stopDaemons?: (opts?: { configDir?: string }) => number[];
}

export interface SetupResult {
  ok: boolean;
  reason?: string;
  /**
   * Outcome of the credential-daemon start attempt. The daemon is the sole
   * consumer of channel-delivered credentials; setup MUST leave one running
   * (2026-06-11 incident: it didn't, and the pushed GitHub credential had no
   * consumer until the next session boundary).
   */
  daemon?: DaemonResult;
  /**
   * Where the GitHub credential stood when setup returned:
   * - 'bundled'   — legacy server shipped it inside the bootstrap frame;
   * - 'delivered' — the daemon wrote it to disk during the bounded wait;
   * - 'pending'   — not yet delivered; the daemon keeps listening and the
   *                 credential lands the moment the dashboard GitHub-App
   *                 install completes.
   */
  githubCredential?: 'delivered' | 'pending' | 'bundled';
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: top-level orchestration with multiple auth + retry branches
export async function runSpellguardSetup(
  args: SetupArgs = {},
): Promise<SetupResult> {
  const baseUrl = args.baseUrl ?? DEFAULT_SPELLGUARD_BASE;

  const existing = readConfig();
  // Set when the operator chose "re-authorize" against a live identity:
  // the bootstrap re-binds the SAME agent UUID (the server's
  // AgentControlChannelDO supports same-UUID re-bootstrap with secret
  // rotation), so re-auth stops conflicting with the agent's own name (I2).
  let reuseAgentId: string | undefined;
  let probeSaysGone = false;
  if (existing.config && !existing.config.revoked) {
    // Validate the stored identity server-side BEFORE offering the menu.
    // Local config can be stale: an agent deleted in the dashboard while
    // this machine was offline still has revoked:false here (I13). On
    // 'transient' (network blip / 5xx) fall back to the menu — never block
    // setup on a probe failure.
    const probe = await probeAgentIdentity({
      baseUrl: existing.config.spellguardBaseUrl ?? baseUrl,
      agentId: existing.config.agentId,
      agentSecret: existing.config.agentSecret,
      scopedTokenId: existing.config.scopedTokenId,
      fetchImpl: args.fetchImpl,
    });
    if (probe === 'gone') {
      markConfigRevoked();
      renderMessage({
        level: 'warn',
        message:
          'Spellguard: the stored agent is no longer recognized by the server (it was likely deleted or revoked in the dashboard). Starting fresh setup.',
      });
      probeSaysGone = true;
    }
  }
  if (existing.config && !existing.config.revoked && !probeSaysGone) {
    // Surface a numbered menu instead of printing a warning and
    // silently overwriting the existing credential.
    const choice = args.existingConfigChoice
      ? await args.existingConfigChoice()
      : await promptExistingConfigChoice({});
    if (choice === 'print_identity') {
      // Identity is always present (agentId, agentSecret). The GitHub
      // fields are optional under the new protocol — only printed when
      // the credential daemon has already received the GitHub descriptor
      // through the channel.
      const lines = [
        'Spellguard: current identity:',
        `  agent=${existing.config.agentId}`,
        `  config_dir=${defaultConfigDir()}`,
      ];
      if (existing.config.scopedTokenId) {
        lines.push(`  scoped_token_id=${existing.config.scopedTokenId}`);
      }
      if (existing.config.expiresAt) {
        lines.push(`  expires_at=${existing.config.expiresAt}`);
      }
      if (existing.config.scopeSummary) {
        lines.push(`  repos=${existing.config.scopeSummary.repos.join(', ')}`);
      } else {
        lines.push(
          '  github=not connected (complete the dashboard GitHub-App install to grant repo access)',
        );
      }
      lines.push(
        'No changes made. Re-run /spellguard-setup to choose a different action.',
      );
      renderMessage({ level: 'info', message: lines.join('\n') });
      return { ok: true, reason: 'print_identity' };
    }
    if (choice === 'provision_additional') {
      // NOTE: the dashboard flow itself distinguishes provision-additional from
      // re-authorize via the agent-name form field (different name → server
      // creates a new agent row; same name → upsert/replace). This CLI arm just
      // passes the user through to the same provisioning flow with guidance to
      // pick a unique agent name. The local config.json is unconditionally
      // overwritten at the end of the flow — storing multiple local
      // credentials is not currently supported.
      renderMessage({
        level: 'info',
        message:
          'Spellguard: provisioning an additional agent — choose a unique agent name in the browser form. Note: the local credential on this machine will be replaced by the new one at the end of the flow.',
      });
    } else {
      reuseAgentId = existing.config.agentId;
      renderMessage({
        level: 'info',
        message: `Spellguard: re-authorizing — the same agent identity (agent=${existing.config.agentId}) is re-used and only the secret rotates (the server defers rotation until after issuance, so a mid-flow failure does not strand the old secret).`,
      });
    }
  }

  // C3 — recover a revoked / self-wiped machine.
  //
  // A `revoked: true` config still carries the agent IDENTITY: the P2-T6
  // self-wipe (`markConfigSuperseded`) clears the credential material but
  // preserves agentId/agentSecret ON PURPOSE so this machine can RE-ATTACH to
  // its existing agent. The probe + menu
  // above are gated on `!revoked`, so without this branch a revoked config
  // fell straight through to a SILENT create-new bootstrap — the operator was
  // never told this re-run is a recovery and would naturally create a
  // brand-new, GitHub-pending orphan agent instead of re-attaching to (and
  // restoring the GitHub connection of) the existing one.
  //
  // So: surface the persisted cause (FR-10 re-surfaces it at SessionStart; we
  // repeat it here at the actionable moment) and point the operator at the
  // dashboard "Select an existing agent" door, which re-attaches this machine
  // (the daemon re-receives the rotated credential automatically — C12). We do
  // NOT reuse the stored agentId for the create-new bootstrap: per FR-10 the
  // machine "does not retry as the old identity", and that UUID still belongs
  // to the live agent server-side, so a same-UUID create-new would collide /
  // rebind it. The select-existing door returns the canonical agent id via the
  // poll (C9) and overrides the locally-generated UUID below.
  if (existing.config?.revoked) {
    const cause = existing.config.revokedMessage
      ? `Spellguard: ${existing.config.revokedMessage}`
      : "Spellguard: this machine's Spellguard credential was revoked.";
    renderMessage({
      level: 'warn',
      message: `${cause}\n\nRe-running setup to RECONNECT this machine. In the browser, choose "Select an existing agent" to re-attach to your existing agent — it keeps the agent's history and restores its GitHub connection automatically. Only choose "Create a new agent" if you intend to provision a brand-new, separate agent.`,
    });
  }

  // The plugin generates the agentId UUID end-to-end. This UUID is used as
  // both the DO room key and the `agents.id` in the DB — the server must never
  // rebind it. A test override is available via `args.agentIdOverride`.
  // Re-authorize re-binds the stored UUID (I2); the probe above guarantees
  // a deleted agent's UUID is never re-bound (probe-gone skips the menu and
  // `reuseAgentId` stays unset).
  // For create-new this is the id end-to-end; for a select-existing reattach the
  // poll below overrides it with the bound EXISTING agent id (C9) before the
  // channel opens, since the lobby's attach-upgrade keys on that id.
  let agentId = args.agentIdOverride ?? reuseAgentId ?? crypto.randomUUID();

  const nonce = generateNonce();
  // P2-T7 / D17: record this plugin's initiating framework on the nonce so the
  // dashboard's "select existing agent" door can scope its list (FR-7).
  // Best-effort; never blocks the create-new bootstrap path.
  await registerInitiatingFramework(baseUrl, nonce, {
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  const url = dashboardUrl(baseUrl, nonce);
  renderMessage({
    level: 'info',
    message: `Spellguard: open this URL in your browser to complete setup:\n  ${url}\n\nWaiting up to 10 minutes for browser approval and agent name…`,
  });

  const start = Date.now();
  const intervalMs = args.intervalMs ?? 30_000;
  const interval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    renderMessage({
      level: 'info',
      message: `Spellguard: still waiting for browser approval (${m}m ${s}s elapsed of 10m).`,
    });
    args.onProgress?.(elapsedSec);
  }, intervalMs);

  // Acquire the HMAC-signed channel token AND user-supplied
  // agent metadata before opening the WS. The server's production WS route
  // requires ?ct=&orgId= (verified via BOOTSTRAP_CHANNEL_SECRET).
  // /bootstrap/context mints the token server-side when the user visits /setup;
  // the token is gated behind agentName so the poll returns 404 until the user
  // has also submitted the Setup form. We poll the /bootstrap/channel-token
  // endpoint to pick up both.
  let channelToken: string;
  let orgId: string;
  let agentName: string;
  let statementOfReason: string | undefined;
  // C10: true when the poll resolves to a select-existing reattach (bound agent
  // id present) — suppresses the create-new bootstrap_request downstream.
  let isReattach = false;
  try {
    // userId is returned by the poll but not needed by AgentControlClient —
    // the ct + orgId query params carry the authenticated identity.
    const polled = await pollChannelToken(baseUrl, nonce, {
      fetchImpl: args.fetchImpl,
      pollIntervalMs: args.pollIntervalMs,
      maxAttempts: args.pollMaxAttempts,
    });
    channelToken = polled.channelToken;
    // Use the server-returned orgId. It is always present; the lobby
    // validates ?orgId= against organization_members.
    orgId = polled.orgId;
    agentName = polled.agentName;
    statementOfReason = polled.reason;
    // C9: a select-existing reattach binds the nonce to an EXISTING agent; the
    // poll returns that agent's id. Open the agent-control channel with THAT id
    // (the lobby's attach-upgrade rejects a URL/bound id mismatch with a 401),
    // overriding the locally-generated UUID. Absent for create-new bootstraps.
    if (polled.agentId) {
      agentId = polled.agentId;
      isReattach = true;
    }
  } catch (e) {
    clearInterval(interval);
    renderMessage({
      level: 'error',
      message: `Spellguard: bootstrap timed out waiting for browser approval (${(e as Error).message}). Re-run /spellguard-setup to try again.`,
    });
    return { ok: false, reason: (e as Error).message };
  }

  // Use AgentControlClient in nonce mode.
  // The client sends `bootstrap_request{agent_name, statement_of_reason}`
  // automatically on the first open, using the values the user filled in the
  // Setup form (polled from the channel token endpoint above).
  const result = await awaitBootstrapViaClient({
    apiBaseUrl: baseUrl,
    agentId,
    nonce,
    channelToken,
    orgId,
    agentName,
    statementOfReason,
    WebSocketImpl: args.WebSocketImpl,
    expectReBootstrap: isReattach,
  });

  clearInterval(interval);

  if (!result.ok) {
    renderMessage({ level: 'error', message: result.message });
    return { ok: false, reason: result.reason };
  }

  const { frame } = result;
  const extracted = extractBootstrapIdentity(frame);
  if (!extracted.ok) {
    renderMessage({ level: 'error', message: extracted.message });
    return { ok: false, reason: extracted.reason };
  }
  const { agentSecret, ghCred } = extracted;

  // The bootstrap frame ships the agent identity (agent_secret,
  // agent_name) but NOT a GitHub credential by default — provider
  // credentials arrive later as separate `credential_delivered` frames
  // through the persistent credential daemon. Write the identity-only
  // config so the daemon has what it needs to authenticate (agentId +
  // agentSecret + spellguardBaseUrl); the daemon's `handleCredentialUpdate`
  // populates `scopedToken` / `gitAuthorName` / `gitAuthorEmail` /
  // `scopeSummary` when the GitHub credential is later delivered (via the
  // dashboard's GitHub-App install OAuth callback at
  // `POST /v1/integrations/github/complete-install`, which broadcasts the
  // descriptor to the agent channel).
  //
  // The `ghCred` branch handles legacy servers that still bundle the
  // GitHub credential with the bootstrap frame: we persist the GitHub
  // fields inline so the daemon can use them immediately. Operators on a
  // current server walk through the dashboard "Connect GitHub" step after
  // bootstrap.
  // D16/UT-013: a re_bootstrap (select-existing attach) frame carries the
  // server-canonical selected `agent_id` as a top-level field — prefer it so an
  // identity-only agent (no credential descriptor to relay the id) is persisted
  // on the correct channel. It equals the URL `agentId` on every well-formed
  // attach; the fallback keeps a first-run bootstrap (no top-level agent_id)
  // working unchanged.
  const resolvedAgentId = frame.agent_id ?? agentId;
  const writtenConfig: SpellguardConfig = {
    agentId: resolvedAgentId,
    agentSecret,
    agentName: frame.agent_name,
    spellguardBaseUrl: baseUrl,
    revoked: false,
    // Persist the bootstrap-frame seq + known_credentials projection
    // so the daemon's first connect can send a real Resume frame. Without
    // this, the daemon sends Resume{0, []}, the server's divergence check
    // fires on every cold start, and any frame pushed between bootstrap
    // and daemon attach is lost without these fields.
    lastServerSeq: frame.seq,
    knownCredentials: ghCred
      ? [
          {
            provider: ghCred.provider,
            scoped_token_id: ghCred.scoped_token_id ?? ghCred.credential_id,
          },
        ]
      : [],
    // Legacy-server fallthrough: bundle the GitHub fields when the frame
    // happens to carry them.
    ...(ghCred
      ? {
          scopedToken: ghCred.scoped_token,
          scopedTokenId: ghCred.scoped_token_id ?? ghCred.credential_id,
          expiresAt: ghCred.expires_at,
          scopeSummary: ghCred.scope_summary,
          gitAuthorName: ghCred.provider_data.git_author_name,
          gitAuthorEmail: ghCred.provider_data.git_author_email,
        }
      : {}),
  };
  // Stop any stale daemon for the OLD identity before the config write —
  // a still-running daemon would race its own handleCredentialUpdate config
  // writes against the new identity (plan Task 2.10). Best-effort: pidfile
  // driven, tolerant of dead pids. The NEW daemon starts right after the
  // write below.
  try {
    (args.stopDaemons ?? stopLocalDaemons)({
      configDir: args.daemonConfigDir,
    });
  } catch {
    /* best-effort */
  }
  writeConfig(writtenConfig);

  // Start the credential daemon NOW — setup must not depend on the next
  // SessionStart hook for this. SessionStart fires only on
  // startup/resume/clear/compact, never on `/reload-plugins`, so on a fresh
  // mid-session install nothing else can start a daemon before the user's
  // next session — and the GitHub credential the dashboard pushes right
  // after this flow would sit queued server-side with no consumer
  // (2026-06-11 incident).
  // CLAUDE_ENV_FILE is hook-only and typically absent here; the daemon
  // tolerates that by skipping env-file updates (the next SessionStart hook
  // injects the git-credential env for its session).
  const daemonResult = ensureCredentialDaemonRunning({
    config: writtenConfig,
    cwd: process.cwd(),
    envFilePath: process.env.CLAUDE_ENV_FILE,
    spawnDaemon: args.spawnDaemon,
    configDir: args.daemonConfigDir,
  });

  // Ensure the local code-attribution store has a usable SQLite backend.
  // On a marketplace install (bare clone of the committed dist/, no
  // pnpm install) there's no vendored better-sqlite3; if this Node also
  // lacks flag-free node:sqlite, fine-grained commit attribution would
  // silently degrade. Self-install the prebuilt better-sqlite3 binary here,
  // best-effort — a failure must never fail setup.
  await ensureAttributionBackend();

  if (ghCred) {
    // Legacy-server path: the GitHub credential arrived bundled with the
    // bootstrap frame and is already on disk — nothing to wait for.
    const lines = [`Spellguard: agent provisioned (agent=${agentId}).`];
    const authorName = ghCred.provider_data.git_author_name;
    const authorEmail = ghCred.provider_data.git_author_email;
    if (authorName && authorEmail) {
      lines.push(
        `  Commits will be authored as: ${authorName} <${authorEmail}>`,
      );
    }
    lines.push(
      '  Restart your Claude Code session for credentials to take effect.',
    );
    renderMessage({ level: 'info', message: lines.join('\n') });
    return { ok: true, daemon: daemonResult, githubCredential: 'bundled' };
  }

  // New-protocol path: identity is written but no provider credential yet.
  // The operator wires GitHub via the dashboard's Connect step; the daemon
  // we just started writes the credential to disk the moment it arrives.
  const daemonLine =
    daemonResult.daemon === 'spawned'
      ? '  The credential daemon is now running and listening for it.'
      : daemonResult.daemon === 'already-running'
        ? `  The credential daemon is already running (pid ${daemonResult.pid}) and listening for it.`
        : `  WARNING: the credential daemon could not be started (${daemonResult.reason}); restart your session so the SessionStart hook can start it.`;
  renderMessage({
    level: 'info',
    message: [
      `Spellguard: agent provisioned (agent=${agentId}).`,
      '  Next: open the dashboard and connect GitHub on this agent to grant',
      '  repo access — the GitHub credential lands in your local config the',
      '  moment that completes.',
      daemonLine,
    ].join('\n'),
  });

  // Bounded wait for the dashboard's GitHub connect step, so the wizard flow
  // ends with positive confirmation when possible. Skipped when the daemon
  // isn't running (nothing can deliver) or when disabled via args.
  const waitMs = args.credentialWaitMs ?? DEFAULT_CREDENTIAL_WAIT_MS;
  let delivered: SpellguardConfig | null = null;
  if (daemonResult.daemon !== 'skipped' && waitMs > 0) {
    renderMessage({
      level: 'info',
      message: `Spellguard: waiting up to ${Math.round(waitMs / 60_000)} minute(s) for the GitHub credential (Ctrl-C is safe — the daemon keeps listening)…`,
    });
    delivered = await waitForGithubCredential(
      waitMs,
      args.credentialPollIntervalMs ?? 2_000,
    );
  }

  if (delivered?.scopeSummary) {
    const author =
      delivered.gitAuthorName && delivered.gitAuthorEmail
        ? ` Commits will be authored as: ${delivered.gitAuthorName} <${delivered.gitAuthorEmail}>.`
        : '';
    renderMessage({
      level: 'info',
      message: `Spellguard: GitHub credential received — repos=[${delivered.scopeSummary.repos.join(', ')}].${author}\n  Git-credential protection for this session finishes wiring at the next session start (restart or /clear).`,
    });
    return { ok: true, daemon: daemonResult, githubCredential: 'delivered' };
  }

  renderMessage({
    level: 'info',
    message: [
      'Spellguard: GitHub credential not delivered yet — that is fine. The',
      '  daemon keeps listening and writes it to your local config the moment',
      '  the dashboard GitHub-App install completes. Git-credential protection',
      '  for this session finishes wiring at the next session start (restart',
      '  or /clear); re-run /spellguard-setup any time to check status.',
    ].join('\n'),
  });
  return { ok: true, daemon: daemonResult, githubCredential: 'pending' };
}

/** Default bounded wait for the dashboard "Connect GitHub" step: 5 minutes. */
const DEFAULT_CREDENTIAL_WAIT_MS = 5 * 60_000;

/**
 * Poll the local config until the credential daemon has written the GitHub
 * credential (`scopedToken` present), or until `timeoutMs` elapses.
 * Returns the fresh config, or null on timeout. Reads the CONFIG FILE — the
 * consuming surface — rather than the socket, per the credential-flow
 * checklist's "effect on consuming application" layer.
 */
async function waitForGithubCredential(
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<SpellguardConfig | null> {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastProgressAt = started;
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  while (Date.now() < deadline) {
    const result = readConfig();
    if (result.config?.scopedToken) return result.config;
    if (Date.now() - lastProgressAt >= 30_000) {
      lastProgressAt = Date.now();
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      renderMessage({
        level: 'info',
        message: `Spellguard: still waiting for the GitHub credential (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s elapsed) — complete the dashboard "Connect GitHub" step.`,
      });
    }
    await delay(pollIntervalMs);
  }
  return null;
}

/**
 * Make sure the local per-line code-attribution store has a usable SQLite
 * backend, self-installing `better-sqlite3` (prebuilt binary, no compile) into
 * the plugin root when none is present. Fully best-effort: any failure prints
 * a friendly "attribution will be degraded" note and returns — it must never
 * fail `/spellguard-setup`.
 *
 * @internal Exported for unit testing.
 */
export async function ensureAttributionBackend(opts?: {
  ensure?: typeof ensureSqliteBackend;
}): Promise<void> {
  const ensure = opts?.ensure ?? ensureSqliteBackend;
  let result: Awaited<ReturnType<typeof ensureSqliteBackend>>;
  try {
    result = await ensure();
  } catch (err) {
    // Defensive: ensureSqliteBackend already swallows its own errors, but if
    // anything unexpected throws we still must not fail setup.
    renderMessage({
      level: 'warn',
      message: `Spellguard: could not verify the code-attribution database backend (${(err as Error).message}). Fine-grained commit attribution will be degraded; it self-heals on Node 24+ or after a local clone + \`pnpm install\`.`,
    });
    return;
  }

  if (result.status === 'already') {
    // A backend was already usable (node:sqlite flag-free, or better-sqlite3
    // already vendored/installed). Nothing to do, nothing to announce.
    return;
  }
  if (result.status === 'installed') {
    renderMessage({
      level: 'info',
      message:
        'Spellguard: installed the code-attribution database backend (better-sqlite3, prebuilt binary). Per-line commit attribution is enabled.',
    });
    return;
  }
  // skipped / failed — degrade gracefully with actionable guidance.
  renderMessage({
    level: 'warn',
    message: `Spellguard: could not install the code-attribution database backend (${result.reason ?? 'unknown reason'}). Fine-grained commit attribution will be degraded. To enable it: upgrade to Node 24+ (built-in SQLite), or clone the plugin repo and run \`pnpm install\` so the native backend is present.`,
  });
}

// ── AgentControlClient-based bootstrap helper ──────────────────────────

type BootstrapClientResult =
  | {
      ok: true;
      /**
       * The credential-delivery frame that completes setup. Either a first-run
       * `cause:'bootstrap'` OR a self-installed select-existing-attach
       * `cause:'re_bootstrap'` (CXq-H2 / FIX C) — both carry the agent_secret +
       * agent_name the plugin persists; re_bootstrap additionally carries the
       * selected top-level `agent_id` (D16/UT-013).
       */
      frame: CredentialDeliveredFrame & { cause: 'bootstrap' | 're_bootstrap' };
    }
  | { ok: false; reason: string; message: string };

/**
 * Opens the persistent agent-control socket in nonce mode and waits for
 * the server to push `credential_delivered{cause:'bootstrap'}`.
 *
 * The client sends `bootstrap_request{agent_name, statement_of_reason}`
 * automatically after the first `Hello` frame (see AgentControlClient#onOpen).
 * The agent_name and statement_of_reason come from the dashboard form — polled
 * via /bootstrap/channel-token — so the server receives real user-supplied
 * values rather than server-generated defaults.
 *
 * On success the outer `runSpellguardSetup` persists the credential +
 * device_token.
 *
 * On any fatal server frame (`error` via `onFatalClose`, or an `onError`
 * from the frame dispatcher), the promise rejects with a typed result.
 * There is a 10-minute overall timeout matching the legacy behaviour.
 *
 * @internal Not exported — call `runSpellguardSetup`.
 */
async function awaitBootstrapViaClient(opts: {
  apiBaseUrl: string;
  agentId: string;
  nonce: string;
  channelToken: string;
  orgId: string;
  /** Agent name collected from the dashboard Setup form. */
  agentName?: string;
  /** Optional reason collected from the dashboard Setup form. */
  statementOfReason?: string;
  WebSocketImpl?: AgentControlClientOptions['WebSocketImpl'];
  timeoutMs?: number;
  /** C10: select-existing reattach — suppress the create-new bootstrap_request
   *  so the server's auto-delivered re_bootstrap isn't blocked + rejected. */
  expectReBootstrap?: boolean;
}): Promise<BootstrapClientResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<BootstrapClientResult>((resolve) => {
    let settled = false;
    let client: AgentControlClient | null = null;

    const settle = (result: BootstrapClientResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        reason: 'bootstrap_timeout',
        message:
          'Spellguard: bootstrap timed out or channel unavailable (bootstrap_timeout). Re-run /spellguard-setup to try again.',
      });
    }, timeoutMs);

    client = new AgentControlClient({
      apiBaseUrl: opts.apiBaseUrl,
      agentId: opts.agentId,
      credentials: () => ({
        mode: 'nonce',
        nonce: opts.nonce,
        channelToken: opts.channelToken,
        orgId: opts.orgId,
        ...(opts.agentName ? { agentName: opts.agentName } : {}),
        ...(opts.statementOfReason
          ? { statementOfReason: opts.statementOfReason }
          : {}),
        // Record the correct agents.framework at creation (REQ-FI) instead of
        // the server's hardcoded default; plugin-sync reconciles to the same
        // canonical value on startup.
        framework: FRAMEWORK,
        // C10: on a select-existing reattach the server auto-delivers
        // re_bootstrap — do not send (and get rejected on) a bootstrap_request.
        ...(opts.expectReBootstrap ? { expectReBootstrap: true } : {}),
      }),
      onCredentialDelivered: (frame) => {
        // CXq-H2 (FIX C): complete setup on BOTH a first-run bootstrap AND a
        // self-installed select-existing-attach re_bootstrap delivery. Both
        // carry the agent_secret + agent_name (and re_bootstrap also the
        // top-level agent_id) the plugin persists to disk. Treating re_bootstrap
        // as success is what makes "attach to an existing agent" actually
        // finish — the credential arrives but the CLI used to ignore it and
        // time out.
        if (frame.cause !== 'bootstrap' && frame.cause !== 're_bootstrap') {
          // Not a delivery we're waiting for — ignore (shouldn't happen on a
          // fresh nonce-mode channel, but defensive against replays).
          return;
        }
        settle({
          ok: true,
          frame: frame as CredentialDeliveredFrame & {
            cause: 'bootstrap' | 're_bootstrap';
          },
        });
      },
      onSeqAdvanced: (_seq) => {
        // No cursor persistence during first-run setup — the config is
        // written atomically by `runSpellguardSetup` after we resolve.
      },
      onFatalClose: (code, reason) => {
        // Map fatal close codes to specific, actionable user copy.
        // A blanket "timed out or channel unavailable" message for
        // every code would hide the typed bootstrap-error reasons
        // surfaced through 4400 BOOTSTRAP_ERROR (nonce_already_used,
        // agent_id_conflict, kms_error, etc.). Users with a real auth or
        // protocol failure saw "timed out" and re-ran setup blindly.
        // RESUME_WINDOW_EXCEEDED is no longer in FATAL_CLOSE_CODES (the
        // client soft-recovers), so it never reaches this hook.
        let message: string;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            // 4400 — server sends a typed reason describing exactly what
            // failed (e.g. "nonce_already_used", "agent_id_conflict",
            // "kms_error"). Surface the reason verbatim so users can act
            // on it rather than guessing.
            message = `Spellguard bootstrap failed: ${reason || 'unknown error'}. Re-run /spellguard-setup to try again.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            // 4401 — nonce/secret rejected. Typically a nonce already
            // consumed by another session or an expired bootstrap window.
            message = `Spellguard: authentication failed (${reason || 'auth_failed'}); the nonce may already have been consumed by another session. Re-run /spellguard-setup.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            // 4403 — the agent_id in the URL doesn't belong to this user/org.
            message = `Spellguard: agent ownership check failed (${reason || 'agent_ownership'}). Confirm you're signed in to the correct organization and re-run /spellguard-setup.`;
            break;
          default:
            // Fallback for any unmapped fatal code — surface code + reason
            // so we don't lose information.
            message = `Spellguard: bootstrap channel closed unexpectedly (code=${code}${reason ? `, reason=${reason}` : ''}). Re-run /spellguard-setup to try again.`;
        }
        settle({
          ok: false,
          reason: reason || String(code),
          message,
        });
      },
      onError: (err) => {
        // Informational — the fatal path is onFatalClose. Server-emitted
        // `error` frames arrive here as a parsed Error from #dispatch.
        // If the error message looks like a server error code, surface it.
        const msg = err.message ?? '';
        if (msg.includes('server:')) {
          settle({
            ok: false,
            reason: msg,
            message: buildServerErrorMessage(msg),
          });
          return; // server errors are terminal — skip the generic warn below
        }
        // Otherwise just log; the timeout covers non-recoverable stalls.
        renderMessage({
          level: 'warn',
          message: `Spellguard: bootstrap channel error: ${msg}`,
        });
      },
      ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
    });

    client.start();
  });
}

/**
 * Map a server-emitted error string to a user-facing message.
 * The server sends `error` frames as `"server: <code>: <message>"` via
 * AgentControlClient's #dispatch.
 */
function buildServerErrorMessage(errMsg: string): string {
  // Extract the code portion from "server: <code>: <message>".
  const codeMatch = /server:\s*([^:]+):/.exec(errMsg);
  const code = codeMatch?.[1]?.trim() ?? '';

  if (code === 'not_in_org') {
    return 'Spellguard: you are not a member of any Spellguard organization. Ask your admin to invite you, then re-run /spellguard-setup.';
  }
  if (code === 'nonce_expired') {
    return 'Spellguard: bootstrap timed out (nonce expired). Re-run /spellguard-setup.';
  }
  if (code === 'github_consent_declined') {
    return 'Spellguard: GitHub authorization was declined. Re-run /spellguard-setup to retry.';
  }
  if (code === 'sso_failure') {
    return 'Spellguard: SSO failed mid-setup. Re-run /spellguard-setup.';
  }
  if (code === 'session_mismatch') {
    return 'Spellguard: the browser session that completed setup does not match the one that started it. Sign in to the Spellguard dashboard with the same account, then re-run /spellguard-setup.';
  }
  if (code === 'membership_lost') {
    return 'Spellguard: your organization membership was revoked during setup. Contact your organization admin, then re-run /spellguard-setup.';
  }
  if (code === 'github_exchange_failed') {
    return 'Spellguard: GitHub rejected the authorization code (likely transient). Re-run /spellguard-setup and complete the GitHub consent screen again.';
  }
  if (code === 'github_identity_failed') {
    return 'Spellguard: could not read your GitHub identity (GitHub /user call failed). Re-run /spellguard-setup; if this keeps happening, contact support.';
  }
  if (code === 'validation_error') {
    return 'Spellguard: the setup link was malformed or expired. Re-run /spellguard-setup to get a fresh link.';
  }
  return `Spellguard setup failed: ${errMsg}`;
}
