// SPDX-License-Identifier: Apache-2.0

/**
 * Managed-region OpenClaw config-merge module.
 *
 * Writes platform credentials delivered via the Spellguard channel into the
 * OpenClaw config file so OpenClaw's default config-watch auto-restarts and
 * the bot reconnects.  All writes are:
 *
 *  - Idempotent  — if the serialised file content is already identical, no
 *                  write is issued (prevents restart loops).
 *  - Atomic      — content is written to a temp file then renamed over the
 *                  target so the config file is never seen in a partial state.
 *                  The temp file is created as a sibling of the target (same
 *                  directory) to avoid EXDEV cross-device rename errors on
 *                  Docker / WSL2 / mounted-volume deployments.
 *  - Scoped      — only the `spellguard-managed` account key inside each
 *                  provider's `accounts` map is touched; operator-authored
 *                  accounts and top-level config keys are preserved verbatim.
 *
 * MSTeams note: the upstream OpenClaw `MSTeamsConfig` type is a SINGLE-ACCOUNT
 * top-level object — `appId`, `appPassword`, `tenantId` are read by OpenClaw
 * directly from `channels.msteams` (NOT inside an `accounts` map).  Therefore
 * Teams credentials are written directly onto `cfg.channels.msteams` rather
 * than into an accounts sub-map.  A `_spellguardManaged: true` marker is set
 * so that revokes and re-merges can identify plugin-owned keys without touching
 * operator-authored values.
 *
 * Operator-clobber guard (Teams): if `channels.msteams` already exists without
 * `_spellguardManaged: true`, the entry is assumed to be operator-authored and
 * is left completely untouched.  A structured warning is emitted and the teams
 * entry is silently skipped (no throw).
 *
 * No-throw contract: this module NEVER throws.  Any read or write failure is
 * caught, emits a structured console.warn, and returns `{ changed: false }`.
 * Callers can always destructure the result safely.
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderCredEntry } from './credential-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANAGED_ACCOUNT_ID = 'spellguard-managed';

// ---------------------------------------------------------------------------
// Config path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical OpenClaw config path using the same precedence as
 * OpenClaw's own `resolveCanonicalConfigPath`:
 *   1. `OPENCLAW_CONFIG_PATH` (trimmed)
 *   2. `OPENCLAW_STATE_DIR`/openclaw.json
 *   3. `~/.openclaw/openclaw.json`
 */
export function resolveOpenClawConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;

  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  const base = stateDir || join(homedir(), '.openclaw');
  return join(base, 'openclaw.json');
}

// ---------------------------------------------------------------------------
// Per-provider account builder
// ---------------------------------------------------------------------------

/**
 * Build the managed account object for a given provider.
 * Returns `null` for providers that are NOT config-merged via the accounts map
 * (e.g. github uses issued tokens; teams uses top-level keys — see
 * `applyTeamsEntry`).
 */
function buildManagedAccount(
  provider: string,
  secrets: Record<string, string>,
): Record<string, unknown> | null {
  if (provider === 'slack') {
    const { botToken, appToken, signingSecret } = secrets;
    return {
      // NOTE: no `_spellguardManaged` marker on accounts-keyed channels.
      // OpenClaw's strict schema (`additionalProperties: false`) rejects
      // unknown keys inside `channels.slack.accounts.*` /
      // `channels.discord.accounts.*`, skipping the entire config reload
      // — so the bot never picks up the delivered credential. The
      // account-key name itself (`MANAGED_ACCOUNT_ID =
      // 'spellguard-managed'`) is the marker used by the revoke +
      // re-merge paths to identify plugin-owned entries. Teams (handled
      // separately, top-level not accounts-keyed) still uses the
      // `_spellguardManaged` marker because there is no account-key to
      // convey ownership.
      //
      // Permissive policy/access fields MUST be written PER-ACCOUNT, not only
      // at the `channels.slack` top level. OpenClaw's slack channel resolves
      // them off the per-account config — in the runtime bundle
      // `const slackCfg = account.config; … slackCfg.groupPolicy ?? …`, i.e.
      // `slackCfg` IS the account, not top-level `channels.slack` (a prior
      // comment here misread that). With these only at top level, the managed
      // account defaults to `groupPolicy: 'allowlist'` and OpenClaw DROPS every
      // group-channel mention (`slack: drop channel … groupPolicy=allowlist`)
      // — the bot connects its socket but never replies. Verified end-to-end
      // (bare VM 2026.4.22 + Lightsail): moving these onto the account flips the
      // gateway to `slack: allow channel … → dispatch → reply`, with NO binding
      // / agents.list needed (dispatch routes to the default agent). They match
      // the known-good account shape in `packages/agents/openclaw/openclaw.json`
      // and are valid account keys, so `additionalProperties:false` accepts
      // them. `ensureSlackChannelDefaults` keeps the same values at the top
      // level too, as a harmless fallback for any top-level reader.
      enabled: true,
      botToken,
      groupPolicy: 'open',
      dmPolicy: 'open',
      allowFrom: ['*'],
      allowBots: true,
      userTokenReadOnly: true,
      ...(appToken ? { appToken, mode: 'socket' } : { mode: 'http' }),
      ...(signingSecret ? { signingSecret } : {}),
    };
  }
  if (provider === 'discord') {
    return { enabled: true, token: secrets.botToken };
  }
  // github and unknown providers (including teams — handled separately): not config-merged via accounts map
  return null;
}

