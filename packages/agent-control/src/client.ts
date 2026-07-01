// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-control-channel persistent client.
 *
 * Wraps `partysocket` with a thin Spellguard protocol layer:
 *   - Async URL provider regenerates the URL on every reconnect (so
 *     the agent_secret is always fresh on the wire for secret mode).
 *   - On every `open` event after the first connect, sends a `Resume`
 *     frame so the server replays missed frames from its 64-frame ring
 *     buffer, or signals `resume_window_exceeded`.
 *   - Persists `last_server_seq` to disk only after the dispatch
 *     handler succeeds, so a crash mid-handler is recovered on reconnect.
 *   - Translates fatal close codes (4401/4403/4413) into a terminal
 *     state for the caller; the wrapper does not silently loop on
 *     auth errors.
 *
 * Two start modes: the setup flow uses `start({nonce, ...})` and the
 * daemon steady-state uses `start({secret, agentId, agentSecret})`.
 *
 * Auth shape:
 *   - Secret mode: the plaintext `agent_secret` is passed via the
 *     `Sec-WebSocket-Protocol` subprotocol header. The URL query is left
 *     empty for secret-mode connections. Subprotocol values are not
 *     surfaced in Cloudflare's request-log / Workers tail / Logpush
 *     output the way URL query params are, so the plaintext secret no
 *     longer leaks to anyone with tail access.
 *   - Nonce mode: setup-time auth (nonce + channel-token + orgId) remains
 *     in the URL query — the nonce is single-use, channel-token is HMAC-
 *     bound to (nonce, userId) and short-lived, and orgId is not a secret.
 *
 * partysocket supports `Sec-WebSocket-Protocol` via the async `protocols`
 * option (see ws-Cg2f-sDL.d.ts: ProtocolsProvider). The server reads the
 * header in `handleSecretUpgrade` and does not echo a subprotocol in the
 * 101 response — the `ws` library accepts the connection without
 * subprotocol negotiation when no `Sec-WebSocket-Protocol` is present in
 * the response.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PartySocket } from 'partysocket';
import WebSocket from 'ws';
import {
  AGENT_CONTROL_CLOSE_CODES,
  AUTH_SUPERSEDED_CLOSE_REASONS,
  type AuthSupersededCloseReason,
  type ConfigUpdatedFrame,
  type CredentialDeliveredFrame,
  type CredentialDescriptor,
  type CredentialKind,
  type CredentialRequestFrame,
  type CredentialRevokedFrame,
  type CredentialRotatedFrame,
  type LoginCodeFrame,
  type LoginRelayUpdateFrame,
  type LoginRestartFrame,
  type ServerFrame,
  parseServerFrame,
} from './protocol';

// Subprotocol values used for secret-mode auth on the WebSocket upgrade.
// The server reads `agent-secret.<plaintext>` from the
// Sec-WebSocket-Protocol header and validates it against the stored
// hashed agent secret. See the file header comment for the full rationale.
const SUBPROTOCOL_VERSION = 'spellguard.agent-control.v1';
const SUBPROTOCOL_SECRET_PREFIX = 'agent-secret.';

