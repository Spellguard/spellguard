// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-control-channel WebSocket protocol — client-side mirror.
 *
 * Restates the wire shape that the Spellguard backend serves. The client
 * keeps its own copy of these types rather than importing them from the
 * Spellguard management plane, which is not part of this published package.
 *
 * Drift between the client and server copies is pinned by the
 * protocol-shape test. Both copies must change together.
 *
 * `CredentialDescriptor` is also restated here (instead of imported)
 * for the same package-boundary reason; its GitHub-shaped descriptor
 * structurally matches the server-side credential descriptor type.
 */

/**
 * Runtime sentinel — imported as a value by the protocol-shape drift
 * guard so the test suite catches a missing module at load time. Bumped
 * only on a wire-incompatible change. MUST match the server-side value.
 *
 * Bumped from `'1'` to `'2'` to add the login-relay frames (REQ-003,
 * Tasks 14–15): `LoginRelayUpdateFrame` (box → control plane, up),
 * `LoginCodeFrame` (control plane → box, down), and `LoginRestartFrame`
 * (control plane → box, "re-run setup-token"). The new frames are themselves
 * additive and backward-compatible, but the bump is taken per REQ-003 §2 to
 * force the qa:cross-plugin gate so all plugin copies are updated together.
 * MUST match the server-side value.
 */
export const AGENT_CONTROL_PROTOCOL_VERSION = '2' as const;
export type AgentControlProtocolVersion = typeof AGENT_CONTROL_PROTOCOL_VERSION;

// ── Credential descriptor (restated inline) ───────────────────────────────

/** Provider-specific GitHub identity payload. */
export interface GithubProviderData {
  github_user_id: number;
  github_login: string;
  github_user_email: string | null;
  git_author_name: string;
  git_author_email: string;
}

export type ProviderId =
  | 'github'
  | 'slack'
  | 'discord'
  | 'teams'
  | 'openrouter';
export type CredentialKind = 'issued' | 'manual' | 'auto-created';

/** Common base of every credential descriptor — provider-agnostic spine. */
export interface BaseCredentialDescriptor {
  /** Stable per-credential record id (the common key across kinds). */
  credential_id: string;
  provider: ProviderId;
  kind: CredentialKind;
  /** Owning agent (the credentials row's agent_id). */
  agent_id: string;
  /**
   * Server-derived state. On push frames (`credential_delivered`,
   * `credential_rotated`), this will always be `'valid'` — non-valid
   * states travel via the dedicated `credential_revoked` frame.
   */
  status: 'valid' | 'near_expiry' | 'expired' | 'revoked';
}

/**
 * GitHub-flavored variant of CredentialDescriptor.
 *
 * ## Redacted-replay contract
 *
 * `scoped_token` is intentionally absent in two situations:
 *
 * 1. **Ring-buffer replay** — The server strips `scoped_token` before
 *    persisting frames to the Durable Object ring buffer (secrets must not
 *    rest in a storage layer the framework can inspect). When the client
 *    reconnects and the server replays `credential_delivered` or
 *    `credential_rotated` frames from the buffer, those frames arrive
 *    without a `scoped_token`.
 *
 * 2. **`cause:'admin_reissue'`** — When the server detects divergence
 *    between the plugin's `known_credentials` and the current server
 *    state during resume, it emits a `credential_delivered{cause:'admin_reissue'}`
 *    staleness signal. This frame does NOT carry a `scoped_token` because
 *    the server intentionally avoids calling `provider.refresh()` (which
 *    would trigger an unnecessary rotation) or `provider.status()` (which
 *    by design returns no raw secret). The frame is a notice,
 *    not a delivery.
 *
 * **Plugin response**: the client MUST detect any `credential_delivered` or
 * `credential_rotated` frame where `scoped_token` is absent and automatically
 * issue a `credential_request{reason:'expiry'}` to obtain fresh secret
 * material. The redacted frame itself must NOT be forwarded to
 * `onCredentialDelivered`/`onCredentialRotated` — writing a config without
 * a usable token would break the agent's GitHub access.
 */
