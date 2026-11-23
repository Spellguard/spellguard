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
import { type A2aArtifact, type A2aMessage, type A2aTask, type A2aTaskState } from './a2a';
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
export declare const AGENT_CONTROL_PROTOCOL_VERSION: "5";
export type AgentControlProtocolVersion = typeof AGENT_CONTROL_PROTOCOL_VERSION;
/** Provider-specific GitHub identity payload. */
export interface GithubProviderData {
    github_user_id: number;
    github_login: string;
    github_user_email: string | null;
    git_author_name: string;
    git_author_email: string;
}
export type ProviderId = 'github' | 'slack' | 'discord' | 'teams' | 'openrouter';
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
export type GithubCredentialScope = {
    mode: 'all';
} | {
    mode: 'selected';
    repos: string[];
};
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
export declare function isGithubCredentialScope(value: unknown): value is GithubCredentialScope;
/**
 * Human-readable one-line rendering of a credential scope, for plugin status
 * output. Shared so "all repositories" is worded identically everywhere and no
 * surface re-derives it from a repo list that an org-wide grant does not have.
 */
export declare function describeGithubCredentialScope(scope: GithubCredentialScope | undefined): string;
export type GithubGrantScope = {
    mode: 'all';
} | {
    mode: 'selected';
    repository_names: string[];
};
export interface GithubGrantCredentialDescriptor extends Omit<GithubCredentialDescriptor, 'scope_summary' | 'github_org_login' | 'installation_id' | 'status'> {
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
export interface OpenrouterCredentialDescriptor extends BaseCredentialDescriptor {
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
export type CredentialDescriptor = GithubCredentialDescriptor | SlackCredentialDescriptor | DiscordCredentialDescriptor | TeamsCredentialDescriptor | OpenrouterCredentialDescriptor;
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
export interface AgentConfigDescriptor {
    provider: string;
    [providerSpecificField: string]: unknown;
}
export type CanonicalFramework = 'claude_code' | 'codex' | 'openclaw' | 'hermes';
/** Pinned generalized-task wire limits. String/outer sizes use UTF-8 bytes. */
export declare const A2A_PROTOCOL_LIMITS: {
    readonly ordinaryFrameBytes: 65536;
    readonly taskCreateOuterFrameBytes: 327680;
    readonly taskUpdateOuterFrameBytes: 1572864;
    readonly taskCreateInputBytes: 262144;
    readonly taskCreateEnvelopeBytes: 65536;
    readonly identifierBytes: 256;
    readonly messageTextBytes: 16384;
    readonly messagePartsBytes: 65536;
    readonly artifactsPerUpdate: 50;
    readonly artifactLabelBytes: 256;
    readonly artifactValueBytes: 2048;
    readonly taskUpdateResultBytes: 1048576;
    readonly diagnosticsPerUpdate: 16;
    readonly diagnosticsBytesPerUpdate: 8192;
};
/** Canonical generalized task-type name accepted by the v1 envelope. */
export declare const A2A_TASK_TYPE_PATTERN: RegExp;
/** Exact task-store outcomes returned for box-relayed progress writes. */
export type A2aTaskStoreOutcome = 'persisted' | 'already_terminal' | 'thread_bound_reached';
export interface A2aBlockedTaskType {
    task_type: string;
    cause: string;
}
export type A2aHandlerState = 'current' | 'outdated_unedited' | 'owner_modified' | 'example_scaffold' | 'not_installed_apply_pending' | 'not_installed_custom' | 'missing_deleted' | 'custom_no_reference' | 'not_reported';
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
export interface A2aTaskSummaryResponse extends Omit<A2aPublicTaskResponse, 'originatingAgentId' | 'originatingAgentIdentity' | 'originatingSessionId'> {
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
export type A2aAckResult = {
    kind: 'task_update';
    outcome: A2aTaskStoreOutcome;
    response?: A2aPublicTaskResponse;
} | {
    kind: 'message';
    outcome: 'persisted';
    message_id: string;
    response?: A2aMessageResponse;
} | {
    kind: 'task_create';
    task: A2aTask;
    /**
     * `pending_wake` is an ACCEPTANCE, not a failure: the recipient box was
     * asleep, so the task is durably parked (`metadata.pending_wake`) and a
     * wake was requested. Mirrors the DO's own union.
     */
    outcome?: 'created' | 'duplicate' | 'delivery_failed' | 'pending_wake';
    response?: A2aPublicTaskResponse;
} | {
    kind: 'task_read';
    task: A2aTask;
    response?: A2aTaskDetailResponse;
} | ({
    kind: 'config_applied';
} & A2aConfigApplicationResult) | ({
    kind: 'maintenance';
} & A2aMaintenanceApplicationResult);
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
export interface HelloFrame extends ServerFrameBase {
    type: 'hello';
    channel_id: string;
    current_seq: string;
    resume_window_seconds: number;
    is_fresh_channel: boolean;
}
export interface CredentialDeliveredFrame extends ServerFrameBase {
    type: 'credential_delivered';
    cause: 'bootstrap' | 'refresh_response' | 'rotation_push' | 'admin_reissue' | 're_bootstrap';
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
    reason: 'admin_revoked' | 'github_side_revoked' | 'installation_revoked' | 'refresh_token_expired' | 'org_offboarded' | 'agent_deleted'
    /** The org disconnected the SOURCE this credential was minted from. */
     | 'source_disconnected' | 'unknown';
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
    error_code?: 'refresh_token_expired' | 'installation_revoked' | 'rate_limited' | 'agent_unknown' | 'MEMBER_OFFBOARDING_IN_PROGRESS' | 'validation_error' | 'github_error' | 'kms_error' | 'not_implemented' | string;
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
    from?: {
        id?: string;
        name?: string;
    };
    /** Inbound recipient/the bot (becomes the outbound reply's `from`). */
    recipient?: {
        id?: string;
        name?: string;
    };
    /** Human-readable block reason surfaced to the conversation. */
    reason?: string;
}
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
export type ServerFrame = HelloFrame | CredentialDeliveredFrame | CredentialRotatedFrame | CredentialRevokedFrame | GithubGrantsBundleFrame | GithubGrantsCommitConfirmedFrame | ConfigUpdatedFrame | AckFrame | ErrorFrame | ResumeWindowExceededFrame | LoginCodeFrame | LoginRestartFrame | SlackEventFrame | SlackEventBlockedFrame | TeamsActivityFrame | TeamsActivityBlockedFrame | A2aTaskDispatchFrame | A2aMessageServerFrame | A2aMaintenanceFrame;
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
    known_credentials: Array<{
        provider: string;
        scoped_token_id: string;
    }>;
    /** Phase C: client capability flags. Today: 'github_multi_org' = this
     * plugin can hold one GitHub credential per GitHub org simultaneously.
     * The server persists these on the agent row; absence = legacy. */
    capabilities?: string[];
}
export interface CredentialRequestFrame extends ClientFrameBase {
    type: 'credential_request';
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
export interface A2aConfigAppliedFrame extends ClientFrameBase, A2aConfigApplicationResult {
    type: 'a2a_config_applied';
}
/** Box → server: per-type handler-file inventory for the applied revision. */
export interface A2aHandlerInventoryFrame extends ClientFrameBase {
    type: 'a2a_handler_inventory';
    config_revision: string;
    handlers: A2aHandlerInventoryEntry[];
}
/** Box → server: completion or blocking result for a maintenance operation. */
export interface A2aMaintenanceResultFrame extends ClientFrameBase, A2aMaintenanceApplicationResult {
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
export type ClientFrame = BootstrapRequestFrame | ResumeFrame | CredentialRequestFrame | AckClientFrame | CloudflareCredentialAppliedFrame | GithubGrantsAppliedFrame | PingFrame | ChannelReadyFrame | LoginRelayUpdateFrame | A2aConfigAppliedFrame | A2aHandlerInventoryFrame | A2aMaintenanceResultFrame | A2aSupervisionKeepaliveFrame | A2aSessionRegisterFrame | A2aTaskCreateFrame | A2aTaskReadFrame | A2aDeferredAcceptedFrame | A2aMessageDeliveryFrame | A2aTaskUpdateFrame | A2aMessageClientFrame;
/** The five frame families multiplexed over the single agent-control socket. */
export type FrameFamily = 'lifecycle' | 'credential' | 'login' | 'relay' | 'a2a';
/** Every frame `type` on the wire — server-emitted or client-emitted. */
type AnyFrameType = ServerFrame['type'] | ClientFrame['type'];
/** Total classifier: the family of any server- or client-frame `type`. */
export declare function frameFamily(type: AnyFrameType): FrameFamily;
/**
 * Total classifier: the QoS of any SERVER frame `type`. Reliable frames enter
 * the seq stream and the resume ring buffer; transient frames never do.
 */
export declare function frameQos(type: ServerFrame['type']): 'reliable' | 'transient';
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
export declare function conservativeJsonSizeBudget(value: unknown): number | null;
/** Runtime validator for the optional data carried by a generalized ACK. */
export declare function validateA2aAckResult(value: unknown): value is A2aAckResult;
/**
 * Strict Task 1 contract validator for generalized v4 frames. It deliberately
 * validates only the additive generalized family; legacy parser tolerance is
 * unchanged for byte shapes that were already valid before this extension.
 */
export declare function validateA2aContractFrame(value: unknown, direction: 'server' | 'client'): boolean;
/**
 * The a2a collaboration-plane frame type discriminants (both directions).
 * Exported so consumers can branch the a2a plane off the credential plane
 * without re-listing the strings.
 */
export declare const A2A_FRAME_TYPES: ReadonlySet<string>;
/**
 * Whether a frame (or any `{type}`-shaped value) belongs to the a2a
 * collaboration plane rather than the credential/login plane.
 */
export declare function isA2aFrame(frame: {
    type?: unknown;
} | null | undefined): boolean;
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
export declare function parseServerFrame(text: string): ServerFrame | null;
export declare const AGENT_CONTROL_CLOSE_CODES: {
    readonly NORMAL: 1000;
    readonly INTERNAL_ERROR: 1011;
    readonly BOOTSTRAP_ERROR: 4400;
    readonly AUTH_FAILED: 4401;
    readonly AGENT_OWNERSHIP: 4403;
    readonly RESUME_WINDOW_EXCEEDED: 4413;
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
    readonly STALE_SOCKET: 4410;
    readonly ALREADY_CONNECTED: 4429;
    /**
     * Set ONLY on a deliberate move/re-bootstrap rotation; the sole trigger
     * for the plugin self-wipe. The close reason string is one of
     * `AUTH_SUPERSEDED_CLOSE_REASONS` — use that constant to match on it.
     */
    readonly AUTH_SUPERSEDED: 4409;
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
    readonly AGENT_SUSPENDED: 4423;
};
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
export declare const AUTH_SUPERSEDED_CLOSE_REASONS: {
    readonly ATTACHED_ELSEWHERE: "attached_elsewhere";
    readonly REASSIGNED: "reassigned";
};
export type AuthSupersededCloseReason = (typeof AUTH_SUPERSEDED_CLOSE_REASONS)[keyof typeof AUTH_SUPERSEDED_CLOSE_REASONS];
export type AgentControlCloseCode = (typeof AGENT_CONTROL_CLOSE_CODES)[keyof typeof AGENT_CONTROL_CLOSE_CODES];
/** The close reason carried with `AGENT_SUSPENDED` (4423). */
export declare const AGENT_SUSPENDED_CLOSE_REASON = "quarantined";
/**
 * The client capability that asks for AGENT_SUSPENDED (#1348). A client
 * advertises it (as `?suspend=1` on the connect URL, which the upgrade answer
 * needs, and in its Resume capabilities) only when it drops every credential
 * it placed on a suspension. A client that doesn't gets 4401 instead, because
 * it would read an unknown 4423 as a transient drop and keep its credentials.
 */
export declare const AGENT_SUSPEND_CAPABILITY = "agent_suspend_v1";
export {};
