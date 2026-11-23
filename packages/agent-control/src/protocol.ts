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

import {
  A2A_TASK_STATES,
  type A2aArtifact,
  type A2aMessage,
  type A2aTask,
  type A2aTaskState,
  validateA2aMessage,
  validateA2aTask,
} from './a2a';

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
 *
 * Bumped from `'2'` to `'3'` for the consolidated agent socket: the transient
 * relay frames (`SlackEventFrame`, `SlackEventBlockedFrame`,
 * `TeamsActivityFrame`, `TeamsActivityBlockedFrame`) now ride the SAME socket
 * as the reliable credential/lifecycle/login frames, split by the
 * `frameFamily`/`frameQos` taxonomy so QoS is visible in the type system. The
 * relay frames carry the SAME payload fields as the earlier Slack/Teams webhook
 * relay envelopes — the transient lane adds only an optional `ts` the legacy
 * envelopes lacked, which consumers ignore — so the wire stays additive and
 * backward-compatible; the bump
 * is taken to force the qa:cross-plugin gate so
 * every plugin copy adopts the taxonomy together.
 *
 * Bumped from `'3'` to `'4'` to add the A2A collaboration-plane frames as
 * their own `a2a` frame family (REQ-001, Task T2): `A2aTaskDispatchFrame` +
 * `A2aMessageServerFrame` (control plane → box, down) and `A2aTaskUpdateFrame`
 * + `A2aMessageClientFrame` (box → control plane, up). Like the login family,
 * the down frames are emit()-sequenced but transient QoS — excluded from the
 * ring buffer / resume replay (`redactSecretsForBuffer` returns null); their
 * durability is the server-side task store + watchdog re-dispatch (T5/T8/T22),
 * not socket replay. Like the login-relay frames these are additive and
 * backward-compatible (an older peer rejects an unknown a2a frame non-fatally),
 * but the bump is taken to force the qa:cross-plugin gate so all four protocol
 * copies move together.
 *
 * MUST match the server-side value.
 */
export const AGENT_CONTROL_PROTOCOL_VERSION = '5' as const;
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
  /**
   * What this credential grants — a DISCRIMINATED union, because the shape it
   * replaced (`{ repos: string[] }`) meant two different things with the same
   * bytes: `repos: []` was BOTH "the whole organization" (an all-mode grant
   * carries no repository selectors by design) AND "nothing at all". Consumers
   * had to guess, and on 2026-08-26 the managed box guessed wrong — every
   * organization-wide provision failed its self-check after a fully successful
   * boot because a zero-repo credential was dropped as meaningless.
   *
   * `all` carries no repository list at all; `selected` carries a NON-EMPTY
   * one. ABSENCE means the server could not characterize the scope (a legacy
   * or corrupt row) and is NEVER a grant of anything — a client that cannot
   * read a mode MUST fail closed rather than assume either arm.
   */
  scope_summary?: GithubCredentialScope;
  provider_data: GithubProviderData;
  /** Phase C: the GitHub org this credential targets. Optional — absent from
   * pre-C servers; clients treat absence as "legacy single-org". */
  github_org_login?: string;
  /** Phase C: the GitHub App installation id backing this credential. */
  installation_id?: number;
}

/** See {@link GithubCredentialDescriptor.scope_summary}. Two arms, no third. */
export type GithubCredentialScope =
  | { mode: 'all' }
  | { mode: 'selected'; repos: string[] };

/**
 * Is this a well-formed, UNAMBIGUOUS credential scope?
 *
 * The ONE validator for the shape, shared by every receiver (both TS plugins'
 * offline bundle-apply paths today) so they cannot drift into disagreeing about
 * what is acceptable. It accepts exactly the two arms: `all` with no repository
 * list, `selected` with a NON-EMPTY one. It deliberately REJECTS the pre-union
 * `{ repos: [...] }` shape — a frame with no discriminator cannot be
 * distinguished from an organization-wide grant, and guessing is what broke
 * managed provisioning on 2026-08-26.
 */
export function isGithubCredentialScope(
  value: unknown,
): value is GithubCredentialScope {
  if (typeof value !== 'object' || value === null) return false;
  const mode = (value as { mode?: unknown }).mode;
  if (mode === 'all') return true;
  if (mode !== 'selected') return false;
  const repos = (value as { repos?: unknown }).repos;
  return (
    Array.isArray(repos) &&
    repos.length > 0 &&
    repos.every((r) => typeof r === 'string')
  );
}

/**
 * Human-readable one-line rendering of a credential scope, for plugin status
 * output. Shared so "all repositories" is worded identically everywhere and no
 * surface re-derives it from a repo list that an org-wide grant does not have.
 */
export function describeGithubCredentialScope(
  scope: GithubCredentialScope | undefined,
): string {
  if (!scope) return 'unknown';
  return scope.mode === 'all'
    ? 'all repositories in the organization'
    : `[${scope.repos.join(', ')}]`;
}

export type GithubGrantScope =
  | { mode: 'all' }
  | { mode: 'selected'; repository_names: string[] };

export interface GithubGrantCredentialDescriptor
  extends Omit<
    GithubCredentialDescriptor,
    'scope_summary' | 'github_org_login' | 'installation_id' | 'status'
  > {
  grant_id: string;
  scoped_token_id: string;
  installation_record_id: string;
  grant_revision: string;
  grant_set_revision: string;
  github_org_login: string;
  github_org_display_name: string;
  installation_id: number;
  access: 'read' | 'write';
  scope: GithubGrantScope;
  status: 'valid';
  scoped_token: string;
}

