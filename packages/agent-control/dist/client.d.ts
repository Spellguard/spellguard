import WebSocket from 'ws';
import { type AuthSupersededCloseReason, type ConfigUpdatedFrame, type CredentialDeliveredFrame, type CredentialDescriptor, type CredentialRequestFrame, type CredentialRevokedFrame, type CredentialRotatedFrame, type GithubGrantsBundleFrame, type GithubGrantsCommitConfirmedFrame, type LoginCodeFrame, type LoginRelayUpdateFrame, type LoginRestartFrame, type SlackEventBlockedFrame, type SlackEventFrame, type TeamsActivityBlockedFrame, type TeamsActivityFrame } from './protocol';
/**
 * The transient relay frames (server → client). They ride the SAME
 * agent-control socket as the reliable credential/lifecycle frames but carry NO
 * `seq` (they extend `TransientServerFrameBase`): never sequenced, never
 * ring-buffered, never replayed on resume, never acked. Consolidated agent
 * socket (T7): the OpenClaw plugin routes these into its local Slack/Teams bot
 * via `AgentControlClientOptions.onRelayEvent`.
 */
export type RelayServerFrame = SlackEventFrame | SlackEventBlockedFrame | TeamsActivityFrame | TeamsActivityBlockedFrame;
export type StartCredentials = {
    /**
     * Steady-state mode used by the credential daemon after bootstrap.
     * The URL query carries `?agent_secret=<secret>`; the agent_id is
     * already in the URL path so it is included here for explicitness only.
     */
    mode: 'secret';
    agentId: string;
    agentSecret: string;
    /**
     * R2-10 — the daemon's OWN framework slug ('claude_code' | 'codex' | …),
     * threaded onto the secret-mode connect so the control plane can attribute
     * each `login_relay_update` (sent over this same secret-mode connection) to
     * the matching per-framework `frameworks_installed` row. Additive + optional
     * for back-compat: a legacy daemon that omits it is resolved by the DO's
     * sole-managed-login-row fallback (NEG-3). It rides the URL query (a
     * non-secret discriminator).
     *
     * T4.3 note: for a MULTIPLEXED box daemon that carries BOTH managed-login
     * frameworks over ONE connection, this connection-level slug can no longer
     * disambiguate — the per-frame `LoginRelayUpdateFrame.framework` field is
     * the primary discriminator and this connection value is the back-compat
     * fallback the DO uses only when the frame omits it.
     */
    framework?: string;
} | {
    mode: 'nonce';
    nonce: string;
    channelToken: string;
    orgId: string;
    agentName?: string;
    /** Optional reason text echoed back by the dashboard during setup. */
    statementOfReason?: string;
    /**
     * The plugin's framework slug ('claude_code' | 'codex' | ...), sent on
     * bootstrap_request so the server records agents.framework at creation
     * instead of a hardcoded default. Optional for back-compat.
     */
    framework?: string;
    /**
     * C10: set for a SELECT-EXISTING reattach. The lobby upgrades the channel
     * as `managed-provisioning` + `reBootstrap:true`, so the server
     * auto-delivers `credential_delivered{cause:'re_bootstrap'}` (new secret +
     * re-issued creds) on connect — there is nothing to claim. Sending the
     * nonce-mode `bootstrap_request` here is rejected (`bootstrap_request
     * requires nonce-mode upgrade`) and strands the attach, so suppress it.
     */
    expectReBootstrap?: boolean;
} | {
    /**
     * Managed-provisioning bootstrap mode.
     *
     * Used when the client is started on a managed agent host (Lightsail
     * instance / Railway service) via cloud-init / start-script. The
     * server-side bootstrap nonce was minted at provision time with
     * `kind:'managed-provisioning'` and carries the agent_id + org binding,
     * so the URL query elides `ct` and `orgId` — the server resolves both
     * from the nonce record.
     *
     * After Hello the server auto-emits `credential_delivered{cause:'bootstrap'}`;
     * the client does NOT send `bootstrap_request` in this mode (the agent
     * row already exists from provision time, so there is nothing to claim).
     *
     * The client attaches `X-Spellguard-Instance-Fingerprint` on the upgrade
     * request (see `headers` option below) so the server can record the
     * cloud-side identity that completed bootstrap.
     */
    mode: 'managed-bootstrap';
    nonce: string;
};
export interface AgentControlClientOptions {
    /** Spellguard base URL (e.g. https://console.spellguard.ai). */
    apiBaseUrl: string;
    /** Plugin-stored agent UUID. Used end-to-end from first run onward. */
    agentId: string;
    /** Highest server seq the plugin has durably persisted. Sent as
     *  `last_server_seq` on every reconnect's Resume frame.
     *  Defaults to '0' (first connect). */
    initialLastServerSeq?: string;
    /** Cached credential snapshot for the resume `known_credentials` echo. */
    initialKnownCredentials?: Array<{
        provider: string;
        scoped_token_id: string;
    }>;
    /** Async accessor for the auth shape — called on every reconnect. */
    credentials: () => Promise<StartCredentials> | StartCredentials;
    /** Frame handlers — see types below. */
    onCredentialDelivered: (frame: CredentialDeliveredFrame) => void | Promise<void>;
    onCredentialRotated?: (frame: CredentialRotatedFrame) => void | Promise<void>;
    onGithubGrantsBundle?: (frame: GithubGrantsBundleFrame) => void | Promise<void>;
    onGithubGrantsCommitConfirmed?: (frame: GithubGrantsCommitConfirmedFrame) => void | Promise<void>;
    /**
     * Apply a `credential_revoked` frame to local disk state.
     *
     * **This handler MUST NOT terminate the process** (no `process.exit`, no
     * `shutdown()` that exits). It runs BEFORE the client persists the frame's
     * seq and sends its Ack, so a handler that exits leaves the cursor stuck one
     * frame behind forever: the server replays the identical revoke on every
     * subsequent connect and the consumer kills itself again — a permanent,
     * self-reinforcing brick with no in-product exit (observed on a live agent
     * 2026-08-04; the daemon died in 1.9 s with `lastServerSeq` unchanged).
     *
     * A consumer that genuinely needs to stop after a revoke sets a flag here and
     * exits from {@link AgentControlClientOptions.onCredentialRevokeSettled},
     * which runs only AFTER apply → persist → ack. Never the other way round:
     * acking before applying would trade the brick for a window where a
     * server-revoked token stays live on disk.
     */
    onCredentialRevoked?: (frame: CredentialRevokedFrame) => void | Promise<void>;
    /**
     * Called after a `credential_revoked` frame has been fully SETTLED: the
     * revoke was applied to disk by {@link
     * AgentControlClientOptions.onCredentialRevoked}, the cached
     * `knownCredentials` projection was updated and persisted, the frame's seq
     * was persisted via `onSeqAdvanced`, and the Ack was written to the socket.
     *
     * This is the ONLY sanctioned point at which a consumer may terminate the
     * process in response to a revoke — by the time it runs, the durable cursor
     * has already moved past the frame, so the next connect resumes AFTER the
     * revoke instead of replaying it.
     */
    onCredentialRevokeSettled?: (frame: CredentialRevokedFrame) => void | Promise<void>;
    /** Called after every successfully-applied seq-counted frame. The
     *  caller persists `last_server_seq` to disk in this hook so a crash
     *  mid-handler is replayed on reconnect rather than skipped. */
    onSeqAdvanced: (seq: string) => void | Promise<void>;
    /**
     * Called when the cached `knownCredentials` projection mutates
     * (delivery / rotation adds; revocation removes). The caller persists
     * the list to disk so the next reconnect sends a real
     * `Resume.known_credentials` instead of `[]` — without this, server-side
     * divergence detection silently rotates credentials on every daemon
     * restart. Optional for tests; production code should always wire it.
     */
    onKnownCredentialsChanged?: (known: Array<{
        provider: string;
        scoped_token_id: string;
    }>) => void | Promise<void>;
    /** Called when the server sends a fatal close code (4401, 4403, 4413).
     *  The caller surfaces a re-setup banner to the user. The client does
     *  not auto-reconnect after a fatal close. */
    onFatalClose: (code: number, reason: string) => void;
    /**
     * Called ONLY when the server closes the connection with 4409
     * (`AUTH_SUPERSEDED`). This is the sole, safe trigger for the plugin
     * self-wipe (P2-T6, NR-3, D10). It fires instead of — never in addition
     * to — `onFatalClose`, and it MUST NOT fire on any other close code or
     * transient drop.
     *
     * `cause` is one of `AUTH_SUPERSEDED_CLOSE_REASONS`
     * (`'attached_elsewhere'` | `'reassigned'`) when the server sends a
     * recognized reason string, or `undefined` when the reason is absent or
     * unrecognized (FR-10/FR-15/UT-008 — unknown causes must show the GENERIC
     * message, not the attached_elsewhere copy). Plugins map `undefined` →
     * "credentials cleared — run /spellguard-setup".
     */
    onCredentialSuperseded?: (cause: AuthSupersededCloseReason | undefined) => void;
    /**
     * Called when the server closes with AGENT_SUSPENDED (4423, #1348): the
     * agent is quarantined. The plugin drops every credential it placed and
     * KEEPS its identity. The client keeps reconnecting on its own backoff (30 s,
     * doubling to 5 min, `retryInMs` is the next wait), and the reconnect a
     * release lets through resumes normally, so the server re-delivers what is
     * still granted. Fires on every suspended close, never with `onFatalClose`.
     */
    onSuspended?: (event: {
        reason: string;
        retryInMs: number;
    }) => void | Promise<void>;
    /**
     * Called when the server pushes a `config_updated` frame.
     * The handler should persist the new descriptor to the local config-store.
     * If `frame.triggers_rotation === true`, a follow-up `credential_rotated`
     * is expected within ~10 s; the client handles the timeout automatically.
     */
    onConfigUpdated?: (frame: ConfigUpdatedFrame) => void | Promise<void>;
    /**
     * REQ-003 (Task 17) — Called when the control plane pushes a `login_code`
     * frame down to the box during the headless `claude setup-token` relay flow.
     * The handler should feed the code to the pty driving `claude setup-token`.
     * Optional — only wired by the Claude Code daemon when it is managing
     * a login-relay flow; other plugins leave this undefined.
     */
    onLoginCode?: (frame: LoginCodeFrame) => void | Promise<void>;
    /**
     * REQ-003 (Task 17) — Called when the control plane tells the box to
     * abandon the current `claude setup-token` attempt and re-run it from
     * scratch. The handler should kill the current pty and restart the relay.
     * Optional — only wired by the Claude Code daemon.
     */
    onLoginRestart?: (frame: LoginRestartFrame) => void | Promise<void>;
    /**
     * Consolidated agent socket (T7) — called for each inbound transient relay
     * frame (`slack_event`, `slack_event_blocked`, `teams_activity`,
     * `teams_activity_blocked`) the control plane forwards down the SAME
     * agent-control socket the box already holds for credentials.
     *
     * Invoked FIRE-AND-FORGET: the dispatcher never `await`s it (R5 — a slow
     * local Slack/Teams forward must not head-of-line-block the reliable
     * credential frames sharing this socket) and swallows+logs any throw/rejection
     * so a faulty handler can never disturb the socket or the seq/ack cursor.
     * Relay frames carry no `seq`, so handling one advances NO cursor and sends
     * NO ack. Optional — only the OpenClaw plugin wires it; other plugins leave it
     * undefined and relay frames are silently ignored.
     */
    onRelayEvent?: (frame: RelayServerFrame) => void | Promise<void>;
    /** Called on each non-fatal error. Logging hook. */
    onError?: (err: Error) => void;
    /**
     * FIND-DA28 — called once on EVERY (re)connect, right after the socket opens
     * (and the keepalive heartbeat starts), for ALL auth modes. Fire-and-forget;
     * a throw is swallowed. The Claude Code daemon uses this to RE-ASSERT a
     * terminal `login_relay_update{authorized}` when a token already exists on
     * disk: the relay's one-shot authorized update is fire-and-forget, so if the
     * channel was mid-churn when it fired (e.g. a credential admin_reissue /
     * credential_request_timeout right at login completion) the update is silently
     * dropped and the dashboard sticks on "Authorize Claude" forever — there is no
     * "next" update to recover it (login-relay.ts even notes the recovery relies on
     * a subsequent update, which never comes for the terminal state). Re-asserting
     * on each connect self-heals a dropped update and reflects the authed state
     * after a daemon restart. Idempotent (the DO just re-persists `authorized`).
     */
    onConnect?: () => void | Promise<void>;
    /**
     * Informational logging hook for EXPECTED protocol events (e.g. the
     * redacted-replay notice after hibernation). Falls back to `onError` when
     * absent so existing consumers keep seeing the message — but daemons
     * should wire this to their info-level logger; these events are not
     * errors (plan Task 2.3 Fix 3, I7).
     */
    onInfo?: (message: string) => void;
    /** Override for tests. */
    WebSocketImpl?: typeof WebSocket;
    /**
     * Extra HTTP headers to attach to the upgrade request. Used by the
     * managed-provisioning bootstrap path to send `X-Spellguard-Instance-Fingerprint`
     * so the server can record the cloud-side identity that claimed the agent.
     *
     * Implementation note: partysocket calls `new WS(url, protocols)` with no
     * options argument, so we wrap `WebSocketImpl` in a subclass whose
     * constructor forwards `headers` to the underlying `ws` library's
     * ClientOptions. This works with both real `ws.WebSocket` (which accepts
     * `headers`) and test doubles whose constructor takes any extra args.
     */
    upgradeHeaders?: Record<string, string>;
    /** Cap reconnect backoff (default 30 s). */
    maxReconnectionDelayMs?: number;
    /** The suspended (4423) backoff. Default 30 s, doubling to 5 min. */
    suspendedBackoffMs?: {
        initial: number;
        max: number;
    };
    /**
     * FIND-DA24 — how long PartySocket waits for a connection to OPEN before it
     * aborts the attempt and retries. partysocket's default is 4000ms, which is
     * too tight for the agent-control WS upgrade: that handshake does a (cold)
     * Supabase agent-row lookup + bcrypt secret verify + Durable Object
     * cold-start, so it legitimately takes ~2–4s (measured median ~2–2.5s, cold
     * spikes ~3.7s+). When the handshake crosses 4s partysocket aborts the
     * connecting socket and reconnects — and the retry hits the same slow path,
     * producing the ~18s reconnect churn that broke login-relay frame delivery.
     * Default 20s gives generous headroom over the observed worst case while
     * staying well under any "give up" expectation. Injectable for tuning/tests.
     */
    connectionTimeoutMs?: number;
    /**
     * How long to wait for a `credential_rotated` after a `config_updated`
     * frame with `triggers_rotation:true` before firing a manual requestRefresh
     * fallback. Defaults to 10 s. Exposed for testing.
     */
    rotationFallbackTimeoutMs?: number;
    /**
     * Phase C: client capability flags echoed in every Resume frame so the
     * server can persist them on the agent row. Today: `'github_multi_org'` =
     * this plugin can hold one GitHub credential per GitHub org simultaneously.
     * Absent = legacy single-org behavior. Plugins pass `['github_multi_org']`
     * only once their multi-credential handlers land (Phase C Tasks 5-8).
     */
    capabilities?: string[];
    /**
     * FIND-DA22 — application-level WebSocket keepalive heartbeat.
     *
     * `partysocket` handles RECONNECTION but not LIVENESS: a silently-dead
     * ("zombie") TCP — dropped by an idle intermediary with no TCP keepalive —
     * still looks "open" to partysocket's reconnect logic, so it never
     * reconnects and pushed frames vanish. This surfaces during the Claude Code
     * login relay's long, frame-less idle wait (credential delivery flows within
     * seconds of connect, before the idle window, so it never hit this).
     *
     * The client sends a bare `'ping'` every `heartbeatIntervalMs` and tracks the
     * last `'pong'`. If no pong arrives within `heartbeatIntervalMs +
     * heartbeatTimeoutMs`, the socket is a zombie and the client forces
     * `partysocket.reconnect()`. The DO answers bare pings via
     * `setWebSocketAutoResponse` so the keepalive does NOT wake it from
     * hibernation.
     *
     * Interval/timeout/clock are injectable so the unit test can drive them with
     * `vi.useFakeTimers()`.
     */
    heartbeatIntervalMs?: number;
    /** Grace period for a `'pong'` after a `'ping'`. Default 10 s. */
    heartbeatTimeoutMs?: number;
    /** Injectable clock — defaults to `() => Date.now()`. Tests override it. */
    now?: () => number;
}
export declare class AgentControlClient {
    #private;
    private readonly opts;
    constructor(opts: AgentControlClientOptions);
    /** Open the socket. Subsequent reconnects are automatic. */
    start(): void;
    /** Send a CredentialRequest and resolve after the durable response apply.
     *  V4 returns delivered descriptors; V5 resolves `[]` after its bundle hook
     *  commits. Times out if no matching response arrives within `timeoutMs`. */
    requestRefresh(args: Pick<CredentialRequestFrame, 'reason' | 'provider' | 'superseded_scoped_token_id'>, opts?: {
        timeoutMs?: number;
    }): Promise<CredentialDescriptor[]>;
    /**
     * Fire-and-forget signal that the bot's inbound platform socket
     * (Slack/Teams/Discord) is up and it can actually reply. Sends a
     * `channel_ready` ClientFrame — the server persists `agents.channel_ready_at`
     * on first receipt and Acks via the existing `AckFrame`.
     *
     * This mirrors the inline `bootstrap_request`/`resume` send shape: it is
     * NOT routed through `#refreshChain` or the `#pendingRequests` map (there
     * is nothing to correlate — the server's Ack is observed by the existing
     * `case 'ack'` dispatcher and harmlessly ignored when no pending entry
     * matches). Guarded on `#ps` existing and `!#closed` so a call while the
     * agent-control socket is mid-reconnect/closed is a silent no-op (the
     * caller re-triggers on the next readiness event).
     */
    sendChannelReady(args: {
        reason?: string;
        platform?: string;
        metadata?: Record<string, unknown>;
    }): void;
    /**
     * REQ-003 (Task 17) — Fire-and-forget notification that the box's
     * headless login-relay state has changed. Sends a `login_relay_update`
     * ClientFrame up the control channel so the dashboard/broker can surface
     * the URL to the operator or record the outcome.
     *
     * NEG-001: this method accepts ONLY state/url/message — it carries NO
     * token, no code, and no secret material. The token stays on-box.
     *
     * Mirrors `sendChannelReady`: fire-and-forget, not routed through
     * `#refreshChain`, guarded on `#ps` + `!#closed` (silent no-op when the
     * socket is mid-reconnect).
     */
    sendLoginRelayUpdate(update: Pick<LoginRelayUpdateFrame, 'state' | 'login_url' | 'message' | 'framework'>): void;
    /** Close the socket and stop reconnecting. */
    close(): void;
}
/**
 * Does this transport error represent an HTTP 401 on the WebSocket UPGRADE?
 *
 * Three consecutive of these are treated as a terminal identity revocation, so a
 * false positive costs the agent its identity until an operator re-issues one —
 * fail-closed, but a real availability event. Hence:
 *
 *  1. A STRUCTURED status wins outright, in both directions. A transport that
 *     reports `500` is NOT unauthorized even if the body it quotes happens to
 *     contain "401", and there is no fall-through to the text for it.
 *  2. Only when no status is exposed do we read the message, and then the digits
 *     must sit in an HTTP-STATUS POSITION. A plain substring matched `…:8401`
 *     (a port) and any byte count ending in 401; a word boundary alone still
 *     matched `req-401-2f9c` (a request id). Three of those in a row — exactly
 *     what a box that simply cannot reach its server produces — would have wiped
 *     a healthy agent's identity.
 *
 * Kept in lockstep with `is_upgrade_unauthorized` in
 * the Hermes plugin's Python client.
 *
 * Exported for the unit test; not part of the public client API.
 */
export declare function isUpgradeUnauthorized(err: unknown): boolean;
/**
 * Wrap a WebSocket implementation so its constructor forwards
 * `headers` (and any future ClientOptions) as the third argument expected
 * by the `ws` library.
 *
 * partysocket invokes `new WS(url, protocols)` with no options argument, so
 * the underlying `ws.WebSocket` never receives our `headers` option directly.
 * The subclass below intercepts the constructor and forwards
 * `{ headers, ...rest }` as ClientOptions. The same shape works for the test
 * doubles (their constructors accept and ignore extra args) and for the real
 * `ws` library at runtime (its constructor signature is
 * `new WebSocket(address, protocols?, options?)`).
 *
 * The wrapper is intentionally a plain `function (url, protocols)` subclass
 * rather than `extends WS` so we don't need to know `WS`'s constructor shape
 * at TypeScript level — partysocket only calls `new WS(url, protocols)`,
 * which `wrapped(url, protocols)` satisfies.
 */
export declare function makeErrorSafeWebSocket(Base: typeof WebSocket, headers?: Record<string, string>, onUpgradeError?: (err: Error) => void): typeof WebSocket;
