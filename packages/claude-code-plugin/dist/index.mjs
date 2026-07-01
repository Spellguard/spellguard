var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../agent-control/dist/index.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PartySocket } from "partysocket";
import WebSocket from "ws";

// ../../node_modules/openapi-fetch/dist/index.mjs
var PATH_PARAM_RE = /\{[^{}]+\}/g;
var supportsRequestInitExt = () => {
  return typeof process === "object" && Number.parseInt(process?.versions?.node?.substring(0, 2)) >= 18 && process.versions.undici;
};
function randomID() {
  return Math.random().toString(36).slice(2, 11);
}
function createClient(clientOptions) {
  let {
    baseUrl = "",
    Request: CustomRequest = globalThis.Request,
    fetch: baseFetch = globalThis.fetch,
    querySerializer: globalQuerySerializer,
    bodySerializer: globalBodySerializer,
    pathSerializer: globalPathSerializer,
    headers: baseHeaders,
    requestInitExt = void 0,
    ...baseOptions
  } = { ...clientOptions };
  requestInitExt = supportsRequestInitExt() ? requestInitExt : void 0;
  baseUrl = removeTrailingSlash(baseUrl);
  const globalMiddlewares = [];
  async function coreFetch(schemaPath, fetchOptions) {
    const {
      baseUrl: localBaseUrl,
      fetch: fetch2 = baseFetch,
      Request: Request2 = CustomRequest,
      headers,
      params = {},
      parseAs = "json",
      querySerializer: requestQuerySerializer,
      bodySerializer = globalBodySerializer ?? defaultBodySerializer,
      pathSerializer: requestPathSerializer,
      body,
      middleware: requestMiddlewares = [],
      ...init
    } = fetchOptions || {};
    let finalBaseUrl = baseUrl;
    if (localBaseUrl) {
      finalBaseUrl = removeTrailingSlash(localBaseUrl) ?? baseUrl;
    }
    let querySerializer = typeof globalQuerySerializer === "function" ? globalQuerySerializer : createQuerySerializer(globalQuerySerializer);
    if (requestQuerySerializer) {
      querySerializer = typeof requestQuerySerializer === "function" ? requestQuerySerializer : createQuerySerializer({
        ...typeof globalQuerySerializer === "object" ? globalQuerySerializer : {},
        ...requestQuerySerializer
      });
    }
    const pathSerializer = requestPathSerializer || globalPathSerializer || defaultPathSerializer;
    const serializedBody = body === void 0 ? void 0 : bodySerializer(
      body,
      // Note: we declare mergeHeaders() both here and below because it’s a bit of a chicken-or-egg situation:
      // bodySerializer() needs all headers so we aren’t dropping ones set by the user, however,
      // the result of this ALSO sets the lowest-priority content-type header. So we re-merge below,
      // setting the content-type at the very beginning to be overwritten.
      // Lastly, based on the way headers work, it’s not a simple “present-or-not” check becauase null intentionally un-sets headers.
      mergeHeaders(baseHeaders, headers, params.header)
    );
    const finalHeaders = mergeHeaders(
      // with no body, we should not to set Content-Type
      serializedBody === void 0 || // if serialized body is FormData; browser will correctly set Content-Type & boundary expression
      serializedBody instanceof FormData ? {} : {
        "Content-Type": "application/json"
      },
      baseHeaders,
      headers,
      params.header
    );
    const finalMiddlewares = [...globalMiddlewares, ...requestMiddlewares];
    const requestInit = {
      redirect: "follow",
      ...baseOptions,
      ...init,
      body: serializedBody,
      headers: finalHeaders
    };
    let id;
    let options;
    let request = new Request2(
      createFinalURL(schemaPath, { baseUrl: finalBaseUrl, params, querySerializer, pathSerializer }),
      requestInit
    );
    let response;
    for (const key in init) {
      if (!(key in request)) {
        request[key] = init[key];
      }
    }
    if (finalMiddlewares.length) {
      id = randomID();
      options = Object.freeze({
        baseUrl: finalBaseUrl,
        fetch: fetch2,
        parseAs,
        querySerializer,
        bodySerializer,
        pathSerializer
      });
      for (const m of finalMiddlewares) {
        if (m && typeof m === "object" && typeof m.onRequest === "function") {
          const result = await m.onRequest({
            request,
            schemaPath,
            params,
            options,
            id
          });
          if (result) {
            if (result instanceof Request2) {
              request = result;
            } else if (result instanceof Response) {
              response = result;
              break;
            } else {
              throw new Error("onRequest: must return new Request() or Response() when modifying the request");
            }
          }
        }
      }
    }
    if (!response) {
      try {
        response = await fetch2(request, requestInitExt);
      } catch (error2) {
        let errorAfterMiddleware = error2;
        if (finalMiddlewares.length) {
          for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
            const m = finalMiddlewares[i];
            if (m && typeof m === "object" && typeof m.onError === "function") {
              const result = await m.onError({
                request,
                error: errorAfterMiddleware,
                schemaPath,
                params,
                options,
                id
              });
              if (result) {
                if (result instanceof Response) {
                  errorAfterMiddleware = void 0;
                  response = result;
                  break;
                }
                if (result instanceof Error) {
                  errorAfterMiddleware = result;
                  continue;
                }
                throw new Error("onError: must return new Response() or instance of Error");
              }
            }
          }
        }
        if (errorAfterMiddleware) {
          throw errorAfterMiddleware;
        }
      }
      if (finalMiddlewares.length) {
        for (let i = finalMiddlewares.length - 1; i >= 0; i--) {
          const m = finalMiddlewares[i];
          if (m && typeof m === "object" && typeof m.onResponse === "function") {
            const result = await m.onResponse({
              request,
              response,
              schemaPath,
              params,
              options,
              id
            });
            if (result) {
              if (!(result instanceof Response)) {
                throw new Error("onResponse: must return new Response() when modifying the response");
              }
              response = result;
            }
          }
        }
      }
    }
    const contentLength = response.headers.get("Content-Length");
    if (response.status === 204 || request.method === "HEAD" || contentLength === "0" && !response.headers.get("Transfer-Encoding")?.includes("chunked")) {
      return response.ok ? { data: void 0, response } : { error: void 0, response };
    }
    if (response.ok) {
      const getResponseData = async () => {
        if (parseAs === "stream") {
          return response.body;
        }
        if (parseAs === "json" && !contentLength) {
          const raw = await response.text();
          return raw ? JSON.parse(raw) : void 0;
        }
        return await response[parseAs]();
      };
      return { data: await getResponseData(), response };
    }
    let error = await response.text();
    try {
      error = JSON.parse(error);
    } catch {
    }
    return { error, response };
  }
  return {
    request(method, url, init) {
      return coreFetch(url, { ...init, method: method.toUpperCase() });
    },
    /** Call a GET endpoint */
    GET(url, init) {
      return coreFetch(url, { ...init, method: "GET" });
    },
    /** Call a PUT endpoint */
    PUT(url, init) {
      return coreFetch(url, { ...init, method: "PUT" });
    },
    /** Call a POST endpoint */
    POST(url, init) {
      return coreFetch(url, { ...init, method: "POST" });
    },
    /** Call a DELETE endpoint */
    DELETE(url, init) {
      return coreFetch(url, { ...init, method: "DELETE" });
    },
    /** Call a OPTIONS endpoint */
    OPTIONS(url, init) {
      return coreFetch(url, { ...init, method: "OPTIONS" });
    },
    /** Call a HEAD endpoint */
    HEAD(url, init) {
      return coreFetch(url, { ...init, method: "HEAD" });
    },
    /** Call a PATCH endpoint */
    PATCH(url, init) {
      return coreFetch(url, { ...init, method: "PATCH" });
    },
    /** Call a TRACE endpoint */
    TRACE(url, init) {
      return coreFetch(url, { ...init, method: "TRACE" });
    },
    /** Register middleware */
    use(...middleware) {
      for (const m of middleware) {
        if (!m) {
          continue;
        }
        if (typeof m !== "object" || !("onRequest" in m || "onResponse" in m || "onError" in m)) {
          throw new Error("Middleware must be an object with one of `onRequest()`, `onResponse() or `onError()`");
        }
        globalMiddlewares.push(m);
      }
    },
    /** Unregister middleware */
    eject(...middleware) {
      for (const m of middleware) {
        const i = globalMiddlewares.indexOf(m);
        if (i !== -1) {
          globalMiddlewares.splice(i, 1);
        }
      }
    }
  };
}
function serializePrimitiveParam(name, value, options) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value === "object") {
    throw new Error(
      "Deeply-nested arrays/objects aren\u2019t supported. Provide your own `querySerializer()` to handle these."
    );
  }
  return `${name}=${options?.allowReserved === true ? value : encodeURIComponent(value)}`;
}
function serializeObjectParam(name, value, options) {
  if (!value || typeof value !== "object") {
    return "";
  }
  const values = [];
  const joiner = {
    simple: ",",
    label: ".",
    matrix: ";"
  }[options.style] || "&";
  if (options.style !== "deepObject" && options.explode === false) {
    for (const k in value) {
      values.push(k, options.allowReserved === true ? value[k] : encodeURIComponent(value[k]));
    }
    const final2 = values.join(",");
    switch (options.style) {
      case "form": {
        return `${name}=${final2}`;
      }
      case "label": {
        return `.${final2}`;
      }
      case "matrix": {
        return `;${name}=${final2}`;
      }
      default: {
        return final2;
      }
    }
  }
  for (const k in value) {
    const finalName = options.style === "deepObject" ? `${name}[${k}]` : k;
    values.push(serializePrimitiveParam(finalName, value[k], options));
  }
  const final = values.join(joiner);
  return options.style === "label" || options.style === "matrix" ? `${joiner}${final}` : final;
}
function serializeArrayParam(name, value, options) {
  if (!Array.isArray(value)) {
    return "";
  }
  if (options.explode === false) {
    const joiner2 = { form: ",", spaceDelimited: "%20", pipeDelimited: "|" }[options.style] || ",";
    const final = (options.allowReserved === true ? value : value.map((v) => encodeURIComponent(v))).join(joiner2);
    switch (options.style) {
      case "simple": {
        return final;
      }
      case "label": {
        return `.${final}`;
      }
      case "matrix": {
        return `;${name}=${final}`;
      }
      // case "spaceDelimited":
      // case "pipeDelimited":
      default: {
        return `${name}=${final}`;
      }
    }
  }
  const joiner = { simple: ",", label: ".", matrix: ";" }[options.style] || "&";
  const values = [];
  for (const v of value) {
    if (options.style === "simple" || options.style === "label") {
      values.push(options.allowReserved === true ? v : encodeURIComponent(v));
    } else {
      values.push(serializePrimitiveParam(name, v, options));
    }
  }
  return options.style === "label" || options.style === "matrix" ? `${joiner}${values.join(joiner)}` : values.join(joiner);
}
function createQuerySerializer(options) {
  return function querySerializer(queryParams) {
    const search = [];
    if (queryParams && typeof queryParams === "object") {
      for (const name in queryParams) {
        const value = queryParams[name];
        if (value === void 0 || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          search.push(
            serializeArrayParam(name, value, {
              style: "form",
              explode: true,
              ...options?.array,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        if (typeof value === "object") {
          search.push(
            serializeObjectParam(name, value, {
              style: "deepObject",
              explode: true,
              ...options?.object,
              allowReserved: options?.allowReserved || false
            })
          );
          continue;
        }
        search.push(serializePrimitiveParam(name, value, options));
      }
    }
    return search.join("&");
  };
}
function defaultPathSerializer(pathname, pathParams) {
  let nextURL = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    let name = match.substring(1, match.length - 1);
    let explode = false;
    let style = "simple";
    if (name.endsWith("*")) {
      explode = true;
      name = name.substring(0, name.length - 1);
    }
    if (name.startsWith(".")) {
      style = "label";
      name = name.substring(1);
    } else if (name.startsWith(";")) {
      style = "matrix";
      name = name.substring(1);
    }
    if (!pathParams || pathParams[name] === void 0 || pathParams[name] === null) {
      continue;
    }
    const value = pathParams[name];
    if (Array.isArray(value)) {
      nextURL = nextURL.replace(match, serializeArrayParam(name, value, { style, explode }));
      continue;
    }
    if (typeof value === "object") {
      nextURL = nextURL.replace(match, serializeObjectParam(name, value, { style, explode }));
      continue;
    }
    if (style === "matrix") {
      nextURL = nextURL.replace(match, `;${serializePrimitiveParam(name, value)}`);
      continue;
    }
    nextURL = nextURL.replace(match, style === "label" ? `.${encodeURIComponent(value)}` : encodeURIComponent(value));
  }
  return nextURL;
}
function defaultBodySerializer(body, headers) {
  if (body instanceof FormData) {
    return body;
  }
  if (headers) {
    const contentType = headers.get instanceof Function ? headers.get("Content-Type") ?? headers.get("content-type") : headers["Content-Type"] ?? headers["content-type"];
    if (contentType === "application/x-www-form-urlencoded") {
      return new URLSearchParams(body).toString();
    }
  }
  return JSON.stringify(body);
}
function createFinalURL(pathname, options) {
  let finalURL = `${options.baseUrl}${pathname}`;
  if (options.params?.path) {
    finalURL = options.pathSerializer(finalURL, options.params.path);
  }
  let search = options.querySerializer(options.params.query ?? {});
  if (search.startsWith("?")) {
    search = search.substring(1);
  }
  if (search) {
    finalURL += `?${search}`;
  }
  return finalURL;
}
function mergeHeaders(...allHeaders) {
  const finalHeaders = new Headers();
  for (const h of allHeaders) {
    if (!h || typeof h !== "object") {
      continue;
    }
    const iterator = h instanceof Headers ? h.entries() : Object.entries(h);
    for (const [k, v] of iterator) {
      if (v === null) {
        finalHeaders.delete(k);
      } else if (Array.isArray(v)) {
        for (const v2 of v) {
          finalHeaders.append(k, v2);
        }
      } else if (v !== void 0) {
        finalHeaders.set(k, v);
      }
    }
  }
  return finalHeaders;
}
function removeTrailingSlash(url) {
  if (url.endsWith("/")) {
    return url.substring(0, url.length - 1);
  }
  return url;
}

// ../agent-control/dist/index.mjs
var KNOWN_SERVER_FRAME_TYPES = /* @__PURE__ */ new Set([
  "hello",
  "credential_delivered",
  "credential_rotated",
  "credential_revoked",
  "config_updated",
  "ack",
  "error",
  "resume_window_exceeded",
  "login_code",
  "login_restart"
]);
function parseServerFrame(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw;
  if (typeof obj.type !== "string") return null;
  if (!KNOWN_SERVER_FRAME_TYPES.has(obj.type)) return null;
  if (obj.type === "login_code") {
    if (typeof obj.code !== "string" || obj.code.length === 0) return null;
  }
  return obj;
}
var AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1e3,
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
  AUTH_SUPERSEDED: 4409
  // A SERVER_TRANSIENT (4503) code is intentionally not declared here: the
  // server's transient-failure paths (storage put errors, missing DB handle,
  // serialization throws) log and fall through rather than emitting a close
  // code. A structured signal could be added later, paired with a
  // server-side emit site.
};
var AUTH_SUPERSEDED_CLOSE_REASONS = {
  ATTACHED_ELSEWHERE: "attached_elsewhere",
  REASSIGNED: "reassigned"
};
var FATAL_CLOSE_CODES = /* @__PURE__ */ new Set([
  // 4400 BOOTSTRAP_ERROR is wired up server-side. Without listing it here,
  // partysocket would auto-reconnect after a bootstrap-terminal failure and
  // the client would never surface the real error to the setup flow.
  AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR,
  AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED,
  AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP
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
var AgentControlClient = class {
  constructor(opts) {
    this.opts = opts;
    this.#lastServerSeq = opts.initialLastServerSeq ?? "0";
    this.#knownCredentials = opts.initialKnownCredentials ?? [];
  }
  #ps = null;
  #closed = false;
  #lastServerSeq;
  #knownCredentials;
  #firstConnect = true;
  #pendingRequests = /* @__PURE__ */ new Map();
  // Serializes refresh requests because `credential_delivered` carries no
  // `client_msg_id` correlation: with two requests in flight, the dispatcher
  // would resolve them out-of-order. This serialization can be dropped if the
  // protocol later grows an `in_response_to` correlation field.
  #refreshChain = Promise.resolve();
  // Rotation-fallback timers. Key = seq of the config_updated frame.
  // Cleared when a credential_rotated arrives before the 10s window expires.
  #rotationTimers = /* @__PURE__ */ new Map();
  // FIND-DA22 — keepalive heartbeat state. The timer fires every
  // heartbeatIntervalMs; #lastPongAt tracks the last observed 'pong' (clock
  // value, via the injectable #now()) so the timer can detect a zombie socket.
  #heartbeatTimer = null;
  #lastPongAt = 0;
  /** Open the socket. Subsequent reconnects are automatic. */
  start() {
    if (this.#closed || this.#ps) return;
    const BaseImpl = this.opts.WebSocketImpl ?? WebSocket;
    const Impl = makeErrorSafeWebSocket(BaseImpl, this.opts.upgradeHeaders);
    const apiBaseUrl = this.opts.apiBaseUrl.replace(/^https?:\/\//, "");
    const tls = this.opts.apiBaseUrl.startsWith("https://");
    const ps = new PartySocket({
      host: apiBaseUrl,
      protocol: tls ? "wss" : "ws",
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
      maxReconnectionDelay: this.opts.maxReconnectionDelayMs ?? 3e4,
      // FIND-DA24 — override partysocket's 4s default connectionTimeout. The
      // agent-control WS upgrade (cold DB lookup + bcrypt verify + DO
      // cold-start) routinely takes ~2–4s; a 4s abort-and-retry loop on a
      // slow-but-succeeding handshake is the root cause of the login-relay
      // connection flap. 20s default headroom; injectable via opts.
      connectionTimeout: this.opts.connectionTimeoutMs ?? 2e4,
      // Use the `ws` library on Node — partysocket's default targets
      // browsers.
      WebSocket: Impl
    });
    this.#ps = ps;
    ps.addEventListener("open", () => {
      void this.#onOpen();
    });
    ps.addEventListener("message", (e) => {
      void this.#handleMessage(e);
    });
    ps.addEventListener("close", (event) => {
      this.#stopHeartbeat();
      const closeEvent = event;
      const code = closeEvent.code ?? 0;
      const reason = closeEvent.reason ?? "";
      if (code === AGENT_CONTROL_CLOSE_CODES.AUTH_SUPERSEDED) {
        const validReasons = new Set(
          Object.values(AUTH_SUPERSEDED_CLOSE_REASONS)
        );
        const cause = validReasons.has(
          reason
        ) ? reason : void 0;
        this.opts.onCredentialSuperseded?.(cause);
        this.close();
        return;
      }
      if (FATAL_CLOSE_CODES.has(code)) {
        this.opts.onFatalClose(code, reason);
        this.close();
      }
    });
    ps.addEventListener("error", (event) => {
      const wrapped = event;
      const err = event instanceof Error ? event : wrapped.error instanceof Error ? wrapped.error : new Error(
        `socket error: ${typeof wrapped.message === "string" && wrapped.message ? wrapped.message : String(event)}`
      );
      this.opts.onError?.(err);
    });
  }
  /** Send a CredentialRequest and resolve to the delivered descriptors.
   *  Times out if no `credential_delivered` arrives within `timeoutMs`. */
  async requestRefresh(args, opts = {}) {
    if (!this.#ps) throw new Error("client not started");
    const next = this.#refreshChain.catch(() => void 0).then(() => this.#sendRefresh(args, opts));
    this.#refreshChain = next;
    return next;
  }
  async #sendRefresh(args, opts) {
    if (this.#closed) throw new Error("client_closed");
    if (!this.#ps) throw new Error("client not started");
    const clientMsgId = crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? 3e4;
    return await new Promise((resolve4, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error("credential_request_timeout"));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve: resolve4,
        reject,
        timer,
        // Carry the superseded id so the resolution path can prune it from
        // knownCredentials when the new credential is delivered.
        supersededProvider: args.provider,
        supersededScopedTokenId: args.superseded_scoped_token_id
      });
      this.#ps?.send(
        JSON.stringify({
          type: "credential_request",
          client_msg_id: clientMsgId,
          reason: args.reason,
          provider: args.provider,
          ...args.superseded_scoped_token_id ? {
            superseded_scoped_token_id: args.superseded_scoped_token_id
          } : {}
        })
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
  sendChannelReady(args) {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: "channel_ready",
          client_msg_id: crypto.randomUUID(),
          ...args.reason ? { reason: args.reason } : {},
          ...args.platform ? { platform: args.platform } : {},
          ...args.metadata ? { metadata: args.metadata } : {}
        })
      );
    } catch {
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
  sendLoginRelayUpdate(update) {
    if (this.#closed || !this.#ps) return;
    try {
      this.#ps.send(
        JSON.stringify({
          type: "login_relay_update",
          client_msg_id: crypto.randomUUID(),
          state: update.state,
          ...update.login_url ? { login_url: update.login_url } : {},
          ...update.message ? { message: update.message } : {}
        })
      );
    } catch {
    }
  }
  /** Close the socket and stop reconnecting. */
  close() {
    this.#closed = true;
    this.#stopHeartbeat();
    for (const [, p] of this.#pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("client_closed"));
    }
    this.#pendingRequests.clear();
    for (const [, t] of this.#rotationTimers) clearTimeout(t);
    this.#rotationTimers.clear();
    try {
      this.#ps?.close();
    } catch {
    }
    this.#ps = null;
  }
  // ── internals ────────────────────────────────────────────────────────────
  /** Injectable monotonic-enough clock. Defaults to wall time. */
  #now() {
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
  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#lastPongAt = this.#now();
    const intervalMs = this.opts.heartbeatIntervalMs ?? 25e3;
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? 1e4;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#closed || !this.#ps) return;
      if (this.#now() - this.#lastPongAt > intervalMs + timeoutMs) {
        this.#ps.reconnect();
        return;
      }
      try {
        this.#ps.send("ping");
      } catch {
      }
    }, intervalMs);
  }
  /** Stop the heartbeat timer (idempotent). */
  #stopHeartbeat() {
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
  async #writeChannelReadyMarker() {
    const markerPath = process.env.SPELLGUARD_CHANNEL_READY_MARKER;
    if (!markerPath) return;
    try {
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(markerPath, `${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf8");
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  async #buildQuery() {
    const creds = await this.opts.credentials();
    if (creds.mode === "secret") {
      return { agent_secret: creds.agentSecret };
    }
    if (creds.mode === "managed-bootstrap") {
      return { nonce: creds.nonce };
    }
    return {
      nonce: creds.nonce,
      ct: creds.channelToken,
      orgId: creds.orgId,
      ...creds.agentName ? { agent_name: creds.agentName } : {}
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
  async #buildProtocols() {
    const creds = await this.opts.credentials();
    if (creds.mode !== "secret") return null;
    return null;
  }
  async #onOpen() {
    if (!this.#ps) return;
    this.#lastPongAt = this.#now();
    this.#startHeartbeat();
    try {
      const r = this.opts.onConnect?.();
      if (r && typeof r.catch === "function") {
        r.catch((err) => {
          this.opts.onError?.(
            err instanceof Error ? err : new Error(String(err))
          );
        });
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    void this.#writeChannelReadyMarker();
    let creds;
    try {
      creds = await this.opts.credentials();
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (creds.mode === "managed-bootstrap") {
      this.#firstConnect = false;
      return;
    }
    const noStateYet = this.#lastServerSeq === "0" && this.#knownCredentials.length === 0;
    if (creds.mode === "nonce" && noStateYet && !creds.expectReBootstrap) {
      this.#firstConnect = false;
      if (!creds.agentName) {
        this.opts.onError?.(
          new Error(
            "agent-control: agent_name is required for bootstrap_request but was not provided by the credentials accessor. Ensure the caller passes agentName when starting in nonce mode."
          )
        );
        return;
      }
      this.#ps.send(
        JSON.stringify({
          type: "bootstrap_request",
          client_msg_id: crypto.randomUUID(),
          nonce: creds.nonce,
          agent_name: creds.agentName,
          ...creds.statementOfReason ? { statement_of_reason: creds.statementOfReason } : {},
          ...creds.framework ? { framework: creds.framework } : {}
        })
      );
      return;
    }
    this.#firstConnect = false;
  }
  /**
   * Send the Resume frame after Hello has been received and any
   * fresh-channel reset has been applied. Returns void; called from
   * `case 'hello'`.
   */
  #sendResumeIfApplicable() {
    if (!this.#ps) return;
    const noStateYet = this.#lastServerSeq === "0" && this.#knownCredentials.length === 0;
    if (noStateYet) return;
    this.#ps.send(
      JSON.stringify({
        type: "resume",
        client_msg_id: crypto.randomUUID(),
        last_server_seq: this.#lastServerSeq,
        known_credentials: this.#knownCredentials,
        capabilities: this.opts.capabilities
      })
    );
  }
  async #handleMessage(e) {
    const text = typeof e.data === "string" ? e.data : e.data.toString("utf-8");
    if (text === "pong") {
      this.#lastPongAt = this.#now();
      return;
    }
    const frame = parseServerFrame(text);
    if (frame === null) {
      this.opts.onError?.(
        new Error("agent-control: rejected malformed or unknown frame")
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
  async #dispatch(frame) {
    switch (frame.type) {
      case "hello": {
        const hasStaleState = this.#lastServerSeq !== "0" || this.#knownCredentials.length > 0;
        if (frame.is_fresh_channel && hasStaleState) {
          this.opts.onError?.(
            new Error(
              `agent-control: server signaled fresh channel; resetting cursor (was=${this.#lastServerSeq}, server=${frame.current_seq})`
            )
          );
          const preResetKnown = this.#knownCredentials;
          this.#lastServerSeq = "0";
          this.#knownCredentials = [];
          await this.opts.onSeqAdvanced("0");
          await this.opts.onKnownCredentialsChanged?.([]);
          if (this.#ps && preResetKnown.length > 0) {
            this.#ps.send(
              JSON.stringify({
                type: "resume",
                client_msg_id: crypto.randomUUID(),
                last_server_seq: "0",
                known_credentials: preResetKnown,
                capabilities: this.opts.capabilities
              })
            );
          }
          return;
        }
        this.#sendResumeIfApplicable();
        return;
      }
      case "credential_delivered": {
        const isBootstrapCause = frame.cause === "bootstrap" || frame.cause === "re_bootstrap";
        if (!isBootstrapCause && await this.#handleIfRedacted(
          frame.credentials,
          frame.seq,
          `credential_delivered{cause:'${frame.cause}'}`
        )) {
          return;
        }
        await this.opts.onCredentialDelivered(frame);
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        if (isBootstrapCause) {
          this.#queueRefreshForBareIssued(frame.credentials);
        }
        if (frame.cause === "refresh_response" || frame.cause === "admin_reissue") {
          for (const [id, p] of this.#pendingRequests) {
            clearTimeout(p.timer);
            if (p.supersededScopedTokenId) {
              this.#dropKnownCredential(
                p.supersededProvider,
                p.supersededScopedTokenId
              );
            }
            p.resolve(frame.credentials);
            this.#pendingRequests.delete(id);
            break;
          }
        }
        return;
      }
      case "credential_rotated": {
        for (const [seq, t] of this.#rotationTimers) {
          clearTimeout(t);
          this.#rotationTimers.delete(seq);
        }
        const superseded = frame.superseded_scoped_token_id;
        if (await this.#handleIfRedacted(
          frame.credentials,
          frame.seq,
          "credential_rotated",
          superseded
        )) {
          return;
        }
        await this.opts.onCredentialRotated?.(frame);
        if (superseded) {
          const supersededProvider = frame.credentials[0]?.provider;
          this.#dropKnownCredential(supersededProvider, superseded);
        }
        this.#trackKnownCredentials(frame.credentials);
        await this.#advanceSeq(frame.seq);
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          if (p.supersededScopedTokenId) {
            this.#dropKnownCredential(
              p.supersededProvider,
              p.supersededScopedTokenId
            );
          }
          p.resolve(frame.credentials);
          this.#pendingRequests.delete(id);
          break;
        }
        return;
      }
      case "credential_revoked": {
        await this.opts.onCredentialRevoked?.(frame);
        const beforeRevoke = this.#knownCredentials.length;
        this.#knownCredentials = this.#knownCredentials.filter(
          (k) => !(k.provider === frame.provider && k.scoped_token_id === frame.scoped_token_id)
        );
        if (this.#knownCredentials.length !== beforeRevoke) {
          await this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
        }
        await this.#advanceSeq(frame.seq);
        return;
      }
      case "config_updated": {
        await this.opts.onConfigUpdated?.(frame);
        await this.#advanceSeq(frame.seq);
        if (frame.triggers_rotation) {
          const seq = frame.seq;
          const rotationMs = this.opts.rotationFallbackTimeoutMs ?? 1e4;
          const timer = setTimeout(() => {
            this.#rotationTimers.delete(seq);
            const known = this.#knownCredentials.filter(
              (k) => k.provider === frame.config.provider
            );
            for (const k of known.length > 0 ? known : [void 0]) {
              void this.requestRefresh({
                reason: "manual",
                provider: frame.config.provider,
                superseded_scoped_token_id: k?.scoped_token_id
              }).catch((err) => {
                if (err instanceof Error && err.message === "client_closed")
                  return;
                this.opts.onError?.(
                  err instanceof Error ? err : new Error(String(err))
                );
              });
            }
          }, rotationMs);
          this.#rotationTimers.set(seq, timer);
        }
        return;
      }
      case "ack": {
        const pending = this.#pendingRequests.get(frame.client_msg_id);
        if (pending) {
          if (!frame.ok) {
            clearTimeout(pending.timer);
            pending.reject(
              new Error(
                `${frame.error_code ?? "unknown"}: ${frame.error_message ?? ""}`
              )
            );
            this.#pendingRequests.delete(frame.client_msg_id);
          }
        }
        await this.#advanceSeq(frame.seq);
        return;
      }
      case "error": {
        for (const [id, p] of this.#pendingRequests) {
          clearTimeout(p.timer);
          p.reject(new Error(`${frame.code}: ${frame.message}`));
          this.#pendingRequests.delete(id);
          break;
        }
        this.opts.onError?.(
          new Error(`server: ${frame.code}: ${frame.message}`)
        );
        await this.#advanceSeq(frame.seq);
        return;
      }
      case "resume_window_exceeded": {
        this.#lastServerSeq = frame.current_seq;
        this.#knownCredentials = [];
        await this.opts.onSeqAdvanced(frame.current_seq);
        await this.opts.onKnownCredentialsChanged?.([]);
        this.opts.onError?.(
          new Error(
            `agent-control: server signaled resume_window_exceeded; cursor fast-forwarded to seq=${frame.current_seq}; reconnecting`
          )
        );
        return;
      }
      case "login_code": {
        await this.opts.onLoginCode?.(frame);
        return;
      }
      case "login_restart": {
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
  async #handleIfRedacted(creds, seq, logLabel, supersededId) {
    const issuedCreds = creds.filter(
      (c) => {
        const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
        return effKind === "issued";
      }
    );
    if (!issuedCreds.some((c) => !c.scoped_token)) return false;
    await this.#advanceSeq(seq);
    const redactedNotice = `agent-control: redacted ${logLabel} \u2014 queuing credential_request to obtain fresh secret`;
    if (this.opts.onInfo) {
      this.opts.onInfo(redactedNotice);
    } else {
      this.opts.onError?.(new Error(redactedNotice));
    }
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
  #queueRefreshForBareIssued(creds, supersededId) {
    if (this.#closed || !this.#ps) return;
    for (const c of creds) {
      const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
      if (effKind !== "issued") continue;
      const issued = c;
      if (issued.scoped_token) continue;
      void this.requestRefresh({
        reason: "expiry",
        provider: issued.provider,
        superseded_scoped_token_id: supersededId ?? issued.scoped_token_id ?? issued.credential_id
      }).catch((err) => {
        if (err instanceof Error && (err.message === "client_closed" || err.message === "client not started")) {
          return;
        }
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err))
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
  #dropKnownCredential(provider, scopedTokenId) {
    const before = this.#knownCredentials.length;
    this.#knownCredentials = this.#knownCredentials.filter(
      (k) => !((provider === void 0 || k.provider === provider) && k.scoped_token_id === scopedTokenId)
    );
    if (this.#knownCredentials.length !== before) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }
  #trackKnownCredentials(creds) {
    const next = [...this.#knownCredentials];
    let changed = false;
    for (const c of creds) {
      const effKind = c.kind ?? (c.provider === "github" ? "issued" : c.kind);
      const trackingId = effKind === "issued" ? c.scoped_token_id ?? c.credential_id : c.credential_id;
      const idx = next.findIndex(
        (k) => k.provider === c.provider && k.scoped_token_id === trackingId
      );
      if (idx === -1) {
        next.push({ provider: c.provider, scoped_token_id: trackingId });
        changed = true;
      }
    }
    this.#knownCredentials = next;
    if (changed) {
      void this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
    }
  }
  async #advanceSeq(seq) {
    let nextN;
    let currentN;
    try {
      nextN = BigInt(seq);
      currentN = BigInt(this.#lastServerSeq);
    } catch {
      this.opts.onError?.(
        new Error(`agent-control: invalid seq value: ${String(seq)}`)
      );
      return;
    }
    if (nextN <= currentN) return;
    this.#lastServerSeq = seq;
    await this.opts.onSeqAdvanced(seq);
    try {
      this.#ps?.send(
        JSON.stringify({
          type: "ack",
          client_msg_id: crypto.randomUUID(),
          acked_seq: seq
        })
      );
    } catch {
    }
  }
};
function makeErrorSafeWebSocket(Base, headers) {
  function Wrapped(url, protocols) {
    const ws = headers ? (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols, options) signature (see above).
      new Base(url, protocols, { headers })
    ) : (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols) signature (see above).
      new Base(url, protocols)
    );
    if (ws && typeof ws.on === "function") {
      ws.on("error", () => {
      });
    }
    return ws;
  }
  Wrapped.prototype = Base.prototype;
  return Wrapped;
}
var AGENT_GONE_HTTP_STATUSES = [401, 403, 404, 410];
function isAgentGoneStatus(httpStatus) {
  return httpStatus !== void 0 && AGENT_GONE_HTTP_STATUSES.includes(httpStatus);
}
var USER_AGENT = "spellguard-plugin/0.1.0";
function createManagementClient(opts) {
  const baseFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelay = opts.retryDelayMs ?? 1e3;
  const retryOn5xx = opts.retry ?? true;
  const retryingFetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!retryOn5xx) return baseFetch(req);
    const first = await baseFetch(req.clone());
    if (first.status >= 500) {
      await new Promise((resolve4) => setTimeout(resolve4, retryDelay));
      return baseFetch(req);
    }
    return first;
  };
  const auth = {
    onRequest({ request }) {
      if ((opts.auth ?? "agent-secret") === "bearer") {
        request.headers.set("Authorization", `Bearer ${opts.agentSecret}`);
      } else {
        request.headers.set("X-Spellguard-Agent-Id", opts.agentId);
        request.headers.set("X-Spellguard-Agent-Secret", opts.agentSecret);
      }
      request.headers.set("User-Agent", USER_AGENT);
      return request;
    }
  };
  const client = createClient({
    // Strip a trailing slash AND a trailing `/v1` before appending `/v1`, so a
    // baseUrl of either `https://host` or `https://host/v1` (OpenClaw's docker
    // default carries `/v1`) yields a single `/v1`, never `/v1/v1`.
    baseUrl: `${opts.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`,
    fetch: retryingFetch
  });
  client.use(auth);
  return client;
}