export interface SlackCredentialDescriptor extends BaseCredentialDescriptor {
  provider: 'slack';
  kind: 'manual' | 'auto-created';
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  /**
   * Platform-placed Hermes home channel (B5). Optional + additive — legacy
   * frames without it stay valid. The hermes plugin maps it to the
   * `SLACK_HOME_CHANNEL` box env var. NOT a secret.
   */
  homeChannel?: string;
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

/**
 * Common base of every TRANSIENT (fire-and-forget) server-emitted frame.
 *
 * Distinct from `ServerFrameBase` on purpose: transient frames carry NO
 * `seq`. They never enter the reliable sequence stream — they are not
 * ring-buffered, not replayed on resume, and not acked — so QoS is visible
 * in the type system and a transient frame is structurally prevented from
 * being pushed down the sequenced path. `ts` is optional emit-time
 * diagnostic metadata only.
 */
export interface TransientServerFrameBase {
  /** RFC 3339 UTC timestamp the server emitted this frame. Optional. */
  ts?: string;
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

export type CanonicalFramework =
  | 'claude_code'
  | 'codex'
  | 'openclaw'
  | 'hermes';

/** Pinned generalized-task wire limits. String/outer sizes use UTF-8 bytes. */
export const A2A_PROTOCOL_LIMITS = {
  ordinaryFrameBytes: 65_536,
  taskCreateOuterFrameBytes: 327_680,
  taskUpdateOuterFrameBytes: 1_572_864,
  taskCreateInputBytes: 262_144,
  taskCreateEnvelopeBytes: 65_536,
  identifierBytes: 256,
  messageTextBytes: 16_384,
  messagePartsBytes: 65_536,
  artifactsPerUpdate: 50,
  artifactLabelBytes: 256,
  artifactValueBytes: 2_048,
  taskUpdateResultBytes: 1_048_576,
  diagnosticsPerUpdate: 16,
  diagnosticsBytesPerUpdate: 8_192,
} as const;

/** Canonical generalized task-type name accepted by the v1 envelope. */
export const A2A_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Exact task-store outcomes returned for box-relayed progress writes. */
export type A2aTaskStoreOutcome =
  | 'persisted'
  | 'already_terminal'
  | 'thread_bound_reached';

export interface A2aBlockedTaskType {
  task_type: string;
  cause: string;
}

export type A2aHandlerState =
  | 'current'
  | 'outdated_unedited'
  | 'owner_modified'
  | 'example_scaffold'
  | 'not_installed_apply_pending'
  | 'not_installed_custom'
  | 'missing_deleted'
  | 'custom_no_reference'
  | 'not_reported';

export interface A2aHandlerInventoryEntry {
  task_type: string;
  state: A2aHandlerState;
  path: string;
  installed_hash?: string;
  current_hash?: string;
  dist_hash?: string;
  blocking_cause?: string;
}

/** Optional data payload on the existing generic server ACK. */
export interface A2aPublicTaskResponse {
  id: string;
  contextId: string;
  organizationId: string;
  senderKind: 'agent' | 'coordinator' | 'user';
  senderAgentId: string | null;
  senderUserId: string | null;
  recipientAgentId: string;
  originatingAgentId: string | null;
  originatingAgentIdentity: string | null;
  originatingSessionId: string | null;
  framework: string | null;
  type: string;
  state: A2aTaskState;
  artifactUrl: string | null;
  metadata: Record<string, unknown>;
  resultPayload: unknown | null;
  deferred: boolean;
  lastProgressAt: string | null;
  lastSupervisionKeepaliveAt: string | null;
  effectiveDeadlineAt: string | null;
  workingTimeoutSeconds: number | null;
  hasUnansweredWorkerMessage: boolean;
  threadRecordCount: number;
  threadWriteAttemptCount: number;
  suppressedMessageCount: number;
  suppressedProgressCount: number;
  artifactCount: number;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface A2aTaskSummaryResponse
  extends Omit<
    A2aPublicTaskResponse,
    'originatingAgentId' | 'originatingAgentIdentity' | 'originatingSessionId'
  > {
  typeLabel: string;
  stateLabel: string;
}

export interface A2aTaskDetailResponse extends A2aTaskSummaryResponse {
  thread: Array<{
    id: string;
    sequence: number;
    recordKind: 'progress' | 'message' | 'terminal';
    messageId: string | null;
    senderRole: 'USER' | 'AGENT' | null;
    senderKind: 'agent' | 'user' | 'coordinator' | 'handler' | 'daemon' | null;
    senderAgentId: string | null;
    senderAgentIdentity: string | null;
    senderUserId: string | null;
    senderUserIdentity: string | null;
    senderDisplayName: string | null;
    text: string | null;
    parts: unknown | null;
    postTerminal: boolean;
    deliveryState: string | null;
    deliveryReason: string | null;
    terminalState: A2aTaskState | null;
    terminalCause: Record<string, unknown> | null;
    createdAt: string;
  }>;
  artifacts: Array<{
    id: string;
    artifactId: string;
    sequence: number;
    type: string;
    value: string;
    displayLabel: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  diagnostics: Array<{
    id: string;
    sequence: number;
    kind: string;
    reasonCode: string | null;
    message: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface A2aMessageResponse {
  messageId: string;
  postTerminal: boolean;
}

export type A2aAckResult =
  | {
      kind: 'task_update';
      outcome: A2aTaskStoreOutcome;
      response?: A2aPublicTaskResponse;
    }
  | {
      kind: 'message';
      outcome: 'persisted';
      message_id: string;
      response?: A2aMessageResponse;
    }
  | {
      kind: 'task_create';
      task: A2aTask;
      /**
       * `pending_wake` is an ACCEPTANCE, not a failure: the recipient box was
       * asleep, so the task is durably parked (`metadata.pending_wake`) and a
       * wake was requested. Mirrors the DO's own union.
       */
      outcome?: 'created' | 'duplicate' | 'delivery_failed' | 'pending_wake';
      response?: A2aPublicTaskResponse;
    }
  | { kind: 'task_read'; task: A2aTask; response?: A2aTaskDetailResponse }
  | ({ kind: 'config_applied' } & A2aConfigApplicationResult)
  | ({ kind: 'maintenance' } & A2aMaintenanceApplicationResult);

export interface A2aConfigApplicationResult {
  config_revision: string;
  applied_task_types: string[];
  blocked_task_types: A2aBlockedTaskType[];
  superseded?: boolean;
}

export interface A2aMaintenanceApplicationResult {
  operation_id: string;
  status: 'applied' | 'blocked';
  config_revision: string;
  reason?: string;
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
  /**
   * WIRE-VISIBLE: plugins BRANCH on this. The Cloudflare box daemon splits the
   * set into "remove the credential surface" (`org_offboarded`, `agent_deleted`,
   * `source_disconnected` — the thing it came from is gone, no replacement is
   * coming) and "block it in place" (everything else — a replacement IS
   * expected). A NEW value added here lands in the block branch by default; see
   * `cloudflareRemovalReasons` in
   * the Spellguard CLI's source and its
   * exhaustiveness test.
   */
  reason:
    | 'admin_revoked'
    | 'github_side_revoked'
    | 'installation_revoked'
    | 'refresh_token_expired'
    | 'org_offboarded'
    | 'agent_deleted'
    /** The org disconnected the SOURCE this credential was minted from. */
    | 'source_disconnected'
    | 'unknown';
}

/** Complete authoritative GitHub grant set for exactly one set revision. */
export interface GithubGrantsBundleFrame extends ServerFrameBase {
  type: 'github_grants_bundle';
  protocol_version: '5';
  delivery_id: string;
  grant_set_revision: string;
  credentials: GithubGrantCredentialDescriptor[];
}

/** Server confirmation that the exact durable receiver acknowledgement committed. */
export interface GithubGrantsCommitConfirmedFrame extends ServerFrameBase {
  type: 'github_grants_commit_confirmed';
  protocol_version: '5';
  delivery_id: string;
  grant_set_revision: string;
}

export interface ConfigUpdatedFrame extends ServerFrameBase {
  type: 'config_updated';
  config: AgentConfigDescriptor;
  triggers_rotation: boolean;
  /** Additive v4 generalized-routing revision; absent on legacy config frames. */
  config_revision?: string;
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
    | 'MEMBER_OFFBOARDING_IN_PROGRESS'
    | 'validation_error'
    | 'github_error'
    | 'kms_error'
    | 'not_implemented'
    | string;
  error_message?: string;
  /** Data-bearing response for generalized A2A client operations. */
  result?: A2aAckResult;
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

// ── Relay frames (server → client, transient) ──────────────────────────────
//
// The relay family: inbound Slack/Teams events (and their block notices) the
// control plane forwards to the plugin so its local bot can reply. These are the
// ONLY transient (fire-and-forget) server frames — they extend
// `TransientServerFrameBase` (no `seq`), are never ring-buffered, and are never
// replayed on resume. The producers `routes/slack-events.ts` and
// `routes/teams-events.ts` push them onto the agent-control socket, and the
// OpenClaw plugin dispatches them via
// `openclaw-plugin/src/services/relay-dispatch.ts` — the only additive
// difference from a bare envelope is the optional `ts` from the transient base,
// which the producers do not emit.

/**
 * An allowed inbound Slack event, forwarded verbatim for local Bolt dispatch.
 * `payload` is the raw Slack webhook POST body as a JSON STRING (the producer
 * pushes `rawBody = await c.req.text()` unchanged); the plugin re-signs and
 * forwards it to its local Bolt server without re-parsing.
 */
export interface SlackEventFrame extends TransientServerFrameBase {
  type: 'slack_event';
  /** Raw Slack webhook body (JSON string), forwarded verbatim to local Bolt. */
  payload: string;
}

/**
 * A blocked inbound Slack message. Carries no event body — just enough context
 * for the plugin to post a threaded block notice using its own bot token
 * (no Slack secret is stored control-plane-side).
 */
export interface SlackEventBlockedFrame extends TransientServerFrameBase {
  type: 'slack_event_blocked';
  /** Slack channel id the blocked message was posted in. */
  channel: string;
  /** Thread timestamp (the original message `ts`) to reply under. */
  threadTs?: string;
  /** Human-readable block reason surfaced to the channel. */
  reason?: string;
}

/**
 * An allowed inbound Teams (Bot Framework) activity, forwarded verbatim to the
 * plugin's local OpenClaw msteams endpoint. `payload` is the raw activity body
 * as a JSON STRING (the producer pushes `rawBody` unchanged); `authorization`
 * is the original Bot Framework JWT, passed through so OpenClaw can re-verify
 * it as if the request came from Azure directly.
 */
export interface TeamsActivityFrame extends TransientServerFrameBase {
  type: 'teams_activity';
  /** Raw Bot Framework activity body (JSON string), forwarded verbatim. */
  payload: string;
  /** Original inbound Bot Framework JWT, re-verified by OpenClaw's msteams extension. */
  authorization?: string;
}

/**
 * A blocked inbound Teams activity. Carries the inbound activity context the
 * plugin's msteams BlockNoticeAdapter needs to build a threaded reply without
 * a prior stash (serviceUrl, from, recipient, conversationId, activityId).
 */
export interface TeamsActivityBlockedFrame extends TransientServerFrameBase {
  type: 'teams_activity_blocked';
  /** `activity.conversation.id` of the blocked activity. */
  conversationId?: string;
  /** `activity.id` of the blocked activity. */
  activityId?: string;
  /** `activity.serviceUrl` — the Bot Framework reply endpoint. */
  serviceUrl?: string;
  /** Inbound sender (becomes the outbound reply's `recipient`). */
  from?: { id?: string; name?: string };
  /** Inbound recipient/the bot (becomes the outbound reply's `from`). */
  recipient?: { id?: string; name?: string };
  /** Human-readable block reason surfaced to the conversation. */
  reason?: string;
}

// ── A2A collaboration-plane frames (REQ-001 / Task T2) ──────────────────────
//
// The permissioned agent-to-agent collaboration plane rides the SAME
// consolidated agent socket as its own `a2a` frame family — reliable QoS
// (sequenced, ring-buffered, replayed on resume), unlike the transient relay
// family above. Each a2a frame carries a canonical A2A v1.0 payload SHAPE from
// `./a2a` (T1) and NEVER defines its own payload shape, so a credential can
// never be expressed in an a2a frame (NEG-001): `parseServerFrame` delegates
// the payload check to the T1 validators, rejecting a smuggled credential
// field non-fatally.
//
// Receipt-only in T2: frames are typed / validated / acknowledged. Actuation
// (box session spawn — T18), routing (T3), and box→server state reporting (T21)
// add handlers ON TOP of these shapes without re-touching the wire.

/**
 * Server → box: the delegation instruction. Carries the delegated A2A task and
 * the message that initiates it. A multi-framework box routes on `framework`.
 */
export interface A2aTaskDispatchFrame extends ServerFrameBase {
  type: 'a2a_task_dispatch';
  /** The delegated task (canonical A2A v1.0 — validated by T1 `validateA2aTask`). */
  task: A2aTask;
  /**
   * The message that initiates the task. The pre-prompt / session instructions
   * ride IN the A2A message `parts` (A2A-faithful), never as a bespoke frame
   * field. Validated by T1 `validateA2aMessage`.
   */
  message: A2aMessage;
  /**
   * Routing discriminator — which installed framework must handle this dispatch.
   * Additive + optional, mirroring `LoginCodeFrame.framework`. Canonical wire
   * values: 'claude_code' | 'codex' | 'openclaw' | 'hermes'.
   */
  framework?: CanonicalFramework;
  /** The recipient (target) agent — the box agent that must actuate the task. */
  recipient_agent_id: string;
  /** The coordinating / sending agent (provenance — T7/T17). Optional. */
  sender_agent_id?: string;
  /** Owning org context. Optional (the box already authenticated under this org). */
  org_id?: string;
  /** Immutable server-derived attribution copied verbatim into a generalized handler event. */
  event_context?: A2aDispatchEventContext;
}

export interface A2aDispatchEventContext {
  origin: 'send' | 'webhook';
  sender: {
    kind: 'user' | 'agent' | 'coordinator';
    identity: string;
  };
  provider?: string;
  delivery_id?: string;
}

/**
 * Server → box: an A2A message addressed to an agent (the down direction of the
 * bidirectional `a2a_message` frame; the box→server variant is
 * {@link A2aMessageClientFrame}).
 */
export interface A2aMessageServerFrame extends ServerFrameBase {
  type: 'a2a_message';
  /** The A2A v1.0 message (validated by T1 `validateA2aMessage`). */
  message: A2aMessage;
  /** The recipient (addressed-to) agent. */
  recipient_agent_id: string;
  /** The sending agent (provenance). Optional. */
  sender_agent_id?: string;
  /** Routing discriminator (see {@link A2aTaskDispatchFrame.framework}). Optional. */
  framework?: CanonicalFramework;
  /** Owning org context. Optional. */
  org_id?: string;
  /** Native framework session target; absent means ledger-only delivery. */
  target_session_id?: string;
}

/** Server → box: capability-aware maintenance/backfill operation. */
export interface A2aMaintenanceFrame extends ServerFrameBase {
  type: 'a2a_maintenance';
  operation_id: string;
  action: 'backfill';
  config_revision: string;
}

export type ServerFrame =
  | HelloFrame
  | CredentialDeliveredFrame
  | CredentialRotatedFrame
  | CredentialRevokedFrame
  | GithubGrantsBundleFrame
  | GithubGrantsCommitConfirmedFrame
  | ConfigUpdatedFrame
  | AckFrame
  | ErrorFrame
  | ResumeWindowExceededFrame
  | LoginCodeFrame
  | LoginRestartFrame
  | SlackEventFrame
  | SlackEventBlockedFrame
  | TeamsActivityFrame
  | TeamsActivityBlockedFrame
  | A2aTaskDispatchFrame
  | A2aMessageServerFrame
  | A2aMaintenanceFrame;

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
  reason: 'expiry' | 'manual' | 'session_start' | 'resume';
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

/** Positive proof that the daemon placed one token-bearing Cloudflare delivery. */
export interface CloudflareCredentialAppliedFrame extends ClientFrameBase {
  type: 'cloudflare_credential_applied';
  delivery_seq: string;
  credential_id: string;
}

export interface GithubGrantsAppliedFrame extends ClientFrameBase {
  type: 'github_grants_applied';
  protocol_version: '5';
  delivery_id: string;
  grant_set_revision: string;
  applied: boolean;
  error_code?: 'stale_revision' | 'invalid_bundle' | 'durable_apply_failed';
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
  /** e.g. 'slack_socket_connected' | 'agent_control_connected'. */
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
  /**
   * T4.3 — the framework THIS update belongs to. A multiplexed Go box daemon
   * carries BOTH managed-login frameworks (claude_code + codex) over ONE
   * connection, so the connection-level `?framework=` can no longer
   * disambiguate — the frame carries it instead (the primary attribution path
   * server-side). Canonical wire values: 'claude_code' | 'codex' | 'openclaw' |
   * 'hermes'. Additive + optional so the existing single-framework Node daemon
   * (which omits it) stays byte- and wire-compatible.
   */
  framework?: string;
}

/**
 * Box → server: how the box reports a dispatched task's progress / result
 * (the up direction of the a2a plane). Correlates to a dispatched task by
 * `taskId`; carries the new lifecycle state plus an optional result message /
 * artifact. Receipt-only in T2 (the DO logs + acks); T21 wires the box-side
 * emitter and T5 the durable task store.
 */
export interface A2aTaskUpdateFrame extends ClientFrameBase {
  type: 'a2a_task_update';
  /** The task being reported on — correlates to a dispatched `A2aTask.id`. */
  taskId: string;
  /** The new lifecycle state (one of the 8 canonical A2A task states). */
  state: A2aTaskState;
  /** Optional progress / result message (T1 `A2aMessage`). */
  message?: A2aMessage;
  /** Optional artifact output (T1 `A2aArtifact`). */
  artifact?: A2aArtifact;
  /** Additive multi-artifact form; the singular legacy field stays valid. */
  artifacts?: A2aArtifact[];
  /** Generalized handler result payload. Additive v4 field. */
  result?: unknown;
  /** Bounded handler/runtime diagnostics. Additive v4 field. */
  diagnostics?: A2aTaskDiagnostic[];
  /**
   * Provenance of the failure reason carried in the first text part of
   * `message`. `'handler'` means the box LIFTED this code from the handler's
   * own result file or its IPC completion; absent means the daemon authored
   * it. REQ-012.4's pinned author-facing copy is gated on this.
   */
  reasonSource?: 'handler';
  /** Nonterminal exit-zero acknowledgement; valid only with WORKING. */
  deferred?: boolean;
  /** Which framework produced this update (multi-framework box). Optional. */
  framework?: CanonicalFramework;
}

export interface A2aTaskDiagnostic {
  kind: string;
  reasonCode?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Box → server: an A2A message from an agent (the up direction of the
 * bidirectional `a2a_message` frame; the server→box variant is
 * {@link A2aMessageServerFrame}). Shares the `'a2a_message'` discriminant with
 * that server frame — the two unions stay disjoint because `client_msg_id` is
 * mandatory only here (same pattern as `AckFrame` vs `AckClientFrame`).
 */
export interface A2aMessageClientFrame extends ClientFrameBase {
  type: 'a2a_message';
  /** The A2A v1.0 message (validated by T1 `validateA2aMessage`). */
  message: A2aMessage;
  /** The recipient (addressed-to) agent. */
  recipient_agent_id: string;
  /** The sending agent (provenance). Optional. */
  sender_agent_id?: string;
  /** Routing discriminator. Optional. */
  framework?: CanonicalFramework;
  /** Native session target within this task context. Optional. */
  target_session_id?: string;
}

/** Box → server: post-apply receipt for one totally ordered config revision. */
export interface A2aConfigAppliedFrame
  extends ClientFrameBase,
    A2aConfigApplicationResult {
  type: 'a2a_config_applied';
}

/** Box → server: per-type handler-file inventory for the applied revision. */
export interface A2aHandlerInventoryFrame extends ClientFrameBase {
  type: 'a2a_handler_inventory';
  config_revision: string;
  handlers: A2aHandlerInventoryEntry[];
}

/** Box → server: completion or blocking result for a maintenance operation. */
export interface A2aMaintenanceResultFrame
  extends ClientFrameBase,
    A2aMaintenanceApplicationResult {
  type: 'a2a_maintenance_result';
}

/** Box → server: liveness signal for one supervised non-terminal task. */
export interface A2aSupervisionKeepaliveFrame extends ClientFrameBase {
  type: 'a2a_supervision_keepalive';
  taskId: string;
}

/** Box-local session registration shape, kept transport-neutral (no tmux fields). */
export interface A2aSessionRegisterFrame extends ClientFrameBase {
  type: 'a2a_session_register';
  session_id: string;
  framework: 'claude_code' | 'codex' | 'openclaw' | 'hermes';
  working_directory: string;
  taskId?: string;
}

/** Box → server: task creation relay used by an authorized box session. */
export interface A2aTaskCreateFrame extends ClientFrameBase {
  type: 'a2a_task_create';
  recipient_agent_id: string;
  task_type: string;
  idempotency_key: string;
  message: A2aMessage;
  originating_session_id?: string;
}

/** Box → server: participant-scoped task read relay. */
export interface A2aTaskReadFrame extends ClientFrameBase {
  type: 'a2a_task_read';
  taskId: string;
}

/** Box → server: records that a handler exited successfully in deferred mode. */
export interface A2aDeferredAcceptedFrame extends ClientFrameBase {
  type: 'a2a_deferred_accepted';
  taskId: string;
}

export interface A2aMessageDeliveryFrame extends ClientFrameBase {
  type: 'a2a_message_delivery';
  taskId: string;
  /** The persisted thread record this outcome belongs to. */
  messageId: string;
  /**
   * The message's TERMINAL delivery state (REQ-010.5). Accepted is not
   * delivered: every accepted message reaches exactly one of these.
   */
  outcome: 'injected' | 'resumed' | 'ledger_only' | 'delivery_failed';
  /** Typed reason, required for every outcome other than a clean injection. */
  reason?: string;
}

export type ClientFrame =
  | BootstrapRequestFrame
  | ResumeFrame
  | CredentialRequestFrame
  | AckClientFrame
  | CloudflareCredentialAppliedFrame
  | GithubGrantsAppliedFrame
  | PingFrame
  | ChannelReadyFrame
  | LoginRelayUpdateFrame
  | A2aConfigAppliedFrame
  | A2aHandlerInventoryFrame
  | A2aMaintenanceResultFrame
  | A2aSupervisionKeepaliveFrame
  | A2aSessionRegisterFrame
  | A2aTaskCreateFrame
  | A2aTaskReadFrame
  | A2aDeferredAcceptedFrame
  | A2aMessageDeliveryFrame
  | A2aTaskUpdateFrame
  | A2aMessageClientFrame;

// ── Frame taxonomy — family + QoS ───────────────────────────────────────────
//
// Mirrors the server-side taxonomy (`agent-control-channel/protocol.ts`). The
// consolidated socket multiplexes five frame families. Two are reliable
// (sequenced, ring-buffered, replayed on resume) and three are transient
// (never ring-buffered / replayed on resume):
//
//   family      QoS        frames
//   ─────────   ─────────  ──────────────────────────────────────────────────
//   lifecycle   reliable   hello, ack, error, resume_window_exceeded;
//                          bootstrap_request, resume, ack, ping, channel_ready
//   credential  reliable   credential_delivered/_rotated/_revoked,
//                          config_updated; credential_request
//   login       transient  login_code, login_restart; login_relay_update
//   relay       transient  slack_event(_blocked), teams_activity(_blocked)
//   a2a         transient  a2a_task_dispatch, a2a_message (down);
//                          a2a_task_update, a2a_message (up)
//
// Like the login family, the a2a down frames are emit()-sequenced but excluded
// from the ring buffer (their durability is the server-side task store +
// watchdog re-dispatch, not socket replay) — hence transient QoS.
//
// Both maps are exhaustive by construction: the `satisfies Record<…>` makes a
// frame type added without a classification a compile error, so a new frame
// cannot silently default to a family or QoS.

/** The five frame families multiplexed over the single agent-control socket. */
export type FrameFamily =
  | 'lifecycle'
  | 'credential'
  | 'login'
  | 'relay'
  | 'a2a';

/** Every frame `type` on the wire — server-emitted or client-emitted. */
type AnyFrameType = ServerFrame['type'] | ClientFrame['type'];

const FRAME_FAMILY = {
  // lifecycle — connection/session control
  hello: 'lifecycle',
  ack: 'lifecycle',
  error: 'lifecycle',
  resume_window_exceeded: 'lifecycle',
  bootstrap_request: 'lifecycle',
  resume: 'lifecycle',
  ping: 'lifecycle',
  channel_ready: 'lifecycle',
  // credential — secret delivery / rotation / revocation / config
  credential_delivered: 'credential',
  credential_rotated: 'credential',
  credential_revoked: 'credential',
  github_grants_bundle: 'credential',
  github_grants_commit_confirmed: 'credential',
  github_grants_applied: 'credential',
  cloudflare_credential_applied: 'credential',
  config_updated: 'credential',
  credential_request: 'credential',
  // login — headless managed-login relay
  login_code: 'login',
  login_restart: 'login',
  login_relay_update: 'login',
  // relay — inbound Slack/Teams platform events
  slack_event: 'relay',
  slack_event_blocked: 'relay',
  teams_activity: 'relay',
  teams_activity_blocked: 'relay',
  // a2a — the agent-to-agent collaboration plane
  a2a_config_applied: 'a2a',
  a2a_deferred_accepted: 'a2a',
  a2a_message_delivery: 'a2a',
  a2a_handler_inventory: 'a2a',
  a2a_maintenance: 'a2a',
  a2a_maintenance_result: 'a2a',
  a2a_task_dispatch: 'a2a',
  a2a_task_update: 'a2a',
  a2a_message: 'a2a',
  a2a_session_register: 'a2a',
  a2a_supervision_keepalive: 'a2a',
  a2a_task_create: 'a2a',
  a2a_task_read: 'a2a',
} satisfies Record<AnyFrameType, FrameFamily>;

const SERVER_FRAME_QOS = {
  hello: 'reliable',
  credential_delivered: 'reliable',
  credential_rotated: 'reliable',
  credential_revoked: 'reliable',
  github_grants_bundle: 'reliable',
  github_grants_commit_confirmed: 'reliable',
  config_updated: 'reliable',
  ack: 'reliable',
  error: 'reliable',
  resume_window_exceeded: 'reliable',
  login_code: 'transient',
  login_restart: 'transient',
  slack_event: 'transient',
  slack_event_blocked: 'transient',
  teams_activity: 'transient',
  teams_activity_blocked: 'transient',
  // a2a down frames: emit()-sequenced but never ring-buffered/replayed — the
  // login-family pattern. Durability = server-side task store + watchdog.
  a2a_task_dispatch: 'transient',
  a2a_message: 'transient',
  a2a_maintenance: 'transient',
} satisfies Record<ServerFrame['type'], 'reliable' | 'transient'>;

/** Total classifier: the family of any server- or client-frame `type`. */
export function frameFamily(type: AnyFrameType): FrameFamily {
  return FRAME_FAMILY[type];
}

/**
 * Total classifier: the QoS of any SERVER frame `type`. Reliable frames enter
 * the seq stream and the resume ring buffer; transient frames never do.
 */
export function frameQos(type: ServerFrame['type']): 'reliable' | 'transient' {
  return SERVER_FRAME_QOS[type];
}

// ── Server frame parser (client-side) ─────────────────────────────────────

type Obj = Record<string, unknown>;

const DECIMAL_REVISION_RE = /^[1-9][0-9]*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_FRAMEWORKS = new Set<CanonicalFramework>([
  'claude_code',
  'codex',
  'openclaw',
  'hermes',
]);
const HANDLER_STATES = new Set<A2aHandlerState>([
  'current',
  'outdated_unedited',
  'owner_modified',
  'example_scaffold',
  'not_installed_apply_pending',
  'not_installed_custom',
  'missing_deleted',
  'custom_no_reference',
  'not_reported',
]);

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Obj, allowed: readonly string[]): boolean {
  const keySet = new Set(allowed);
  return Object.keys(value).every((key) => keySet.has(key));
}

function isNonEmptyString(
  value: unknown,
  maxBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const size = utf8ByteLength(value);
  return size !== null && size <= maxBytes;
}

function utf8ByteLength(value: string): number | null {
  let size = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    if (codePoint <= 0x7f) size += 1;
    else if (codePoint <= 0x7ff) size += 2;
    else if (codePoint <= 0xffff) size += 3;
    else size += 4;
  }
  return size;
}

function unicodeScalarCompare(left: string, right: string): number {
  const a = [...left].map((char) => char.codePointAt(0) as number);
  const b = [...right].map((char) => char.codePointAt(0) as number);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index])
      return (a[index] as number) - (b[index] as number);
  }
  return a.length - b.length;
}

function conservativeJsonStringBudget(value: string): number | null {
  let size = 2;
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
    if (codePoint <= 0x1f) size += 6;
    else if (codePoint === 0x22 || codePoint === 0x5c) size += 2;
    else {
      const bytes = utf8ByteLength(char);
      if (bytes === null) return null;
      size += bytes;
    }
  }
  return size;
}

/**
 * Conservative cross-language normalized-size budget for arbitrary JSON.
 *
 * This is deliberately not a native serialized-JSON byte count. Strings use
 * quoted Unicode-scalar JSON form (controls as lowercase `\\u00xx`, U+2028 and
 * U+2029 literal), object keys use Unicode-scalar ordering, and every finite
 * number has a fixed 24-byte budget: the longest finite IEEE-754 decimal token.
 * Unsupported values, cycles, non-finite numbers, and unpaired surrogates are
 * rejected so TypeScript, Go, and Python make the same admission decision.
 */
export function conservativeJsonSizeBudget(value: unknown): number | null {
  const ancestors = new WeakSet<object>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the auditable recursive cross-language JSON budget type switch.
  const visit = (current: unknown): number | null => {
    if (current === null) return 4;
    if (typeof current === 'boolean') return current ? 4 : 5;
    if (typeof current === 'number')
      return Number.isFinite(current) ? 24 : null;
    if (typeof current === 'string')
      return conservativeJsonStringBudget(current);
    if (typeof current !== 'object') return null;
    if (ancestors.has(current)) return null;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        let size = 2 + Math.max(0, current.length - 1);
        for (const item of current) {
          const itemSize = visit(item);
          if (itemSize === null) return null;
          size += itemSize;
        }
        return size;
      }
      const prototype = Object.getPrototypeOf(current);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(current).length > 0
      ) {
        return null;
      }
      const object = current as Record<string, unknown>;
      const keys = Object.keys(object).sort(unicodeScalarCompare);
      let size = 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        const keySize = conservativeJsonStringBudget(key);
        const itemSize = visit(object[key]);
        if (keySize === null || itemSize === null) return null;
        size += keySize + 1 + itemSize;
      }
      return size;
    } catch {
      return null;
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value);
}