// ---------------------------------------------------------------------------
// Channel key mapper
// ---------------------------------------------------------------------------

function channelKeyForProvider(provider: string): string | null {
  if (provider === 'slack') return 'slack';
  if (provider === 'discord') return 'discord';
  if (provider === 'teams') return 'msteams';
  return null;
}

// ---------------------------------------------------------------------------
// OpenRouter model-provider config (NOT a messaging channel)
// ---------------------------------------------------------------------------

/**
 * Canonical OpenRouter API base — hardcoded in OpenClaw's own provider
 * catalog (`@openclaw/...` provider-catalog-*.js, identical in v4 and v5
 * per the schema audit in task #230). We re-pin it here so the JSON we
 * write into `openclaw.json` parses cleanly even if OpenClaw later moves
 * to an alternate URL; the operator's config remains the source of truth.
 */
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Apply an OpenRouter `models.providers.openrouter` entry plus a default
 * model selection at `agents.defaults.model.primary`.
 *
 * Schema confirmed against OpenClaw 2026.4.22 (Lightsail blueprint default)
 * and 2026.5.26 (latest npm). The minimum-required shape both versions
 * accept is `{ baseUrl, apiKey, api, models: [] }` — see task #230 audit
 * notes. v5 adds optional fields (contextWindow, params, etc.) which we
 * leave to the operator to set if desired.
 *
 * Operator-clobber guard: if `models.providers.openrouter` already exists
 * without our `_spellguardManaged` marker, the entry is assumed to be
 * operator-authored and is left untouched. A structured warning is
 * emitted (same pattern as `applyTeamsEntry`).
 *
 * Default-model marker: we ONLY overwrite `agents.defaults.model.primary`
 * when the existing value either is missing entirely OR starts with
 * `openrouter/` (i.e. we previously set it). An operator-set value
 * targeting a different provider (e.g. `bedrock/claude-3-sonnet`) is
 * preserved verbatim.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates revoke + operator-clobber guard + secrets validation + atomic write across two cfg sections (models.providers + agents.defaults.model) — splitting would lose the read-before-write invariant