// src/lib/config-store.ts
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname as dirname2, join } from "node:path";

// src/lib/framework-slug.ts
var FRAMEWORK_SLUG = "claude-code";

// src/lib/config-store.ts
function spellguardRootDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "spellguard") : join(homedir(), ".config", "spellguard");
}
function legacyConfigDir() {
  return spellguardRootDir();
}
function defaultConfigDir() {
  return join(spellguardRootDir(), FRAMEWORK_SLUG);
}
function defaultConfigPath() {
  return join(defaultConfigDir(), "config.json");
}
function gitTokensPath(dir = defaultConfigDir()) {
  return join(dir, "git-tokens");
}
function writeGitTokensFile(config, dir = defaultConfigDir()) {
  const path = gitTokensPath(dir);
  const lines = [];
  let wildcardToken;
  let usableCount = 0;
  let keyedTotal = 0;
  const keyed = config.githubCredentials;
  if (keyed && Object.keys(keyed).length > 0) {
    keyedTotal = Object.keys(keyed).length;
    for (const [org, entry] of Object.entries(keyed)) {
      if (entry.revoked) continue;
      if (!entry.scopedToken) continue;
      lines.push(`${org}	${entry.scopedToken}`);
      usableCount++;
      if (wildcardToken === void 0) wildcardToken = entry.scopedToken;
    }
  } else if (!config.revoked && config.scopedToken) {
    wildcardToken = config.scopedToken;
    usableCount = 1;
  }
  if (wildcardToken !== void 0 && usableCount === 1 && keyedTotal <= 1) {
    lines.push(`*	${wildcardToken}`);
  }
  if (lines.length === 0) {
    if (existsSync(path)) rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const content = `${lines.join("\n")}
`;
  const tmpPath = `${path}.tmp`;
  if (platform() !== "win32") {
    const fd = openSync(tmpPath, "w", 384);
    try {
      writeSync(fd, content, 0, "utf-8");
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmpPath, content, "utf-8");
  }
  renameSync(tmpPath, path);
}
function mistypedGithubField(parsed) {
  if (parsed.scopedToken !== void 0 && typeof parsed.scopedToken !== "string")
    return "scopedToken";
  if (parsed.scopedTokenId !== void 0 && typeof parsed.scopedTokenId !== "string")
    return "scopedTokenId";
  if (parsed.expiresAt !== void 0 && typeof parsed.expiresAt !== "string")
    return "expiresAt";
  if (parsed.revokedMessage !== void 0 && typeof parsed.revokedMessage !== "string")
    return "revokedMessage";
  return null;
}
function readConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return { config: null, reason: "missing" };
  if (platform() !== "win32") {
    try {
      const stat = statSync(path);
      const mode = stat.mode & 511;
      if (mode !== 384) return { config: null, reason: "wrong_permissions" };
    } catch {
      return { config: null, reason: "missing" };
    }
  }
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { config: null, reason: "missing" };
  }
  if (raw.trim() === "") {
    return { config: null, reason: "missing" };
  }
  try {
    const parsed = JSON.parse(raw);
    for (const field of [
      "agentSecret",
      "agentId",
      "spellguardBaseUrl"
    ]) {
      if (typeof parsed[field] !== "string") {
        return { config: null, reason: "malformed", malformedField: field };
      }
    }
    const mistyped = mistypedGithubField(parsed);
    if (mistyped) {
      return { config: null, reason: "malformed", malformedField: mistyped };
    }
    if (parsed.knownCredentials !== void 0) {
      if (!Array.isArray(parsed.knownCredentials) || !parsed.knownCredentials.every(
        (k) => k != null && typeof k.provider === "string" && typeof k.scoped_token_id === "string"
      )) {
        return {
          config: null,
          reason: "malformed",
          malformedField: "knownCredentials"
        };
      }
    }
    if (parsed.githubCredentials !== void 0) {
      const map = parsed.githubCredentials;
      if (map == null || typeof map !== "object" || Array.isArray(map) || !Object.values(map).every(
        (e) => e != null && typeof e === "object" && typeof e.scopedTokenId === "string" && typeof e.expiresAt === "string" && (e.scopedToken === void 0 || typeof e.scopedToken === "string")
      )) {
        return { config: null, reason: "malformed" };
      }
    }
    return { config: parsed };
  } catch {
    return { config: null, reason: "malformed", malformedField: "json" };
  }
}
function writeConfig(config, path = defaultConfigPath()) {
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const content = JSON.stringify(config, null, 2);
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
      if (platform() !== "win32") chmodSync(`${path}.bak`, 384);
    } catch {
    }
  }
  const tmpPath = `${path}.tmp`;
  if (platform() !== "win32") {
    const fd = openSync(tmpPath, "w", 384);
    try {
      writeSync(fd, content, 0, "utf-8");
    } finally {
      closeSync(fd);
    }
  } else {
    writeFileSync(tmpPath, content, "utf-8");
  }
  renameSync(tmpPath, path);
  writeGitTokensFile(config, dirname2(path));
}
function markConfigRevoked(path = defaultConfigPath()) {
  const result = readConfig(path);
  if (result.config) {
    writeConfig({ ...result.config, revoked: true }, path);
  }
}