/** DEC-14 exact compact JSON UTF-8 metric for the task-message parts value. */
function serializedJsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : utf8ByteLength(serialized);
  } catch {
    return null;
  }
}

function a2aMessageTextWithinLimit(value: A2aMessage): boolean {
  return value.parts.every((part) => {
    if (part.text === undefined) return true;
    const size = utf8ByteLength(part.text);
    return size !== null && size <= A2A_PROTOCOL_LIMITS.messageTextBytes;
  });
}

function a2aArtifactWithinLimits(value: A2aArtifact): boolean {
  if (
    value.name !== undefined &&
    (utf8ByteLength(value.name) === null ||
      (utf8ByteLength(value.name) as number) >
        A2A_PROTOCOL_LIMITS.artifactLabelBytes)
  ) {
    return false;
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: all canonical artifact part variants are checked at one contract boundary.
  return value.parts.every((part) => {
    if (
      part.text !== undefined &&
      (utf8ByteLength(part.text) === null ||
        (utf8ByteLength(part.text) as number) >
          A2A_PROTOCOL_LIMITS.artifactValueBytes)
    ) {
      return false;
    }
    if (
      part.url !== undefined &&
      (utf8ByteLength(part.url) === null ||
        (utf8ByteLength(part.url) as number) >
          A2A_PROTOCOL_LIMITS.artifactValueBytes)
    ) {
      return false;
    }
    if (part.data !== undefined) {
      const size =
        typeof part.data === 'string'
          ? utf8ByteLength(part.data)
          : conservativeJsonSizeBudget(part.data);
      if (size === null || size > A2A_PROTOCOL_LIMITS.artifactValueBytes) {
        return false;
      }
    }
    return true;
  });
}

function validA2aMessage(
  value: unknown,
  textLimit = false,
  partsLimit = false,
): value is A2aMessage {
  const result = validateA2aMessage(value);
  const partsBudget = result.valid
    ? serializedJsonByteLength(result.value.parts)
    : null;
  return (
    result.valid &&
    conservativeJsonSizeBudget(value) !== null &&
    (!partsLimit ||
      (partsBudget !== null &&
        partsBudget <= A2A_PROTOCOL_LIMITS.messagePartsBytes)) &&
    (!textLimit || a2aMessageTextWithinLimit(result.value))
  );
}

function validA2aArtifact(value: unknown): value is A2aArtifact {
  const task = validateA2aTask({
    id: 'contract-validation',
    status: { state: 'SUBMITTED' },
    artifacts: [value as A2aArtifact],
  });
  return (
    task.valid &&
    conservativeJsonSizeBudget(value) !== null &&
    a2aArtifactWithinLimits(task.value.artifacts?.[0] as A2aArtifact)
  );
}

function validTaskUpdateDiagnostics(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length > A2A_PROTOCOL_LIMITS.diagnosticsPerUpdate
  )
    return false;
  let aggregate = 0;
  for (const item of value) {
    if (
      !isPlainObject(item) ||
      !hasOnlyKeys(item, ['kind', 'reasonCode', 'message', 'details']) ||
      typeof item.kind !== 'string' ||
      !A2A_TASK_TYPE_PATTERN.test(item.kind) ||
      (item.reasonCode !== undefined && typeof item.reasonCode !== 'string') ||
      (item.message !== undefined && typeof item.message !== 'string') ||
      (item.details !== undefined && !isPlainObject(item.details))
    )
      return false;
    const reasonBytes =
      item.reasonCode === undefined ? 0 : utf8ByteLength(item.reasonCode);
    const messageBytes =
      item.message === undefined ? 0 : utf8ByteLength(item.message);
    const detailsBytes =
      item.details === undefined || Object.keys(item.details).length === 0
        ? 0
        : utf8ByteLength(JSON.stringify(item.details));
    if (reasonBytes === null || messageBytes === null || detailsBytes === null)
      return false;
    aggregate += reasonBytes + messageBytes + detailsBytes;
  }
  return aggregate <= A2A_PROTOCOL_LIMITS.diagnosticsBytesPerUpdate;
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_REVISION_RE.test(value);
}