export interface GithubCredentialDescriptor extends BaseCredentialDescriptor {
  provider: 'github';
  kind: 'issued';
  /** Legacy alias retained for the issued path; equals credential_id. */
  scoped_token_id?: string;
  /** ISO-8601 expiry of this issuance */
  expires_at: string;
  /** Raw GitHub scoped token. Absent on /status responses and on replayed
   *  or admin_reissue frames — see the redacted-replay contract above. */
  scoped_token?: string;
  /** Common shape across providers — used for human-readable display */
  scope_summary: { repos: string[] };
  provider_data: GithubProviderData;
  /** Phase C: the GitHub org this credential targets. Optional — absent from
   * pre-C servers; clients treat absence as "legacy single-org". */
  github_org_login?: string;
  /** Phase C: the GitHub App installation id backing this credential. */
  installation_id?: number;
}

export interface SlackCredentialDescriptor extends BaseCredentialDescriptor {
  provider: 'slack';
  kind: 'manual' | 'auto-created';
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  /**
   * Stable per-credential identifier carried on credential_delivered + credential_revoked
   * frames. For `kind:'auto-created'`, MUST equal `credential_id` (matches GitHub-issued
   * convention). For `kind:'manual'`, optional — backfilled with `manual:slack:${agent_id}`
   * for divergence-detection symmetry.
   */
  scoped_token_id?: string;
}

export interface DiscordCredentialDescriptor extends BaseCredentialDescriptor {
  provider: 'discord';
  kind: 'manual';
  botToken: string;
}

export interface TeamsCredentialDescriptor extends BaseCredentialDescriptor {
  provider: 'teams';
  kind: 'manual';
  appId: string;
  tenantId: string;
  password: string;
}

/**
 * OpenRouter model-provider credential. Two fields delivered:
 *   - `api_key`  — bearer token for OpenRouter (encrypted at rest server-side)
 *   - `model_id` — non-secret model reference (e.g. `openai/gpt-oss-120b`)
 *
 * The plugin's openclaw-config-merge writes both into the consuming
 * agent's `openclaw.json`:
 *   `models.providers.openrouter.{baseUrl, apiKey, api:"openai-completions", models:[]}`
 *   `agents.defaults.model.primary = "openrouter/<model_id>"`
 */
export interface OpenrouterCredentialDescriptor
  extends BaseCredentialDescriptor {
  provider: 'openrouter';
  kind: 'manual';
  api_key: string;
  model_id: string;
  scoped_token_id?: string;
}

/**
 * Discriminated union by `provider` (and `kind`). GitHub is `kind:'issued'`;
 * Slack/Discord/Teams/OpenRouter are `kind:'manual'`. Future providers
 * extend the union without touching the spine.
 */
export type CredentialDescriptor =
  | GithubCredentialDescriptor
  | SlackCredentialDescriptor
  | DiscordCredentialDescriptor
  | TeamsCredentialDescriptor
  | OpenrouterCredentialDescriptor;

// ── Envelope base types ─────────────────────────────────────────────────────

export interface ServerFrameBase {
  /** Monotonically increasing server-side sequence, decimal string. */
  seq: string;
  /** RFC 3339 UTC timestamp the server emitted this frame. */
  ts: string;
}

export interface ClientFrameBase {
  /** UUIDv4 the client generated for this message. */
  client_msg_id: string;
}

// ── Provider config descriptor ─────────────────────────────────────────────

export interface AgentConfigDescriptor {
  provider: string;
  [providerSpecificField: string]: unknown;
}

// ── Server → Client frames ──────────────────────────────────────────────────

export interface HelloFrame extends ServerFrameBase {
  type: 'hello';
  channel_id: string;
  current_seq: string;
  resume_window_seconds: number;
  is_fresh_channel: boolean;
}