export type StartCredentials =
  | {
      /**
       * Steady-state mode used by the credential daemon after bootstrap.
       * The URL query carries `?agent_secret=<secret>`; the agent_id is
       * already in the URL path so it is included here for explicitness only.
       */
      mode: 'secret';
      agentId: string;
      agentSecret: string;
    }
  | {
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
    }
  | {
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
  onCredentialDelivered: (
    frame: CredentialDeliveredFrame,
  ) => void | Promise<void>;
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
  onKnownCredentialsChanged?: (
    known: Array<{ provider: string; scoped_token_id: string }>,
  ) => void | Promise<void>;

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
  onCredentialSuperseded?: (
    cause: AuthSupersededCloseReason | undefined,
  ) => void;

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

const FATAL_CLOSE_CODES = new Set<number>([
  // 4400 BOOTSTRAP_ERROR is wired up server-side. Without listing it here,
  // partysocket would auto-reconnect after a bootstrap-terminal failure and
  // the client would never surface the real error to the setup flow.
  AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR,
  AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED,
  AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP,
  // RESUME_WINDOW_EXCEEDED is intentionally NOT fatal — the protocol
  // contract says the client falls through to a fresh-bootstrap-style
  // recovery (reset cursor + projection, reconnect). The frame handler
  // (`case 'resume_window_exceeded'`) fast-forwards local state to the
  // server's `current_seq` and clears the projection; partysocket then
  // auto-reconnects, the next Resume passes the window check, and the
  // server's divergence detection emits admin_reissue for any live
  // credentials. Treating this as fatal here would kill the daemon and
  // force the user to re-run `/spellguard-setup` for a recoverable
  // condition.
]);

export class AgentControlClient {
  #ps: PartySocket | null = null;
  #closed = false;
  #lastServerSeq: string;
  #knownCredentials: Array<{ provider: string; scoped_token_id: string }>;
  #firstConnect = true;
  #pendingRequests = new Map<
    string,
    {
      resolve: (descriptor: CredentialDescriptor[]) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      // Track the superseded id so the credential_delivered
      // {cause:'refresh_response'} resolution path can drop it from
      // knownCredentials. Without this, a client-initiated refresh leaks one
      // stale id into the projection on every refresh — divergence detection
      // on the next reconnect then triggers another rotation.
      supersededProvider?: string;
      supersededScopedTokenId?: string;
    }
  >();
  // Serializes refresh requests because `credential_delivered` carries no
  // `client_msg_id` correlation: with two requests in flight, the dispatcher
  // would resolve them out-of-order. This serialization can be dropped if the
  // protocol later grows an `in_response_to` correlation field.
  #refreshChain: Promise<unknown> = Promise.resolve();
  // Rotation-fallback timers. Key = seq of the config_updated frame.
  // Cleared when a credential_rotated arrives before the 10s window expires.
  #rotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // FIND-DA22 — keepalive heartbeat state. The timer fires every
  // heartbeatIntervalMs; #lastPongAt tracks the last observed 'pong' (clock
  // value, via the injectable #now()) so the timer can detect a zombie socket.
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #lastPongAt = 0;

  constructor(private readonly opts: AgentControlClientOptions) {
    this.#lastServerSeq = opts.initialLastServerSeq ?? '0';
    this.#knownCredentials = opts.initialKnownCredentials ?? [];
  }

  /** Open the socket. Subsequent reconnects are automatic. */
  start(): void {
    if (this.#closed || this.#ps) return;
    const BaseImpl = this.opts.WebSocketImpl ?? WebSocket;
    // Always route through the error-safe wrapper (with or without upgrade
    // headers). Beyond forwarding headers, the wrapper attaches a permanent
    // `'error'` listener to every constructed socket — load-bearing on Node,
    // where an unhandled `'error'` event crashes the process and would kill a
    // managed-bootstrap claim before PartySocket can reconnect. See
    // `makeErrorSafeWebSocket`.
    const Impl = makeErrorSafeWebSocket(BaseImpl, this.opts.upgradeHeaders);
    const apiBaseUrl = this.opts.apiBaseUrl.replace(/^https?:\/\//, '');
    const tls = this.opts.apiBaseUrl.startsWith('https://');

    const ps = new PartySocket({
      host: apiBaseUrl,
      protocol: tls ? 'wss' : 'ws',
      // basePath overrides partysocket's default `${prefix}/${party}/${room}`
      // path so the URL exactly matches our route mount
      // `/v1/agent-control/channel/:agent_id`. Must not start with a slash —
      // partysocket inserts the leading `/` between host and basePath.
      basePath: `v1/agent-control/channel/${this.opts.agentId}`,
      // Async URL provider — partysocket calls this on every reconnect
      // attempt, so freshly-rotated nonce-mode params reach the wire.
      // agent_secret is carried in the subprotocol header, not the URL
      // query, so secret-mode connections leave this empty.
      query: async () => this.#buildQuery(),
      // Secret-mode auth flows through Sec-WebSocket-Protocol. partysocket
      // calls this on every reconnect, so a rotated secret (after admin
      // rotation) reaches the wire on the next attempt.
      protocols: async () => this.#buildProtocols(),
      maxRetries: Number.POSITIVE_INFINITY,
      // Cap the backoff to keep reconnects responsive after long
      // hibernation windows.
      maxReconnectionDelay: this.opts.maxReconnectionDelayMs ?? 30_000,
      // FIND-DA24 — override partysocket's 4s default connectionTimeout. The
      // agent-control WS upgrade (cold DB lookup + bcrypt verify + DO
      // cold-start) routinely takes ~2–4s; a 4s abort-and-retry loop on a
      // slow-but-succeeding handshake is the root cause of the login-relay
      // connection flap. 20s default headroom; injectable via opts.
      connectionTimeout: this.opts.connectionTimeoutMs ?? 20_000,
      // Use the `ws` library on Node — partysocket's default targets
      // browsers.
      WebSocket: Impl,
    });
    this.#ps = ps;

    ps.addEventListener('open', () => {
      void this.#onOpen();
    });

    ps.addEventListener('message', (e) => {
      void this.#handleMessage(e as MessageEvent);
    });

    ps.addEventListener('close', (event) => {
      // FIND-DA22 — stop the heartbeat on EVERY disconnect (fatal, superseded,
      // and transient). On a non-fatal close partysocket auto-reconnects and
      // the next `open` restarts it via #onOpen.
      this.#stopHeartbeat();
      const closeEvent = event as { code?: number; reason?: string };
      const code = closeEvent.code ?? 0;
      const reason = closeEvent.reason ?? '';
      if (code === AGENT_CONTROL_CLOSE_CODES.AUTH_SUPERSEDED) {
        // Guardrail (NR-3): 4409 fires onCredentialSuperseded ONLY — never
        // also onFatalClose. The self-wipe path (P2-T6) keys exclusively on
        // this callback; routing through onFatalClose as well would let a
        // generic fatal-close handler fire a wipe on ordinary auth errors.
        //
        // FR-10/FR-15/UT-008: pass `undefined` for absent or unrecognized
        // reason strings so plugins display the GENERIC message
        // ("credentials cleared — run /spellguard-setup") rather than the
        // attached_elsewhere copy. Only recognized values are forwarded as-is.
        const validReasons = new Set<string>(
          Object.values(AUTH_SUPERSEDED_CLOSE_REASONS),
        );
        const cause: AuthSupersededCloseReason | undefined = validReasons.has(
          reason,
        )
          ? (reason as AuthSupersededCloseReason)
          : undefined;
        this.opts.onCredentialSuperseded?.(cause);
        this.close();
        return;
      }
      if (FATAL_CLOSE_CODES.has(code)) {
        this.opts.onFatalClose(code, reason);
        this.close();
      }
      // Non-fatal closes: partysocket auto-reconnects. The next `open`
      // sends Resume.
    });

    ps.addEventListener('error', (event) => {
      // partysocket emits its own ErrorEvent wrapper with `.message`
      // (from `error.message`) and `.error` (the underlying Error). The
      // previous `String(event)` rendered the EventTarget as the useless
      // `[object Event]`. Read the wrapped fields so consumers (and
      // operators tailing logs) see the real failure (ECONNREFUSED,
      // close 4401, etc.).
      const wrapped = event as {
        message?: unknown;
        error?: unknown;
      };
      const err =
        event instanceof Error
          ? event
          : wrapped.error instanceof Error
            ? wrapped.error
            : new Error(
                `socket error: ${
                  typeof wrapped.message === 'string' && wrapped.message
                    ? wrapped.message
                    : String(event)
                }`,
              );
      this.opts.onError?.(err);
    });
  }

  /** Send a CredentialRequest and resolve to the delivered descriptors.
   *  Times out if no `credential_delivered` arrives within `timeoutMs`. */
  async requestRefresh(
    args: Pick<
      CredentialRequestFrame,
      'reason' | 'provider' | 'superseded_scoped_token_id'
    >,
    opts: { timeoutMs?: number } = {},
  ): Promise<CredentialDescriptor[]> {
    if (!this.#ps) throw new Error('client not started');
    const next = this.#refreshChain
      .catch(() => undefined)
      .then(() => this.#sendRefresh(args, opts));
    this.#refreshChain = next;
    return next;
  }

  async #sendRefresh(
    args: Pick<
      CredentialRequestFrame,
      'reason' | 'provider' | 'superseded_scoped_token_id'
    >,
    opts: { timeoutMs?: number },
  ): Promise<CredentialDescriptor[]> {
    if (this.#closed) throw new Error('client_closed');
    if (!this.#ps) throw new Error('client not started');
    const clientMsgId = crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;

    return await new Promise<CredentialDescriptor[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error('credential_request_timeout'));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve,
        reject,
        timer,
        // Carry the superseded id so the resolution path can prune it from
        // knownCredentials when the new credential is delivered.
        supersededProvider: args.provider,
        supersededScopedTokenId: args.superseded_scoped_token_id,
      });
      this.#ps?.send(
        JSON.stringify({
          type: 'credential_request',
          client_msg_id: clientMsgId,
          reason: args.reason,
          provider: args.provider,
          ...(args.superseded_scoped_token_id
            ? {
                superseded_scoped_token_id: args.superseded_scoped_token_id,
              }
            : {}),
        }),
      );
    });
  }

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
  }): void {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: 'channel_ready',
          client_msg_id: crypto.randomUUID(),
          ...(args.reason ? { reason: args.reason } : {}),
          ...(args.platform ? { platform: args.platform } : {}),
          ...(args.metadata ? { metadata: args.metadata } : {}),
        }),
      );
    } catch {
      // socket closing — non-fatal; the next readiness event re-triggers.
    }
  }

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
  sendLoginRelayUpdate(
    update: Pick<LoginRelayUpdateFrame, 'state' | 'login_url' | 'message'>,
  ): void {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: 'login_relay_update',
          client_msg_id: crypto.randomUUID(),
          state: update.state,
          ...(update.login_url ? { login_url: update.login_url } : {}),
          ...(update.message ? { message: update.message } : {}),
        }),
      );
    } catch {
      // socket closing — non-fatal; relay state will re-sync on next connect
    }
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.#closed = true;
    // FIND-DA22 — stop the keepalive heartbeat on terminal close so no further
    // pings are sent after the client is shut down.
    this.#stopHeartbeat();
    for (const [, p] of this.#pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error('client_closed'));
    }
    this.#pendingRequests.clear();
    // Cancel any pending rotation-fallback timers.
    for (const [, t] of this.#rotationTimers) clearTimeout(t);
    this.#rotationTimers.clear();
    try {
      this.#ps?.close();
    } catch {
      // ignore
    }
    this.#ps = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Injectable monotonic-enough clock. Defaults to wall time. */
  #now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * FIND-DA22 — start the application-level keepalive heartbeat.
   *
   * Called from `#onOpen` (a fresh socket starts the heartbeat). Sends a bare
   * `'ping'` every `heartbeatIntervalMs` and watches for the matching `'pong'`
   * (tracked in `#lastPongAt`). If a full interval+grace passes with no pong,
   * the socket is a zombie (the reconnect logic can't see it) and we force
   * `partysocket.reconnect()` ourselves. Stopped on every disconnect via
   * `#stopHeartbeat` and restarted by the next `#onOpen`.
   */
  #startHeartbeat(): void {
    // Clear any prior timer first so repeated opens never stack intervals.
    this.#stopHeartbeat();
    this.#lastPongAt = this.#now();
    const intervalMs = this.opts.heartbeatIntervalMs ?? 25_000;
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? 10_000;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed || !this.#ps) return;
      // Liveness check FIRST: if the peer missed a full ping/pong cycle the
      // socket is dead even though partysocket still thinks it's open — force a
      // reconnect and do NOT also send a ping on the corpse.
      if (this.#now() - this.#lastPongAt > intervalMs + timeoutMs) {
        this.#ps.reconnect();
        return;
      }
      // Bare 'ping' probe — NOT a JSON frame; the DO's setWebSocketAutoResponse
      // (and its onMessage fallback) replies a bare 'pong' without waking from
      // hibernation, and the receive path short-circuits on `text === 'pong'`.
      try {
        this.#ps.send('ping');
      } catch {
        // socket closing — the close listener will stop the heartbeat and the
        // next #onOpen restarts it on reconnect.
      }
    }, intervalMs);
  }

  /** Stop the heartbeat timer (idempotent). */
  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /**
   * REQ-010 — write the local "channel-ready" coordination marker once the
   * agent-control channel is established, but ONLY on a managed box: gated on
   * the `SPELLGUARD_CHANNEL_READY_MARKER` env var, which the Go managed-bootstrap
   * authors into the daemon's systemd unit (`internal/boxinstall/systemd.go`).
   * The Go orchestrator's no-false-online gate (`WaitForDaemonChannelReady`)
   * polls that exact path before running the authenticated git self-check; if
   * nothing writes it the gate times out (`daemon_channel_timeout`) on a real
   * box. Reading the path from the env (rather than re-deriving it in TS)
   * eliminates any TS-vs-Go path-derivation drift.
   *
   * This is a pure coordination signal — NOT a credential and NOT crypto. The
   * payload is a throwaway ISO timestamp. Best-effort by contract: when the env
   * var is unset (every non-managed/local consumer) it touches no filesystem,
   * and any fs error is routed to the logging hook and swallowed so a failed
   * marker write can never crash the daemon.
   */
  async #writeChannelReadyMarker(): Promise<void> {
    const markerPath = process.env.SPELLGUARD_CHANNEL_READY_MARKER;
    if (!markerPath) return;
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async #buildQuery(): Promise<Record<string, string>> {
    const creds = await this.opts.credentials();
    if (creds.mode === 'secret') {
      // The canonical auth path is Sec-WebSocket-Protocol (set by
      // `#buildProtocols`). We ALSO send agent_secret in the URL query as a
      // transitional fallback for two reasons:
      //   1. Local-dev: the local Workers runtime + partysocket combination
      //      occasionally drops the subprotocol negotiation mid-handshake,
      //      causing the `[object Event]` error loop with the WS upgrade
      //      stuck at "101 Switching Protocols" but no data frames. URL
      //      query is dispatched at the HTTP-upgrade layer and is reliable.
      //   2. Older client builds that predate the subprotocol path still use
      //      this, so keeping the URL alive avoids forcing a coordinated
      //      upgrade.
      // The server prefers the subprotocol entry when both are present (so
      // the URL-redaction guarantee still holds), and `redactQuery` strips
      // `agent_secret` from every log site that prints a URL — so this is
      // not a regression to the leak risk the subprotocol path addresses.
      return { agent_secret: creds.agentSecret };
    }
    if (creds.mode === 'managed-bootstrap') {
      // Managed-provisioning bootstrap carries the nonce only. The server
      // resolves the agent_id, org_id, and credential bindings from the
      // bootstrap-channel nonce record (kind='managed-provisioning').
      // No `ct` (no browser session) and no `orgId` (server-bound).
      return { nonce: creds.nonce };
    }
    return {
      nonce: creds.nonce,
      ct: creds.channelToken,
      orgId: creds.orgId,
      ...(creds.agentName ? { agent_name: creds.agentName } : {}),
    };
  }

  /**
   * Build the Sec-WebSocket-Protocol header value for secret-mode auth.
   * Format: `[<version>, agent-secret.<plaintext>]`. The server reads the
   * agent-secret protocol entry, validates it against the stored hashed
   * agent secret (with grace-window fallback), and does NOT echo a
   * subprotocol in the 101 response — the `ws` library accepts the connection
   * without subprotocol negotiation when the response omits the header.
   *
   * Returns `null` for nonce mode so partysocket sends no Sec-WebSocket-Protocol
   * header at all on first-run bootstrap.
   */
  async #buildProtocols(): Promise<string[] | null> {
    // The intent was to move `agent_secret` from the URL into
    // Sec-WebSocket-Protocol to keep it out of Cloudflare's request log.
    // In practice the `ws` library (used on Node by partysocket) closes
    // the connection with "Server sent no subprotocol" whenever the
    // client offers a subprotocol and the server doesn't echo one of
    // them in the 101 response — and the server's response does not echo
    // (it cannot easily, because the server-side `stub.fetch()` upgrade
    // surface doesn't expose the Sec-WebSocket-Protocol response slot).
    // We therefore offer NO subprotocols. `agent_secret` is carried in
    // the URL query (see `#buildQuery`) and the route's redactQuery
    // strips it from every log site, preserving the no-leak goal.
    const creds = await this.opts.credentials();
    if (creds.mode !== 'secret') return null;
    return null;
  }

  async #onOpen(): Promise<void> {
    if (!this.#ps) return;

    // FIND-DA22 — a fresh socket starts the keepalive heartbeat. Done before
    // any mode-specific early-return below so every connect is monitored.
    this.#lastPongAt = this.#now();
    this.#startHeartbeat();

    // FIND-DA28 — fire the connect hook on EVERY open (before the mode-specific
    // early-returns below), so a consumer can re-assert terminal state (e.g. the
    // Claude Code daemon re-sends login_relay_update{authorized} when a token
    // exists). Fire-and-forget; never let a hook throw break the open path.
    try {
      const r = this.opts.onConnect?.();
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => {
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        });
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }

    // REQ-010 — the channel is now established; signal the managed-bootstrap
    // self-check gate by writing the local channel-ready marker. No-op off a
    // managed box (env-gated); fire-and-forget so a slow/failed fs write never
    // delays or breaks the open path.
    void this.#writeChannelReadyMarker();

    let creds: StartCredentials;
    try {
      creds = await this.opts.credentials();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Managed-provisioning bootstrap. The server auto-emits
    // `credential_delivered{cause:'bootstrap'}` after Hello when the nonce
    // record has `kind='managed-provisioning'` — the agent row already
    // exists from provision time, so there is nothing to claim and no
    // `bootstrap_request` is sent. The Hello dispatcher's
    // `#sendResumeIfApplicable` short-circuits because state is fresh
    // (`lastServerSeq='0' && knownCredentials=[]`).
    if (creds.mode === 'managed-bootstrap') {
      this.#firstConnect = false;
      return;
    }

    // Nonce-mode bootstrap path. We re-send `bootstrap_request` on EVERY
    // nonce-mode open where no frame has been durably applied yet, not just
    // the first connect. If the very first socket dropped before
    // bootstrap_request was sent or before its Ack/credential_delivered was
    // persisted, the reconnect would otherwise send neither bootstrap_request
    // (gated by #firstConnect) nor Resume (gated by lastServerSeq !== '0' ||
    // known.length > 0), and the setup flow would hang to its outer 10-min
    // timeout. Re-sending is safe: the server's claimNonce call returns
    // `nonce_already_used` if the nonce was previously consumed and the server
    // surfaces a typed Ack rather than crashing.
    const noStateYet =
      this.#lastServerSeq === '0' && this.#knownCredentials.length === 0;

    // C10: a select-existing reattach (`expectReBootstrap`) must NOT send the
    // nonce-mode bootstrap_request — the lobby upgraded the channel as
    // managed-provisioning, so the server auto-delivers re_bootstrap and rejects
    // a bootstrap_request. Just connect and await the auto-delivery.
    if (creds.mode === 'nonce' && noStateYet && !creds.expectReBootstrap) {
      this.#firstConnect = false;
      // agent_name is required on bootstrap_request. The agent-metadata flow
      // guarantees it is present by the time the client has polled the
      // channel token. If it is somehow missing here, throw a descriptive
      // error rather than sending an invalid frame that the server will
      // reject with validation_error.
      if (!creds.agentName) {
        this.opts.onError?.(
          new Error(
            'agent-control: agent_name is required for bootstrap_request but was not provided by the credentials accessor. ' +
              'Ensure the caller passes agentName when starting in nonce mode.',
          ),
        );
        return;
      }
      this.#ps.send(
        JSON.stringify({
          type: 'bootstrap_request',
          client_msg_id: crypto.randomUUID(),
          nonce: creds.nonce,
          agent_name: creds.agentName,
          ...(creds.statementOfReason
            ? { statement_of_reason: creds.statementOfReason }
            : {}),
          ...(creds.framework ? { framework: creds.framework } : {}),
        }),
      );
      return;
    }

    // Resume sending is deferred to the Hello dispatcher (case 'hello').
    // The fresh-channel cursor reset must run before Resume is sent: if
    // #onOpen sent Resume(stale_seq, stale_known) on the `open` event, the
    // server would process the stale Resume against its fresh state, declare
    // divergence, and emit admin_reissue → the client's redacted-replay
    // handler would fire requestRefresh → spurious GitHub installation-token
    // rotation on every fresh-channel reconnect. Sending Resume from the
    // Hello dispatcher guarantees the cursor reset takes effect first.
    this.#firstConnect = false;
  }

  /**
   * Send the Resume frame after Hello has been received and any
   * fresh-channel reset has been applied. Returns void; called from
   * `case 'hello'`.
   */
  #sendResumeIfApplicable(): void {
    if (!this.#ps) return;
    const noStateYet =
      this.#lastServerSeq === '0' && this.#knownCredentials.length === 0;
    // First secret-mode connect with no state: server's Hello carries
    // current_seq and the bootstrap delivery is seq=1; nothing for us to
    // resume from.
    if (noStateYet) return;
    this.#ps.send(
      JSON.stringify({
        type: 'resume',
        client_msg_id: crypto.randomUUID(),
        last_server_seq: this.#lastServerSeq,
        known_credentials: this.#knownCredentials,
        capabilities: this.opts.capabilities,
      }),
    );
  }

  async #handleMessage(e: MessageEvent): Promise<void> {
    const text =
      typeof e.data === 'string'
        ? e.data
        : (e.data as Buffer).toString('utf-8');

    // 'pong' replies to ping probes are bare strings, not JSON. FIND-DA22:
    // record the pong so the heartbeat's liveness check sees the socket is
    // alive. NOT seq-counted, never ring-buffered, never parsed as a frame.
    if (text === 'pong') {
      this.#lastPongAt = this.#now();
      return;
    }

    // Route through the shared validator so its field-level checks actually
    // run on the receive path. `parseServerFrame` JSON-parses, rejects
    // unknown frame types, and (for `login_code`) requires a non-empty `code`
    // string — returning null on any structural problem. Previously the client
    // JSON.parsed inline and dispatched directly, so `parseServerFrame`'s
    // login_code validation was dead code. A null result is handled
    // non-fatally (onError + return), matching the old JSON-parse-failure path.
    const frame = parseServerFrame(text);
    if (frame === null) {
      this.opts.onError?.(
        new Error('agent-control: rejected malformed or unknown frame'),
      );
      return;
    }

    try {
      await this.#dispatch(frame);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pure protocol-frame dispatcher; each case is a leaf delegating to a typed handler. Splitting per-case would scatter the seq-advancement / pending-resolution invariants this method enforces in one place.
  async #dispatch(frame: ServerFrame): Promise<void> {
    switch (frame.type) {
      case 'hello': {
        // First frame on every connect; not seq-counted.
        //
        // If the server signals is_fresh_channel:true, the server-side
        // channel has no identity persisted and current_seq is 0. Reset our
        // cursor and known projection so we don't carry stale state into a
        // freshly recreated channel.
        //
        // Send Resume from HERE (after the reset), not from #onOpen on the
        // `open` event. Otherwise the stale Resume reaches the server before
        // the fresh-channel reset takes effect and the server emits a
        // spurious admin_reissue → unnecessary token rotation.
        const hasStaleState =
          this.#lastServerSeq !== '0' || this.#knownCredentials.length > 0;
        if (frame.is_fresh_channel && hasStaleState) {
          this.opts.onError?.(
            new Error(
              `agent-control: server signaled fresh channel; resetting cursor (was=${this.#lastServerSeq}, server=${frame.current_seq})`,
            ),
          );
          // Capture the pre-reset projection BEFORE zeroing local state,
          // then send a one-shot Resume with the captured known_credentials
          // so the server's divergence detection can run against what we
          // used to hold. Without this, the client silently drops its
          // projection — admin-side revocations that happened during the
          // server-side outage are never detected and the daemon keeps using
          // its (now-stale) cached tokens until natural expiry. last_server_seq
          // is sent as '0' to match the cursor we've just reset to; the
          // server's replay range becomes empty (no replay) and only the
          // divergence path runs. #sendResumeIfApplicable() is skipped here
          // because we issue the Resume inline with the captured projection;
          // the helper would short-circuit anyway once local state is zeroed.
          const preResetKnown = this.#knownCredentials;
          this.#lastServerSeq = '0';
          this.#knownCredentials = [];
          await this.opts.onSeqAdvanced('0');
          await this.opts.onKnownCredentialsChanged?.([]);
          if (this.#ps && preResetKnown.length > 0) {
            this.#ps.send(
              JSON.stringify({
                type: 'resume',
                client_msg_id: crypto.randomUUID(),
                last_server_seq: '0',
                known_credentials: preResetKnown,
                capabilities: this.opts.capabilities,
              }),
            );
          }
          return;
        }
        this.#sendResumeIfApplicable();
        return;
      }

      case 'credential_delivered': {
        // C11: a bootstrap / re_bootstrap delivery's PRIMARY payload is the
        // `agent_secret` (+ agent_name) the setup flow blocks on. Its github
        // descriptor is INTENTIONALLY bare — the server's `buildLiveDescriptors`
        // omits `scoped_token` (the real token follows via a credential_request).
        // The redacted-replay short-circuit below is for STEADY-STATE frames
        // (admin_reissue / refresh_response / hibernation replays) where a bare
        // issued credential means "refresh me." Applying it to bootstrap/
        // re_bootstrap silently drops the agent_secret and hangs setup to its
        // 10-min timeout — the exact reason reattaching to an agent that ALREADY
        // holds a github credential never completed (a first-run bootstrap works
        // only because no github credential is staged yet). So for these causes
        // we ALWAYS deliver, then queue the follow-up refresh for any bare
        // issued credential.
        const isBootstrapCause =
          frame.cause === 'bootstrap' || frame.cause === 're_bootstrap';
        if (
          !isBootstrapCause &&
          (await this.#handleIfRedacted(
            frame.credentials,
            frame.seq,
            `credential_delivered{cause:'${frame.cause}'}`,
          ))
        ) {
          return;
        }
        await this.opts.onCredentialDelivered(frame);
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        if (isBootstrapCause) {
          // The github descriptor on a bootstrap/re_bootstrap is bare by design;
          // queue a credential_request so the real scoped_token arrives next.
          // No-op + silently swallowed when the one-shot setup client has
          // already closed after settling (the daemon recovers the token via
          // the steady-state divergence/admin_reissue path on its next connect).
          this.#queueRefreshForBareIssued(frame.credentials);
        }
        // If this delivery resolves a pending refresh request, fire the
        // promise (we accept refresh_response and admin_reissue here;
        // bootstrap is a separate one-shot path the setup flow waits on).
        if (
          frame.cause === 'refresh_response' ||
          frame.cause === 'admin_reissue'
        ) {
          // We don't have client_msg_id correlation on the delivery;
          // resolve any pending requests with the delivered descriptors.
          // In practice there's at most one outstanding refresh at a time
          // (#refreshChain serializes).
          for (const [id, p] of this.#pendingRequests) {
            clearTimeout(p.timer);
            // Drop the superseded id BEFORE the new one is added
            // (#trackKnownCredentials already ran above for refresh_response
            // too). Without this, a client-initiated refresh leaks one stale
            // id per refresh into knownCredentials, which trips server-side
            // divergence detection on the next reconnect and triggers a
            // spurious admin_reissue → another rotation.
            if (p.supersededScopedTokenId) {
              this.#dropKnownCredential(
                p.supersededProvider,
                p.supersededScopedTokenId,
              );
            }
            p.resolve(frame.credentials);
            this.#pendingRequests.delete(id);
            break;
          }
        }
        return;
      }

      case 'credential_rotated': {
        // Cancel any pending rotation-fallback timer — the server
        // delivered the credential_rotated we were waiting for.
        for (const [seq, t] of this.#rotationTimers) {
          clearTimeout(t);
          this.#rotationTimers.delete(seq);
        }
        const superseded = frame.superseded_scoped_token_id;
        if (
          await this.#handleIfRedacted(
            frame.credentials,
            frame.seq,
            'credential_rotated',
            superseded,
          )
        ) {
          return;
        }
        await this.opts.onCredentialRotated?.(frame);
        // Drop the superseded scoped_token_id BEFORE adding the new one.
        // Without this, every rotation accumulates a stale id in
        // knownCredentials; the next reconnect's Resume diverges from the
        // server's live set and triggers a spurious admin_reissue → another
        // rotation. The provider check pairs with the id so we don't
        // accidentally remove a same-id entry under a different provider
        // (defense-in-depth).
        //
        // Phase C (decision D6): the server emits one credential_rotated frame
        // per credential, so `frame.credentials[0].provider` is THE provider of
        // the single rotated credential — the per-credential supersede below is
        // correct even for a multi-org agent holding several github credentials
        // simultaneously (each org's rotation arrives as its own frame).
        if (superseded) {
          const supersededProvider = frame.credentials[0]?.provider;
          this.#dropKnownCredential(supersededProvider, superseded);
        }
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        // A rotation satisfies an in-flight credential_request the same way
        // a refresh_response delivery does — the daemon has fresh
        // credentials on disk either way. Without this, the pending request
        // fired a spurious `credential_request_timeout` 30 s AFTER the
        // credential landed (observed 2026-06-11; plan Task 2.3 Fix 2).
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          if (p.supersededScopedTokenId) {
            this.#dropKnownCredential(
              p.supersededProvider,
              p.supersededScopedTokenId,
            );
          }
          p.resolve(frame.credentials);
          this.#pendingRequests.delete(id);
          break;
        }
        return;
      }

      case 'credential_revoked': {
        // Snapshot before mutation so we can detect changes and
        // notify the persistence callback only on real removals.
        await this.opts.onCredentialRevoked?.(frame);
        const beforeRevoke = this.#knownCredentials.length;
        this.#knownCredentials = this.#knownCredentials.filter(
          (k) =>
            !(
              k.provider === frame.provider &&
              k.scoped_token_id === frame.scoped_token_id
            ),
        );
        if (this.#knownCredentials.length !== beforeRevoke) {
          await this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
        }
        await this.#advanceSeq(frame.seq);
        return;
      }

      case 'config_updated': {
        // Apply the descriptor via caller-supplied hook.
        await this.opts.onConfigUpdated?.(frame);
        await this.#advanceSeq(frame.seq);
        // If triggers_rotation, start a 10s fallback timer. If no
        // credential_rotated arrives in time, issue a manual refresh so
        // credentials don't silently diverge after an admin reconfiguration.
        if (frame.triggers_rotation) {
          const seq = frame.seq;
          const rotationMs = this.opts.rotationFallbackTimeoutMs ?? 10_000;
          const timer = setTimeout(() => {
            this.#rotationTimers.delete(seq);
            // Phase C: a multi-org agent holds one credential per GitHub org
            // (decision D6). Refresh EACH known credential of the provider,
            // targeting it by its own scoped_token_id, so the manual refresh of
            // one org's credential never clobbers a sibling org's live
            // credential. When none is known (legacy single-org reconfigure with
            // no prior credential), fall back to a single un-targeted refresh.
            const known = this.#knownCredentials.filter(
              (k) => k.provider === frame.config.provider,
            );
            for (const k of known.length > 0 ? known : [undefined]) {
              void this.requestRefresh({
                reason: 'manual',
                provider: frame.config.provider,
                superseded_scoped_token_id: k?.scoped_token_id,
              }).catch((err: unknown) => {
                if (err instanceof Error && err.message === 'client_closed')
                  return;
                this.opts.onError?.(
                  err instanceof Error ? err : new Error(String(err)),
                );
              });
            }
          }, rotationMs);
          this.#rotationTimers.set(seq, timer);
        }
        return;
      }

      case 'ack': {
        const pending = this.#pendingRequests.get(frame.client_msg_id);
        if (pending) {
          if (!frame.ok) {
            clearTimeout(pending.timer);
            pending.reject(
              new Error(
                `${frame.error_code ?? 'unknown'}: ${frame.error_message ?? ''}`,
              ),
            );
            this.#pendingRequests.delete(frame.client_msg_id);
          }
          // ok=true: keep the pending entry; the credential_delivered
          // that follows resolves it.
        }
        await this.#advanceSeq(frame.seq);
        return;
      }

      case 'error': {
        // C4: ANY server `error` frame that arrives while a credential_request
        // is in flight is the answer to that request — reject it immediately
        // instead of letting it hang the full 30 s timeout. Server-emitted
        // `error` frames carry no `client_msg_id`, but the `#refreshChain`
        // serializer guarantees at most one outstanding request, so the head of
        // the pending queue IS the request the server just answered.
        //
        // Previously only a hard-coded whitelist of codes
        // (refresh_token_expired, installation_revoked, github_error, …)
        // rejected the pending request; an UNLISTED code (e.g. `not_found` for
        // an already-superseded scoped_token_id) fell through to the timeout.
        // On a live agent that manifested as a `credential_request_timeout`
        // every ~8 h for days — the expiry watcher blocked on the 30 s timeout,
        // the credential never refreshed, and it eventually went stale. Reject
        // on every code so the daemon logs the REAL failure (and can retry)
        // instead of a generic timeout. (Validation/authz failures still arrive
        // as Ack{ok:false} and are rejected in the `ack` case above.)
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          p.reject(new Error(`${frame.code}: ${frame.message}`));
          this.#pendingRequests.delete(id);
          break;
        }
        this.opts.onError?.(
          new Error(`server: ${frame.code}: ${frame.message}`),
        );
        await this.#advanceSeq(frame.seq);
        return;
      }

      case 'resume_window_exceeded': {
        // Do NOT treat as fatal. Fast-forward our cursor to the
        // server's current_seq and clear the projection so the next
        // partysocket reconnect's Resume passes the window check
        // (clientSeq === serverSeq, replay range empty) and the server's
        // divergence detection re-issues admin_reissue for any live
        // credentials we should know about. The 4413 close that follows
        // is no longer in FATAL_CLOSE_CODES, so reconnect is automatic.
        // Note: we call opts.onSeqAdvanced directly (not #advanceSeq)
        // because #advanceSeq is now monotonic and would no-op when seq
        // happens to equal the current value, and we also need to bypass
        // the AckClient send which would race the close.
        this.#lastServerSeq = frame.current_seq;
        this.#knownCredentials = [];
        await this.opts.onSeqAdvanced(frame.current_seq);
        await this.opts.onKnownCredentialsChanged?.([]);
        this.opts.onError?.(
          new Error(
            `agent-control: server signaled resume_window_exceeded; cursor fast-forwarded to seq=${frame.current_seq}; reconnecting`,
          ),
        );
        return;
      }

      case 'login_code': {
        // REQ-003 (Task 17) — The control plane is delivering the auth code
        // that completes the headless `claude setup-token` relay flow.
        // Dispatch to the registered handler (Claude Code daemon only);
        // other plugins leave `onLoginCode` undefined and the frame is
        // silently ignored. Not seq-counted (no #advanceSeq call): the
        // server emits these outside the normal credential-delivery sequence.
        await this.opts.onLoginCode?.(frame);
        return;
      }

      case 'login_restart': {
        // REQ-003 (Task 17) — The control plane is telling the box to
        // abandon the current `claude setup-token` attempt and re-run it.
        // Not seq-counted.
        await this.opts.onLoginRestart?.(frame);
        return;
      }
    }
  }

  /**
   * Handles a credential frame that has any redacted credential (no
   * `scoped_token`). See the redacted-replay contract in protocol.ts.
   *
   * Returns `true` if any credential was redacted (caller should return
   * early, skipping `onCredentialDelivered`/`onCredentialRotated`).
   * Returns `false` when all credentials carry a `scoped_token`.
   *
   * When redacted: advances seq, logs via `onError` (informational), and
   * queues a fire-and-forget `requestRefresh` for each bare credential.
   * `client_closed` rejections on teardown are swallowed silently.
   */
  async #handleIfRedacted(
    creds: CredentialDescriptor[],
    seq: string,
    logLabel: string,
    supersededId?: string,
  ): Promise<boolean> {
    // Only `issued` (GitHub) credentials participate in the redacted-replay
    // contract — manual providers (slack/discord/teams) always carry their
    // full secrets on every push frame.
    //
    // Rollout-robustness: an older backend may omit `kind` on github frames.
    // Treat a github credential whose `kind` is absent as 'issued' so
    // redaction-suppression and scoped_token_id tracking work correctly
    // during a mixed-version rollout window.
    const issuedCreds = creds.filter(
      (c): c is Extract<CredentialDescriptor, { kind: 'issued' }> => {
        const effKind: CredentialKind =
          (c as { kind?: CredentialKind }).kind ??
          (c.provider === 'github' ? 'issued' : c.kind);
        return effKind === 'issued';
      },
    );
    if (!issuedCreds.some((c) => !c.scoped_token)) return false;

    // Do NOT track redacted credentials in #knownCredentials here.
    // The redacted frame is a notification that we need to refresh — it does
    // not carry a real scoped_token. If we add the entry now and the follow-up
    // requestRefresh fails (refresh_token_expired, installation_revoked,
    // github_error, etc.), the projection holds an id the server's live set
    // will never honor, and divergence detection on every subsequent reconnect
    // triggers another admin_reissue → another failing refresh — an infinite
    // loop of spurious server work. Tracking happens only when the real
    // `credential_delivered{cause:'refresh_response'}` arrives (see the
    // non-redacted branch of case 'credential_delivered').
    await this.#advanceSeq(seq);
    // Expected protocol behavior (hibernation replay redacts secrets) —
    // info, not error, when the consumer provides an info hook.
    const redactedNotice = `agent-control: redacted ${logLabel} — queuing credential_request to obtain fresh secret`;
    if (this.opts.onInfo) {
      this.opts.onInfo(redactedNotice);
    } else {
      this.opts.onError?.(new Error(redactedNotice));
    }
    // Fire-and-forget: resolves when the follow-up refresh_response
    // delivers the real scoped_token. #refreshChain serializes concurrent
    // notices. Swallow client_closed on teardown.
    this.#queueRefreshForBareIssued(creds, supersededId);
    return true;
  }

  /**
   * Queue a fire-and-forget `credential_request` for each ISSUED (github)
   * credential that arrived WITHOUT a `scoped_token`. Shared by the
   * redacted-replay path (`#handleIfRedacted`) and the bootstrap/re_bootstrap
   * delivery path (where the descriptor is bare by design — see the C11 note
   * in `case 'credential_delivered'`). #refreshChain serializes concurrent
   * requests; `client_closed` / `client not started` rejections on teardown
   * are swallowed (a one-shot setup client closes right after settling, and the
   * daemon recovers the token via the steady-state divergence path).
   */
  #queueRefreshForBareIssued(
    creds: CredentialDescriptor[],
    supersededId?: string,
  ): void {
    // Nothing to refresh on a socket that's already closed (one-shot setup
    // client post-settle) — avoid a spurious `client not started` onError.
    if (this.#closed || !this.#ps) return;
    for (const c of creds) {
      // Rollout-robustness mirror of #handleIfRedacted: treat a github
      // credential whose `kind` is absent (older backend) as 'issued'.
      const effKind: CredentialKind =
        (c as { kind?: CredentialKind }).kind ??
        (c.provider === 'github' ? 'issued' : c.kind);
      if (effKind !== 'issued') continue;
      const issued = c as Extract<CredentialDescriptor, { kind: 'issued' }>;
      if (issued.scoped_token) continue;
      void this.requestRefresh({
        reason: 'expiry',
        provider: issued.provider,
        superseded_scoped_token_id:
          supersededId ?? issued.scoped_token_id ?? issued.credential_id,
      }).catch((err: unknown) => {
        if (
          err instanceof Error &&
          (err.message === 'client_closed' ||
            err.message === 'client not started')
        ) {
          return;
        }
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }
  }

  /**
   * Drop a single (provider, scoped_token_id) entry. Called from the
   * credential_rotated dispatch path before #trackKnownCredentials adds
   * the new entry, so the projection stays in lockstep with the server's
   * live row set across rotations.
   */
  #dropKnownCredential(
    provider: string | undefined,
    scopedTokenId: string,
  ): void {
    const before = this.#knownCredentials.length;
    this.#knownCredentials = this.#knownCredentials.filter(
      (k) =>
        !(
          (provider === undefined || k.provider === provider) &&
          k.scoped_token_id === scopedTokenId
        ),
    );
    if (this.#knownCredentials.length !== before) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }

  #trackKnownCredentials(creds: CredentialDescriptor[]): void {
    const next = [...this.#knownCredentials];
    let changed = false;
    for (const c of creds) {
      // For issued (GitHub) credentials, use scoped_token_id if present,
      // falling back to credential_id. For manual providers (slack/discord/
      // teams), credential_id is the stable tracking key.
      //
      // Rollout-robustness: treat a github credential whose `kind` is absent
      // (older backend) as 'issued' so scoped_token_id is preferred as
      // the tracking key during a mixed-version rollout window.
      const effKind: CredentialKind =
        (c as { kind?: CredentialKind }).kind ??
        (c.provider === 'github' ? 'issued' : c.kind);
      const trackingId =
        effKind === 'issued'
          ? ((c as { scoped_token_id?: string }).scoped_token_id ??
            c.credential_id)
          : c.credential_id;
      const idx = next.findIndex(
        (k) => k.provider === c.provider && k.scoped_token_id === trackingId,
      );
      if (idx === -1) {
        next.push({ provider: c.provider, scoped_token_id: trackingId });
        changed = true;
      }
    }
    this.#knownCredentials = next;
    // Persist the projection so a daemon restart replays a real
    // known_credentials list to the server (avoids spurious admin_reissue
    // → silent token rotation on every cold start).
    if (changed) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }

  async #advanceSeq(seq: string): Promise<void> {
    // Guard monotonicity at the source. A stray/replayed `ack`
    // frame, or a redundant call from #handleIfRedacted after a regular
    // dispatch path already advanced, can carry a seq <= our current cursor.
    // Without this guard the cursor can regress (or leap forward past frames
    // the plugin never processed if the cases run out of order), the disk
    // hook gets called with stale values, and Resume on the next reconnect
    // either over-replays or under-replays.
    let nextN: bigint;
    let currentN: bigint;
    try {
      nextN = BigInt(seq);
      currentN = BigInt(this.#lastServerSeq);
    } catch {
      // Malformed seq — surface to the caller; do not silently drop.
      this.opts.onError?.(
        new Error(`agent-control: invalid seq value: ${String(seq)}`),
      );
      return;
    }
    if (nextN <= currentN) return;

    this.#lastServerSeq = seq;
    await this.opts.onSeqAdvanced(seq);
    // Send AckClient back so the server can prune its ring buffer.
    try {
      this.#ps?.send(
        JSON.stringify({
          type: 'ack',
          client_msg_id: crypto.randomUUID(),
          acked_seq: seq,
        }),
      );
    } catch {
      // socket closing — non-fatal, next reconnect's resume covers it
    }
  }
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
// Exported for the transport-safety unit test (tests/unit/agent-control/
// websocket-error-safety.test.ts). Not part of the public client API.
export function makeErrorSafeWebSocket(
  Base: typeof WebSocket,
  headers?: Record<string, string>,
): typeof WebSocket {
  // `Wrapped` is a function DECLARATION (not a `const`-assigned function
  // expression) on purpose. It must be `new`-able — arrow functions cannot be
  // constructed and partysocket does `new WS(url, protocols)` internally — and
  // the declaration form also sidesteps biome's `useArrowFunction` autofix,
  // which ignored inline suppressions and kept rewriting the expression form
  // into a broken (non-constructable) arrow on every `lint --write`. The
  // `as any` casts bridge ws.WebSocket's (url, protocols?, options?) signature,
  // which partysocket types as the browser `typeof WebSocket`.
  function Wrapped(url: string, protocols?: string | string[]): WebSocket {
    const ws = headers
      ? // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols, options) signature (see above).
        new (Base as any)(url, protocols, { headers })
      : // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols) signature (see above).
        new (Base as any)(url, protocols);
    // Node's `ws` THROWS on an `'error'` event that has no EventEmitter
    // listener. When PartySocket times out a still-connecting socket it calls
    // `.close()`, and `ws` then emits `'error'` ("WebSocket was closed before
    // the connection was established"). PartySocket removes its own (DOM-style)
    // listeners while tearing the socket down, so without a permanent listener
    // here that emit becomes an uncaught exception that crashes the whole
    // process — killing a managed-bootstrap claim before PartySocket's
    // `maxRetries: Infinity` can reconnect. (This bricked a real Lightsail
    // agent on first boot: the transient connect timeout crashed `spellguard-
    // setup`, the agent secret was never persisted, and the box was stuck
    // `no-agent-secret` forever.) The no-op listener guarantees the emit is
    // always handled; PartySocket's own `'error'` listener still fires
    // (→ `onError`) and its reconnect then drives the claim to completion.
    // Guarded for non-EventEmitter impls (browser WebSocket / test doubles use
    // `addEventListener` and have no `.on`).
    if (ws && typeof ws.on === 'function') {
      ws.on('error', () => {});
    }
    return ws;
  }
  Wrapped.prototype = Base.prototype;
  return Wrapped as unknown as typeof WebSocket;
}
