import type { paths } from '@spellguard/management-api-types';
import { type Client } from 'openapi-fetch';
/**
 * HTTP statuses from an agent-authed management endpoint that mean the server no
 * longer recognizes this agent or its credential — deleted, revoked, offboarded,
 * or attached elsewhere. `requireAgentSecret` runs before any param handling, so
 * these are returned regardless of query params. Every other non-OK status (5xx,
 * network) is TRANSIENT and must not be treated as "gone".
 */
export declare const AGENT_GONE_HTTP_STATUSES: readonly number[];
/**
 * Accepts `undefined` (a network failure with no HTTP status) and treats it as
 * NOT gone — a missing status is transient, never "the agent is gone".
 */
export declare function isAgentGoneStatus(httpStatus: number | undefined): boolean;
/**
 * Most agent-authed routes read the `X-Spellguard-Agent-Id`/`-Secret` headers
 * (`requireAgentSecret`). A few — notably `POST /agents/{id}/plugin-sync` — are
 * authed with `Authorization: Bearer <agentSecret>` (`requireAgentBearer`).
 */
export type ManagementAuthMode = 'agent-secret' | 'bearer';
export interface ManagementClientOptions {
    /** Management API origin, e.g. `https://console.spellguard.ai` (no `/v1`). */
    baseUrl: string;
    agentId: string;
    agentSecret: string;
    /** Auth header style the target route expects. Defaults to `agent-secret`. */
    auth?: ManagementAuthMode;
    /** Test seam; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /**
     * Retry once on a 5xx (default `true`). Set `false` when the caller has its
     * own reconnect/backoff (e.g. OpenClaw's platform relay) so the client makes a
     * single attempt and lets the caller drive retries.
     */
    retry?: boolean;
    /** Backoff before the single 5xx retry. Defaults to 1000ms. */
    retryDelayMs?: number;
}
/**
 * The shared agent-secret-authenticated typed client for the Spellguard
 * management API, used by the coding plugins (Claude Code + Codex). Types come
 * from `@spellguard/management-api-types` (the generated contract), so a
 * renamed/removed/retyped route is a compile error at the call site.
 *
 * Behavior parity with the legacy `agentSecretGet`/`agentSecretPost` transport:
 * injects the `X-Spellguard-Agent-Id`/`-Secret` + `User-Agent` headers, and
 * retries ONCE on a 5xx. The retry clones the request first so a POST body
 * survives the second attempt. Callers read the openapi-fetch `{ data, error,
 * response }` envelope and classify HTTP failures with `isAgentGoneStatus`.
 */
export declare function createManagementClient(opts: ManagementClientOptions): Client<paths>;