export interface CredentialDeliveredFrame extends ServerFrameBase {
  type: 'credential_delivered';
  cause:
    | 'bootstrap'
    | 'refresh_response'
    | 'rotation_push'
    | 'admin_reissue'
    | 're_bootstrap';
  credentials: CredentialDescriptor[];
  /**
   * Spellguard agent secret. Set on `cause:'bootstrap'` only — the plugin
   * persists this to disk and uses it to authenticate future socket
   * reconnects via `?agent_secret=` and REST routes via
   * `X-Spellguard-Agent-Id` + `X-Spellguard-Agent-Secret`. Absent on
   * rotation / refresh_response / admin_reissue frames.
   */
  agent_secret?: string;
  /** Set on `cause:'bootstrap'` only — see server-side comment. */
  agent_name?: string;
  /**
   * Selected agent UUID. Set on `cause:'re_bootstrap'` (D16/UT-013) — the
   * select-existing attach delivers to the EXISTING agent the dashboard bound
   * the nonce to. An identity-only agent carries no credential descriptor that
   * would otherwise relay the agent_id, so it travels on the frame. The plugin
   * persists this as its `agentId`. Optional + additive (absent on `bootstrap`
   * and every non-re_bootstrap frame).
   */
  agent_id?: string;
}

export interface CredentialRotatedFrame extends ServerFrameBase {
  type: 'credential_rotated';
  credentials: CredentialDescriptor[];
  superseded_scoped_token_id?: string;
}

export interface CredentialRevokedFrame extends ServerFrameBase {
  type: 'credential_revoked';
  provider: string;
  scoped_token_id: string;
  reason:
    | 'admin_revoked'
    | 'github_side_revoked'
    | 'installation_revoked'
    | 'refresh_token_expired'
    | 'org_offboarded'
    | 'agent_deleted'
    | 'unknown';
}

export interface ConfigUpdatedFrame extends ServerFrameBase {
  type: 'config_updated';
  config: AgentConfigDescriptor;
  triggers_rotation: boolean;
}

export interface AckFrame extends ServerFrameBase {
  type: 'ack';
  client_msg_id: string;
  ok: boolean;
  error_code?:
    | 'refresh_token_expired'
    | 'installation_revoked'
    | 'rate_limited'
    | 'agent_unknown'
    | 'validation_error'
    | 'github_error'
    | 'kms_error'
    | 'not_implemented'
    | string;
  error_message?: string;
}

export interface ErrorFrame extends ServerFrameBase {
  type: 'error';
  code: string;
  message: string;
  fatal: boolean;
}

export interface ResumeWindowExceededFrame extends ServerFrameBase {
  type: 'resume_window_exceeded';
  current_seq: string;
}

/**
 * REQ-003 (Task 14) — Down frame: control plane delivers the login auth
 * code to the box so the user can complete the headless `claude login`
 * flow via the managed relay.
 *
 * This is the ONLY frame that legitimately carries a `code` field on
 * the credential socket. The corresponding up-frame (`LoginRelayUpdateFrame`)
 * must NEVER carry the code (NEG-001).
 */
export interface LoginCodeFrame extends ServerFrameBase {
  type: 'login_code';
  /** Auth code to apply on the box (user-entered or relay-applied). */
  code: string;
}

/**
 * REQ-003 (Task 15) — Down frame: the dashboard tells the box to abandon the
 * current headless login attempt and re-run `claude setup-token` from scratch.
 * The box re-runs the relay flow and emits a fresh
 * `LoginRelayUpdateFrame{state:'url_ready', login_url}`. Carries NO payload
 * beyond the discriminator (NEG-001: no token, no code, no secret).
 */
export interface LoginRestartFrame extends ServerFrameBase {
  type: 'login_restart';
}

export type ServerFrame =
  | HelloFrame
  | CredentialDeliveredFrame
  | CredentialRotatedFrame
  | CredentialRevokedFrame
  | ConfigUpdatedFrame
  | AckFrame
  | ErrorFrame
  | ResumeWindowExceededFrame
  | LoginCodeFrame
  | LoginRestartFrame;

// ── Client → Server frames ──────────────────────────────────────────────────

