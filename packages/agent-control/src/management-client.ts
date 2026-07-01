// SPDX-License-Identifier: Apache-2.0

import type { paths } from '@spellguard/management-api-types';
import createClient, { type Client, type Middleware } from 'openapi-fetch';

/**
 * HTTP statuses from an agent-authed management endpoint that mean the server no
 * longer recognizes this agent or its credential — deleted, revoked, offboarded,
 * or attached elsewhere. `requireAgentSecret` runs before any param handling, so
 * these are returned regardless of query params. Every other non-OK status (5xx,
 * network) is TRANSIENT and must not be treated as "gone".
 */
export const AGENT_GONE_HTTP_STATUSES: readonly number[] = [401, 403, 404, 410];

/**
 * Accepts `undefined` (a network failure with no HTTP status) and treats it as
 * NOT gone — a missing status is transient, never "the agent is gone".
 */
export function isAgentGoneStatus(httpStatus: number | undefined): boolean {
  return (
    httpStatus !== undefined && AGENT_GONE_HTTP_STATUSES.includes(httpStatus)
  );
}

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

const USER_AGENT = 'spellguard-plugin/0.1.0';

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
export function createManagementClient(
  opts: ManagementClientOptions,
): Client<paths> {
  // Late-bind the default global `fetch` (resolve it at call time, not client-
  // creation time) so a long-lived client picks up a later global swap — needed
  // for OpenClaw's relay reconnect and the `vi.stubGlobal('fetch', …)` test
  // pattern. An explicit `fetchImpl` always wins.
  const baseFetch: typeof fetch =
    opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelay = opts.retryDelayMs ?? 1000;
  const retryOn5xx = opts.retry ?? true;

  // Retry once on a 5xx (unless disabled). Clone for the first attempt so the
  // request body is still available for the retry (parity with the old
  // transport, which retried both GET and POST).
  const retryingFetch = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req =
      input instanceof Request ? input : new Request(String(input), init);
    if (!retryOn5xx) return baseFetch(req);
    const first = await baseFetch(req.clone());
    if (first.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return baseFetch(req);
    }
    return first;
  }) as typeof fetch;

  const auth: Middleware = {
    onRequest({ request }) {
      if ((opts.auth ?? 'agent-secret') === 'bearer') {
        request.headers.set('Authorization', `Bearer ${opts.agentSecret}`);
      } else {
        request.headers.set('X-Spellguard-Agent-Id', opts.agentId);
        request.headers.set('X-Spellguard-Agent-Secret', opts.agentSecret);
      }
      request.headers.set('User-Agent', USER_AGENT);
      return request;
    },
  };

  const client = createClient<paths>({
    // Strip a trailing slash AND a trailing `/v1` before appending `/v1`, so a
    // baseUrl of either `https://host` or `https://host/v1` (OpenClaw's docker
    // default carries `/v1`) yields a single `/v1`, never `/v1/v1`.
    baseUrl: `${opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`,
    fetch: retryingFetch,
  });
  client.use(auth);
  return client;
}
