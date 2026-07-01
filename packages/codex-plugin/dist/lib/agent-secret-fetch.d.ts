export interface FetchOptions {
    baseUrl: string;
    agentId: string;
    agentSecret: string;
    fetchImpl?: typeof fetch;
    retryDelayMs?: number;
    /**
     * Optional extra headers to include on the request. Used to
     * attach the current scoped GitHub token to /credentials/github/status
     * calls so the server-side liveness probe can fire.
     */
    extraHeaders?: Record<string, string>;
}
export type FetchSuccess<T> = {
    ok: true;
    status: number;
    body: T;
};
export type FetchFailure = {
    ok: false;
    status?: number;
    code?: string;
    message?: string;
};
export type FetchResult<T> = FetchSuccess<T> | FetchFailure;
export declare function agentSecretGet<T>(path: string, opts: FetchOptions): Promise<FetchResult<T>>;
/**
 * Path for the agent-authed GitHub credential-status probe
 * (`GET /v1/credentials/github/status`). `scoped_token_id` is always present —
 * empty for an identity-only config (before any credential has landed) — so the
 * server can attach the scoped token to its liveness check. ONE builder for the
 * four callers that probe this endpoint (setup identity-probe, session-start,
 * the credential monitor, the pre-tool-use hook) so the path can't drift.
 */
export declare function credentialStatusPath(scopedTokenId?: string): string;
/**
 * HTTP statuses from an agent-authed credential endpoint that mean the server no
 * longer recognizes this agent or its credential — deleted, revoked, offboarded,
 * or attached elsewhere. `requireAgentSecret` runs before any param handling, so
 * these are returned regardless of query params. Every other non-OK status (5xx,
 * network) is TRANSIENT and must not be treated as "gone". Centralized here so
 * the four status-probe callers classify HTTP failures identically (they had
 * drifted: 401-only, 401/410, and 401/403/404/410 all appeared in-tree).
 */
export declare const AGENT_GONE_HTTP_STATUSES: readonly number[];
/**
 * Accepts `undefined` (a network failure with no HTTP status) and treats it as
 * NOT gone — a missing status is transient, never "the agent is gone".
 */
export declare function isAgentGoneStatus(httpStatus: number | undefined): boolean;
export declare function agentSecretPost<T>(path: string, body: unknown, opts: FetchOptions): Promise<FetchResult<T>>;