function isTaskType(value: unknown): value is string {
  return typeof value === 'string' && A2A_TASK_TYPE_PATTERN.test(value);
}

function isDispatchEventContext(value: unknown): boolean {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ['origin', 'sender', 'provider', 'delivery_id']) ||
    !isPlainObject(value.sender) ||
    !hasOnlyKeys(value.sender, ['kind', 'identity'])
  )
    return false;
  const sender = value.sender;
  if (value.origin === 'send') {
    return (
      (sender.kind === 'user' || sender.kind === 'agent') &&
      typeof sender.identity === 'string' &&
      UUID_RE.test(sender.identity) &&
      value.provider === undefined &&
      value.delivery_id === undefined
    );
  }
  return (
    value.origin === 'webhook' &&
    sender.kind === 'coordinator' &&
    sender.identity === 'spellguard' &&
    isNonEmptyString(value.provider, A2A_PROTOCOL_LIMITS.identifierBytes) &&
    isNonEmptyString(value.delivery_id, A2A_PROTOCOL_LIMITS.identifierBytes)
  );
}

/** The four terminal delivery states of REQ-010.5. */
const DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  'injected',
  'resumed',
  'ledger_only',
  'delivery_failed',
]);

function isDeliveryOutcome(value: unknown): boolean {
  return typeof value === 'string' && DELIVERY_OUTCOMES.has(value);
}

function isTaskTypeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isTaskType);
}

function isBlockedTaskTypes(value: unknown): value is A2aBlockedTaskType[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        hasOnlyKeys(entry, ['task_type', 'cause']) &&
        isTaskType(entry.task_type) &&
        isNonEmptyString(entry.cause, 500),
    )
  );
}

function isHandlerInventory(
  value: unknown,
): value is A2aHandlerInventoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        hasOnlyKeys(entry, [
          'task_type',
          'state',
          'path',
          'installed_hash',
          'current_hash',
          'dist_hash',
          'blocking_cause',
        ]) &&
        isTaskType(entry.task_type) &&
        typeof entry.state === 'string' &&
        HANDLER_STATES.has(entry.state as A2aHandlerState) &&
        isNonEmptyString(entry.path, 4096) &&
        (entry.installed_hash === undefined ||
          isNonEmptyString(entry.installed_hash, 256)) &&
        (entry.current_hash === undefined ||
          isNonEmptyString(entry.current_hash, 256)) &&
        (entry.dist_hash === undefined ||
          isNonEmptyString(entry.dist_hash, 256)) &&
        (entry.blocking_cause === undefined ||
          isNonEmptyString(entry.blocking_cause, 500)),
    )
  );
}

function isConfigApplication(value: Obj): boolean {
  return (
    isRevision(value.config_revision) &&
    isTaskTypeList(value.applied_task_types) &&
    isBlockedTaskTypes(value.blocked_task_types) &&
    (value.superseded === undefined || typeof value.superseded === 'boolean')
  );
}

function isMaintenanceApplication(value: Obj): boolean {
  return (
    isNonEmptyString(value.operation_id, 256) &&
    (value.status === 'applied' || value.status === 'blocked') &&
    isRevision(value.config_revision) &&
    (value.reason === undefined || isNonEmptyString(value.reason, 500))
  );
}

const PUBLIC_TASK_RESPONSE_KEYS = [
  'id',
  'contextId',
  'organizationId',
  'senderKind',
  'senderAgentId',
  'senderUserId',
  'recipientAgentId',
  'originatingAgentId',
  'originatingAgentIdentity',
  'originatingSessionId',
  'framework',
  'type',
  'state',
  'artifactUrl',
  'metadata',
  'resultPayload',
  'deferred',
  'lastProgressAt',
  'lastSupervisionKeepaliveAt',
  'effectiveDeadlineAt',
  'workingTimeoutSeconds',
  'hasUnansweredWorkerMessage',
  'threadRecordCount',
  'threadWriteAttemptCount',
  'suppressedMessageCount',
  'suppressedProgressCount',
  'artifactCount',
  'terminalAt',
  'createdAt',
  'updatedAt',
] as const;

const TASK_SUMMARY_RESPONSE_KEYS = [
  ...PUBLIC_TASK_RESPONSE_KEYS.filter(
    (key) =>
      key !== 'originatingAgentId' &&
      key !== 'originatingAgentIdentity' &&
      key !== 'originatingSessionId',
  ),
  'typeLabel',
  'stateLabel',
] as const;

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function exactKeys(value: Obj, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function validTaskResponseBase(value: Obj, summary: boolean): boolean {
  const keys = summary ? TASK_SUMMARY_RESPONSE_KEYS : PUBLIC_TASK_RESPONSE_KEYS;
  return (
    exactKeys(value, keys) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.contextId) &&
    isNonEmptyString(value.organizationId) &&
    (value.senderKind === 'agent' ||
      value.senderKind === 'coordinator' ||
      value.senderKind === 'user') &&
    nullableString(value.senderAgentId) &&
    nullableString(value.senderUserId) &&
    isNonEmptyString(value.recipientAgentId) &&
    (summary ||
      (nullableString(value.originatingAgentId) &&
        nullableString(value.originatingAgentIdentity) &&
        nullableString(value.originatingSessionId))) &&
    nullableString(value.framework) &&
    isNonEmptyString(value.type) &&
    A2A_TASK_STATES.includes(value.state as A2aTaskState) &&
    nullableString(value.artifactUrl) &&
    isPlainObject(value.metadata) &&
    typeof value.deferred === 'boolean' &&
    nullableString(value.lastProgressAt) &&
    nullableString(value.lastSupervisionKeepaliveAt) &&
    nullableString(value.effectiveDeadlineAt) &&
    (value.workingTimeoutSeconds === null ||
      typeof value.workingTimeoutSeconds === 'number') &&
    typeof value.hasUnansweredWorkerMessage === 'boolean' &&
    typeof value.threadRecordCount === 'number' &&
    typeof value.threadWriteAttemptCount === 'number' &&
    typeof value.suppressedMessageCount === 'number' &&
    typeof value.suppressedProgressCount === 'number' &&
    typeof value.artifactCount === 'number' &&
    nullableString(value.terminalAt) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt) &&
    (!summary ||
      (isNonEmptyString(value.typeLabel) && isNonEmptyString(value.stateLabel)))
  );
}

