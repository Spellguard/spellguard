import WebSocket from 'ws';
import { type AuthSupersededCloseReason, type ConfigUpdatedFrame, type CredentialDeliveredFrame, type CredentialDescriptor, type CredentialRequestFrame, type CredentialRevokedFrame, type CredentialRotatedFrame, type LoginCodeFrame, type LoginRelayUpdateFrame, type LoginRestartFrame } from './protocol';
export type StartCredentials = {
    /**
     * Steady-state mode used by the credential daemon after bootstrap.
     * The URL query carries `?agent_secret=<secret>`; the agent_id is
     * already in the URL path so it is included here for explicitness only.
     */
    mode: 'secret';
    agentId: string;
    agentSecret: string;
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
    onCredentialRevoked?: (frame: CredentialRevokedFrame) => void | Promise<void>;
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
    /** Send a CredentialRequest and resolve to the delivered descriptors.
     *  Times out if no `credential_delivered` arrives within `timeoutMs`. */
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
    sendLoginRelayUpdate(update: Pick<LoginRelayUpdateFrame, 'state' | 'login_url' | 'message'>): void;
    /** Close the socket and stop reconnecting. */
    close(): void;
}
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
export declare function makeErrorSafeWebSocket(Base: typeof WebSocket, headers?: Record<string, string>): typeof WebSocket;