export interface BootstrapRequestFrame extends ClientFrameBase {
  type: 'bootstrap_request';
  nonce: string;
  /**
   * agent_name is required. The agent-metadata flow guarantees the
   * dashboard has stored a name before the client polls the channel token,
   * so this field is always available by the time the client sends this frame.
   */
  agent_name: string;
  statement_of_reason?: string;
  /**
   * The plugin's framework slug, so the server records the correct
   * `agents.framework` at creation instead of a hardcoded default (REQ-FI: a
   * Codex agent was otherwise born `claude-code`). Canonical wire values:
   * 'claude_code' | 'codex' | 'openclaw' | 'hermes'. Optional for back-compat
   * with older plugins — the server falls back to NULL ('unknown') and the
   * plugin's startup plugin-sync reconciles it.
   */
  framework?: string;
}

export interface ResumeFrame extends ClientFrameBase {
  type: 'resume';
  last_server_seq: string;
  known_credentials: Array<{ provider: string; scoped_token_id: string }>;
  /** Phase C: client capability flags. Today: 'github_multi_org' = this
   * plugin can hold one GitHub credential per GitHub org simultaneously.
   * The server persists these on the agent row; absence = legacy. */
  capabilities?: string[];
}

export interface CredentialRequestFrame extends ClientFrameBase {
  type: 'credential_request';
  // The git-helper's erase path does not signal the daemon: the persistent
  // daemon's expiry watcher plus server-pushed credential_revoked frames
  // cover the cases an erase signal would otherwise handle.
  reason: 'expiry' | 'manual' | 'session_start';
  provider: string;
  /**
   * Phase C: this doubles as the per-credential refresh selector. When an
   * agent holds one GitHub credential per org, the client names exactly
   * which credential to refresh by its `scoped_token_id`; the server
   * resolves the installation from that credential's lineage (as established
   * in Phase B). No separate org-targeting field is needed — this scalar
   * already identifies the single credential in question.
   */
  superseded_scoped_token_id?: string;
}

export interface AckClientFrame extends ClientFrameBase {
  type: 'ack';
  acked_seq: string;
}

export interface PingFrame extends ClientFrameBase {
  type: 'ping';
}

/**
 * Plugin signals that its inbound platform channel (Slack/Teams/Discord
 * socket) is up and the bot can actually reply. This is the milestone the
 * managed-provisioning UX gates "ready" on — distinct from the VM being
 * `online`, which only means the agent-control socket connected. The
 * broker persists a `agents.channel_ready_at` timestamp on first receipt
 * and Acks via the existing `AckFrame`.
 *
 * Carries no secrets — `reason`/`platform` are diagnostic strings and
 * `metadata` holds non-secret connect telemetry (e.g. `connect_ms`,
 * `openclaw_version`). Fire-and-forget on the client side; an old broker
 * that does not recognize this frame safely rejects it via
 * `parseClientFrame` (non-fatal `Error{fatal:false}`), so it stays
 * backward-compatible without a protocol-version bump.
 */
export interface ChannelReadyFrame extends ClientFrameBase {
  type: 'channel_ready';
  /** e.g. 'slack_socket_connected' | 'relay_connected'. */
  reason?: string;
  /** Which inbound socket came up: 'slack' | 'teams' | 'discord'. */
  platform?: string;
  /** Non-secret diagnostics: { connect_ms, openclaw_version }. */
  metadata?: Record<string, unknown>;
}

/**
 * REQ-003 (Task 14) — Up frame: the box reports its current login-relay
 * state to the control plane during the headless `claude login` flow.
 * The control plane surfaces the URL to the operator (dashboard / relay)
 * and then pushes the auth code back via `LoginCodeFrame`.
 *
 * NEG-001: this frame carries NO secret material — no token, no code,
 * no OAuth payload. It is a state-change notification only.
 */
export interface LoginRelayUpdateFrame extends ClientFrameBase {
  type: 'login_relay_update';
  /** Current state of the headless login flow on the box. */
  state: 'url_ready' | 'awaiting_code' | 'authorized' | 'failed';
  /** Login URL — present on `url_ready` and `awaiting_code` states. */
  login_url?: string;
  /** Human-readable failure reason — present on `failed` state. */
  message?: string;
}