function validatePublicTaskResponse(
  value: unknown,
): value is A2aPublicTaskResponse {
  return isPlainObject(value) && validTaskResponseBase(value, false);
}

function validateTaskDetailResponse(
  value: unknown,
): value is A2aTaskDetailResponse {
  if (!isPlainObject(value)) return false;
  const { thread, artifacts, diagnostics, ...summary } = value;
  return (
    validTaskResponseBase(summary, true) &&
    Array.isArray(thread) &&
    Array.isArray(artifacts) &&
    Array.isArray(diagnostics) &&
    thread.every(validateTaskThreadResponse) &&
    artifacts.every(validateTaskArtifactResponse) &&
    diagnostics.every(validateTaskDiagnosticResponse)
  );
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateTaskThreadResponse(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    exactKeys(value, [
      'id',
      'sequence',
      'recordKind',
      'messageId',
      'senderRole',
      'senderKind',
      'senderAgentId',
      'senderAgentIdentity',
      'senderUserId',
      'senderUserIdentity',
      'senderDisplayName',
      'text',
      'parts',
      'postTerminal',
      'deliveryState',
      'deliveryReason',
      'terminalState',
      'terminalCause',
      'createdAt',
    ]) &&
    isNonEmptyString(value.id) &&
    nonnegativeInteger(value.sequence) &&
    (value.recordKind === 'progress' ||
      value.recordKind === 'message' ||
      value.recordKind === 'terminal') &&
    nullableString(value.messageId) &&
    (value.senderRole === null ||
      value.senderRole === 'USER' ||
      value.senderRole === 'AGENT') &&
    (value.senderKind === null ||
      value.senderKind === 'agent' ||
      value.senderKind === 'user' ||
      value.senderKind === 'coordinator' ||
      value.senderKind === 'handler' ||
      value.senderKind === 'daemon') &&
    nullableString(value.senderAgentId) &&
    nullableString(value.senderAgentIdentity) &&
    nullableString(value.senderUserId) &&
    nullableString(value.senderUserIdentity) &&
    nullableString(value.senderDisplayName) &&
    nullableString(value.text) &&
    typeof value.postTerminal === 'boolean' &&
    nullableString(value.deliveryState) &&
    nullableString(value.deliveryReason) &&
    (value.terminalState === null ||
      A2A_TASK_STATES.includes(value.terminalState as A2aTaskState)) &&
    (value.terminalCause === null || isPlainObject(value.terminalCause)) &&
    isNonEmptyString(value.createdAt)
  );
}

function validateTaskArtifactResponse(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    exactKeys(value, [
      'id',
      'artifactId',
      'sequence',
      'type',
      'value',
      'displayLabel',
      'metadata',
      'createdAt',
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.artifactId) &&
    nonnegativeInteger(value.sequence) &&
    isNonEmptyString(value.type) &&
    typeof value.value === 'string' &&
    nullableString(value.displayLabel) &&
    isPlainObject(value.metadata) &&
    isNonEmptyString(value.createdAt)
  );
}

function validateTaskDiagnosticResponse(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    exactKeys(value, [
      'id',
      'sequence',
      'kind',
      'reasonCode',
      'message',
      'details',
      'createdAt',
    ]) &&
    isNonEmptyString(value.id) &&
    nonnegativeInteger(value.sequence) &&
    isNonEmptyString(value.kind) &&
    nullableString(value.reasonCode) &&
    nullableString(value.message) &&
    isPlainObject(value.details) &&
    isNonEmptyString(value.createdAt)
  );
}