// src/lib/daemon-spawn.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, join as join2, sep } from "node:path";
import { fileURLToPath } from "node:url";
function daemonScriptPath() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const devPath = join2(
    here,
    "..",
    "..",
    "bin",
    "spellguard-credential-daemon.ts"
  );
  const builtPath = join2(here, "spellguard-credential-daemon.mjs");
  const runningFromDist = here.endsWith(`${sep}dist${sep}bin`) || here.endsWith("/dist/bin");
  if (runningFromDist && existsSync2(builtPath)) return builtPath;
  if (existsSync2(devPath)) return devPath;
  return builtPath;
}
function readDaemonPid(pidPath) {
  if (!existsSync2(pidPath)) return null;
  try {
    const raw = readFileSync2(pidPath, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function isDaemonAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function ensureCredentialDaemonRunning(args) {
  const { config, cwd } = args;
  if (!config.agentSecret || !config.agentId) {
    return { daemon: "skipped", reason: "missing_credentials" };
  }
  const configDir = args.configDir ?? defaultConfigDir();
  const pidDir = join2(configDir, "agents");
  const pidPath = join2(pidDir, `${config.agentId}.pid`);
  const existingPid = readDaemonPid(pidPath);
  if (existingPid !== null && isDaemonAlive(existingPid)) {
    return { daemon: "already-running", pid: existingPid };
  }
  const scriptPath = daemonScriptPath();
  const spawnFn = args.spawnDaemon ?? defaultSpawnDaemon;
  spawnFn(process.execPath, [scriptPath, config.agentId, "--cwd", cwd], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // Forward CLAUDE_ENV_FILE only when the caller has one (hook context).
      // The daemon logs + skips env-file updates when it is absent.
      ...args.envFilePath ? { CLAUDE_ENV_FILE: args.envFilePath } : {}
    }
  });
  return { daemon: "spawned" };
}
function defaultSpawnDaemon(execPath, args, opts) {
  const child = spawn(execPath, args, opts);
  child.unref();
}

// src/lib/env-file-writer.ts
import {
  appendFileSync,
  chmodSync as chmodSync2,
  copyFileSync as copyFileSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname4, join as join3, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/lib/git-insteadof-rules.ts
var SSH_TO_HTTPS_INSTEADOF = [
  { key: "url.https://github.com/.insteadOf", value: "git@github.com:" },
  { key: "url.https://github.com/.insteadOf", value: "ssh://git@github.com/" }
];
function repoIdentityInsteadOf(repo) {
  const base = `https://github.com/${repo.owner}/${repo.repo}`;
  return [
    { key: `url.${base}.insteadOf`, value: base },
    { key: `url.${base}.pushInsteadOf`, value: base }
  ];
}
function sshRewriteEntries(repo) {
  const entries = [...SSH_TO_HTTPS_INSTEADOF];
  if (repo) entries.push(...repoIdentityInsteadOf(repo));
  return entries;
}
function isSshRewriteEnabled(env = process.env) {
  const raw = env.SPELLGUARD_SSH_REWRITE;
  if (raw === void 0 || raw.trim() === "") return true;
  return !/^(0|off|false|no)$/i.test(raw.trim());
}
function insteadOfGitConfigEnv(repo) {
  const entries = sshRewriteEntries(repo);
  const env = {
    GIT_CONFIG_COUNT: String(entries.length)
  };
  entries.forEach((entry, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = entry.key;
    env[`GIT_CONFIG_VALUE_${i}`] = entry.value;
  });
  return env;
}

// src/lib/env-file-writer.ts
var HERE = dirname4(fileURLToPath2(import.meta.url));
function bundledHelperPath() {
  return resolve(HERE, "..", "..", "bin", "spellguard-git-helper");
}
function ensureStableHelper(configDir) {
  const bundled = bundledHelperPath();
  try {
    const dest = join3(configDir, "bin", "spellguard-git-helper");
    mkdirSync2(dirname4(dest), { recursive: true });
    copyFileSync2(bundled, dest);
    chmodSync2(dest, 493);
    return dest;
  } catch {
    return bundled;
  }
}
function bashQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function writeGitConfigEnv(spec) {
  if (!spec.envFilePath) return;
  const helper = spec.helperPath ?? bundledHelperPath();
  const hasAuthor = typeof spec.gitAuthorName === "string" && spec.gitAuthorName.length > 0 && typeof spec.gitAuthorEmail === "string" && spec.gitAuthorEmail.length > 0;
  const sshRewrite = spec.sshRewrite ?? isSshRewriteEnabled();
  const lines = [
    "export GIT_CONFIG_KEY_0=credential.helper",
    "export GIT_CONFIG_VALUE_0=''",
    // disables any inherited generic helper
    "export GIT_CONFIG_KEY_1=credential.helper",
    `export GIT_CONFIG_VALUE_1=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_2=credential.https://github.com.helper",
    "export GIT_CONFIG_VALUE_2=''",
    // disables gh / other URL-specific helpers
    "export GIT_CONFIG_KEY_3=credential.https://github.com.helper",
    `export GIT_CONFIG_VALUE_3=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_4=credential.https://gist.github.com.helper",
    "export GIT_CONFIG_VALUE_4=''",
    "export GIT_CONFIG_KEY_5=credential.https://gist.github.com.helper",
    `export GIT_CONFIG_VALUE_5=${bashQuote(helper)}`,
    "export GIT_CONFIG_KEY_6=credential.https://github.com.useHttpPath",
    "export GIT_CONFIG_VALUE_6=true"
  ];
  let idx = 7;
  if (sshRewrite) {
    for (const rule of sshRewriteEntries(spec.sshRewriteRepo)) {
      lines.push(
        `export GIT_CONFIG_KEY_${idx}=${rule.key}`,
        `export GIT_CONFIG_VALUE_${idx}=${bashQuote(rule.value)}`
      );
      idx++;
    }
  }
  if (hasAuthor) {
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.name`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorName)}`
    );
    idx++;
    lines.push(
      `export GIT_CONFIG_KEY_${idx}=user.email`,
      `export GIT_CONFIG_VALUE_${idx}=${bashQuote(spec.gitAuthorEmail)}`
    );
    idx++;
  }
  lines.unshift(`export GIT_CONFIG_COUNT=${idx}`);
  if (spec.ghConfigDir) {
    lines.push(`export GH_CONFIG_DIR=${bashQuote(spec.ghConfigDir)}`);
  }
  if (existsSync3(spec.envFilePath)) {
    appendFileSync(spec.envFilePath, `
${lines.join("\n")}
`, "utf-8");
  } else {
    writeFileSync2(spec.envFilePath, `${lines.join("\n")}
`, "utf-8");
  }
}
function clearGitConfigEnv(envFilePath) {
  if (!envFilePath) return;
  writeFileSync2(envFilePath, "export GIT_CONFIG_COUNT=0\n", "utf-8");
}

// src/lib/gh-config-dir.ts
import { join as join4 } from "node:path";
function ghConfigDirPath(configDir, agentId) {
  return join4(configDir, "gh", agentId);
}

// src/lib/git-version-check.ts
import { execFileSync } from "node:child_process";
function parseGitVersion(stdout) {
  const m = stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
function isGitVersionSupported(v) {
  if (v.major > 2) return true;
  if (v.major < 2) return false;
  return v.minor >= 31;
}
function detectGitVersion() {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf-8" });
    return parseGitVersion(out);
  } catch {
    return null;
  }
}

// src/lib/migrate-legacy-config.ts
import {
  copyFileSync as copyFileSync3,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import { join as join6 } from "node:path";

// src/lib/stop-daemons.ts
import { readFileSync as readFileSync3, readdirSync, unlinkSync } from "node:fs";
import { join as join5 } from "node:path";
function stopLocalDaemons(opts) {
  const dir = join5(opts?.configDir ?? defaultConfigDir(), "agents");
  const kill = opts?.killImpl ?? process.kill.bind(process);
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return [];
  }
  const stopped = [];
  for (const f of entries) {
    const p = join5(dir, f);
    let pid;
    try {
      pid = Number.parseInt(readFileSync3(p, "utf8").trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
    }
    try {
      unlinkSync(p);
    } catch {
    }
  }
  return stopped;
}

// src/lib/migrate-legacy-config.ts
function moveFile(src, dst) {
  if (!existsSync4(src)) return false;
  try {
    renameSync2(src, dst);
    return true;
  } catch {
    try {
      copyFileSync3(src, dst);
      rmSync2(src, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
function migrateLegacyConfig(opts = {}) {
  const legacyDir = opts.legacyDir ?? legacyConfigDir();
  const frameworkDir = opts.frameworkDir ?? defaultConfigDir();
  const marker = join6(legacyDir, ".migrated");
  if (existsSync4(marker))
    return { migrated: false, reason: "already-migrated" };
  const legacyConfig = join6(legacyDir, "config.json");
  if (!existsSync4(legacyConfig)) {
    return { migrated: false, reason: "no-legacy-config" };
  }
  const frameworkConfig = join6(frameworkDir, "config.json");
  if (existsSync4(frameworkConfig)) {
    return { migrated: false, reason: "framework-already-configured" };
  }
  const stop = opts.stopLegacyDaemons ?? ((dir) => stopLocalDaemons({ configDir: dir }));
  try {
    stop(legacyDir);
  } catch {
  }
  mkdirSync3(frameworkDir, { recursive: true, mode: 448 });
  if (!moveFile(legacyConfig, frameworkConfig)) {
    return { migrated: false, reason: "move-failed" };
  }
  moveFile(join6(legacyDir, "git-tokens"), join6(frameworkDir, "git-tokens"));
  const legacyAgents = join6(legacyDir, "agents");
  if (existsSync4(legacyAgents)) {
    try {
      renameSync2(legacyAgents, join6(frameworkDir, "agents"));
    } catch {
    }
  }
  writeFileSync3(
    marker,
    "spellguard: legacy single-slot config migrated into a per-framework dir\n",
    { mode: 384 }
  );
  return { migrated: true, reason: "migrated" };
}

// src/lib/platform-check.ts
function isPlatformSupported(info) {
  if (info.platform === "darwin") return { ok: true };
  if (info.platform === "linux") return { ok: true };
  if (info.platform === "win32") {
    return {
      ok: false,
      message: "Spellguard: Native Windows is not supported in MVP; please use WSL (Windows Subsystem for Linux)."
    };
  }
  return {
    ok: false,
    message: `Spellguard: unsupported platform "${info.platform}"; supported platforms are macOS, Linux, and WSL.`
  };
}

// src/lib/plugin-sync.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname5, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var FRAMEWORK = "claude_code";
var TIMEOUT_MS = 5e3;
function readPluginVersion() {
  try {
    const here = dirname5(fileURLToPath3(import.meta.url));
    const pkg = JSON.parse(
      readFileSync4(resolve2(here, "..", "..", "package.json"), "utf8")
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}
async function syncFrameworkIdentity(options) {
  const base = options.managementUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const api = createManagementClient({
      baseUrl: base,
      agentId: options.agentId,
      agentSecret: options.agentSecret,
      // The plugin-sync route is authed with Authorization: Bearer
      // (requireAgentBearer), not the X-Spellguard-Agent-* headers.
      auth: "bearer",
      fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal })
    });
    const { error, response } = await api.POST("/agents/{id}/plugin-sync", {
      params: { path: { id: options.agentId } },
      body: {
        framework: FRAMEWORK,
        pluginVersion: readPluginVersion()
      }
    });
    if (error) {
      console.error(
        JSON.stringify({
          event: "plugin_sync.failed",
          status: response.status,
          agentId: options.agentId
        })
      );
      return;
    }
    console.log(
      JSON.stringify({
        event: "plugin_sync.ok",
        agentId: options.agentId
      })
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "plugin_sync.failed",
        error: err.message,
        agentId: options.agentId
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

// src/lib/render-message.ts
var __renderedForTest = [];
function formatRenderLine(input) {
  const prefix = input.level === "error" ? "[spellguard error]" : input.level === "warn" ? "[spellguard warn]" : "[spellguard]";
  return input.detail ? `${prefix} ${input.message} \u2014 ${input.detail}` : `${prefix} ${input.message}`;
}
function renderMessage(input) {
  __renderedForTest.push(input);
  process.stderr.write(`${formatRenderLine(input)}
`);
}

// src/lib/session-env-identity-heal.ts
import { readFileSync as readFileSync5, readdirSync as readdirSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname6, join as join7 } from "node:path";
function bashQuote2(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function healOneCapture(file, name, email) {
  let content;
  try {
    content = readFileSync5(file, "utf-8");
  } catch {
    return;
  }
  if (!/^export GIT_CONFIG_KEY_\d+=user\.name$/m.test(content)) return;
  const healed = content.replace(
    /^(export GIT_CONFIG_KEY_(\d+)=user\.name\nexport GIT_CONFIG_VALUE_\2=).*$/gm,
    (_m, prefix) => `${prefix}${bashQuote2(name)}`
  ).replace(
    /^(export GIT_CONFIG_KEY_(\d+)=user\.email\nexport GIT_CONFIG_VALUE_\2=).*$/gm,
    (_m, prefix) => `${prefix}${bashQuote2(email)}`
  );
  if (healed === content) return;
  try {
    writeFileSync4(file, healed, "utf-8");
  } catch {
  }
}
function healSessionEnvIdentity(envFilePath, gitAuthorName, gitAuthorEmail) {
  if (!envFilePath || !gitAuthorName || !gitAuthorEmail) return;
  try {
    const dir = dirname6(envFilePath);
    for (const entry of readdirSync2(dir)) {
      if (/^sessionstart-hook-.*\.sh$/.test(entry)) {
        healOneCapture(join7(dir, entry), gitAuthorName, gitAuthorEmail);
      }
    }
  } catch {
  }
}

// src/lib/ssh-remote-detect.ts
import { execFileSync as execFileSync2 } from "node:child_process";

// src/lib/git-remote-canonicalizer.ts
var GITHUB_HOST_ALIASES = /* @__PURE__ */ new Set(["github.com", "ssh.github.com"]);
function canonicalizeGitRemote(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const sshShortMatch = trimmed.match(
    /^git@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (sshShortMatch) {
    const host2 = sshShortMatch[1].toLowerCase();
    if (!GITHUB_HOST_ALIASES.has(host2)) return null;
    return {
      host: "github.com",
      owner: sshShortMatch[2].toLowerCase(),
      repo: sshShortMatch[3].toLowerCase(),
      isSsh: true
    };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!GITHUB_HOST_ALIASES.has(host)) return null;
  const isSsh = url.protocol === "ssh:";
  if (!isSsh && url.protocol !== "https:" && url.protocol !== "http:")
    return null;
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  if (segments.length < 2) return null;
  const [owner, repoRaw] = segments;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/i, "");
  return {
    host: "github.com",
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    isSsh
  };
}

// src/lib/ssh-remote-parse.ts
var SCP_RE = /^[\w.-]+@([\w.-]+):([^/]+)\/([^/]+?)(?:\.git)?$/;
var SSH_URL_RE = /^ssh:\/\/[\w.-]+@([\w.-]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/;
function parseSshRemote(remote) {
  if (typeof remote !== "string" || remote.length === 0) return null;
  const trimmed = remote.trim();
  let m = SCP_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  m = SSH_URL_RE.exec(trimmed);
  if (m) {
    const [, , owner, repo] = m;
    if (owner && repo) return { owner, repo };
  }
  return null;
}

// src/lib/ssh-remote-detect.ts
function detectSshRemoteFromOutput(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^\S+\s+(\S+)\s+\(/);
    if (!match) continue;
    const url = match[1];
    const canon = canonicalizeGitRemote(url);
    if (canon?.isSsh) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
    if (/^git@[\w.-]+:/.test(url) || url.startsWith("ssh://")) {
      return { hasSsh: true, sshRemoteUrl: url };
    }
  }
  return { hasSsh: false };
}
function detectSshRemote(cwd) {
  try {
    const out = execFileSync2("git", ["remote", "-v"], {
      encoding: "utf-8",
      cwd
    });
    return detectSshRemoteFromOutput(out);
  } catch {
    return { hasSsh: false };
  }
}
function detectSshRemoteAfterRewrite(cwd, repo) {
  try {
    const out = execFileSync2("git", ["remote", "-v"], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, ...insteadOfGitConfigEnv(repo) }
    });
    return detectSshRemoteFromOutput(out);
  } catch {
    return { hasSsh: true };
  }
}
function repoIdentityFromSshDetection(result) {
  if (!result.hasSsh || !result.sshRemoteUrl) return void 0;
  const parsed = parseSshRemote(result.sshRemoteUrl);
  return parsed ? { owner: parsed.owner, repo: parsed.repo } : void 0;
}

// src/hooks/session-start.ts
async function runSessionStart(deps = {}) {
  const platformInfo = deps.platformInfo ?? {
    platform: process.platform,
    release: (await import("node:os")).release()
  };
  const platformOk = isPlatformSupported(platformInfo);
  if (!platformOk.ok) {
    renderMessage({
      level: "error",
      message: platformOk.message ?? "Spellguard: unsupported platform."
    });
    return { ok: false, reason: "platform_unsupported" };
  }
  const gitVersion = deps.gitVersion === void 0 ? detectGitVersion() : deps.gitVersion;
  if (!gitVersion) {
    renderMessage({
      level: "error",
      message: "Spellguard: git is not installed or not on PATH."
    });
    return { ok: false, reason: "git_missing" };
  }
  if (!isGitVersionSupported(gitVersion)) {
    renderMessage({
      level: "error",
      message: `Spellguard requires git 2.31 or later (current: ${gitVersion.major}.${gitVersion.minor}.${gitVersion.patch}).`
    });
    return { ok: false, reason: "git_version_too_old" };
  }
  if (!deps.readConfigImpl) migrateLegacyConfig();
  const readResult = (deps.readConfigImpl ?? readConfig)();
  if (!readResult.config) {
    if (readResult.reason === "malformed") {
      renderMessage({
        level: "error",
        message: `Spellguard: config file exists but is malformed (failing field: ${readResult.malformedField ?? "unknown"}). A .bak snapshot sits next to ~/.config/spellguard/config.json \u2014 inspect/restore it, or delete the file and re-run \`/spellguard-setup\`.`
      });
      return { ok: false, reason: "malformed" };
    }
    renderMessage({
      level: "info",
      message: "Spellguard not configured \u2014 run `/spellguard-setup` to provision a credential."
    });
    return { ok: false, reason: readResult.reason ?? "missing" };
  }
  if (readResult.config.agentId && readResult.config.spellguardBaseUrl && readResult.config.agentSecret) {
    void syncFrameworkIdentity({
      agentId: readResult.config.agentId,
      managementUrl: readResult.config.spellguardBaseUrl,
      agentSecret: readResult.config.agentSecret
    });
  }
  const cwd = deps.cwd ?? process.cwd();
  const sshDetectFn = deps.sshDetect ?? detectSshRemote;
  const sshResult = sshDetectFn(cwd);
  let sshRewriteRepo;
  if (sshResult.hasSsh) {
    const repoIdentity = repoIdentityFromSshDetection(sshResult);
    const rewriteEnabled = isSshRewriteEnabled();
    const afterRewrite = rewriteEnabled ? (deps.sshDetectAfterRewrite ?? detectSshRemoteAfterRewrite)(
      cwd,
      repoIdentity
    ) : sshResult;
    if (!rewriteEnabled || afterRewrite.hasSsh) {
      const httpsTarget = repoIdentity ? `https://github.com/${repoIdentity.owner}/${repoIdentity.repo}.git` : "https://github.com/<owner>/<repo>.git";
      const why = !rewriteEnabled ? "SSH remote detected" : "SSH remote still resolves to SSH after the automatic HTTPS rewrite (a same-specificity force-SSH rule or an SSH host alias is overriding it)";
      renderMessage({
        level: "error",
        message: `Spellguard requires HTTPS git remotes. ${why} (${sshResult.sshRemoteUrl ?? "unknown"}). Run \`git remote set-url origin ${httpsTarget}\` to switch.`
      });
      return { ok: false, reason: "ssh_remote" };
    }
    sshRewriteRepo = repoIdentity;
    renderMessage({
      level: "info",
      message: `Spellguard: SSH GitHub remote detected (${sshResult.sshRemoteUrl ?? "unknown"}); transparently rewriting it to HTTPS for this session so the Spellguard credential is used. Your stored git remote is unchanged.`
    });
  }
  const envFilePath = deps.claudeEnvFile ?? process.env.CLAUDE_ENV_FILE;
  if (!envFilePath) {
    renderMessage({
      level: "error",
      message: "Spellguard: CLAUDE_ENV_FILE environment variable not set; cannot inject git credential helper."
    });
    return { ok: false, reason: "no_claude_env_file" };
  }
  const configDir = deps.configDir ?? defaultConfigDir();
  const ghConfigDir = ghConfigDirPath(configDir, readResult.config.agentId);
  const writeEnvFile = () => {
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else {
      writeGitConfigEnv({
        envFilePath,
        gitAuthorName: readResult.config?.gitAuthorName,
        gitAuthorEmail: readResult.config?.gitAuthorEmail,
        ghConfigDir,
        helperPath: ensureStableHelper(configDir),
        sshRewriteRepo
      });
    }
  };
  writeEnvFile();
  if (readResult.config.revoked) {
    renderMessage({
      level: "error",
      message: readResult.config.revokedMessage ? `Spellguard: ${readResult.config.revokedMessage}` : "Spellguard: this credential has been revoked. Run `/spellguard-setup` to provision a new one."
    });
    return { ok: false, reason: "revoked" };
  }
  if (!readResult.config.scopedTokenId || !readResult.config.scopedToken || !readResult.config.expiresAt || !readResult.config.scopeSummary) {
    const daemonResult2 = ensureCredentialDaemonRunning({
      config: readResult.config,
      cwd,
      envFilePath,
      spawnDaemon: deps.spawnDaemon,
      configDir: deps.configDir
    });
    renderMessage({
      level: "info",
      message: "Spellguard: agent identity present; GitHub not yet connected. Open your Spellguard dashboard and complete the GitHub App install on this agent \u2014 the credential daemon will pick up the token over the channel and update your local config automatically. Git operations remain unprotected until the credential lands."
    });
    return { ok: true, daemonResult: daemonResult2, reason: "identity_only" };
  }
  const initialConfig = readResult.config;
  const scopedTokenId = initialConfig.scopedTokenId;
  const baseUrl = readResult.config.spellguardBaseUrl;
  const agentId = readResult.config.agentId;
  const agentSecret = readResult.config.agentSecret;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const scopedTokenForProbe = readResult.config.scopedToken;
  const api = createManagementClient({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl
  });
  const { data, error, response } = await api.GET(
    "/credentials/github/status",
    {
      params: { query: { scoped_token_id: scopedTokenId } },
      headers: scopedTokenForProbe ? { "X-Spellguard-Scoped-Token": scopedTokenForProbe } : void 0
    }
  );
  if (error) {
    const httpStatus = response?.status;
    const needsReconnect = isAgentGoneStatus(httpStatus);
    renderMessage({
      level: "error",
      message: needsReconnect ? `Spellguard: your agent is no longer recognized by the server (HTTP ${httpStatus}). This usually means the credential was revoked or the Spellguard environment was reset. Run \`/spellguard-setup\` to reconnect this agent.` : `Spellguard: could not verify your credential with the server (${error.error?.code ?? error.error?.message ?? "unknown error"}). This is usually transient \u2014 check your connection and restart the session. If it persists, run \`/spellguard-setup\`.`
      // openapi-fetch error envelope: { error: { code, message } }
    });
    return { ok: false, reason: "status_failed" };
  }
  const status = data.status;
  if (status === "revoked") {
    (deps.markConfigRevokedImpl ?? markConfigRevoked)();
    renderMessage({
      level: "error",
      message: "Spellguard: this credential has been revoked. Run `/spellguard-setup` to provision a new one."
    });
    return { ok: false, reason: "revoked" };
  }
  if (status === "superseded") {
    renderMessage({
      level: "info",
      message: "Spellguard: your GitHub credential was rotated; fetching the new token over the credential channel."
    });
  }
  let activeConfig = initialConfig;
  if (status === "near_expiry") {
    renderMessage({
      level: "info",
      message: "Spellguard: credential approaching expiry; daemon will refresh in background."
    });
  }
  const daemonResult = ensureCredentialDaemonRunning({
    config: activeConfig,
    cwd,
    envFilePath,
    spawnDaemon: deps.spawnDaemon,
    configDir: deps.configDir
  });
  if (status === "expired") {
    const pollFn = deps.pollForFreshCredential ?? defaultPollForFreshCredential;
    const fresh = await pollFn(activeConfig.expiresAt, 5e3);
    if (!fresh) {
      renderMessage({
        level: "error",
        message: "Spellguard: credential has expired and the daemon could not obtain a fresh one within 5 s. Check your network connection and try again."
      });
      return { ok: false, reason: "expired_no_refresh", daemonResult };
    }
    activeConfig = fresh;
  }
  if (deps.writeEnvFileImpl) {
    deps.writeEnvFileImpl();
  } else {
    writeGitConfigEnv({
      envFilePath,
      gitAuthorName: activeConfig.gitAuthorName,
      gitAuthorEmail: activeConfig.gitAuthorEmail,
      ghConfigDir,
      helperPath: ensureStableHelper(configDir),
      sshRewriteRepo
    });
    healSessionEnvIdentity(
      envFilePath,
      activeConfig.gitAuthorName,
      activeConfig.gitAuthorEmail
    );
  }
  const minutesLeft = Math.max(
    0,
    Math.floor(
      (new Date(activeConfig.expiresAt).getTime() - Date.now()) / 6e4
    )
  );
  renderMessage({
    level: "info",
    message: `Spellguard: agent credentials injected \u2014 agent=${activeConfig.agentId}, repos=${activeConfig.scopeSummary.repos.length}, expires in ${minutesLeft} minutes`
  });
  return { ok: true, daemonResult };
}
async function defaultPollForFreshCredential(initialExpiresAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const initialTs = new Date(initialExpiresAt).getTime();
  const delay = (ms) => new Promise((resolve4) => setTimeout(resolve4, ms));
  while (Date.now() < deadline) {
    await delay(500);
    const result = readConfig();
    if (result.config?.expiresAt && new Date(result.config.expiresAt).getTime() > initialTs) {
      return result.config;
    }
  }
  return null;
}

// src/hooks/pre-tool-use-observation.ts
import { homedir as homedir3 } from "node:os";
import { join as join10 } from "node:path";

// src/lib/bash-command-timing.ts
import {
  chmodSync as chmodSync3,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync6,
  readdirSync as readdirSync3,
  rmSync as rmSync3,
  statSync as statSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { join as join8 } from "node:path";
var TIMING_SUBDIR = "bash-timing";
var STALE_MS = 60 * 60 * 1e3;
function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200) || "nokey";
}
function timingDir(rootDir) {
  return join8(rootDir, TIMING_SUBDIR);
}
function markBashCommandStart(input) {
  try {
    const dir = timingDir(input.rootDir);
    mkdirSync4(dir, { recursive: true });
    try {
      chmodSync3(dir, 448);
    } catch {
    }
    writeFileSync5(join8(dir, `${safeKey(input.key)}.txt`), String(input.nowMs), {
      mode: 384
    });
  } catch {
  }
}

// src/lib/git-command-parser.ts
var SEGMENT_RE = /&&|\|\||;|\|/g;
var PUSH_RE = /^git\s+push(?:\s|$)/;
var CHECKOUT_NEW_BRANCH_RE = /^git\s+checkout\s+-[bB]\s+\S/;
var SWITCH_NEW_BRANCH_RE = /^git\s+switch\s+-[bBc]\s+\S/;
var COMMIT_RE = /^git\s+commit(?:\s|$)/;
var COMMIT_HELP_RE = /(?:^|\s)(--help|-h)(?:\s|$)/;
function detectGitOp(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  const segments = cmd.split(SEGMENT_RE);
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) continue;
    if (PUSH_RE.test(segment)) return "push";
    if (CHECKOUT_NEW_BRANCH_RE.test(segment)) return "checkout_new_branch";
    if (SWITCH_NEW_BRANCH_RE.test(segment)) return "switch_new_branch";
    if (COMMIT_RE.test(segment) && !COMMIT_HELP_RE.test(segment))
      return "commit";
  }
  return null;
}
var OPT_VAL = `(?:[^\\s'"]|'[^']*'|"[^"]*")+`;
var GIT_GLOBAL_OPT_RE = new RegExp(
  `^(?:-C\\s+${OPT_VAL}|--git-dir(?:=${OPT_VAL}|\\s+${OPT_VAL})|--work-tree(?:=${OPT_VAL}|\\s+${OPT_VAL})|--namespace(?:=${OPT_VAL}|\\s+${OPT_VAL})|-c\\s+${OPT_VAL}|--no-pager|--paginate|-p|--bare)\\s+`
);

// src/lib/observation-emitter.ts
import { randomUUID } from "node:crypto";
var WHITELIST_FIELDS = [
  "event_uuid",
  "agent_id",
  "scoped_token_id",
  "operation_type",
  "target",
  "timestamp",
  "client_session_id"
];
var WHITELIST_TARGET_FIELDS = [
  "owner",
  "repo",
  "branch",
  "head_sha",
  "pr_number",
  "commits_count",
  "commit_message"
];
function buildObservationEvent(input) {
  if (typeof input.target.owner !== "string" || input.target.owner.length === 0) {
    throw new Error(
      "buildObservationEvent: target.owner must be a non-empty string"
    );
  }
  if (typeof input.target.repo !== "string" || input.target.repo.length === 0) {
    throw new Error(
      "buildObservationEvent: target.repo must be a non-empty string"
    );
  }
  const target = {
    owner: input.target.owner.toLowerCase(),
    repo: input.target.repo.toLowerCase()
  };
  for (const key of WHITELIST_TARGET_FIELDS) {
    const v = input.target[key];
    if (v !== void 0 && key !== "owner" && key !== "repo") {
      target[key] = v;
    }
  }
  return {
    event_uuid: input.eventUuid ?? randomUUID(),
    agent_id: input.agentId,
    scoped_token_id: input.scopedTokenId,
    operation_type: input.operationType,
    target,
    timestamp: input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
    client_session_id: input.clientSessionId
  };
}
var ObservationQueue = class {
  constructor(opts) {
    this.opts = opts;
  }
  buf = [];
  enqueue(event) {
    this.buf.push(event);
    if (this.buf.length > this.opts.capacity) {
      this.buf.splice(0, this.buf.length - this.opts.capacity);
    }
  }
  size() {
    return this.buf.length;
  }
  drain() {
    const out = this.buf;
    this.buf = [];
    return out;
  }
  peek() {
    return [...this.buf];
  }
  prepend(events) {
    this.buf = [...events, ...this.buf];
    if (this.buf.length > this.opts.capacity) {
      this.buf.splice(0, this.buf.length - this.opts.capacity);
    }
  }
};
function managementClientFor(opts) {
  const baseUrl = opts.endpoint.replace(/\/v1\/observations\/?$/, "");
  return createManagementClient({
    baseUrl,
    agentId: opts.agentId,
    agentSecret: opts.agentSecret,
    fetchImpl: opts.fetchImpl
  });
}
async function emitOrQueue(event, queue, opts) {
  const api = managementClientFor(opts);
  try {
    const { error, response } = await api.POST("/observations", {
      body: event
    });
    if (!error) return { delivered: true, status: response.status };
    queue.enqueue(event);
    return { delivered: false, status: response.status };
  } catch {
    queue.enqueue(event);
    return { delivered: false };
  }
}
async function flushQueue(queue, opts) {
  const api = managementClientFor(opts);
  let flushed = 0;
  const snapshot = queue.drain();
  for (let i = 0; i < snapshot.length; i++) {
    const event = snapshot[i];
    let ok = false;
    try {
      const { error } = await api.POST("/observations", { body: event });
      ok = !error;
    } catch {
      ok = false;
    }
    if (!ok) {
      queue.prepend(snapshot.slice(i));
      return { flushed, remaining: queue.size() };
    }
    flushed++;
  }
  return { flushed, remaining: queue.size() };
}

// src/lib/observation-pipeline.ts
import { homedir as homedir2 } from "node:os";
import { join as join9 } from "node:path";

// src/lib/observation-scope.ts
import { existsSync as existsSync5, readFileSync as readFileSync7 } from "node:fs";
import yaml from "js-yaml";
var STALENESS_MS = 24 * 60 * 60 * 1e3;
function tupleKey(t) {
  return `${t.owner.toLowerCase()}/${t.repo.toLowerCase()}`;
}
function isInEffectiveScope(target, ctx) {
  const ageMs = Date.now() - ctx.cacheRefreshedAt;
  if (ageMs >= STALENESS_MS) return false;
  const key = tupleKey(target);
  const inServer = ctx.serverScope.some((t) => tupleKey(t) === key);
  if (!inServer) return false;
  if (ctx.userAllowlist.length === 0) return true;
  return ctx.userAllowlist.some((t) => tupleKey(t) === key);
}
function loadUserAllowlist(path) {
  if (!existsSync5(path)) return { allowlist: [] };
  let raw;
  try {
    raw = readFileSync7(path, "utf-8");
  } catch (e) {
    return {
      allowlist: [],
      parseError: `read failed: ${e.message}`
    };
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    return {
      allowlist: [],
      parseError: `yaml parse failed: ${e.message}`
    };
  }
  if (!parsed || typeof parsed !== "object") return { allowlist: [] };
  const list = parsed.allowlist;
  if (!Array.isArray(list)) return { allowlist: [] };
  const out = [];
  for (const entry of list) {
    if (entry && typeof entry === "object" && typeof entry.owner === "string" && typeof entry.repo === "string") {
      out.push({
        owner: entry.owner.toLowerCase(),
        repo: entry.repo.toLowerCase()
      });
    }
  }
  return { allowlist: out };
}

// src/lib/scope-cache.ts
import {
  chmodSync as chmodSync4,
  existsSync as existsSync6,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync8,
  writeFileSync as writeFileSync6
} from "node:fs";
import { platform as platform2 } from "node:os";
import { dirname as dirname7 } from "node:path";
var REFRESH_INTERVAL_MS = 30 * 60 * 1e3;
function readScopeCache(path) {
  if (!existsSync6(path)) return null;
  try {
    const raw = readFileSync8(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.serverScope) || typeof parsed.refreshedAt !== "number")
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeScopeCache(path, scope) {
  mkdirSync5(dirname7(path), { recursive: true });
  writeFileSync6(path, JSON.stringify(scope), { mode: 384 });
  if (platform2() !== "win32") {
    chmodSync4(path, 384);
  }
}
function shouldRefreshCache(cache, now = Date.now()) {
  if (!cache) return true;
  return now - cache.refreshedAt >= REFRESH_INTERVAL_MS;
}

// src/lib/observation-pipeline.ts
function defaultScopeCachePath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join9(
    xdg ?? join9(homedir2(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join9(
    xdg ?? join9(homedir2(), ".config"),
    "spellguard",
    "observation.yaml"
  );
}
async function observeGitOperation(input, deps) {
  const canon = canonicalizeGitRemote(input.remoteUrl);
  if (!canon) return { emitted: false, reason: "invalid_remote" };
  if (canon.isSsh) return { emitted: false, reason: "invalid_remote" };
  const cache = readScopeCache(deps.scopeCachePath ?? defaultScopeCachePath());
  if (!cache) return { emitted: false, reason: "stale_cache" };
  const allowlist = loadUserAllowlist(
    deps.allowlistPath ?? defaultAllowlistPath()
  ).allowlist;
  const inScope = isInEffectiveScope(
    { owner: canon.owner, repo: canon.repo },
    {
      serverScope: cache.serverScope,
      userAllowlist: allowlist,
      cacheRefreshedAt: cache.refreshedAt
    }
  );
  if (!inScope) return { emitted: false, reason: "out_of_scope" };
  const event = buildObservationEvent({
    agentId: input.agentId,
    scopedTokenId: input.scopedTokenId,
    operationType: input.operationType,
    target: {
      owner: canon.owner,
      repo: canon.repo,
      branch: input.branch,
      head_sha: input.headSha,
      pr_number: input.prNumber,
      commits_count: input.commitsCount,
      commit_message: input.commitMessage
    },
    clientSessionId: input.clientSessionId
  });
  const result = await emitOrQueue(event, deps.queue, {
    endpoint: `${deps.spellguardBaseUrl.replace(/\/$/, "")}/v1/observations`,
    agentId: deps.agentId,
    agentSecret: deps.agentSecret,
    fetchImpl: deps.fetchImpl
  });
  return {
    emitted: true,
    reason: result.delivered ? "delivered" : "queued",
    event
  };
}

// src/hooks/pre-tool-use-observation.ts
function detectGitOperation(toolName, args) {
  if (toolName !== "Bash" && toolName !== "bash") return null;
  const cmd = args.join(" ");
  const op = detectGitOp(cmd);
  if (op === "push") return "push";
  if (op === "checkout_new_branch" || op === "switch_new_branch")
    return "branch_create";
  if (/(^|&&|;|\|\|)\s*gh\s+pr\s+create(\s|$)/.test(cmd)) return "pr_open";
  return null;
}
function resolveRemoteUrl(input) {
  if (input.remoteUrl) return input.remoteUrl;
  return process.env.SPELLGUARD_CURRENT_REMOTE ?? null;
}
var STATUS_PROBE_TIMEOUT_MS = 5e3;
async function probeStatus(args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    const api = createManagementClient({
      baseUrl: args.baseUrl,
      agentId: args.agentId,
      agentSecret: args.agentSecret,
      fetchImpl: (input, init) => args.fetchImpl(input, { ...init, signal: controller.signal })
    });
    const { data, error, response } = await api.GET(
      "/credentials/github/status",
      { params: { query: { scoped_token_id: args.scopedTokenId } } }
    );
    if (isAgentGoneStatus(response?.status)) return "block";
    if (error) return "allow";
    if (data?.status === "revoked") return "block";
    return "allow";
  } catch {
    return "allow";
  } finally {
    clearTimeout(timer);
  }
}
async function emitPreToolUseObservation(input) {
  const op = detectGitOperation(input.toolName, input.toolArgs);
  if (!op) return null;
  const remoteUrl = resolveRemoteUrl(input);
  if (!remoteUrl) return null;
  const canon = canonicalizeGitRemote(remoteUrl);
  if (!canon || canon.isSsh) return null;
  const queue = input.queue ?? new ObservationQueue({ capacity: 100 });
  const baseUrl = input.spellguardBaseUrl ?? input.endpoint.replace(/\/v1\/observations\/?$/, "");
  return observeGitOperation(
    {
      operationType: op,
      remoteUrl,
      agentId: input.agentId,
      scopedTokenId: input.scopedTokenId,
      clientSessionId: input.clientSessionId
    },
    {
      spellguardBaseUrl: baseUrl,
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      queue
    }
  );
}
async function runPreToolUse(input) {
  if (input.toolName === "Bash" || input.toolName === "bash") {
    markBashCommandStart({
      rootDir: input.editsRootDir ?? join10(homedir3(), ".spellguard"),
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now()
    });
  }
  const op = detectGitOperation(input.toolName, input.toolArgs);
  if (!op) return { decision: "skip" };
  const baseUrl = input.spellguardBaseUrl ?? input.endpoint.replace(/\/v1\/observations\/?$/, "");
  const fetchImpl = input.statusFetchImpl ?? fetch;
  const verdict = await probeStatus({
    baseUrl,
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    scopedTokenId: input.scopedTokenId,
    fetchImpl
  });
  if (verdict === "block") {
    return {
      decision: "block",
      message: "Spellguard credential revoked. Run /spellguard-setup to re-authorize."
    };
  }
  const observation = await emitPreToolUseObservation(input);
  return { decision: "allow", observation };
}
var runPreToolUseObservation = emitPreToolUseObservation;
var runPreToolUseHook = runPreToolUse;

// src/monitors/credential-monitor.ts
import { homedir as homedir4 } from "node:os";
import { join as join11 } from "node:path";
function defaultScopeCachePath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join11(
    xdg ?? join11(homedir4(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join11(
    xdg ?? join11(homedir4(), ".config"),
    "spellguard",
    "observation.yaml"
  );
}
async function runMonitorTick(deps = {}) {
  const result = readConfig();
  if (!result.config) return { status: "unknown", scopeRefreshed: false };
  if (result.config.revoked)
    return { status: "revoked", scopeRefreshed: false };
  if (!result.config.scopedTokenId) {
    return { status: "unknown", scopeRefreshed: false };
  }
  const scopedTokenIdValue = result.config.scopedTokenId;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = result.config.spellguardBaseUrl;
  const agentId = result.config.agentId;
  const agentSecret = result.config.agentSecret;
  const envFilePath = deps.envFilePath ?? process.env.CLAUDE_ENV_FILE ?? "";
  const scopeCachePath = deps.scopeCachePath ?? defaultScopeCachePath2();
  const scopedToken = result.config.scopedToken;
  const api = createManagementClient({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl
  });
  const { data: statusData, error: statusError } = await api.GET(
    "/credentials/github/status",
    {
      params: { query: { scoped_token_id: scopedTokenIdValue } },
      headers: scopedToken ? { "X-Spellguard-Scoped-Token": scopedToken } : void 0
    }
  );
  if (statusError) return { status: "unknown", scopeRefreshed: false };
  const credStatus = statusData.status;
  if (credStatus === "revoked") {
    markConfigRevoked();
    if (envFilePath) clearGitConfigEnv(envFilePath);
    renderMessage({
      level: "error",
      message: "Spellguard: credential revoked; subsequent git operations will fail until you re-run `/spellguard-setup` or restart Claude Code."
    });
  }
  const scopeRefreshed = await maybeRefreshScopeCache({
    baseUrl,
    agentId,
    agentSecret,
    fetchImpl,
    scopedTokenId: scopedTokenIdValue,
    scopeCachePath,
    allowlistPath: deps.allowlistPath ?? defaultAllowlistPath2()
  });
  return { status: credStatus, scopeRefreshed };
}
async function maybeRefreshScopeCache(opts) {
  const cache = readScopeCache(opts.scopeCachePath);
  if (!shouldRefreshCache(cache)) return false;
  const api = createManagementClient({
    baseUrl: opts.baseUrl,
    agentId: opts.agentId,
    agentSecret: opts.agentSecret,
    fetchImpl: opts.fetchImpl
  });
  const { data: scopeData, error: scopeError } = await api.GET(
    "/credentials/github/scope",
    { params: { query: { scoped_token_id: opts.scopedTokenId } } }
  );
  if (scopeError) return false;
  writeScopeCache(opts.scopeCachePath, {
    serverScope: scopeData.server_scope,
    refreshedAt: Date.now()
  });
  try {
    const { allowlist } = loadUserAllowlist(opts.allowlistPath);
    await api.PUT("/credentials/github/scope-ack", {
      body: { user_allowlist: allowlist }
    });
  } catch {
  }
  return true;
}

// src/skills/spellguard-setup.ts
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

// src/lib/probe-identity.ts
async function probeAgentIdentity(opts) {
  try {
    const api = createManagementClient({
      baseUrl: opts.baseUrl,
      agentId: opts.agentId,
      agentSecret: opts.agentSecret,
      fetchImpl: opts.fetchImpl
    });
    const { error, response } = await api.GET("/credentials/github/status", {
      params: { query: { scoped_token_id: opts.scopedTokenId ?? "" } }
    });
    if (!error) return "ok";
    const status = response?.status;
    if (opts.scopedTokenId) {
      return isAgentGoneStatus(status) ? "gone" : "transient";
    }
    return status === 401 ? "gone" : "transient";
  } catch {
    return "transient";
  }
}

// src/lib/sqlite-self-install.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync as mkdirSync6 } from "node:fs";
import { dirname as dirname8, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/lib/sqlite-backend.ts
import { createRequire } from "node:module";
var localRequire = typeof __require === "function" ? __require : createRequire(import.meta.url);
function suppressSqliteExperimentalWarning() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const optsOrType = rest[0];
    const type = typeof optsOrType === "object" && optsOrType !== null ? optsOrType.type : optsOrType;
    const name = typeof warning === "object" ? warning?.name : void 0;
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const isSqliteExperimental = type === "ExperimentalWarning" || name === "ExperimentalWarning" || typeof message === "string" && message.includes("SQLite is an experimental");
    if (isSqliteExperimental) return;
    return original.call(process, warning, ...rest);
  };
  return () => {
    process.emitWarning = original;
  };
}
function namedParamsIn(sql) {
  const names = /* @__PURE__ */ new Set();
  const re = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;
  let m = re.exec(sql);
  while (m !== null) {
    names.add(m[1]);
    m = re.exec(sql);
  }
  return names;
}
function pickKnownParams(params, known) {
  if (!params) return params;
  const out = {};
  for (const key of Object.keys(params)) {
    const bare = key.replace(/^[@:$]/, "");
    if (known.has(bare)) out[bare] = params[key];
  }
  return out;
}
function adaptNodeSqlite(DatabaseSync) {
  return {
    kind: "node:sqlite",
    open(dbPath) {
      const db = new DatabaseSync(dbPath);
      const wrapStatement = (sql) => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          run(params) {
            return stmt.run(pickKnownParams(params, known) ?? {});
          },
          get(params) {
            return stmt.get(pickKnownParams(params, known) ?? {});
          },
          all(params) {
            return stmt.all(pickKnownParams(params, known) ?? {});
          }
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          db.exec(`PRAGMA ${directive}`);
        },
        close() {
          db.close();
        }
      };
    }
  };
}
function adaptBetterSqlite3(Database) {
  return {
    kind: "better-sqlite3",
    open(dbPath) {
      const db = new Database(dbPath);
      const wrapStatement = (sql) => {
        const stmt = db.prepare(sql);
        const known = namedParamsIn(sql);
        return {
          // better-sqlite3 ignores extra keys already, but we sanitize too so
          // both backends receive the exact same bind object.
          run(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.run(p) : stmt.run();
          },
          get(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.get(p) : stmt.get();
          },
          all(params) {
            const p = pickKnownParams(params, known);
            return p ? stmt.all(p) : stmt.all();
          }
        };
      };
      return {
        exec(sql) {
          db.exec(sql);
        },
        prepare: wrapStatement,
        pragma(directive) {
          db.pragma(directive);
        },
        close() {
          db.close();
        }
      };
    }
  };
}
function tryNodeSqlite() {
  const restore = suppressSqliteExperimentalWarning();
  try {
    const mod = localRequire("node:sqlite");
    if (!mod?.DatabaseSync) return null;
    const backend = adaptNodeSqlite(mod.DatabaseSync);
    const probe = backend.open(":memory:");
    probe.exec("CREATE TABLE __probe (x); DROP TABLE __probe;");
    probe.close();
    return backend;
  } catch {
    return null;
  } finally {
    restore();
  }
}
function tryBetterSqlite3() {
  try {
    const Database = localRequire("better-sqlite3");
    return adaptBetterSqlite3(Database);
  } catch {
    return null;
  }
}
var cachedBackend;
function loadSqliteBackend() {
  if (cachedBackend !== void 0) return cachedBackend;
  cachedBackend = tryNodeSqlite() ?? tryBetterSqlite3() ?? null;
  return cachedBackend;
}
function hasUsableSqliteBackend() {
  return loadSqliteBackend() !== null;
}

// src/lib/sqlite-self-install.ts
var SELF_INSTALL_PACKAGES = [
  "better-sqlite3@^12",
  "bindings@^1",
  "file-uri-to-path@^1"
];
function resolvePluginRoot(overrideDir) {
  if (overrideDir) return overrideDir;
  const here = dirname8(fileURLToPath4(import.meta.url));
  return resolve3(here, "..", "..");
}
function isWritable(dir) {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
async function ensureSqliteBackend(opts = {}) {
  const hasBackend = opts.hasBackend ?? hasUsableSqliteBackend;
  if (hasBackend()) return { status: "already" };
  const pluginRoot = resolvePluginRoot(opts.pluginRoot);
  try {
    mkdirSync6(resolve3(pluginRoot, "node_modules"), { recursive: true });
  } catch (err) {
    return {
      status: "skipped",
      installDir: pluginRoot,
      reason: `plugin directory is not writable (${err.message})`
    };
  }
  if (!isWritable(pluginRoot)) {
    return {
      status: "skipped",
      installDir: pluginRoot,
      reason: "plugin directory is not writable"
    };
  }
  const runInstall = opts.runInstall ?? defaultNpmInstall;
  let installOutcome;
  try {
    installOutcome = await runInstall({
      cwd: pluginRoot,
      packages: SELF_INSTALL_PACKAGES
    });
  } catch (err) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: `npm install could not run (${err.message}); is npm on PATH?`
    };
  }
  if (installOutcome.code !== 0) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: `npm install exited ${installOutcome.code}${installOutcome.stderr ? `: ${installOutcome.stderr.trim()}` : ""}`
    };
  }
  const hasAfter = opts.hasBackendAfter ?? hasUsableSqliteBackend;
  if (!hasAfter()) {
    return {
      status: "failed",
      installDir: pluginRoot,
      reason: "better-sqlite3 installed but did not load (no prebuilt binary for this platform/arch?)"
    };
  }
  return { status: "installed", installDir: pluginRoot };
}
function defaultNpmInstall(args) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn2(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        ...args.packages
      ],
      {
        cwd: args.cwd,
        // Inherit stdout so prebuild-install progress is visible; capture
        // stderr so we can surface a concise reason on failure.
        stdio: ["ignore", "inherit", "pipe"],
        env: process.env
      }
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code: code ?? 1, stderr }));
  });
}