export type ClientFrame =
  | BootstrapRequestFrame
  | ResumeFrame
  | CredentialRequestFrame
  | AckClientFrame
  | PingFrame
  | ChannelReadyFrame
  | LoginRelayUpdateFrame;

// ── Server frame parser (client-side) ─────────────────────────────────────

type Obj = Record<string, unknown>;

const KNOWN_SERVER_FRAME_TYPES = new Set([
  'hello',
  'credential_delivered',
  'credential_rotated',
  'credential_revoked',
  'config_updated',
  'ack',
  'error',
  'resume_window_exceeded',
  'login_code',
  'login_restart',
]);

/**
 * Parse and shallow-validate a server-emitted frame. Returns `null` on
 * any structural problem so the caller can handle it non-fatally —
 * mirroring the `Error{fatal:false}` rejection contract from the server
 * side's `parseClientFrame`. Unknown frame types are also rejected (null)
 * rather than thrown so future additive server frames do not crash an
 * older client.
 *
 * The only frame with active field validation here is `login_code`: it
 * requires a non-empty `code` string (the field that makes this frame
 * meaningful). All other frames are validated at the type level only
 * (caller receives a correctly-typed value).
 */
export function parseServerFrame(text: string): ServerFrame | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Obj;

  if (typeof obj.type !== 'string') return null;
  if (!KNOWN_SERVER_FRAME_TYPES.has(obj.type)) return null;

  // Field-level validation for login_code: `code` must be a non-empty string.
  if (obj.type === 'login_code') {
    if (typeof obj.code !== 'string' || obj.code.length === 0) return null;
  }

  return obj as unknown as ServerFrame;
}

// ── Close codes ────────────────────────────────────────────────────────────

export const AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1000,
  INTERNAL_ERROR: 1011,
  BOOTSTRAP_ERROR: 4400,
  AUTH_FAILED: 4401,
  AGENT_OWNERSHIP: 4403,
  RESUME_WINDOW_EXCEEDED: 4413,
  ALREADY_CONNECTED: 4429,
  /**
   * Set ONLY on a deliberate move/re-bootstrap rotation; the sole trigger
   * for the plugin self-wipe. The close reason string is one of
   * `AUTH_SUPERSEDED_CLOSE_REASONS` — use that constant to match on it.
   */
  AUTH_SUPERSEDED: 4409,
  // A SERVER_TRANSIENT (4503) code is intentionally not declared here: the
  // server's transient-failure paths (storage put errors, missing DB handle,
  // serialization throws) log and fall through rather than emitting a close
  // code. A structured signal could be added later, paired with a
  // server-side emit site.
} as const;

/**
 * Machine-readable close reason strings carried alongside the
 * `AUTH_SUPERSEDED` (4409) close code. The plugin reads this string (via
 * the WebSocket `CloseEvent.reason`) to pick the right self-wipe message.
 *
 * Carriage: standard WebSocket close reason string — `connection.close(4409,
 * AUTH_SUPERSEDED_CLOSE_REASONS.ATTACHED_ELSEWHERE)` — consistent with
 * how other close reasons are carried in this protocol (e.g. 'auth_revoked').
 *
 * - `attached_elsewhere`: the agent connected from a second location while
 *   already attached; the older session is being displaced.
 * - `reassigned`: an admin reassigned the agent to a different owner; the
 *   current plugin must wipe and let the new owner re-bootstrap.
 */
export const AUTH_SUPERSEDED_CLOSE_REASONS = {
  ATTACHED_ELSEWHERE: 'attached_elsewhere',
  REASSIGNED: 'reassigned',
} as const;

export type AuthSupersededCloseReason =
  (typeof AUTH_SUPERSEDED_CLOSE_REASONS)[keyof typeof AUTH_SUPERSEDED_CLOSE_REASONS];

export type AgentControlCloseCode =
  (typeof AGENT_CONTROL_CLOSE_CODES)[keyof typeof AGENT_CONTROL_CLOSE_CODES];