/** Runtime validator for the optional data carried by a generalized ACK. */
export function validateA2aAckResult(value: unknown): value is A2aAckResult {
  if (!isPlainObject(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'task_update':
      return (
        hasOnlyKeys(value, ['kind', 'outcome', 'response']) &&
        (value.outcome === 'persisted' ||
          value.outcome === 'already_terminal' ||
          value.outcome === 'thread_bound_reached') &&
        (value.response === undefined ||
          validatePublicTaskResponse(value.response))
      );
    case 'message':
      return (
        hasOnlyKeys(value, ['kind', 'outcome', 'message_id', 'response']) &&
        value.outcome === 'persisted' &&
        isNonEmptyString(value.message_id) &&
        (value.response === undefined ||
          (isPlainObject(value.response) &&
            exactKeys(value.response, ['messageId', 'postTerminal']) &&
            isNonEmptyString(value.response.messageId) &&
            typeof value.response.postTerminal === 'boolean'))
      );
    case 'task_create':
      return (
        hasOnlyKeys(value, ['kind', 'task', 'outcome', 'response']) &&
        validateA2aTask(value.task).valid &&
        conservativeJsonSizeBudget(value.task) !== null &&
        (value.outcome === undefined ||
          value.outcome === 'created' ||
          value.outcome === 'duplicate' ||
          value.outcome === 'delivery_failed' ||
          // Acceptance, not failure: the recipient box was asleep, the task is
          // durably parked and a wake was requested. The server emits this for
          // task_create; rejecting it drops the entire ack frame (see the
          // declared `A2aAckResult` union and the Go daemon's mirror).
          value.outcome === 'pending_wake') &&
        (value.response === undefined ||
          validatePublicTaskResponse(value.response))
      );
    case 'task_read':
      return (
        hasOnlyKeys(value, ['kind', 'task', 'response']) &&
        validateA2aTask(value.task).valid &&
        conservativeJsonSizeBudget(value.task) !== null &&
        (value.response === undefined ||
          validateTaskDetailResponse(value.response))
      );
    case 'config_applied':
      return (
        hasOnlyKeys(value, [
          'kind',
          'config_revision',
          'applied_task_types',
          'blocked_task_types',
          'superseded',
        ]) && isConfigApplication(value)
      );
    case 'maintenance':
      return (
        hasOnlyKeys(value, [
          'kind',
          'operation_id',
          'status',
          'config_revision',
          'reason',
        ]) && isMaintenanceApplication(value)
      );
    default:
      return false;
  }
}

/**
 * Strict Task 1 contract validator for generalized v4 frames. It deliberately
 * validates only the additive generalized family; legacy parser tolerance is
 * unchanged for byte shapes that were already valid before this extension.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one closed discriminator switch is the auditable wire-contract boundary.
export function validateA2aContractFrame(
  value: unknown,
  direction: 'server' | 'client',
): boolean {
  if (!isPlainObject(value) || typeof value.type !== 'string') return false;
  const serverBase =
    direction === 'server' &&
    isNonEmptyString(value.seq) &&
    isNonEmptyString(value.ts);
  const clientBase =
    direction === 'client' &&
    isNonEmptyString(value.client_msg_id, A2A_PROTOCOL_LIMITS.identifierBytes);

  switch (value.type) {
    case 'a2a_task_dispatch':
      return (
        serverBase &&
        hasOnlyKeys(value, [
          'type',
          'seq',
          'ts',
          'task',
          'message',
          'framework',
          'recipient_agent_id',
          'sender_agent_id',
          'org_id',
          'event_context',
        ]) &&
        isNonEmptyString(
          value.recipient_agent_id,
          A2A_PROTOCOL_LIMITS.identifierBytes,
        ) &&
        (value.sender_agent_id === undefined ||
          isNonEmptyString(
            value.sender_agent_id,
            A2A_PROTOCOL_LIMITS.identifierBytes,
          )) &&
        (value.org_id === undefined ||
          isNonEmptyString(
            value.org_id,
            A2A_PROTOCOL_LIMITS.identifierBytes,
          )) &&
        (value.framework === undefined ||
          (typeof value.framework === 'string' &&
            CANONICAL_FRAMEWORKS.has(value.framework as CanonicalFramework))) &&
        (value.event_context === undefined ||
          isDispatchEventContext(value.event_context)) &&
        validateA2aTask(value.task).valid &&
        validateA2aMessage(value.message).valid
      );
    case 'config_updated':
      return (
        serverBase &&
        hasOnlyKeys(value, [
          'type',
          'seq',
          'ts',
          'config',
          'triggers_rotation',
          'config_revision',
        ]) &&
        isPlainObject(value.config) &&
        typeof value.triggers_rotation === 'boolean' &&
        isRevision(value.config_revision)
      );
    case 'a2a_maintenance':
      return (
        serverBase &&
        hasOnlyKeys(value, [
          'type',
          'seq',
          'ts',
          'operation_id',
          'action',
          'config_revision',
        ]) &&
        isNonEmptyString(value.operation_id, 256) &&
        value.action === 'backfill' &&
        isRevision(value.config_revision)
      );
    case 'a2a_config_applied':
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'config_revision',
          'applied_task_types',
          'blocked_task_types',
          'superseded',
        ]) &&
        isConfigApplication(value)
      );
    case 'a2a_handler_inventory':
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'config_revision',
          'handlers',
        ]) &&
        isRevision(value.config_revision) &&
        isHandlerInventory(value.handlers)
      );
    case 'a2a_maintenance_result':
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'operation_id',
          'status',
          'config_revision',
          'reason',
        ]) &&
        isMaintenanceApplication(value)
      );
    case 'a2a_supervision_keepalive':
    case 'a2a_task_read':
    case 'a2a_deferred_accepted':
      return (
        clientBase &&
        hasOnlyKeys(value, ['type', 'client_msg_id', 'taskId']) &&
        isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes)
      );
    case 'a2a_message_delivery':
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'taskId',
          'messageId',
          'reason',
          'outcome',
        ]) &&
        isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) &&
        isNonEmptyString(
          value.messageId,
          A2A_PROTOCOL_LIMITS.identifierBytes,
        ) &&
        isDeliveryOutcome(value.outcome) &&
        // A clean injection needs no explanation; every other terminal state
        // must name why, so no message ends as an unexplained failure.
        (value.outcome === 'injected'
          ? value.reason === undefined
          : isNonEmptyString(value.reason, A2A_PROTOCOL_LIMITS.identifierBytes))
      );
    case 'a2a_session_register':
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'session_id',
          'framework',
          'working_directory',
          'taskId',
        ]) &&
        isNonEmptyString(value.session_id, 256) &&
        typeof value.framework === 'string' &&
        CANONICAL_FRAMEWORKS.has(value.framework as CanonicalFramework) &&
        isNonEmptyString(value.working_directory, 4096) &&
        (value.taskId === undefined ||
          isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes))
      );
    case 'a2a_task_create': {
      const messageBudget = conservativeJsonSizeBudget(value.message);
      const frameBudget = conservativeJsonSizeBudget(value);
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'recipient_agent_id',
          'task_type',
          'idempotency_key',
          'message',
          'originating_session_id',
        ]) &&
        isNonEmptyString(
          value.recipient_agent_id,
          A2A_PROTOCOL_LIMITS.identifierBytes,
        ) &&
        isTaskType(value.task_type) &&
        isNonEmptyString(value.idempotency_key, 256) &&
        validA2aMessage(value.message, true) &&
        messageBudget !== null &&
        messageBudget <= A2A_PROTOCOL_LIMITS.taskCreateInputBytes &&
        frameBudget !== null &&
        frameBudget - messageBudget <=
          A2A_PROTOCOL_LIMITS.taskCreateEnvelopeBytes &&
        (value.originating_session_id === undefined ||
          isNonEmptyString(value.originating_session_id, 256))
      );
    }
    case 'a2a_task_update': {
      const artifacts = value.artifacts;
      const artifact = value.artifact;
      const artifactsValid =
        artifacts === undefined ||
        (Array.isArray(artifacts) && artifacts.every(validA2aArtifact));
      const artifactValid =
        artifact === undefined || validA2aArtifact(artifact);
      const artifactCount =
        (artifact === undefined ? 0 : 1) +
        (Array.isArray(artifacts) ? artifacts.length : 0);
      const resultBudget =
        value.result === undefined
          ? 0
          : conservativeJsonSizeBudget(value.result);
      return (
        clientBase &&
        hasOnlyKeys(value, [
          'type',
          'client_msg_id',
          'taskId',
          'state',
          'message',
          'artifact',
          'artifacts',
          'result',
          'diagnostics',
          'reasonSource',
          'deferred',
          'framework',
        ]) &&
        isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) &&
        typeof value.state === 'string' &&
        A2A_TASK_STATES.includes(value.state as A2aTaskState) &&
        (value.message === undefined || validA2aMessage(value.message, true)) &&
        artifactValid &&
        artifactsValid &&
        artifactCount <= A2A_PROTOCOL_LIMITS.artifactsPerUpdate &&
        resultBudget !== null &&
        resultBudget <= A2A_PROTOCOL_LIMITS.taskUpdateResultBytes &&
        (value.diagnostics === undefined ||
          validTaskUpdateDiagnostics(value.diagnostics)) &&
        // Present-or-absent, and 'handler' is the ONLY admissible value: a
        // daemon-authored reason is the default, so there is no positive daemon
        // marker to accept — anything else is drift and fails the whole frame.
        (value.reasonSource === undefined ||
          value.reasonSource === 'handler') &&
        (value.deferred === undefined ||
          (value.deferred === true && value.state === 'WORKING')) &&
        (value.framework === undefined ||
          (typeof value.framework === 'string' &&
            CANONICAL_FRAMEWORKS.has(value.framework as CanonicalFramework)))
      );
    }
    case 'a2a_message': {
      const common =
        validA2aMessage(value.message, true, true) &&
        isNonEmptyString(
          value.recipient_agent_id,
          A2A_PROTOCOL_LIMITS.identifierBytes,
        ) &&
        (value.sender_agent_id === undefined ||
          isNonEmptyString(
            value.sender_agent_id,
            A2A_PROTOCOL_LIMITS.identifierBytes,
          )) &&
        (value.framework === undefined ||
          (typeof value.framework === 'string' &&
            CANONICAL_FRAMEWORKS.has(value.framework as CanonicalFramework))) &&
        (value.target_session_id === undefined ||
          isNonEmptyString(value.target_session_id, 256));
      if (direction === 'client') {
        return (
          clientBase &&
          hasOnlyKeys(value, [
            'type',
            'client_msg_id',
            'message',
            'recipient_agent_id',
            'sender_agent_id',
            'framework',
            'target_session_id',
          ]) &&
          common
        );
      }
      return (
        serverBase &&
        hasOnlyKeys(value, [
          'type',
          'seq',
          'ts',
          'message',
          'recipient_agent_id',
          'sender_agent_id',
          'framework',
          'org_id',
          'target_session_id',
        ]) &&
        common &&
        (value.org_id === undefined ||
          isNonEmptyString(value.org_id, A2A_PROTOCOL_LIMITS.identifierBytes))
      );
    }
    default:
      return false;
  }
}

function isGeneralizedServerEnvelopeValid(obj: Obj): boolean {
  if (obj.type === 'ack' && obj.result !== undefined) {
    return validateA2aAckResult(obj.result);
  }
  if (obj.type === 'config_updated' && obj.config_revision !== undefined) {
    return validateA2aContractFrame(obj, 'server');
  }
  if (obj.type === 'a2a_maintenance') {
    return validateA2aContractFrame(obj, 'server');
  }
  if (obj.type === 'a2a_task_dispatch') {
    return validateA2aContractFrame(obj, 'server');
  }
  if (obj.type === 'a2a_message') {
    return validateA2aContractFrame(obj, 'server');
  }
  return true;
}

const KNOWN_SERVER_FRAME_TYPES = new Set([
  'hello',
  'credential_delivered',
  'credential_rotated',
  'credential_revoked',
  'github_grants_bundle',
  'github_grants_commit_confirmed',
  'config_updated',
  'ack',
  'error',
  'resume_window_exceeded',
  'login_code',
  'login_restart',
  'slack_event',
  'slack_event_blocked',
  'teams_activity',
  'teams_activity_blocked',
  // A2A collaboration-plane down frames (Task T2). `a2a_message` is
  // bidirectional; this is its server→box direction.
  'a2a_task_dispatch',
  'a2a_message',
  'a2a_maintenance',
]);

/**
 * The a2a collaboration-plane frame type discriminants (both directions).
 * Exported so consumers can branch the a2a plane off the credential plane
 * without re-listing the strings.
 */
export const A2A_FRAME_TYPES: ReadonlySet<string> = new Set([
  'a2a_config_applied',
  'a2a_deferred_accepted',
  'a2a_message_delivery',
  'a2a_handler_inventory',
  'a2a_maintenance',
  'a2a_maintenance_result',
  'a2a_task_dispatch',
  'a2a_task_update',
  'a2a_message',
  'a2a_session_register',
  'a2a_supervision_keepalive',
  'a2a_task_create',
  'a2a_task_read',
]);

/**
 * Whether a frame (or any `{type}`-shaped value) belongs to the a2a
 * collaboration plane rather than the credential/login plane.
 */
export function isA2aFrame(
  frame: { type?: unknown } | null | undefined,
): boolean {
  if (!frame || typeof frame !== 'object') return false;
  return A2A_FRAME_TYPES.has((frame as { type?: unknown }).type as string);
}

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

  // V5 is a closed, version-marked contract. It must never be accepted by the
  // permissive V4 path below, because doing so could acknowledge a bundle a
  // receiver did not atomically apply.
  if (obj.type === 'github_grants_bundle') {
    if (!isGithubGrantsBundle(obj)) return null;
    return obj as unknown as GithubGrantsBundleFrame;
  }
  if (obj.type === 'github_grants_commit_confirmed') {
    if (
      !hasOnlyKeys(obj, [
        'type',
        'protocol_version',
        'seq',
        'ts',
        'delivery_id',
        'grant_set_revision',
      ]) ||
      obj.protocol_version !== '5' ||
      typeof obj.seq !== 'string' ||
      typeof obj.ts !== 'string' ||
      typeof obj.delivery_id !== 'string' ||
      !UUID_RE.test(obj.delivery_id) ||
      !isRevision(obj.grant_set_revision)
    )
      return null;
    return obj as unknown as GithubGrantsCommitConfirmedFrame;
  }
  if (A2A_FRAME_TYPES.has(obj.type) && conservativeJsonSizeBudget(obj) === null)
    return null;

  // Field-level validation for login_code: `code` must be a non-empty string.
  if (obj.type === 'login_code') {
    if (typeof obj.code !== 'string' || obj.code.length === 0) return null;
  }

  if (!isGeneralizedServerEnvelopeValid(obj)) return null;

  // A2A frames carry the T1 payload shapes — a smuggled credential field fails
  // the T1 validator (see `isA2aServerPayloadValid`).
  if (!isA2aServerPayloadValid(obj)) return null;

  return obj as unknown as ServerFrame;
}