// src/skills/spellguard-setup.ts
var DEFAULT_SPELLGUARD_BASE = (() => { const v = process.env.SPELLGUARD_BASE_URL; if (!v) throw new Error('SPELLGUARD_BASE_URL is not set. Set it to your Spellguard console URL, e.g. export SPELLGUARD_BASE_URL=https://your-spellguard-console.example.com'); return v; })();
async function pollChannelToken(apiBaseUrl, nonce, opts = {}) {
  const pollIntervalMs = opts.pollIntervalMs ?? 2e3;
  const maxAttempts = opts.maxAttempts ?? 300;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBaseUrl.replace(/\/$/, "");
  const url = `${base}/v1/bootstrap/channel-token/${encodeURIComponent(nonce)}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const res = await fetchImpl(url).catch(() => null);
    if (res?.ok) {
      const body = await res.json();
      if (body.channelToken && body.userId && body.orgId && body.agentName) {
        return {
          channelToken: body.channelToken,
          userId: body.userId,
          orgId: body.orgId,
          agentName: body.agentName,
          reason: body.reason,
          agentId: body.agentId
        };
      }
    } else if (res && res.status !== 404) {
      let errText = "";
      try {
        errText = await res.text();
      } catch {
      }
      throw new Error(
        `channel-token poll failed: ${res.status}${errText ? ` ${errText}` : ""}`
      );
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  throw new Error(
    "Channel token not minted within 10 minutes \u2014 user may not have visited /setup in their browser or submitted the agent name form."
  );
}
function generateNonce() {
  return randomBytes(32).toString("base64url");
}
var INITIATING_FRAMEWORK = FRAMEWORK;
async function registerInitiatingFramework(baseUrl, nonce, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  try {
    await fetchImpl(`${base}/v1/bootstrap/register-framework`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce, framework: INITIATING_FRAMEWORK })
    });
  } catch {
  }
}
function dashboardUrl(baseUrl, nonce) {
  return `${baseUrl.replace(/\/$/, "")}/setup?bootstrap=${encodeURIComponent(nonce)}`;
}
async function promptExistingConfigChoice(opts) {
  const question = [
    "Spellguard: an existing credential is present. Choose an action:",
    "  1) Print current identity and exit",
    "  2) Provision an additional agent (the server keeps the existing agent; the credential stored on THIS machine is replaced)",
    "  3) Re-authorize (re-binds the same agent identity; only the secret rotates)",
    "Enter 1, 2, or 3: "
  ].join("\n");
  if (!opts.promptFn && !process.stdin.isTTY) {
    renderMessage({
      level: "warn",
      message: "Spellguard: an existing credential is present and no interactive terminal is available. Printing the current identity. To act on it non-interactively, re-run with --choice reauthorize | additional | print, or use /spellguard-reset to disconnect this machine."
    });
    return "print_identity";
  }
  const ask = opts.promptFn ? opts.promptFn : (q) => {
    const rl = createInterface({
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout
    });
    return new Promise((resolve4) => {
      rl.question(q, (answer) => {
        rl.close();
        resolve4(answer);
      });
    });
  };
  for (let i = 0; i < 3; i++) {
    const raw = (await ask(question)).trim();
    if (raw === "1") return "print_identity";
    if (raw === "2") return "provision_additional";
    if (raw === "3") return "reauthorize";
    renderMessage({
      level: "warn",
      message: `Spellguard: unrecognized choice "${raw}". Enter 1, 2, or 3.`
    });
  }
  renderMessage({
    level: "warn",
    message: 'Spellguard: no valid choice after 3 attempts. Defaulting to "print identity and exit".'
  });
  return "print_identity";
}
function extractBootstrapIdentity(frame) {
  const rawCreds = frame.credentials;
  if (!Array.isArray(rawCreds)) {
    return {
      ok: false,
      reason: "malformed_credentials_array",
      message: "Spellguard: bootstrap frame was malformed (missing credentials array). Re-run /spellguard-setup."
    };
  }
  if (!frame.agent_secret) {
    return {
      ok: false,
      reason: "missing_agent_secret",
      message: "Spellguard: server bootstrap response missing agent_secret \u2014 out-of-date server version. Please upgrade the server and re-run /spellguard-setup."
    };
  }
  const ghMaybe = rawCreds.find(
    (c) => typeof c === "object" && c !== null && c.provider === "github"
  );
  const pd = ghMaybe?.provider_data;
  const ghWellFormed = ghMaybe?.scoped_token && pd && typeof pd.git_author_name === "string" && pd.git_author_name.length > 0 && typeof pd.git_author_email === "string" && pd.git_author_email.length > 0;
  return {
    ok: true,
    agentSecret: frame.agent_secret,
    ...ghWellFormed ? { ghCred: ghMaybe } : {}
  };
}
async function runSpellguardSetup(args = {}) {
  const baseUrl = args.baseUrl ?? DEFAULT_SPELLGUARD_BASE;
  const existing = readConfig();
  let reuseAgentId;
  let probeSaysGone = false;
  if (existing.config && !existing.config.revoked) {
    const probe = await probeAgentIdentity({
      baseUrl: existing.config.spellguardBaseUrl ?? baseUrl,
      agentId: existing.config.agentId,
      agentSecret: existing.config.agentSecret,
      scopedTokenId: existing.config.scopedTokenId,
      fetchImpl: args.fetchImpl
    });
    if (probe === "gone") {
      markConfigRevoked();
      renderMessage({
        level: "warn",
        message: "Spellguard: the stored agent is no longer recognized by the server (it was likely deleted or revoked in the dashboard). Starting fresh setup."
      });
      probeSaysGone = true;
    }
  }
  if (existing.config && !existing.config.revoked && !probeSaysGone) {
    const choice = args.existingConfigChoice ? await args.existingConfigChoice() : await promptExistingConfigChoice({});
    if (choice === "print_identity") {
      const lines = [
        "Spellguard: current identity:",
        `  agent=${existing.config.agentId}`,
        `  config_dir=${defaultConfigDir()}`
      ];
      if (existing.config.scopedTokenId) {
        lines.push(`  scoped_token_id=${existing.config.scopedTokenId}`);
      }
      if (existing.config.expiresAt) {
        lines.push(`  expires_at=${existing.config.expiresAt}`);
      }
      if (existing.config.scopeSummary) {
        lines.push(`  repos=${existing.config.scopeSummary.repos.join(", ")}`);
      } else {
        lines.push(
          "  github=not connected (complete the dashboard GitHub-App install to grant repo access)"
        );
      }
      lines.push(
        "No changes made. Re-run /spellguard-setup to choose a different action."
      );
      renderMessage({ level: "info", message: lines.join("\n") });
      return { ok: true, reason: "print_identity" };
    }
    if (choice === "provision_additional") {
      renderMessage({
        level: "info",
        message: "Spellguard: provisioning an additional agent \u2014 choose a unique agent name in the browser form. Note: the local credential on this machine will be replaced by the new one at the end of the flow."
      });
    } else {
      reuseAgentId = existing.config.agentId;
      renderMessage({
        level: "info",
        message: `Spellguard: re-authorizing \u2014 the same agent identity (agent=${existing.config.agentId}) is re-used and only the secret rotates (the server defers rotation until after issuance, so a mid-flow failure does not strand the old secret).`
      });
    }
  }
  if (existing.config?.revoked) {
    const cause = existing.config.revokedMessage ? `Spellguard: ${existing.config.revokedMessage}` : "Spellguard: this machine's Spellguard credential was revoked.";
    renderMessage({
      level: "warn",
      message: `${cause}

Re-running setup to RECONNECT this machine. In the browser, choose "Select an existing agent" to re-attach to your existing agent \u2014 it keeps the agent's history and restores its GitHub connection automatically. Only choose "Create a new agent" if you intend to provision a brand-new, separate agent.`
    });
  }
  let agentId = args.agentIdOverride ?? reuseAgentId ?? crypto.randomUUID();
  const nonce = generateNonce();
  await registerInitiatingFramework(baseUrl, nonce, {
    ...args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}
  });
  const url = dashboardUrl(baseUrl, nonce);
  renderMessage({
    level: "info",
    message: `Spellguard: open this URL in your browser to complete setup:
  ${url}

Waiting up to 10 minutes for browser approval and agent name\u2026`
  });
  const start = Date.now();
  const intervalMs = args.intervalMs ?? 3e4;
  const interval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - start) / 1e3);
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    renderMessage({
      level: "info",
      message: `Spellguard: still waiting for browser approval (${m}m ${s}s elapsed of 10m).`
    });
    args.onProgress?.(elapsedSec);
  }, intervalMs);
  let channelToken;
  let orgId;
  let agentName;
  let statementOfReason;
  let isReattach = false;
  try {
    const polled = await pollChannelToken(baseUrl, nonce, {
      fetchImpl: args.fetchImpl,
      pollIntervalMs: args.pollIntervalMs,
      maxAttempts: args.pollMaxAttempts
    });
    channelToken = polled.channelToken;
    orgId = polled.orgId;
    agentName = polled.agentName;
    statementOfReason = polled.reason;
    if (polled.agentId) {
      agentId = polled.agentId;
      isReattach = true;
    }
  } catch (e) {
    clearInterval(interval);
    renderMessage({
      level: "error",
      message: `Spellguard: bootstrap timed out waiting for browser approval (${e.message}). Re-run /spellguard-setup to try again.`
    });
    return { ok: false, reason: e.message };
  }
  const result = await awaitBootstrapViaClient({
    apiBaseUrl: baseUrl,
    agentId,
    nonce,
    channelToken,
    orgId,
    agentName,
    statementOfReason,
    WebSocketImpl: args.WebSocketImpl,
    expectReBootstrap: isReattach
  });
  clearInterval(interval);
  if (!result.ok) {
    renderMessage({ level: "error", message: result.message });
    return { ok: false, reason: result.reason };
  }
  const { frame } = result;
  const extracted = extractBootstrapIdentity(frame);
  if (!extracted.ok) {
    renderMessage({ level: "error", message: extracted.message });
    return { ok: false, reason: extracted.reason };
  }
  const { agentSecret, ghCred } = extracted;
  const resolvedAgentId = frame.agent_id ?? agentId;
  const writtenConfig = {
    agentId: resolvedAgentId,
    agentSecret,
    agentName: frame.agent_name,
    spellguardBaseUrl: baseUrl,
    revoked: false,
    // Persist the bootstrap-frame seq + known_credentials projection
    // so the daemon's first connect can send a real Resume frame. Without
    // this, the daemon sends Resume{0, []}, the server's divergence check
    // fires on every cold start, and any frame pushed between bootstrap
    // and daemon attach is lost without these fields.
    lastServerSeq: frame.seq,
    knownCredentials: ghCred ? [
      {
        provider: ghCred.provider,
        scoped_token_id: ghCred.scoped_token_id ?? ghCred.credential_id
      }
    ] : [],
    // Legacy-server fallthrough: bundle the GitHub fields when the frame
    // happens to carry them.
    ...ghCred ? {
      scopedToken: ghCred.scoped_token,
      scopedTokenId: ghCred.scoped_token_id ?? ghCred.credential_id,
      expiresAt: ghCred.expires_at,
      scopeSummary: ghCred.scope_summary,
      gitAuthorName: ghCred.provider_data.git_author_name,
      gitAuthorEmail: ghCred.provider_data.git_author_email
    } : {}
  };
  try {
    (args.stopDaemons ?? stopLocalDaemons)({
      configDir: args.daemonConfigDir
    });
  } catch {
  }
  writeConfig(writtenConfig);
  const daemonResult = ensureCredentialDaemonRunning({
    config: writtenConfig,
    cwd: process.cwd(),
    envFilePath: process.env.CLAUDE_ENV_FILE,
    spawnDaemon: args.spawnDaemon,
    configDir: args.daemonConfigDir
  });
  await ensureAttributionBackend();
  if (ghCred) {
    const lines = [`Spellguard: agent provisioned (agent=${agentId}).`];
    const authorName = ghCred.provider_data.git_author_name;
    const authorEmail = ghCred.provider_data.git_author_email;
    if (authorName && authorEmail) {
      lines.push(
        `  Commits will be authored as: ${authorName} <${authorEmail}>`
      );
    }
    lines.push(
      "  Restart your Claude Code session for credentials to take effect."
    );
    renderMessage({ level: "info", message: lines.join("\n") });
    return { ok: true, daemon: daemonResult, githubCredential: "bundled" };
  }
  const daemonLine = daemonResult.daemon === "spawned" ? "  The credential daemon is now running and listening for it." : daemonResult.daemon === "already-running" ? `  The credential daemon is already running (pid ${daemonResult.pid}) and listening for it.` : `  WARNING: the credential daemon could not be started (${daemonResult.reason}); restart your session so the SessionStart hook can start it.`;
  renderMessage({
    level: "info",
    message: [
      `Spellguard: agent provisioned (agent=${agentId}).`,
      "  Next: open the dashboard and connect GitHub on this agent to grant",
      "  repo access \u2014 the GitHub credential lands in your local config the",
      "  moment that completes.",
      daemonLine
    ].join("\n")
  });
  const waitMs = args.credentialWaitMs ?? DEFAULT_CREDENTIAL_WAIT_MS;
  let delivered = null;
  if (daemonResult.daemon !== "skipped" && waitMs > 0) {
    renderMessage({
      level: "info",
      message: `Spellguard: waiting up to ${Math.round(waitMs / 6e4)} minute(s) for the GitHub credential (Ctrl-C is safe \u2014 the daemon keeps listening)\u2026`
    });
    delivered = await waitForGithubCredential(
      waitMs,
      args.credentialPollIntervalMs ?? 2e3
    );
  }
  if (delivered?.scopeSummary) {
    const author = delivered.gitAuthorName && delivered.gitAuthorEmail ? ` Commits will be authored as: ${delivered.gitAuthorName} <${delivered.gitAuthorEmail}>.` : "";
    renderMessage({
      level: "info",
      message: `Spellguard: GitHub credential received \u2014 repos=[${delivered.scopeSummary.repos.join(", ")}].${author}
  Git-credential protection for this session finishes wiring at the next session start (restart or /clear).`
    });
    return { ok: true, daemon: daemonResult, githubCredential: "delivered" };
  }
  renderMessage({
    level: "info",
    message: [
      "Spellguard: GitHub credential not delivered yet \u2014 that is fine. The",
      "  daemon keeps listening and writes it to your local config the moment",
      "  the dashboard GitHub-App install completes. Git-credential protection",
      "  for this session finishes wiring at the next session start (restart",
      "  or /clear); re-run /spellguard-setup any time to check status."
    ].join("\n")
  });
  return { ok: true, daemon: daemonResult, githubCredential: "pending" };
}
var DEFAULT_CREDENTIAL_WAIT_MS = 5 * 6e4;
async function waitForGithubCredential(timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastProgressAt = started;
  const delay = (ms) => new Promise((resolve4) => setTimeout(resolve4, ms));
  while (Date.now() < deadline) {
    const result = readConfig();
    if (result.config?.scopedToken) return result.config;
    if (Date.now() - lastProgressAt >= 3e4) {
      lastProgressAt = Date.now();
      const elapsedSec = Math.floor((Date.now() - started) / 1e3);
      renderMessage({
        level: "info",
        message: `Spellguard: still waiting for the GitHub credential (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s elapsed) \u2014 complete the dashboard "Connect GitHub" step.`
      });
    }
    await delay(pollIntervalMs);
  }
  return null;
}
async function ensureAttributionBackend(opts) {
  const ensure = opts?.ensure ?? ensureSqliteBackend;
  let result;
  try {
    result = await ensure();
  } catch (err) {
    renderMessage({
      level: "warn",
      message: `Spellguard: could not verify the code-attribution database backend (${err.message}). Fine-grained commit attribution will be degraded; it self-heals on Node 24+ or after a local clone + \`pnpm install\`.`
    });
    return;
  }
  if (result.status === "already") {
    return;
  }
  if (result.status === "installed") {
    renderMessage({
      level: "info",
      message: "Spellguard: installed the code-attribution database backend (better-sqlite3, prebuilt binary). Per-line commit attribution is enabled."
    });
    return;
  }
  renderMessage({
    level: "warn",
    message: `Spellguard: could not install the code-attribution database backend (${result.reason ?? "unknown reason"}). Fine-grained commit attribution will be degraded. To enable it: upgrade to Node 24+ (built-in SQLite), or clone the plugin repo and run \`pnpm install\` so the native backend is present.`
  });
}
async function awaitBootstrapViaClient(opts) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1e3;
  return new Promise((resolve4) => {
    let settled = false;
    let client = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
      }
      resolve4(result);
    };
    const timer = setTimeout(() => {
      settle({
        ok: false,
        reason: "bootstrap_timeout",
        message: "Spellguard: bootstrap timed out or channel unavailable (bootstrap_timeout). Re-run /spellguard-setup to try again."
      });
    }, timeoutMs);
    client = new AgentControlClient({
      apiBaseUrl: opts.apiBaseUrl,
      agentId: opts.agentId,
      credentials: () => ({
        mode: "nonce",
        nonce: opts.nonce,
        channelToken: opts.channelToken,
        orgId: opts.orgId,
        ...opts.agentName ? { agentName: opts.agentName } : {},
        ...opts.statementOfReason ? { statementOfReason: opts.statementOfReason } : {},
        // Record the correct agents.framework at creation (REQ-FI) instead of
        // the server's hardcoded default; plugin-sync reconciles to the same
        // canonical value on startup.
        framework: FRAMEWORK,
        // C10: on a select-existing reattach the server auto-delivers
        // re_bootstrap — do not send (and get rejected on) a bootstrap_request.
        ...opts.expectReBootstrap ? { expectReBootstrap: true } : {}
      }),
      onCredentialDelivered: (frame) => {
        if (frame.cause !== "bootstrap" && frame.cause !== "re_bootstrap") {
          return;
        }
        settle({
          ok: true,
          frame
        });
      },
      onSeqAdvanced: (_seq) => {
      },
      onFatalClose: (code, reason) => {
        let message;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            message = `Spellguard bootstrap failed: ${reason || "unknown error"}. Re-run /spellguard-setup to try again.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            message = `Spellguard: authentication failed (${reason || "auth_failed"}); the nonce may already have been consumed by another session. Re-run /spellguard-setup.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            message = `Spellguard: agent ownership check failed (${reason || "agent_ownership"}). Confirm you're signed in to the correct organization and re-run /spellguard-setup.`;
            break;
          default:
            message = `Spellguard: bootstrap channel closed unexpectedly (code=${code}${reason ? `, reason=${reason}` : ""}). Re-run /spellguard-setup to try again.`;
        }
        settle({
          ok: false,
          reason: reason || String(code),
          message
        });
      },
      onError: (err) => {
        const msg = err.message ?? "";
        if (msg.includes("server:")) {
          settle({
            ok: false,
            reason: msg,
            message: buildServerErrorMessage(msg)
          });
          return;
        }
        renderMessage({
          level: "warn",
          message: `Spellguard: bootstrap channel error: ${msg}`
        });
      },
      ...opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}
    });
    client.start();
  });
}
function buildServerErrorMessage(errMsg) {
  const codeMatch = /server:\s*([^:]+):/.exec(errMsg);
  const code = codeMatch?.[1]?.trim() ?? "";
  if (code === "not_in_org") {
    return "Spellguard: you are not a member of any Spellguard organization. Ask your admin to invite you, then re-run /spellguard-setup.";
  }
  if (code === "nonce_expired") {
    return "Spellguard: bootstrap timed out (nonce expired). Re-run /spellguard-setup.";
  }
  if (code === "github_consent_declined") {
    return "Spellguard: GitHub authorization was declined. Re-run /spellguard-setup to retry.";
  }
  if (code === "sso_failure") {
    return "Spellguard: SSO failed mid-setup. Re-run /spellguard-setup.";
  }
  if (code === "session_mismatch") {
    return "Spellguard: the browser session that completed setup does not match the one that started it. Sign in to the Spellguard dashboard with the same account, then re-run /spellguard-setup.";
  }
  if (code === "membership_lost") {
    return "Spellguard: your organization membership was revoked during setup. Contact your organization admin, then re-run /spellguard-setup.";
  }
  if (code === "github_exchange_failed") {
    return "Spellguard: GitHub rejected the authorization code (likely transient). Re-run /spellguard-setup and complete the GitHub consent screen again.";
  }
  if (code === "github_identity_failed") {
    return "Spellguard: could not read your GitHub identity (GitHub /user call failed). Re-run /spellguard-setup; if this keeps happening, contact support.";
  }
  if (code === "validation_error") {
    return "Spellguard: the setup link was malformed or expired. Re-run /spellguard-setup to get a fresh link.";
  }
  return `Spellguard setup failed: ${errMsg}`;
}
export {
  ObservationQueue,
  WHITELIST_FIELDS,
  WHITELIST_TARGET_FIELDS,
  buildObservationEvent,
  canonicalizeGitRemote,
  detectGitOperation,
  emitOrQueue,
  emitPreToolUseObservation,
  flushQueue,
  isInEffectiveScope,
  loadUserAllowlist,
  observeGitOperation,
  runMonitorTick,
  runPreToolUse,
  runPreToolUseHook,
  runPreToolUseObservation,
  runSessionStart,
  runSpellguardSetup,
  syncFrameworkIdentity
};