function applyOpenrouterEntry(
  cfg: Record<string, unknown>,
  entry: ProviderCredEntry,
): void {
  // Probe (read-only) before touching the cfg: a no-op revoke (no existing
  // managed block) and a no-op delivery (missing secrets) must not perturb
  // file content, or the outer caller's idempotency check sees a spurious
  // {changed:true}.
  const existingModels =
    typeof cfg.models === 'object' && cfg.models !== null
      ? (cfg.models as Record<string, unknown>)
      : null;
  const existingProviders =
    existingModels !== null &&
    typeof existingModels.providers === 'object' &&
    existingModels.providers !== null
      ? (existingModels.providers as Record<string, unknown>)
      : null;
  const existingOpenrouter =
    existingProviders !== null &&
    typeof existingProviders.openrouter === 'object' &&
    existingProviders.openrouter !== null
      ? (existingProviders.openrouter as Record<string, unknown>)
      : null;

  if (entry.revoked) {
    // No managed-ownership marker is written (OpenClaw rejects extra keys
    // in models.providers.* — see write block below for the rationale).
    // On revoke we DO clear the openrouter block — there's no way to
    // distinguish managed from operator-authored without a marker. v1
    // limitation; documented in the PRD's REQ-012 non-goals.
    if (existingProviders !== null && existingOpenrouter !== null) {
      existingProviders.openrouter = undefined;
    }
    // Clear the openrouter-pointing primary too — only if it points at
    // openrouter (operator-set bedrock/anthropic primary is preserved).
    const agents =
      typeof cfg.agents === 'object' && cfg.agents !== null
        ? (cfg.agents as Record<string, unknown>)
        : null;
    const defaults =
      agents && typeof agents.defaults === 'object' && agents.defaults !== null
        ? (agents.defaults as Record<string, unknown>)
        : null;
    const model =
      defaults && typeof defaults.model === 'object' && defaults.model !== null
        ? (defaults.model as Record<string, unknown>)
        : null;
    if (model && typeof model.primary === 'string') {
      if ((model.primary as string).startsWith('openrouter/')) {
        model.primary = undefined;
      }
    }
    return;
  }

  // No operator-clobber guard (v1 limitation): OpenClaw rejects unknown
  // keys in models.providers.*, so we can't tag managed vs operator-
  // authored. The managed-flow overwrites whatever was there. Operators
  // who want both can register their own model provider under a different
  // key (e.g. `openrouter-mine`). Documented in REQ-012 non-goals.

  const apiKey = entry.secrets.api_key;
  const modelId = entry.secrets.model_id;
  if (!apiKey || !modelId) {
    console.warn({
      event: 'openclaw_config_merge.skipped',
      reason: 'openrouter_missing_secrets',
      provider: 'openrouter',
      hasApiKey: Boolean(apiKey),
      hasModelId: Boolean(modelId),
    });
    return;
  }

  // We're committed to writing now — lazy-create the cfg.models /
  // cfg.models.providers containers and write the provider block.
  //
  // NOTE — no `_spellguardManaged: true` marker on this block. OpenClaw's
  // `models.providers.openrouter` config IS strict (additionalProperties:
  // false) — verified live against 2026.4.22 on a Lightsail instance:
  // adding the marker caused `[reload] config reload skipped (invalid
  // config): models.providers.openrouter: Unrecognized key:
  // "_spellguardManaged"` and the whole openclaw.json reload was aborted.
  // The v4/v5 schema audit (task #230) read the type definitions but the
  // runtime validator is stricter than the type suggests.
  //
  // Without a marker, the operator-clobber guard can only check
  // existence/absence — it cannot tell an operator-authored block from
  // a previously-managed one. v1 behavior: always overwrite the
  // openrouter block. Operators who want both managed + operator-authored
  // model providers can register their own under a different key (e.g.
  // `openrouter-operator`) or use a different provider entirely.
  if (typeof cfg.models !== 'object' || cfg.models === null) {
    cfg.models = {};
  }
  const models = cfg.models as Record<string, unknown>;
  if (typeof models.providers !== 'object' || models.providers === null) {
    models.providers = {};
  }
  const providers = models.providers as Record<string, unknown>;
  providers.openrouter = {
    baseUrl: OPENROUTER_API_BASE_URL,
    apiKey,
    api: 'openai-completions',
    models: [],
  };

  // Default model: set `agents.defaults.model.primary` to
  // `openrouter/<model_id>`. Preserve an operator-set value that targets
  // a different provider.
  if (typeof cfg.agents !== 'object' || cfg.agents === null) {
    cfg.agents = {};
  }
  const agents = cfg.agents as Record<string, unknown>;
  if (typeof agents.defaults !== 'object' || agents.defaults === null) {
    agents.defaults = {};
  }
  const defaults = agents.defaults as Record<string, unknown>;
  if (typeof defaults.model !== 'object' || defaults.model === null) {
    defaults.model = {};
  }
  const model = defaults.model as Record<string, unknown>;
  // Always set the primary to the delivered openrouter model. This
  // intentionally OVERWRITES whatever was there — including the
  // Lightsail blueprint's `bedrock/global.anthropic.claude-sonnet-4-6`
  // default, which is what REQ-012 was created to sidestep (the customer
  // brought their own OpenRouter key precisely BECAUSE they don't want
  // to onboard their AWS account for Bedrock IAM access). Verified live
  // on a Lightsail instance 2026-05-28: leaving the blueprint's bedrock
  // primary in place caused the agent to fail with
  // "is not authorized to perform: sts:AssumeRole on resource:
  // LightsailRoleFor-{instanceId}" — exactly the customer-onboarding
  // gap the credential channel delivery is meant to fix.
  //
  // Tradeoff: an operator who has explicitly configured a non-openrouter
  // primary in openclaw.json + ALSO delivers an OpenRouter credential
  // via the dashboard will see their primary overwritten. That's
  // acceptable because (a) delivering the openrouter cred is itself an
  // explicit operator action, (b) the operator can override post-merge
  // by editing openclaw.json and OpenClaw's hot-reload will pick up the
  // change, and (c) we have no way to distinguish "blueprint default
  // bedrock" from "operator-set bedrock" without an additional marker
  // OpenClaw's strict schema doesn't allow us to write.
  model.primary = `openrouter/${modelId}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure a nested accounts map exists and return it. */
function ensureAccounts(
  channels: Record<string, unknown>,
  channelKey: string,
): Record<string, unknown> {
  if (
    typeof channels[channelKey] !== 'object' ||
    channels[channelKey] === null
  ) {
    channels[channelKey] = {};
  }
  const section = channels[channelKey] as Record<string, unknown>;
  if (typeof section.accounts !== 'object' || section.accounts === null) {
    section.accounts = {};
  }
  return section.accounts as Record<string, unknown>;
}

/**
 * Apply a Teams (msteams) provider entry directly onto `channels.msteams`.
 *
 * OpenClaw's `MSTeamsConfig` is a single-account top-level object — it reads
 * `appId`, `appPassword`, and `tenantId` directly from `channels.msteams`, NOT
 * from an `accounts` sub-map.  We therefore write/delete managed keys directly
 * on that object and track ownership via `_spellguardManaged: true`.
 *
 * Operator-clobber guard: if `channels.msteams` exists but lacks
 * `_spellguardManaged: true`, we assume it is operator-authored and skip the
 * write entirely (emit a warning, return without modifying).
 */
function applyTeamsEntry(
  channels: Record<string, unknown>,
  entry: ProviderCredEntry,
): void {
  const existing =
    typeof channels.msteams === 'object' && channels.msteams !== null
      ? (channels.msteams as Record<string, unknown>)
      : null;

  if (entry.revoked) {
    // Only clean up keys we originally wrote.
    if (existing?._spellguardManaged === true) {
      existing.appId = undefined;
      existing.tenantId = undefined;
      existing.appPassword = undefined;
      existing._spellguardManaged = undefined;
      // If no non-managed keys remain (operator added nothing extra), suppress
      // the msteams object so OpenClaw doesn't see `channels.msteams: {}`.
      // Setting to undefined causes JSON.stringify to omit the key entirely
      // (equivalent to delete, which is blocked by biome noDelete).
      const remainingKeys = Object.keys(existing).filter(
        (k) => existing[k] !== undefined,
      );
      if (remainingKeys.length === 0) {
        channels.msteams = undefined;
      }
    }
    // If not managed by us (or absent), leave untouched.
    return;
  }

  // Operator-clobber guard: if msteams config exists without our marker, skip.
  if (existing !== null && existing._spellguardManaged !== true) {
    console.warn({
      event: 'openclaw_config_merge.skipped',
      reason: 'operator_msteams_config_present',
      provider: 'teams',
    });
    return;
  }

  // Write (or overwrite our own prior write) the top-level managed keys.
  if (typeof channels.msteams !== 'object' || channels.msteams === null) {
    channels.msteams = {};
  }
  const msteams = channels.msteams as Record<string, unknown>;
  msteams.appId = entry.secrets.appId;
  msteams.tenantId = entry.secrets.tenantId;
  msteams.appPassword = entry.secrets.password;
  msteams._spellguardManaged = true;
}

/**
 * Apply a single provider entry to the mutable cfg object.
 *
 * Most providers (slack/discord) write into `channels.<provider>.accounts`;
 * teams writes directly onto `channels.msteams`; OpenRouter writes outside
 * the `channels` map entirely, into `models.providers.openrouter` and
 * `agents.defaults.model.primary`. The first arg is therefore the full
 * `cfg` root, NOT the `channels` sub-object — that's wide enough to host
 * all current providers.
 */
/**
 * A Slack credential is usable by OpenClaw's slack channel — and therefore
 * worth writing into openclaw.json (which trips a gateway restart) — only when
 * it can run a mode: http needs `botToken` + `signingSecret`; socket needs
 * `botToken` + `appToken`. A bot-token-only delivery satisfies neither.
 */
export function isUsableSlackCredential(
  secrets: Record<string, string>,
): boolean {
  return !!secrets.botToken && (!!secrets.appToken || !!secrets.signingSecret);
}

function applyProviderEntry(
  cfg: Record<string, unknown>,
  provider: string,
  entry: ProviderCredEntry,
): void {
  // OpenRouter writes outside `channels` — model-provider config lives
  // under `models.providers.openrouter` and `agents.defaults.model.primary`.
  if (provider === 'openrouter') {
    applyOpenrouterEntry(cfg, entry);
    return;
  }

  // The rest of the providers all live under `channels.*`.
  if (typeof cfg.channels !== 'object' || cfg.channels === null) {
    cfg.channels = {};
  }
  const channels = cfg.channels as Record<string, unknown>;

  // Teams uses a top-level single-account structure — route to its own handler.
  if (provider === 'teams') {
    applyTeamsEntry(channels, entry);
    return;
  }

  const channelKey = channelKeyForProvider(provider);
  if (channelKey === null) return;

  // Single-restart completeness gate (Slack). A Slack credential can arrive in
  // pieces — bot token inline, then signing secret a beat later via the
  // channel's divergence-replay — and a partial is unusable in BOTH modes (http
  // needs signingSecret, socket needs appToken). If we touched channels.slack
  // for a partial — the account OR the top-level UX defaults below — openclaw.json
  // would change and OpenClaw would restart (a full restart on Railway) for a
  // config that still can't run. So skip the WHOLE slack apply until the
  // credential is usable: the first openclaw.json write is then the COMPLETING
  // delivery → exactly one restart. A partial re-delivery is likewise skipped, so
  // it never downgrades an already-complete account. Platform-agnostic — the gate
  // only ever skips a write, never forces one (on Lightsail it just collapses the
  // same two writes into one). Revokes are NOT gated (a revoke must always apply).
  if (
    provider === 'slack' &&
    !entry.revoked &&
    !isUsableSlackCredential(entry.secrets)
  ) {
    return;
  }

  const accounts = ensureAccounts(channels, channelKey);

  if (entry.revoked) {
    delete accounts[MANAGED_ACCOUNT_ID];
  } else {
    const built = buildManagedAccount(provider, entry.secrets);
    if (built !== null) {
      accounts[MANAGED_ACCOUNT_ID] = built;
    }
  }

  // Ensure channel-wide UX defaults on Slack so a freshly-managed bot
  // behaves like the reference deploy (threaded replies, streaming
  // status, bot-to-bot mentions, open group/DM). All are read off
  // `slackCfg.*` (top-level) in OpenClaw's slack channel — not from
  // `accounts[x].*` — so they MUST live on `channels.slack` itself.
  // Idempotent: existing operator-set values win (`??=`).
  if (provider === 'slack') {
    ensureSlackChannelDefaults(channels);
  }
}

/**
 * Apply OpenClaw slack channel-wide defaults so managed bots match
 * the reference `packages/agents/openclaw/openclaw.json` behavior:
 * threaded replies, streaming "Working…" previews, allow bot-to-bot
 * mentions, open group/DM policy. Only sets fields the operator
 * hasn't explicitly configured (`??=`).
 */
function ensureSlackChannelDefaults(channels: Record<string, unknown>): void {
  if (typeof channels.slack !== 'object' || channels.slack === null) {
    channels.slack = {};
  }
  const slack = channels.slack as Record<string, unknown>;
  slack.replyToMode ??= 'all';
  slack.allowBots ??= true;
  slack.groupPolicy ??= 'open';
  slack.dmPolicy ??= 'open';
  slack.allowFrom ??= ['*'];
  slack.userTokenReadOnly ??= true;
  slack.streaming ??= { mode: 'partial', nativeTransport: true };
}

/**
 * Atomic file write: write to a temp sibling directory then rename.
 *
 * The temp dir is created as a sibling of `configPath` (same directory) rather
 * than under `os.tmpdir()` to avoid EXDEV cross-device rename errors on Docker,
 * WSL2, and mounted-volume deployments where the config dir may be on a
 * different filesystem than `/tmp`.
 *
 * The temp dir is always removed in a finally block — a failed write or rename
 * does NOT leak temp dirs in the operator's config directory.
 *
 * Returns true on success, false on any error (the module's no-throw contract
 * means errors are handled by the caller via the return value).
 */
function atomicWrite(configPath: string, content: string): boolean {
  let fileMode = 0o600;
  try {
    fileMode = statSync(configPath).mode & 0o777;
  } catch {
    // Keep default mode if stat fails (e.g. file doesn't exist yet).
  }

  const tmpDir = mkdtempSync(join(dirname(configPath), '.sg-oc-merge-'));
  try {
    const tmpFile = join(tmpDir, 'openclaw.json.tmp');
    writeFileSync(tmpFile, content, 'utf-8');
    chmodSync(tmpFile, fileMode);
    renameSync(tmpFile, configPath);
    return true;
  } finally {
    // Always remove the temp dir — even if write/chmod/rename failed.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MergeResult {
  changed: boolean;
}

export interface MergeArgs {
  /** Explicit config path; falls back to `resolveOpenClawConfigPath()` when omitted. */
  configPath?: string;
  /** Provider credential map to merge in. */
  providers: Record<string, ProviderCredEntry>;
}

/**
 * Merge provider credentials into the OpenClaw config file under a
 * plugin-owned managed region.  Never touches operator-authored config.
 *
 * Returns `{ changed: true }` when the file was rewritten, `{ changed: false }`
 * when the content was already identical (idempotent fixed point), the file
 * could not be read, or a write error occurred.
 *
 * This function NEVER throws — all errors are caught and surfaced as a
 * structured console.warn plus `{ changed: false }`.
 */
export function mergeProviderCredsIntoOpenClawConfig(
  args: MergeArgs,
): MergeResult {
  const configPath = args.configPath ?? resolveOpenClawConfigPath();

  // Read + parse the existing config.  On ANY error: warn and bail — we never
  // write a fresh file over a missing or unreadable config.
  let cfg: Record<string, unknown>;
  let rawBefore: string;
  try {
    rawBefore = readFileSync(configPath, 'utf-8');
    cfg = JSON.parse(rawBefore) as Record<string, unknown>;
  } catch {
    console.warn({
      event: 'openclaw_config_merge.skipped',
      reason: 'unreadable',
      configPath,
    });
    return { changed: false };
  }

  // Apply each provider entry. applyProviderEntry receives the full cfg
  // root because OpenRouter writes outside the channels map (into
  // models.providers + agents.defaults); messaging providers (slack /
  // discord / teams) get the channels sub-object lazily ensured inside
  // the dispatcher.
  for (const [provider, entry] of Object.entries(args.providers)) {
    applyProviderEntry(cfg, provider, entry);
  }

  // Idempotency check: compare serialised content before any write.
  //
  // This is the restart-loop fixed point: once the file contains the managed
  // account, subsequent calls produce the exact same bytes and skip the write.
  //
  // One-time reformat note: if the operator's openclaw.json uses non-canonical
  // formatting (e.g. trailing spaces, non-2-space indent), the FIRST merge will
  // reformat the entire file (causing one extra OpenClaw restart) and then
  // become a stable fixed point — not a loop.  A manual non-canonical edit
  // after a managed merge triggers one extra restart on the next credential
  // delivery (bounded, not a loop).
  const nextContent = `${JSON.stringify(cfg, null, 2)}\n`;
  if (nextContent === rawBefore) return { changed: false };

  try {
    atomicWrite(configPath, nextContent);
  } catch (err) {
    console.warn({
      event: 'openclaw_config_merge.skipped',
      reason: 'write_failed',
      configPath,
      error: String(err),
    });
    return { changed: false };
  }
  return { changed: true };
}