function isGithubGrantsBundle(value: Obj): boolean {
  if (
    !hasOnlyKeys(value, [
      'type',
      'protocol_version',
      'seq',
      'ts',
      'delivery_id',
      'grant_set_revision',
      'credentials',
    ]) ||
    value.protocol_version !== '5' ||
    typeof value.seq !== 'string' ||
    typeof value.ts !== 'string' ||
    typeof value.delivery_id !== 'string' ||
    !UUID_RE.test(value.delivery_id) ||
    !isRevision(value.grant_set_revision) ||
    !Array.isArray(value.credentials)
  )
    return false;

  const grantIds = new Set<string>();
  const installationIds = new Set<string>();
  const credentialIds = new Set<string>();
  const scopedTokenIds = new Set<string>();
  const numericInstallationIds = new Set<number>();
  const owners = new Set<string>();
  let memberAgentId: string | undefined;
  for (const raw of value.credentials) {
    if (!isPlainObject(raw)) return false;
    const scope = raw.scope;
    const providerData = raw.provider_data;
    if (
      !hasOnlyKeys(raw, [
        'grant_id',
        'installation_record_id',
        'credential_id',
        'scoped_token_id',
        'agent_id',
        'provider',
        'kind',
        'status',
        'grant_revision',
        'grant_set_revision',
        'github_org_login',
        'github_org_display_name',
        'installation_id',
        'expires_at',
        'scoped_token',
        'access',
        'scope',
        'provider_data',
      ]) ||
      raw.provider !== 'github' ||
      raw.kind !== 'issued' ||
      raw.status !== 'valid' ||
      typeof raw.grant_id !== 'string' ||
      !UUID_RE.test(raw.grant_id) ||
      typeof raw.installation_record_id !== 'string' ||
      !UUID_RE.test(raw.installation_record_id) ||
      typeof raw.credential_id !== 'string' ||
      !UUID_RE.test(raw.credential_id) ||
      // NOT a UUID, unlike the four relational ids around it. This is GitHub's
      // INSTALLATION-TOKEN id — a number the mint path stringifies
      // (`scopedTokenId()` in `services/github/github-api.ts`) into the `text`
      // column `credentials.scoped_token_id`; real rows look like `5249971925`.
      // A UUID test here rejected every bundle the server actually sends, so a
      // marked agent's credential store stayed empty and git kept 401ing. It is
      // an OPAQUE identifier everywhere else in the codebase (the API contract
      // types it `z.string().min(1)`), and it is validated as one here: present,
      // a string, non-empty. Uniqueness within the bundle is still enforced
      // below.
      typeof raw.scoped_token_id !== 'string' ||
      raw.scoped_token_id.length === 0 ||
      typeof raw.agent_id !== 'string' ||
      !UUID_RE.test(raw.agent_id) ||
      !isRevision(raw.grant_revision) ||
      raw.grant_set_revision !== value.grant_set_revision ||
      typeof raw.github_org_login !== 'string' ||
      raw.github_org_login.length === 0 ||
      typeof raw.github_org_display_name !== 'string' ||
      raw.github_org_display_name.trim().length === 0 ||
      typeof raw.installation_id !== 'number' ||
      !Number.isSafeInteger(raw.installation_id) ||
      raw.installation_id <= 0 ||
      typeof raw.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(raw.expires_at)) ||
      typeof raw.scoped_token !== 'string' ||
      raw.scoped_token.length === 0 ||
      !['read', 'write'].includes(raw.access as string) ||
      !isPlainObject(scope) ||
      !isPlainObject(providerData) ||
      !hasOnlyKeys(providerData, [
        'github_user_id',
        'github_login',
        'github_user_email',
        'git_author_name',
        'git_author_email',
      ]) ||
      typeof providerData.github_user_id !== 'number' ||
      !Number.isSafeInteger(providerData.github_user_id) ||
      // Strictly positive: no GitHub account has id 0, and 0 is precisely the
      // placeholder a missing identity used to produce server-side. The
      // plugins write this into the box's real git config, so a bundle whose
      // committer resolves to nobody is refused at the boundary too.
      providerData.github_user_id <= 0 ||
      typeof providerData.github_login !== 'string' ||
      providerData.github_login.trim().length === 0 ||
      !(
        providerData.github_user_email === null ||
        typeof providerData.github_user_email === 'string'
      ) ||
      typeof providerData.git_author_name !== 'string' ||
      providerData.git_author_name.trim().length === 0 ||
      typeof providerData.git_author_email !== 'string' ||
      providerData.git_author_email.trim().length === 0
    )
      return false;
    const owner = raw.github_org_login as string;
    const validScope =
      (scope.mode === 'all' && hasOnlyKeys(scope, ['mode'])) ||
      (scope.mode === 'selected' &&
        hasOnlyKeys(scope, ['mode', 'repository_names']) &&
        Array.isArray(scope.repository_names) &&
        scope.repository_names.length > 0 &&
        scope.repository_names.every((name) => {
          if (typeof name !== 'string' || name !== name.toLowerCase())
            return false;
          const parts = name.split('/');
          return (
            parts.length === 2 &&
            parts[0] === owner.toLowerCase() &&
            parts[1].length > 0
          );
        }) &&
        new Set(scope.repository_names).size === scope.repository_names.length);
    if (!validScope) return false;
    const normalizedLogin = owner.toLowerCase();
    if (
      grantIds.has(raw.grant_id) ||
      installationIds.has(raw.installation_record_id) ||
      credentialIds.has(raw.credential_id) ||
      scopedTokenIds.has(raw.scoped_token_id) ||
      numericInstallationIds.has(raw.installation_id) ||
      (memberAgentId !== undefined && memberAgentId !== raw.agent_id) ||
      owners.has(normalizedLogin)
    )
      return false;
    grantIds.add(raw.grant_id);
    installationIds.add(raw.installation_record_id);
    credentialIds.add(raw.credential_id);
    scopedTokenIds.add(raw.scoped_token_id);
    numericInstallationIds.add(raw.installation_id);
    memberAgentId = raw.agent_id;
    owners.add(normalizedLogin);
  }
  return true;
}

/**
 * Validate the embedded A2A v1.0 payload of a server→box a2a frame by delegating
 * to the T1 validators; a non-a2a frame is trivially valid here. NEG-001: a
 * smuggled credential field (a closed-key-set violation) fails the T1 validator,
 * so `parseServerFrame` rejects the frame non-fatally — the a2a frame NEVER
 * defines its own divergent payload shape.
 */
function isA2aServerPayloadValid(obj: Obj): boolean {
  if (obj.type === 'a2a_task_dispatch') {
    return (
      validateA2aTask(obj.task).valid &&
      validateA2aMessage(obj.message).valid &&
      conservativeJsonSizeBudget(obj.task) !== null &&
      conservativeJsonSizeBudget(obj.message) !== null
    );
  }
  if (obj.type === 'a2a_message') {
    return (
      validA2aMessage(obj.message, true, true) &&
      conservativeJsonSizeBudget(obj.message) !== null
    );
  }
  return true;
}

// ── Close codes ────────────────────────────────────────────────────────────

export const AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1000,
  INTERNAL_ERROR: 1011,
  BOOTSTRAP_ERROR: 4400,
  AUTH_FAILED: 4401,
  AGENT_OWNERSHIP: 4403,
  RESUME_WINDOW_EXCEEDED: 4413,
  /**
   * The channel displaced a registered socket that had stopped answering the
   * keepalive, so a newcomer could take the single-socket slot (S2).
   *
   * Distinct from `ALREADY_CONNECTED` because it points the OTHER way: 4429
   * tells a newcomer "someone live is already here", while this tells an
   * incumbent "you look dead and have been replaced". It is deliberately NOT
   * fatal to the client — a socket that receives it either really is a zombie
   * whose process is gone, or is a live daemon that was mis-judged and must
   * reconnect rather than exit.
   */
  STALE_SOCKET: 4410,
  ALREADY_CONNECTED: 4429,
  /**
   * Set ONLY on a deliberate move/re-bootstrap rotation; the sole trigger
   * for the plugin self-wipe. The close reason string is one of
   * `AUTH_SUPERSEDED_CLOSE_REASONS` — use that constant to match on it.
   */
  AUTH_SUPERSEDED: 4409,
  /**
   * The agent is quarantined: its channel is suspended, not revoked (#1348).
   * Sent only to a client that advertised `AGENT_SUSPEND_CAPABILITY`; any
   * other gets AUTH_FAILED (4401). The client drops every credential it
   * placed, keeps its identity, and reconnects with backoff (30 s, doubling to
   * 5 min). A quarantined agent's capable reconnect is answered with this code
   * too, until a release lets the upgrade through and the normal resume
   * re-delivers what is still granted. The reason is
   * `AGENT_SUSPENDED_CLOSE_REASON`.
   */
  AGENT_SUSPENDED: 4423,
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

/** The close reason carried with `AGENT_SUSPENDED` (4423). */
export const AGENT_SUSPENDED_CLOSE_REASON = 'quarantined';

/**
 * The client capability that asks for AGENT_SUSPENDED (#1348). A client
 * advertises it (as `?suspend=1` on the connect URL, which the upgrade answer
 * needs, and in its Resume capabilities) only when it drops every credential
 * it placed on a suspension. A client that doesn't gets 4401 instead, because
 * it would read an unknown 4423 as a transient drop and keep its credentials.
 */
export const AGENT_SUSPEND_CAPABILITY = 'agent_suspend_v1';
