// ../agent-control/dist/index.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PartySocket } from "partysocket";
import WebSocket from "ws";
import { hostname } from "node:os";

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
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
var A2A_TASK_STATES = [
  "SUBMITTED",
  "WORKING",
  "INPUT_REQUIRED",
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "REJECTED",
  "AUTH_REQUIRED"
];
var A2A_ROLES = ["USER", "AGENT"];
var TASK_STATE_SET = new Set(A2A_TASK_STATES);
var ROLE_SET = new Set(A2A_ROLES);
var PART_CONTENT_KEYS = ["text", "raw", "url", "data"];
var PART_KEYS = /* @__PURE__ */ new Set([
  ...PART_CONTENT_KEYS,
  "metadata",
  "filename",
  "mediaType"
]);
var MESSAGE_KEYS = /* @__PURE__ */ new Set([
  "messageId",
  "role",
  "parts",
  "contextId",
  "taskId",
  "metadata",
  "extensions",
  "referenceTaskIds"
]);
var ARTIFACT_KEYS = /* @__PURE__ */ new Set([
  "artifactId",
  "parts",
  "name",
  "description",
  "metadata",
  "extensions"
]);
var STATUS_KEYS = /* @__PURE__ */ new Set(["state", "message", "timestamp"]);
var TASK_KEYS = /* @__PURE__ */ new Set([
  "id",
  "status",
  "contextId",
  "artifacts",
  "history",
  "metadata"
]);
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function rejectUnknownKeys(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${path}: unknown field '${key}' is not permitted`);
    }
  }
}
function checkOptionalString(obj, key, path, errors) {
  if (key in obj && typeof obj[key] !== "string") {
    errors.push(`${path}.${key}: expected string`);
  }
}
function checkOptionalStringArray(obj, key, path, errors) {
  if (!(key in obj)) return;
  const arr = obj[key];
  if (!Array.isArray(arr)) {
    errors.push(`${path}.${key}: expected array of string`);
    return;
  }
  arr.forEach((el, i) => {
    if (typeof el !== "string") {
      errors.push(`${path}.${key}[${i}]: expected string`);
    }
  });
}
function checkOptionalObject(obj, key, path, errors) {
  if (key in obj && !isPlainObject(obj[key])) {
    errors.push(`${path}.${key}: expected object`);
  }
}
function validatePart(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, PART_KEYS, path, errors);
  const contentPresent = PART_CONTENT_KEYS.filter((k) => k in input);
  if (contentPresent.length !== 1) {
    errors.push(
      `${path}: exactly one content field (text|raw|url|data) required, found ${contentPresent.length}`
    );
  }
  if ("text" in input && typeof input.text !== "string") {
    errors.push(`${path}.text: expected string`);
  }
  if ("raw" in input && typeof input.raw !== "string") {
    errors.push(`${path}.raw: expected string`);
  }
  if ("url" in input && typeof input.url !== "string") {
    errors.push(`${path}.url: expected string`);
  }
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalString(input, "filename", path, errors);
  checkOptionalString(input, "mediaType", path, errors);
}
function validateParts(input, path, errors) {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array of parts`);
    return;
  }
  if (input.length < 1) {
    errors.push(`${path}: at least one part required`);
  }
  input.forEach((p, i) => validatePart(p, `${path}[${i}]`, errors));
}
function validateMessageInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, MESSAGE_KEYS, path, errors);
  if (typeof input.messageId !== "string" || input.messageId.length === 0) {
    errors.push(`${path}.messageId: required non-empty string`);
  }
  if (typeof input.role !== "string" || !ROLE_SET.has(input.role)) {
    errors.push(
      `${path}.role: required, must be one of ${A2A_ROLES.join(" | ")}`
    );
  }
  if (!("parts" in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, "contextId", path, errors);
  checkOptionalString(input, "taskId", path, errors);
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalStringArray(input, "extensions", path, errors);
  checkOptionalStringArray(input, "referenceTaskIds", path, errors);
}
function validateArtifactInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, ARTIFACT_KEYS, path, errors);
  if (typeof input.artifactId !== "string" || input.artifactId.length === 0) {
    errors.push(`${path}.artifactId: required non-empty string`);
  }
  if (!("parts" in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, "name", path, errors);
  checkOptionalString(input, "description", path, errors);
  checkOptionalObject(input, "metadata", path, errors);
  checkOptionalStringArray(input, "extensions", path, errors);
}
function validateStatusInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, STATUS_KEYS, path, errors);
  if (typeof input.state !== "string" || !TASK_STATE_SET.has(input.state)) {
    errors.push(
      `${path}.state: required, must be one of ${A2A_TASK_STATES.join(" | ")}`
    );
  }
  if ("message" in input) {
    validateMessageInto(input.message, `${path}.message`, errors);
  }
  checkOptionalString(input, "timestamp", path, errors);
}
function validateTaskInto(input, path, errors) {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, TASK_KEYS, path, errors);
  if (typeof input.id !== "string" || input.id.length === 0) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (!("status" in input)) {
    errors.push(`${path}.status: required`);
  } else {
    validateStatusInto(input.status, `${path}.status`, errors);
  }
  checkOptionalString(input, "contextId", path, errors);
  if ("artifacts" in input) {
    if (!Array.isArray(input.artifacts)) {
      errors.push(`${path}.artifacts: expected array`);
    } else {
      input.artifacts.forEach(
        (a, i) => validateArtifactInto(a, `${path}.artifacts[${i}]`, errors)
      );
    }
  }
  if ("history" in input) {
    if (!Array.isArray(input.history)) {
      errors.push(`${path}.history: expected array`);
    } else {
      input.history.forEach(
        (m, i) => validateMessageInto(m, `${path}.history[${i}]`, errors)
      );
    }
  }
  checkOptionalObject(input, "metadata", path, errors);
}
function validateA2aMessage(input) {
  const errors = [];
  validateMessageInto(input, "message", errors);
  return errors.length === 0 ? { valid: true, value: input, errors: [] } : { valid: false, value: null, errors };
}
function validateA2aTask(input) {
  const errors = [];
  validateTaskInto(input, "task", errors);
  return errors.length === 0 ? { valid: true, value: input, errors: [] } : { valid: false, value: null, errors };
}
function isA2aMessage(input) {
  return validateA2aMessage(input).valid;
}
function isA2aTask(input) {
  return validateA2aTask(input).valid;
}
var AGENT_CONTROL_PROTOCOL_VERSION = "5";
function isGithubCredentialScope(value) {
  if (typeof value !== "object" || value === null) return false;
  const mode = value.mode;
  if (mode === "all") return true;
  if (mode !== "selected") return false;
  const repos = value.repos;
  return Array.isArray(repos) && repos.length > 0 && repos.every((r) => typeof r === "string");
}
function describeGithubCredentialScope(scope) {
  if (!scope) return "unknown";
  return scope.mode === "all" ? "all repositories in the organization" : `[${scope.repos.join(", ")}]`;
}
var A2A_PROTOCOL_LIMITS = {
  ordinaryFrameBytes: 65536,
  taskCreateOuterFrameBytes: 327680,
  taskUpdateOuterFrameBytes: 1572864,
  taskCreateInputBytes: 262144,
  taskCreateEnvelopeBytes: 65536,
  identifierBytes: 256,
  messageTextBytes: 16384,
  messagePartsBytes: 65536,
  artifactsPerUpdate: 50,
  artifactLabelBytes: 256,
  artifactValueBytes: 2048,
  taskUpdateResultBytes: 1048576,
  diagnosticsPerUpdate: 16,
  diagnosticsBytesPerUpdate: 8192
};
var A2A_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
var FRAME_FAMILY = {
  // lifecycle — connection/session control
  hello: "lifecycle",
  ack: "lifecycle",
  error: "lifecycle",
  resume_window_exceeded: "lifecycle",
  bootstrap_request: "lifecycle",
  resume: "lifecycle",
  ping: "lifecycle",
  channel_ready: "lifecycle",
  // credential — secret delivery / rotation / revocation / config
  credential_delivered: "credential",
  credential_rotated: "credential",
  credential_revoked: "credential",
  github_grants_bundle: "credential",
  github_grants_commit_confirmed: "credential",
  github_grants_applied: "credential",
  cloudflare_credential_applied: "credential",
  config_updated: "credential",
  credential_request: "credential",
  // login — headless managed-login relay
  login_code: "login",
  login_restart: "login",
  login_relay_update: "login",
  // relay — inbound Slack/Teams platform events
  slack_event: "relay",
  slack_event_blocked: "relay",
  teams_activity: "relay",
  teams_activity_blocked: "relay",
  // a2a — the agent-to-agent collaboration plane
  a2a_config_applied: "a2a",
  a2a_deferred_accepted: "a2a",
  a2a_message_delivery: "a2a",
  a2a_handler_inventory: "a2a",
  a2a_maintenance: "a2a",
  a2a_maintenance_result: "a2a",
  a2a_task_dispatch: "a2a",
  a2a_task_update: "a2a",
  a2a_message: "a2a",
  a2a_session_register: "a2a",
  a2a_supervision_keepalive: "a2a",
  a2a_task_create: "a2a",
  a2a_task_read: "a2a"
};
var SERVER_FRAME_QOS = {
  hello: "reliable",
  credential_delivered: "reliable",
  credential_rotated: "reliable",
  credential_revoked: "reliable",
  github_grants_bundle: "reliable",
  github_grants_commit_confirmed: "reliable",
  config_updated: "reliable",
  ack: "reliable",
  error: "reliable",
  resume_window_exceeded: "reliable",
  login_code: "transient",
  login_restart: "transient",
  slack_event: "transient",
  slack_event_blocked: "transient",
  teams_activity: "transient",
  teams_activity_blocked: "transient",
  // a2a down frames: emit()-sequenced but never ring-buffered/replayed — the
  // login-family pattern. Durability = server-side task store + watchdog.
  a2a_task_dispatch: "transient",
  a2a_message: "transient",
  a2a_maintenance: "transient"
};
function frameFamily(type) {
  return FRAME_FAMILY[type];
}
function frameQos(type) {
  return SERVER_FRAME_QOS[type];
}
var DECIMAL_REVISION_RE = /^[1-9][0-9]*$/;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var CANONICAL_FRAMEWORKS = /* @__PURE__ */ new Set([
  "claude_code",
  "codex",
  "openclaw",
  "hermes"
]);
var HANDLER_STATES = /* @__PURE__ */ new Set([
  "current",
  "outdated_unedited",
  "owner_modified",
  "example_scaffold",
  "not_installed_apply_pending",
  "not_installed_custom",
  "missing_deleted",
  "custom_no_reference",
  "not_reported"
]);
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
  const keySet = new Set(allowed);
  return Object.keys(value).every((key) => keySet.has(key));
}
function isNonEmptyString(value, maxBytes = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || value.length === 0) return false;
  const size = utf8ByteLength(value);
  return size !== null && size <= maxBytes;
}
function utf8ByteLength(value) {
  let size = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 55296 && codePoint <= 57343) return null;
    if (codePoint <= 127) size += 1;
    else if (codePoint <= 2047) size += 2;
    else if (codePoint <= 65535) size += 3;
    else size += 4;
  }
  return size;
}
function unicodeScalarCompare(left, right) {
  const a = [...left].map((char) => char.codePointAt(0));
  const b = [...right].map((char) => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index])
      return a[index] - b[index];
  }
  return a.length - b.length;
}
function conservativeJsonStringBudget(value) {
  let size = 2;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 55296 && codePoint <= 57343) return null;
    if (codePoint <= 31) size += 6;
    else if (codePoint === 34 || codePoint === 92) size += 2;
    else {
      const bytes = utf8ByteLength(char);
      if (bytes === null) return null;
      size += bytes;
    }
  }
  return size;
}
function conservativeJsonSizeBudget(value) {
  const ancestors = /* @__PURE__ */ new WeakSet();
  const visit = (current) => {
    if (current === null) return 4;
    if (typeof current === "boolean") return current ? 4 : 5;
    if (typeof current === "number")
      return Number.isFinite(current) ? 24 : null;
    if (typeof current === "string")
      return conservativeJsonStringBudget(current);
    if (typeof current !== "object") return null;
    if (ancestors.has(current)) return null;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        let size2 = 2 + Math.max(0, current.length - 1);
        for (const item of current) {
          const itemSize = visit(item);
          if (itemSize === null) return null;
          size2 += itemSize;
        }
        return size2;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(current).length > 0) {
        return null;
      }
      const object = current;
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
function serializedJsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === void 0 ? null : utf8ByteLength(serialized);
  } catch {
    return null;
  }
}
function a2aMessageTextWithinLimit(value) {
  return value.parts.every((part) => {
    if (part.text === void 0) return true;
    const size = utf8ByteLength(part.text);
    return size !== null && size <= A2A_PROTOCOL_LIMITS.messageTextBytes;
  });
}
function a2aArtifactWithinLimits(value) {
  if (value.name !== void 0 && (utf8ByteLength(value.name) === null || utf8ByteLength(value.name) > A2A_PROTOCOL_LIMITS.artifactLabelBytes)) {
    return false;
  }
  return value.parts.every((part) => {
    if (part.text !== void 0 && (utf8ByteLength(part.text) === null || utf8ByteLength(part.text) > A2A_PROTOCOL_LIMITS.artifactValueBytes)) {
      return false;
    }
    if (part.url !== void 0 && (utf8ByteLength(part.url) === null || utf8ByteLength(part.url) > A2A_PROTOCOL_LIMITS.artifactValueBytes)) {
      return false;
    }
    if (part.data !== void 0) {
      const size = typeof part.data === "string" ? utf8ByteLength(part.data) : conservativeJsonSizeBudget(part.data);
      if (size === null || size > A2A_PROTOCOL_LIMITS.artifactValueBytes) {
        return false;
      }
    }
    return true;
  });
}
function validA2aMessage(value, textLimit = false, partsLimit = false) {
  const result = validateA2aMessage(value);
  const partsBudget = result.valid ? serializedJsonByteLength(result.value.parts) : null;
  return result.valid && conservativeJsonSizeBudget(value) !== null && (!partsLimit || partsBudget !== null && partsBudget <= A2A_PROTOCOL_LIMITS.messagePartsBytes) && (!textLimit || a2aMessageTextWithinLimit(result.value));
}
function validA2aArtifact(value) {
  const task = validateA2aTask({
    id: "contract-validation",
    status: { state: "SUBMITTED" },
    artifacts: [value]
  });
  return task.valid && conservativeJsonSizeBudget(value) !== null && a2aArtifactWithinLimits(task.value.artifacts?.[0]);
}
function validTaskUpdateDiagnostics(value) {
  if (!Array.isArray(value) || value.length > A2A_PROTOCOL_LIMITS.diagnosticsPerUpdate)
    return false;
  let aggregate = 0;
  for (const item of value) {
    if (!isPlainObject2(item) || !hasOnlyKeys(item, ["kind", "reasonCode", "message", "details"]) || typeof item.kind !== "string" || !A2A_TASK_TYPE_PATTERN.test(item.kind) || item.reasonCode !== void 0 && typeof item.reasonCode !== "string" || item.message !== void 0 && typeof item.message !== "string" || item.details !== void 0 && !isPlainObject2(item.details))
      return false;
    const reasonBytes = item.reasonCode === void 0 ? 0 : utf8ByteLength(item.reasonCode);
    const messageBytes = item.message === void 0 ? 0 : utf8ByteLength(item.message);
    const detailsBytes = item.details === void 0 || Object.keys(item.details).length === 0 ? 0 : utf8ByteLength(JSON.stringify(item.details));
    if (reasonBytes === null || messageBytes === null || detailsBytes === null)
      return false;
    aggregate += reasonBytes + messageBytes + detailsBytes;
  }
  return aggregate <= A2A_PROTOCOL_LIMITS.diagnosticsBytesPerUpdate;
}
function isRevision(value) {
  return typeof value === "string" && DECIMAL_REVISION_RE.test(value);
}
function isTaskType(value) {
  return typeof value === "string" && A2A_TASK_TYPE_PATTERN.test(value);
}
function isDispatchEventContext(value) {
  if (!isPlainObject2(value) || !hasOnlyKeys(value, ["origin", "sender", "provider", "delivery_id"]) || !isPlainObject2(value.sender) || !hasOnlyKeys(value.sender, ["kind", "identity"]))
    return false;
  const sender = value.sender;
  if (value.origin === "send") {
    return (sender.kind === "user" || sender.kind === "agent") && typeof sender.identity === "string" && UUID_RE.test(sender.identity) && value.provider === void 0 && value.delivery_id === void 0;
  }
  return value.origin === "webhook" && sender.kind === "coordinator" && sender.identity === "spellguard" && isNonEmptyString(value.provider, A2A_PROTOCOL_LIMITS.identifierBytes) && isNonEmptyString(value.delivery_id, A2A_PROTOCOL_LIMITS.identifierBytes);
}
var DELIVERY_OUTCOMES = /* @__PURE__ */ new Set([
  "injected",
  "resumed",
  "ledger_only",
  "delivery_failed"
]);
function isDeliveryOutcome(value) {
  return typeof value === "string" && DELIVERY_OUTCOMES.has(value);
}
function isTaskTypeList(value) {
  return Array.isArray(value) && value.every(isTaskType);
}
function isBlockedTaskTypes(value) {
  return Array.isArray(value) && value.every(
    (entry) => isPlainObject2(entry) && hasOnlyKeys(entry, ["task_type", "cause"]) && isTaskType(entry.task_type) && isNonEmptyString(entry.cause, 500)
  );
}
function isHandlerInventory(value) {
  return Array.isArray(value) && value.every(
    (entry) => isPlainObject2(entry) && hasOnlyKeys(entry, [
      "task_type",
      "state",
      "path",
      "installed_hash",
      "current_hash",
      "dist_hash",
      "blocking_cause"
    ]) && isTaskType(entry.task_type) && typeof entry.state === "string" && HANDLER_STATES.has(entry.state) && isNonEmptyString(entry.path, 4096) && (entry.installed_hash === void 0 || isNonEmptyString(entry.installed_hash, 256)) && (entry.current_hash === void 0 || isNonEmptyString(entry.current_hash, 256)) && (entry.dist_hash === void 0 || isNonEmptyString(entry.dist_hash, 256)) && (entry.blocking_cause === void 0 || isNonEmptyString(entry.blocking_cause, 500))
  );
}
function isConfigApplication(value) {
  return isRevision(value.config_revision) && isTaskTypeList(value.applied_task_types) && isBlockedTaskTypes(value.blocked_task_types) && (value.superseded === void 0 || typeof value.superseded === "boolean");
}
function isMaintenanceApplication(value) {
  return isNonEmptyString(value.operation_id, 256) && (value.status === "applied" || value.status === "blocked") && isRevision(value.config_revision) && (value.reason === void 0 || isNonEmptyString(value.reason, 500));
}
var PUBLIC_TASK_RESPONSE_KEYS = [
  "id",
  "contextId",
  "organizationId",
  "senderKind",
  "senderAgentId",
  "senderUserId",
  "recipientAgentId",
  "originatingAgentId",
  "originatingAgentIdentity",
  "originatingSessionId",
  "framework",
  "type",
  "state",
  "artifactUrl",
  "metadata",
  "resultPayload",
  "deferred",
  "lastProgressAt",
  "lastSupervisionKeepaliveAt",
  "effectiveDeadlineAt",
  "workingTimeoutSeconds",
  "hasUnansweredWorkerMessage",
  "threadRecordCount",
  "threadWriteAttemptCount",
  "suppressedMessageCount",
  "suppressedProgressCount",
  "artifactCount",
  "terminalAt",
  "createdAt",
  "updatedAt"
];
var TASK_SUMMARY_RESPONSE_KEYS = [
  ...PUBLIC_TASK_RESPONSE_KEYS.filter(
    (key) => key !== "originatingAgentId" && key !== "originatingAgentIdentity" && key !== "originatingSessionId"
  ),
  "typeLabel",
  "stateLabel"
];
function nullableString(value) {
  return value === null || typeof value === "string";
}
function exactKeys(value, keys) {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}
function validTaskResponseBase(value, summary) {
  const keys = summary ? TASK_SUMMARY_RESPONSE_KEYS : PUBLIC_TASK_RESPONSE_KEYS;
  return exactKeys(value, keys) && isNonEmptyString(value.id) && isNonEmptyString(value.contextId) && isNonEmptyString(value.organizationId) && (value.senderKind === "agent" || value.senderKind === "coordinator" || value.senderKind === "user") && nullableString(value.senderAgentId) && nullableString(value.senderUserId) && isNonEmptyString(value.recipientAgentId) && (summary || nullableString(value.originatingAgentId) && nullableString(value.originatingAgentIdentity) && nullableString(value.originatingSessionId)) && nullableString(value.framework) && isNonEmptyString(value.type) && A2A_TASK_STATES.includes(value.state) && nullableString(value.artifactUrl) && isPlainObject2(value.metadata) && typeof value.deferred === "boolean" && nullableString(value.lastProgressAt) && nullableString(value.lastSupervisionKeepaliveAt) && nullableString(value.effectiveDeadlineAt) && (value.workingTimeoutSeconds === null || typeof value.workingTimeoutSeconds === "number") && typeof value.hasUnansweredWorkerMessage === "boolean" && typeof value.threadRecordCount === "number" && typeof value.threadWriteAttemptCount === "number" && typeof value.suppressedMessageCount === "number" && typeof value.suppressedProgressCount === "number" && typeof value.artifactCount === "number" && nullableString(value.terminalAt) && isNonEmptyString(value.createdAt) && isNonEmptyString(value.updatedAt) && (!summary || isNonEmptyString(value.typeLabel) && isNonEmptyString(value.stateLabel));
}
function validatePublicTaskResponse(value) {
  return isPlainObject2(value) && validTaskResponseBase(value, false);
}
function validateTaskDetailResponse(value) {
  if (!isPlainObject2(value)) return false;
  const { thread, artifacts, diagnostics, ...summary } = value;
  return validTaskResponseBase(summary, true) && Array.isArray(thread) && Array.isArray(artifacts) && Array.isArray(diagnostics) && thread.every(validateTaskThreadResponse) && artifacts.every(validateTaskArtifactResponse) && diagnostics.every(validateTaskDiagnosticResponse);
}
function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function validateTaskThreadResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "sequence",
    "recordKind",
    "messageId",
    "senderRole",
    "senderKind",
    "senderAgentId",
    "senderAgentIdentity",
    "senderUserId",
    "senderUserIdentity",
    "senderDisplayName",
    "text",
    "parts",
    "postTerminal",
    "deliveryState",
    "deliveryReason",
    "terminalState",
    "terminalCause",
    "createdAt"
  ]) && isNonEmptyString(value.id) && nonnegativeInteger(value.sequence) && (value.recordKind === "progress" || value.recordKind === "message" || value.recordKind === "terminal") && nullableString(value.messageId) && (value.senderRole === null || value.senderRole === "USER" || value.senderRole === "AGENT") && (value.senderKind === null || value.senderKind === "agent" || value.senderKind === "user" || value.senderKind === "coordinator" || value.senderKind === "handler" || value.senderKind === "daemon") && nullableString(value.senderAgentId) && nullableString(value.senderAgentIdentity) && nullableString(value.senderUserId) && nullableString(value.senderUserIdentity) && nullableString(value.senderDisplayName) && nullableString(value.text) && typeof value.postTerminal === "boolean" && nullableString(value.deliveryState) && nullableString(value.deliveryReason) && (value.terminalState === null || A2A_TASK_STATES.includes(value.terminalState)) && (value.terminalCause === null || isPlainObject2(value.terminalCause)) && isNonEmptyString(value.createdAt);
}
function validateTaskArtifactResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "artifactId",
    "sequence",
    "type",
    "value",
    "displayLabel",
    "metadata",
    "createdAt"
  ]) && isNonEmptyString(value.id) && isNonEmptyString(value.artifactId) && nonnegativeInteger(value.sequence) && isNonEmptyString(value.type) && typeof value.value === "string" && nullableString(value.displayLabel) && isPlainObject2(value.metadata) && isNonEmptyString(value.createdAt);
}
function validateTaskDiagnosticResponse(value) {
  return isPlainObject2(value) && exactKeys(value, [
    "id",
    "sequence",
    "kind",
    "reasonCode",
    "message",
    "details",
    "createdAt"
  ]) && isNonEmptyString(value.id) && nonnegativeInteger(value.sequence) && isNonEmptyString(value.kind) && nullableString(value.reasonCode) && nullableString(value.message) && isPlainObject2(value.details) && isNonEmptyString(value.createdAt);
}
function validateA2aAckResult(value) {
  if (!isPlainObject2(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "task_update":
      return hasOnlyKeys(value, ["kind", "outcome", "response"]) && (value.outcome === "persisted" || value.outcome === "already_terminal" || value.outcome === "thread_bound_reached") && (value.response === void 0 || validatePublicTaskResponse(value.response));
    case "message":
      return hasOnlyKeys(value, ["kind", "outcome", "message_id", "response"]) && value.outcome === "persisted" && isNonEmptyString(value.message_id) && (value.response === void 0 || isPlainObject2(value.response) && exactKeys(value.response, ["messageId", "postTerminal"]) && isNonEmptyString(value.response.messageId) && typeof value.response.postTerminal === "boolean");
    case "task_create":
      return hasOnlyKeys(value, ["kind", "task", "outcome", "response"]) && validateA2aTask(value.task).valid && conservativeJsonSizeBudget(value.task) !== null && (value.outcome === void 0 || value.outcome === "created" || value.outcome === "duplicate" || value.outcome === "delivery_failed" || // Acceptance, not failure: the recipient box was asleep, the task is
      // durably parked and a wake was requested. The server emits this for
      // task_create; rejecting it drops the entire ack frame (see the
      // declared `A2aAckResult` union and the Go daemon's mirror).
      value.outcome === "pending_wake") && (value.response === void 0 || validatePublicTaskResponse(value.response));
    case "task_read":
      return hasOnlyKeys(value, ["kind", "task", "response"]) && validateA2aTask(value.task).valid && conservativeJsonSizeBudget(value.task) !== null && (value.response === void 0 || validateTaskDetailResponse(value.response));
    case "config_applied":
      return hasOnlyKeys(value, [
        "kind",
        "config_revision",
        "applied_task_types",
        "blocked_task_types",
        "superseded"
      ]) && isConfigApplication(value);
    case "maintenance":
      return hasOnlyKeys(value, [
        "kind",
        "operation_id",
        "status",
        "config_revision",
        "reason"
      ]) && isMaintenanceApplication(value);
    default:
      return false;
  }
}
function validateA2aContractFrame(value, direction) {
  if (!isPlainObject2(value) || typeof value.type !== "string") return false;
  const serverBase = direction === "server" && isNonEmptyString(value.seq) && isNonEmptyString(value.ts);
  const clientBase = direction === "client" && isNonEmptyString(value.client_msg_id, A2A_PROTOCOL_LIMITS.identifierBytes);
  switch (value.type) {
    case "a2a_task_dispatch":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "task",
        "message",
        "framework",
        "recipient_agent_id",
        "sender_agent_id",
        "org_id",
        "event_context"
      ]) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && (value.sender_agent_id === void 0 || isNonEmptyString(
        value.sender_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.org_id === void 0 || isNonEmptyString(
        value.org_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework)) && (value.event_context === void 0 || isDispatchEventContext(value.event_context)) && validateA2aTask(value.task).valid && validateA2aMessage(value.message).valid;
    case "config_updated":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "config",
        "triggers_rotation",
        "config_revision"
      ]) && isPlainObject2(value.config) && typeof value.triggers_rotation === "boolean" && isRevision(value.config_revision);
    case "a2a_maintenance":
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "operation_id",
        "action",
        "config_revision"
      ]) && isNonEmptyString(value.operation_id, 256) && value.action === "backfill" && isRevision(value.config_revision);
    case "a2a_config_applied":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "config_revision",
        "applied_task_types",
        "blocked_task_types",
        "superseded"
      ]) && isConfigApplication(value);
    case "a2a_handler_inventory":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "config_revision",
        "handlers"
      ]) && isRevision(value.config_revision) && isHandlerInventory(value.handlers);
    case "a2a_maintenance_result":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "operation_id",
        "status",
        "config_revision",
        "reason"
      ]) && isMaintenanceApplication(value);
    case "a2a_supervision_keepalive":
    case "a2a_task_read":
    case "a2a_deferred_accepted":
      return clientBase && hasOnlyKeys(value, ["type", "client_msg_id", "taskId"]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes);
    case "a2a_message_delivery":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "taskId",
        "messageId",
        "reason",
        "outcome"
      ]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) && isNonEmptyString(
        value.messageId,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && isDeliveryOutcome(value.outcome) && // A clean injection needs no explanation; every other terminal state
      // must name why, so no message ends as an unexplained failure.
      (value.outcome === "injected" ? value.reason === void 0 : isNonEmptyString(value.reason, A2A_PROTOCOL_LIMITS.identifierBytes));
    case "a2a_session_register":
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "session_id",
        "framework",
        "working_directory",
        "taskId"
      ]) && isNonEmptyString(value.session_id, 256) && typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework) && isNonEmptyString(value.working_directory, 4096) && (value.taskId === void 0 || isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes));
    case "a2a_task_create": {
      const messageBudget = conservativeJsonSizeBudget(value.message);
      const frameBudget = conservativeJsonSizeBudget(value);
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "recipient_agent_id",
        "task_type",
        "idempotency_key",
        "message",
        "originating_session_id"
      ]) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && isTaskType(value.task_type) && isNonEmptyString(value.idempotency_key, 256) && validA2aMessage(value.message, true) && messageBudget !== null && messageBudget <= A2A_PROTOCOL_LIMITS.taskCreateInputBytes && frameBudget !== null && frameBudget - messageBudget <= A2A_PROTOCOL_LIMITS.taskCreateEnvelopeBytes && (value.originating_session_id === void 0 || isNonEmptyString(value.originating_session_id, 256));
    }
    case "a2a_task_update": {
      const artifacts = value.artifacts;
      const artifact = value.artifact;
      const artifactsValid = artifacts === void 0 || Array.isArray(artifacts) && artifacts.every(validA2aArtifact);
      const artifactValid = artifact === void 0 || validA2aArtifact(artifact);
      const artifactCount = (artifact === void 0 ? 0 : 1) + (Array.isArray(artifacts) ? artifacts.length : 0);
      const resultBudget = value.result === void 0 ? 0 : conservativeJsonSizeBudget(value.result);
      return clientBase && hasOnlyKeys(value, [
        "type",
        "client_msg_id",
        "taskId",
        "state",
        "message",
        "artifact",
        "artifacts",
        "result",
        "diagnostics",
        "reasonSource",
        "deferred",
        "framework"
      ]) && isNonEmptyString(value.taskId, A2A_PROTOCOL_LIMITS.identifierBytes) && typeof value.state === "string" && A2A_TASK_STATES.includes(value.state) && (value.message === void 0 || validA2aMessage(value.message, true)) && artifactValid && artifactsValid && artifactCount <= A2A_PROTOCOL_LIMITS.artifactsPerUpdate && resultBudget !== null && resultBudget <= A2A_PROTOCOL_LIMITS.taskUpdateResultBytes && (value.diagnostics === void 0 || validTaskUpdateDiagnostics(value.diagnostics)) && // Present-or-absent, and 'handler' is the ONLY admissible value: a
      // daemon-authored reason is the default, so there is no positive daemon
      // marker to accept — anything else is drift and fails the whole frame.
      (value.reasonSource === void 0 || value.reasonSource === "handler") && (value.deferred === void 0 || value.deferred === true && value.state === "WORKING") && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework));
    }
    case "a2a_message": {
      const common = validA2aMessage(value.message, true, true) && isNonEmptyString(
        value.recipient_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      ) && (value.sender_agent_id === void 0 || isNonEmptyString(
        value.sender_agent_id,
        A2A_PROTOCOL_LIMITS.identifierBytes
      )) && (value.framework === void 0 || typeof value.framework === "string" && CANONICAL_FRAMEWORKS.has(value.framework)) && (value.target_session_id === void 0 || isNonEmptyString(value.target_session_id, 256));
      if (direction === "client") {
        return clientBase && hasOnlyKeys(value, [
          "type",
          "client_msg_id",
          "message",
          "recipient_agent_id",
          "sender_agent_id",
          "framework",
          "target_session_id"
        ]) && common;
      }
      return serverBase && hasOnlyKeys(value, [
        "type",
        "seq",
        "ts",
        "message",
        "recipient_agent_id",
        "sender_agent_id",
        "framework",
        "org_id",
        "target_session_id"
      ]) && common && (value.org_id === void 0 || isNonEmptyString(value.org_id, A2A_PROTOCOL_LIMITS.identifierBytes));
    }
    default:
      return false;
  }
}
function isGeneralizedServerEnvelopeValid(obj) {
  if (obj.type === "ack" && obj.result !== void 0) {
    return validateA2aAckResult(obj.result);
  }
  if (obj.type === "config_updated" && obj.config_revision !== void 0) {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_maintenance") {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_task_dispatch") {
    return validateA2aContractFrame(obj, "server");
  }
  if (obj.type === "a2a_message") {
    return validateA2aContractFrame(obj, "server");
  }
  return true;
}
var KNOWN_SERVER_FRAME_TYPES = /* @__PURE__ */ new Set([
  "hello",
  "credential_delivered",
  "credential_rotated",
  "credential_revoked",
  "github_grants_bundle",
  "github_grants_commit_confirmed",
  "config_updated",
  "ack",
  "error",
  "resume_window_exceeded",
  "login_code",
  "login_restart",
  "slack_event",
  "slack_event_blocked",
  "teams_activity",
  "teams_activity_blocked",
  // A2A collaboration-plane down frames (Task T2). `a2a_message` is
  // bidirectional; this is its server→box direction.
  "a2a_task_dispatch",
  "a2a_message",
  "a2a_maintenance"
]);
var A2A_FRAME_TYPES = /* @__PURE__ */ new Set([
  "a2a_config_applied",
  "a2a_deferred_accepted",
  "a2a_message_delivery",
  "a2a_handler_inventory",
  "a2a_maintenance",
  "a2a_maintenance_result",
  "a2a_task_dispatch",
  "a2a_task_update",
  "a2a_message",
  "a2a_session_register",
  "a2a_supervision_keepalive",
  "a2a_task_create",
  "a2a_task_read"
]);
function isA2aFrame(frame) {
  if (!frame || typeof frame !== "object") return false;
  return A2A_FRAME_TYPES.has(frame.type);
}
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
  if (obj.type === "github_grants_bundle") {
    if (!isGithubGrantsBundle(obj)) return null;
    return obj;
  }
  if (obj.type === "github_grants_commit_confirmed") {
    if (!hasOnlyKeys(obj, [
      "type",
      "protocol_version",
      "seq",
      "ts",
      "delivery_id",
      "grant_set_revision"
    ]) || obj.protocol_version !== "5" || typeof obj.seq !== "string" || typeof obj.ts !== "string" || typeof obj.delivery_id !== "string" || !UUID_RE.test(obj.delivery_id) || !isRevision(obj.grant_set_revision))
      return null;
    return obj;
  }
  if (A2A_FRAME_TYPES.has(obj.type) && conservativeJsonSizeBudget(obj) === null)
    return null;
  if (obj.type === "login_code") {
    if (typeof obj.code !== "string" || obj.code.length === 0) return null;
  }
  if (!isGeneralizedServerEnvelopeValid(obj)) return null;
  if (!isA2aServerPayloadValid(obj)) return null;
  return obj;
}
function isGithubGrantsBundle(value) {
  if (!hasOnlyKeys(value, [
    "type",
    "protocol_version",
    "seq",
    "ts",
    "delivery_id",
    "grant_set_revision",
    "credentials"
  ]) || value.protocol_version !== "5" || typeof value.seq !== "string" || typeof value.ts !== "string" || typeof value.delivery_id !== "string" || !UUID_RE.test(value.delivery_id) || !isRevision(value.grant_set_revision) || !Array.isArray(value.credentials))
    return false;
  const grantIds = /* @__PURE__ */ new Set();
  const installationIds = /* @__PURE__ */ new Set();
  const credentialIds = /* @__PURE__ */ new Set();
  const scopedTokenIds = /* @__PURE__ */ new Set();
  const numericInstallationIds = /* @__PURE__ */ new Set();
  const owners = /* @__PURE__ */ new Set();
  let memberAgentId;
  for (const raw of value.credentials) {
    if (!isPlainObject2(raw)) return false;
    const scope = raw.scope;
    const providerData = raw.provider_data;
    if (!hasOnlyKeys(raw, [
      "grant_id",
      "installation_record_id",
      "credential_id",
      "scoped_token_id",
      "agent_id",
      "provider",
      "kind",
      "status",
      "grant_revision",
      "grant_set_revision",
      "github_org_login",
      "github_org_display_name",
      "installation_id",
      "expires_at",
      "scoped_token",
      "access",
      "scope",
      "provider_data"
    ]) || raw.provider !== "github" || raw.kind !== "issued" || raw.status !== "valid" || typeof raw.grant_id !== "string" || !UUID_RE.test(raw.grant_id) || typeof raw.installation_record_id !== "string" || !UUID_RE.test(raw.installation_record_id) || typeof raw.credential_id !== "string" || !UUID_RE.test(raw.credential_id) || // NOT a UUID, unlike the four relational ids around it. This is GitHub's
    // INSTALLATION-TOKEN id — a number the mint path stringifies
    // (`scopedTokenId()` in `services/github/github-api.ts`) into the `text`
    // column `credentials.scoped_token_id`; real rows look like `5249971925`.
    // A UUID test here rejected every bundle the server actually sends, so a
    // marked agent's credential store stayed empty and git kept 401ing. It is
    // an OPAQUE identifier everywhere else in the codebase (the API contract
    // types it `z.string().min(1)`), and it is validated as one here: present,
    // a string, non-empty. Uniqueness within the bundle is still enforced
    // below.
    typeof raw.scoped_token_id !== "string" || raw.scoped_token_id.length === 0 || typeof raw.agent_id !== "string" || !UUID_RE.test(raw.agent_id) || !isRevision(raw.grant_revision) || raw.grant_set_revision !== value.grant_set_revision || typeof raw.github_org_login !== "string" || raw.github_org_login.length === 0 || typeof raw.github_org_display_name !== "string" || raw.github_org_display_name.trim().length === 0 || typeof raw.installation_id !== "number" || !Number.isSafeInteger(raw.installation_id) || raw.installation_id <= 0 || typeof raw.expires_at !== "string" || !Number.isFinite(Date.parse(raw.expires_at)) || typeof raw.scoped_token !== "string" || raw.scoped_token.length === 0 || !["read", "write"].includes(raw.access) || !isPlainObject2(scope) || !isPlainObject2(providerData) || !hasOnlyKeys(providerData, [
      "github_user_id",
      "github_login",
      "github_user_email",
      "git_author_name",
      "git_author_email"
    ]) || typeof providerData.github_user_id !== "number" || !Number.isSafeInteger(providerData.github_user_id) || // Strictly positive: no GitHub account has id 0, and 0 is precisely the
    // placeholder a missing identity used to produce server-side. The
    // plugins write this into the box's real git config, so a bundle whose
    // committer resolves to nobody is refused at the boundary too.
    providerData.github_user_id <= 0 || typeof providerData.github_login !== "string" || providerData.github_login.trim().length === 0 || !(providerData.github_user_email === null || typeof providerData.github_user_email === "string") || typeof providerData.git_author_name !== "string" || providerData.git_author_name.trim().length === 0 || typeof providerData.git_author_email !== "string" || providerData.git_author_email.trim().length === 0)
      return false;
    const owner = raw.github_org_login;
    const validScope = scope.mode === "all" && hasOnlyKeys(scope, ["mode"]) || scope.mode === "selected" && hasOnlyKeys(scope, ["mode", "repository_names"]) && Array.isArray(scope.repository_names) && scope.repository_names.length > 0 && scope.repository_names.every((name) => {
      if (typeof name !== "string" || name !== name.toLowerCase())
        return false;
      const parts = name.split("/");
      return parts.length === 2 && parts[0] === owner.toLowerCase() && parts[1].length > 0;
    }) && new Set(scope.repository_names).size === scope.repository_names.length;
    if (!validScope) return false;
    const normalizedLogin = owner.toLowerCase();
    if (grantIds.has(raw.grant_id) || installationIds.has(raw.installation_record_id) || credentialIds.has(raw.credential_id) || scopedTokenIds.has(raw.scoped_token_id) || numericInstallationIds.has(raw.installation_id) || memberAgentId !== void 0 && memberAgentId !== raw.agent_id || owners.has(normalizedLogin))
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
function isA2aServerPayloadValid(obj) {
  if (obj.type === "a2a_task_dispatch") {
    return validateA2aTask(obj.task).valid && validateA2aMessage(obj.message).valid && conservativeJsonSizeBudget(obj.task) !== null && conservativeJsonSizeBudget(obj.message) !== null;
  }
  if (obj.type === "a2a_message") {
    return validA2aMessage(obj.message, true, true) && conservativeJsonSizeBudget(obj.message) !== null;
  }
  return true;
}
var AGENT_CONTROL_CLOSE_CODES = {
  NORMAL: 1e3,
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
  AGENT_SUSPENDED: 4423
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
var AGENT_SUSPENDED_CLOSE_REASON = "quarantined";
var AGENT_SUSPEND_CAPABILITY = "agent_suspend_v1";
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
  opts;
  #ps = null;
  /** Preserve wire order across async receiver durability hooks. */
  #messageChain = Promise.resolve();
  #closed = false;
  #lastServerSeq;
  #knownCredentials;
  /** True only for a connection whose query advertised `resume=always`. */
  #resumeAlwaysConnection = false;
  #firstConnect = true;
  #pendingRequests = /* @__PURE__ */ new Map();
  // Serializes refresh requests because `credential_delivered` carries no
  // `client_msg_id` correlation: with two requests in flight, the dispatcher
  // would resolve them out-of-order. This serialization can be dropped if the
  // protocol later grows an `in_response_to` correlation field.
  #refreshChain = Promise.resolve();
  // Redacted replay and the following divergence pass can announce the same
  // issued identity before its first refresh completes. Keep one refresh per
  // identity in flight so the second notice cannot rotate it again after the
  // first response settles.
  #redactedRefreshesInFlight = /* @__PURE__ */ new Set();
  // Rotation-fallback timers. Key = seq of the config_updated frame.
  // Cleared when a credential_rotated arrives before the 10s window expires.
  #rotationTimers = /* @__PURE__ */ new Map();
  // FIND-DA22 — keepalive heartbeat state. The timer fires every
  // heartbeatIntervalMs; #lastPongAt tracks the last observed 'pong' (clock
  // value, via the injectable #now()) so the timer can detect a zombie socket.
  #heartbeatTimer = null;
  #lastPongAt = 0;
  /** Consecutive HTTP-upgrade auth failures seen before a socket opens. */
  #consecutiveUpgradeAuthFailures = 0;
  /**
   * #1348: the last suspended (4423) wait, or null while the session is
   * healthy. A suspended reconnect still opens (hello, then 4423), so this
   * resets only on a frame past the hello, never on `open`.
   */
  #suspendedDelayMs = null;
  #suspendedTimer = null;
  /** Open the socket. Subsequent reconnects are automatic. */
  start() {
    if (this.#closed || this.#ps) return;
    const BaseImpl = this.opts.WebSocketImpl ?? WebSocket;
    const Impl = makeErrorSafeWebSocket(
      BaseImpl,
      this.opts.upgradeHeaders,
      (err) => this.#observeUpgradeError(err)
    );
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
      this.#consecutiveUpgradeAuthFailures = 0;
      void this.#onOpen();
    });
    ps.addEventListener("message", (e) => {
      this.#messageChain = this.#messageChain.then(
        () => this.#handleMessage(e)
      );
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
      if (code === AGENT_CONTROL_CLOSE_CODES.AGENT_SUSPENDED) {
        this.#suspend(reason);
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
  /**
   * #1348: the agent is quarantined. PartySocket has already queued its own
   * quick retry (its close handler reconnects before listeners run), so stop
   * it and reconnect on the suspended backoff instead. Identity stays.
   */
  #suspend(reason) {
    const ps = this.#ps;
    if (this.#closed || !ps) return;
    ps.close();
    const { initial, max } = this.opts.suspendedBackoffMs ?? {
      initial: 3e4,
      max: 3e5
    };
    const retryInMs = this.#suspendedDelayMs === null ? initial : Math.min(this.#suspendedDelayMs * 2, max);
    this.#suspendedDelayMs = retryInMs;
    if (this.#suspendedTimer) clearTimeout(this.#suspendedTimer);
    this.#suspendedTimer = setTimeout(() => {
      this.#suspendedTimer = null;
      if (!this.#closed && this.#ps === ps) ps.reconnect();
    }, retryInMs);
    this.#knownCredentials = [];
    void Promise.resolve().then(() => this.opts.onKnownCredentialsChanged?.([])).then(() => this.opts.onSuspended?.({ reason, retryInMs })).catch(
      (err) => this.opts.onError?.(
        err instanceof Error ? err : new Error(String(err))
      )
    );
  }
  #observeUpgradeError(err) {
    if (isUpgradeUnauthorized(err)) {
      this.#consecutiveUpgradeAuthFailures += 1;
      if (this.#consecutiveUpgradeAuthFailures >= 3) {
        this.opts.onFatalClose(
          AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED,
          "http_upgrade_unauthorized"
        );
        this.close();
      }
      return;
    }
    this.#consecutiveUpgradeAuthFailures = 0;
  }
  /** Send a CredentialRequest and resolve after the durable response apply.
   *  V4 returns delivered descriptors; V5 resolves `[]` after its bundle hook
   *  commits. Times out if no matching response arrives within `timeoutMs`. */
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
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error("credential_request_timeout"));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve,
        reject,
        timer,
        requestedProvider: args.provider,
        requestedReason: args.reason,
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
          ...update.message ? { message: update.message } : {},
          // T4.3 — carry the per-frame framework discriminator when the caller
          // (the multiplexed Go box daemon) supplies it. Omitted for the
          // single-framework Node daemon path so its frame stays byte-identical.
          ...update.framework ? { framework: update.framework } : {}
        })
      );
    } catch {
    }
  }
  /** Close the socket and stop reconnecting. */
  close() {
    this.#closed = true;
    if (this.#suspendedTimer) clearTimeout(this.#suspendedTimer);
    this.#suspendedTimer = null;
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
  /**
   * #1348: the Resume capabilities. AGENT_SUSPEND_CAPABILITY is added only
   * when the plugin wired `onSuspended`, since only then does a suspension
   * drop what it placed; a client that can't must keep getting 4401.
   */
  #resumeCapabilities() {
    if (!this.opts.onSuspended) return this.opts.capabilities;
    return [...this.opts.capabilities ?? [], AGENT_SUSPEND_CAPABILITY];
  }
  async #buildQuery() {
    const creds = await this.opts.credentials();
    if (creds.mode === "secret") {
      this.#resumeAlwaysConnection = true;
      return {
        agent_secret: creds.agentSecret,
        resume: "always",
        ...creds.framework ? { framework: creds.framework } : {},
        ...this.opts.onSuspended ? { suspend: "1" } : {}
      };
    }
    this.#resumeAlwaysConnection = false;
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
    if (!this.#ps || !this.#resumeAlwaysConnection) return;
    this.#ps.send(
      JSON.stringify({
        type: "resume",
        client_msg_id: crypto.randomUUID(),
        last_server_seq: this.#lastServerSeq,
        known_credentials: this.#knownCredentials,
        capabilities: this.#resumeCapabilities()
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
    if (frame.type !== "hello") this.#suspendedDelayMs = null;
    try {
      await this.#dispatch(frame);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
  /**
   * A V5 bundle is a complete authoritative GitHub set but carries no request
   * correlation id. Refresh requests are serialized, so at most one pending
   * request can match. A scoped refresh is satisfied only when the full set no
   * longer contains the superseded id; an unscoped manual issuance is
   * satisfied only by a secret-bearing set. The caller invokes this strictly
   * after the receiver's durable apply hook succeeds.
   */
  #settlePendingGithubGrantBundle(frame) {
    const activeIds = new Set(
      frame.credentials.map((credential) => credential.scoped_token_id)
    );
    for (const [id, pending] of this.#pendingRequests) {
      if (pending.requestedProvider !== "github") continue;
      const matches = pending.supersededScopedTokenId ? !activeIds.has(pending.supersededScopedTokenId) : pending.requestedReason === "manual" && frame.credentials.length > 0;
      if (!matches) continue;
      clearTimeout(pending.timer);
      if (pending.supersededScopedTokenId) {
        this.#dropKnownCredential(
          pending.supersededProvider,
          pending.supersededScopedTokenId
        );
      }
      pending.resolve([]);
      this.#pendingRequests.delete(id);
      break;
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
          if (this.#ps && this.#resumeAlwaysConnection) {
            this.#ps.send(
              JSON.stringify({
                type: "resume",
                client_msg_id: crypto.randomUUID(),
                last_server_seq: "0",
                known_credentials: preResetKnown,
                capabilities: this.#resumeCapabilities()
              })
            );
          }
          return;
        }
        this.#sendResumeIfApplicable();
        return;
      }
      case "github_grants_bundle": {
        try {
          if (!this.opts.onGithubGrantsBundle) {
            throw new Error("github_grant_bundle_v1 handler is unavailable");
          }
          await this.opts.onGithubGrantsBundle(frame);
          this.#settlePendingGithubGrantBundle(frame);
          this.#ps?.send(
            JSON.stringify({
              type: "github_grants_applied",
              protocol_version: "5",
              client_msg_id: crypto.randomUUID(),
              delivery_id: frame.delivery_id,
              grant_set_revision: frame.grant_set_revision,
              applied: true
            })
          );
          await this.#advanceSeq(frame.seq);
        } catch (error) {
          this.#ps?.send(
            JSON.stringify({
              type: "github_grants_applied",
              protocol_version: "5",
              client_msg_id: crypto.randomUUID(),
              delivery_id: frame.delivery_id,
              grant_set_revision: frame.grant_set_revision,
              applied: false,
              error_code: "durable_apply_failed"
            })
          );
          throw error;
        }
        return;
      }
      case "github_grants_commit_confirmed":
        await this.opts.onGithubGrantsCommitConfirmed?.(frame);
        await this.#advanceSeq(frame.seq);
        return;
      case "credential_delivered": {
        const isBootstrapCause = frame.cause === "bootstrap" || frame.cause === "re_bootstrap";
        const incomplete = this.#incompleteCredentials(frame.credentials);
        if (!isBootstrapCause && await this.#handleIfIncomplete(
          frame.credentials,
          frame.seq,
          `credential_delivered{cause:'${frame.cause}'}`
        )) {
          return;
        }
        if (isBootstrapCause && incomplete.length > 0) {
          await this.#dropIncompleteKnownCredentials(incomplete);
        }
        const usableCredentials = incomplete.length > 0 ? frame.credentials.filter(
          (credential) => this.#credentialCarriesUsableSecret(credential)
        ) : frame.credentials;
        await this.opts.onCredentialDelivered(
          usableCredentials === frame.credentials ? frame : { ...frame, credentials: usableCredentials }
        );
        this.#trackKnownCredentials(usableCredentials);
        await this.#advanceSeq(frame.seq);
        if (isBootstrapCause) {
          this.#queueRefreshForBareIssued(frame.credentials);
          if (incomplete.some((credential) => credential.provider !== "github")) {
            this.#reportIncomplete(
              `credential_delivered{cause:'${frame.cause}'}`
            );
          }
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
        if (await this.#handleIfIncomplete(
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
        await this.opts.onCredentialRevokeSettled?.(frame);
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
      case "slack_event":
      case "slack_event_blocked":
      case "teams_activity":
      case "teams_activity_blocked": {
        this.#dispatchRelayFrame(frame);
        return;
      }
    }
  }
  /**
   * Fire-and-forget invocation of the relay-event handler. NEVER awaited on the
   * dispatch path (R5): a synchronous throw is caught, and a returned rejecting
   * promise gets a `.catch` — both route to `onError`, never to the socket or
   * the seq cursor. No-op when `onRelayEvent` is unwired (relay frame ignored).
   */
  #dispatchRelayFrame(frame) {
    const handler = this.opts.onRelayEvent;
    if (!handler) return;
    try {
      const r = handler(frame);
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
  }
  /**
   * Settle a frame containing a provider-incomplete descriptor. Ring replay
   * strips GitHub `scoped_token`, Slack/Discord `botToken`, Teams `password`,
   * and OpenRouter `api_key`. Remove any prior projection entry durably, leave
   * the consuming destination untouched, advance the replay cursor, and queue
   * refresh only for the issued GitHub path.
   */
  async #handleIfIncomplete(creds, seq, logLabel, supersededId) {
    const incomplete = this.#incompleteCredentials(creds);
    if (incomplete.length === 0) return false;
    await this.#dropIncompleteKnownCredentials(incomplete);
    await this.#advanceSeq(seq);
    this.#reportIncomplete(logLabel);
    this.#queueRefreshForBareIssued(creds, supersededId);
    return true;
  }
  #credentialCarriesUsableSecret(credential) {
    const raw = credential;
    switch (credential.provider) {
      case "github":
        return typeof raw.scoped_token === "string" && raw.scoped_token.length > 0;
      case "slack":
      case "discord":
        return typeof raw.botToken === "string" && raw.botToken.length > 0;
      case "teams":
        return typeof raw.password === "string" && raw.password.length > 0;
      case "openrouter":
        return typeof raw.api_key === "string" && raw.api_key.length > 0;
      default:
        return true;
    }
  }
  #incompleteCredentials(credentials) {
    return credentials.filter(
      (credential) => !this.#credentialCarriesUsableSecret(credential)
    );
  }
  async #dropIncompleteKnownCredentials(credentials) {
    const identities = new Set(
      credentials.map((credential) => {
        const raw = credential;
        const id = raw.scoped_token_id ?? credential.credential_id;
        return `${credential.provider}\0${String(id)}`;
      })
    );
    const next = this.#knownCredentials.filter(
      (known) => !identities.has(`${known.provider}\0${known.scoped_token_id}`)
    );
    if (next.length === this.#knownCredentials.length) return;
    this.#knownCredentials = next;
    await this.opts.onKnownCredentialsChanged?.(this.#knownCredentials);
  }
  #reportIncomplete(logLabel) {
    const notice = `agent-control: redacted/replay-incomplete ${logLabel} \u2014 preserving existing credential and awaiting authoritative hydration`;
    if (this.opts.onInfo) {
      this.opts.onInfo(notice);
    } else {
      this.opts.onError?.(new Error(notice));
    }
  }
  /**
   * Queue a fire-and-forget `credential_request` for each ISSUED (github)
   * credential that arrived WITHOUT a `scoped_token`. Shared by the
   * redacted-replay path (`#handleIfIncomplete`) and the bootstrap/re_bootstrap
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
      const identity = supersededId ?? issued.scoped_token_id ?? issued.credential_id;
      const refreshKey = `${issued.provider}\0${identity}`;
      if (this.#redactedRefreshesInFlight.has(refreshKey)) continue;
      this.#redactedRefreshesInFlight.add(refreshKey);
      void this.requestRefresh({
        reason: "expiry",
        provider: issued.provider,
        superseded_scoped_token_id: identity
      }).catch((err) => {
        if (err instanceof Error && (err.message === "client_closed" || err.message === "client not started")) {
          return;
        }
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err))
        );
      }).finally(() => {
        this.#redactedRefreshesInFlight.delete(refreshKey);
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
function upgradeStatusOf(err) {
  if (typeof err !== "object" || err === null) return void 0;
  const e = err;
  for (const candidate of [
    e.statusCode,
    e.status,
    e.response?.statusCode,
    e.response?.status
  ]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return void 0;
}
function isUpgradeUnauthorized(err) {
  const status = upgradeStatusOf(err);
  if (status !== void 0) return status === 401;
  const message = typeof err === "object" && err !== null && "message" in err ? String(err.message ?? "") : String(err ?? "");
  return /\b(?:http|status(?:\s+code)?|code|response|upgrade|connection)\b[\s:=]*401\b/i.test(
    message
  ) || /\b401\s+unauthorized\b/i.test(message);
}
function makeErrorSafeWebSocket(Base, headers, onUpgradeError) {
  function Wrapped(url, protocols) {
    const ws = headers ? (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols, options) signature (see above).
      new Base(url, protocols, { headers })
    ) : (
      // biome-ignore lint/suspicious/noExplicitAny: bridging to ws (url, protocols) signature (see above).
      new Base(url, protocols)
    );
    const observe = (value) => {
      const wrapped = value;
      const err = value instanceof Error ? value : wrapped.error instanceof Error ? wrapped.error : new Error(
        typeof wrapped.message === "string" ? wrapped.message : String(value)
      );
      onUpgradeError?.(err);
    };
    if (ws && typeof ws.on === "function") {
      ws.on("error", observe);
    } else if (ws && typeof ws.addEventListener === "function") {
      ws.addEventListener("error", observe);
    }
    return ws;
  }
  Wrapped.prototype = Base.prototype;
  return Wrapped;
}
var INSTANCE_FINGERPRINT_HEADER = "X-Spellguard-Instance-Fingerprint";
var INSTANCE_FINGERPRINT_MAX_LEN = 255;
var ENV = {
  BOOTSTRAP_NONCE: "SPELLGUARD_BOOTSTRAP_NONCE",
  ENDPOINT: "SPELLGUARD_ENDPOINT",
  AGENT_ID: "SPELLGUARD_AGENT_ID",
  RAILWAY_SERVICE_ID: "RAILWAY_SERVICE_ID"
};
function shouldRunManagedBootstrap(env = process.env) {
  const v = env[ENV.BOOTSTRAP_NONCE];
  return typeof v === "string" && v.length > 0;
}
async function resolveInstanceFingerprint(opts = {}) {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m) => console.warn(m));
  const fetchInstanceId = opts.fetchInstanceId ?? defaultFetchInstanceId;
  try {
    const id = await fetchInstanceId();
    if (id && id.length > 0) return truncate(id, INSTANCE_FINGERPRINT_MAX_LEN);
  } catch {
  }
  const railwayId = env[ENV.RAILWAY_SERVICE_ID];
  if (typeof railwayId === "string" && railwayId.length > 0) {
    return truncate(railwayId, INSTANCE_FINGERPRINT_MAX_LEN);
  }
  const host = (opts.hostnameImpl ?? hostname)();
  const now = (opts.nowImpl ?? Date.now)();
  warn(
    "spellguard: instance fingerprint detection failed (no AWS IMDS, no RAILWAY_SERVICE_ID); using fallback. Server-side correlation will be best-effort."
  );
  return truncate(`unknown-${host}-${now}`, INSTANCE_FINGERPRINT_MAX_LEN);
}
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}
var IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token";
var IMDS_INSTANCE_ID_URL = "http://169.254.169.254/latest/meta-data/instance-id";
var IMDS_TIMEOUT_MS = 1500;
async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMDS_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function defaultFetchInstanceId(fetchImpl = fetch) {
  let token = "";
  try {
    const tokenRes = await fetchWithTimeout(fetchImpl, IMDS_TOKEN_URL, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }
    });
    if (tokenRes.ok) token = (await tokenRes.text()).trim();
  } catch {
    return null;
  }
  if (token.length > 0) {
    try {
      const res = await fetchWithTimeout(fetchImpl, IMDS_INSTANCE_ID_URL, {
        headers: { "X-aws-ec2-metadata-token": token }
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.length > 0) return text;
      }
    } catch {
    }
  }
  try {
    const res = await fetchWithTimeout(fetchImpl, IMDS_INSTANCE_ID_URL);
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
async function runManagedBootstrap(opts = {}) {
  const env = opts.env ?? process.env;
  const nonce = env[ENV.BOOTSTRAP_NONCE];
  const endpoint = env[ENV.ENDPOINT];
  const agentId = env[ENV.AGENT_ID];
  if (!nonce) {
    throw new Error(
      `${ENV.BOOTSTRAP_NONCE} is required for managed-provisioning bootstrap`
    );
  }
  if (!endpoint) {
    throw new Error(
      `${ENV.ENDPOINT} is required for managed-provisioning bootstrap`
    );
  }
  if (!agentId) {
    throw new Error(
      `${ENV.AGENT_ID} is required for managed-provisioning bootstrap`
    );
  }
  const instanceFingerprint = await resolveInstanceFingerprint(opts);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1e3;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
      }
      if (err) reject(err);
      else if (result) resolve(result);
    };
    const timer = setTimeout(() => {
      settle(
        new Error(
          `spellguard: managed-bootstrap timed out after ${Math.floor(timeoutMs / 1e3)}s waiting for credential_delivered{cause:'bootstrap'}`
        )
      );
    }, timeoutMs);
    const credentials = () => ({
      mode: "managed-bootstrap",
      nonce
    });
    client = new AgentControlClient({
      apiBaseUrl: endpoint,
      agentId,
      credentials,
      upgradeHeaders: { [INSTANCE_FINGERPRINT_HEADER]: instanceFingerprint },
      onCredentialDelivered: (frame) => {
        if (frame.cause !== "bootstrap") {
          return;
        }
        if (!frame.agent_secret) {
          settle(
            new Error(
              "spellguard: bootstrap frame missing agent_secret \u2014 server bug or out-of-date server version"
            )
          );
          return;
        }
        const bootstrapFrame = frame;
        settle(null, {
          agentId,
          agentSecret: frame.agent_secret,
          spellguardBaseUrl: endpoint,
          instanceFingerprint,
          frame: bootstrapFrame
        });
      },
      onSeqAdvanced: () => {
      },
      onFatalClose: (code, reason) => {
        let label;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            label = "bootstrap_error";
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            label = "auth_failed";
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            label = "agent_ownership";
            break;
          default:
            label = `code_${code}`;
        }
        settle(
          new Error(
            `spellguard: managed-bootstrap channel closed (${label}${reason ? `: ${reason}` : ""})`
          )
        );
      },
      onError: (err) => {
        const msg = err.message ?? "";
        if (msg.includes("server:")) {
          settle(
            new Error(`spellguard: managed-bootstrap server error: ${msg}`)
          );
        }
      },
      ...opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}
    });
    client.start();
  });
}
var AGENT_GONE_HTTP_STATUSES = [401, 403, 404, 410];
function normalizeManagementBaseUrl(baseUrl) {
  let url = baseUrl;
  while (url.endsWith("/")) url = url.slice(0, -1);
  if (url.endsWith("/v1")) url = url.slice(0, -3);
  return url;
}
function isAgentGoneStatus(httpStatus) {
  return httpStatus !== void 0 && AGENT_GONE_HTTP_STATUSES.includes(httpStatus);
}
var USER_AGENT = "spellguard-plugin/0.1.0";
function createManagementClient(opts) {
  const baseFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const retryDelay = opts.retryDelayMs ?? 1e3;
  const retryOn5xx = opts.retry ?? true;
  const retryingFetch = (async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (!retryOn5xx) return baseFetch(req);
    const first = await baseFetch(req.clone());
    if (first.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      return baseFetch(req);
    }
    return first;
  });
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
    baseUrl: `${normalizeManagementBaseUrl(opts.baseUrl)}/v1`,
    fetch: retryingFetch
  });
  client.use(auth);
  return client;
}
var PLUGIN_CONTRACT = {
  version: 1,
  configRoot: {
    envOverride: "XDG_CONFIG_HOME",
    defaultUnderHome: ".config/spellguard"
  },
  files: {
    config: "config.json",
    gitTokens: "git-tokens",
    agentsDir: "agents"
  },
  bins: {
    setup: "run-spellguard-setup.mjs",
    sessionStart: "run-session-start.mjs",
    daemon: "spellguard-credential-daemon.mjs"
  },
  installCacheGlob: "plugins/cache/*/spellguard/*/dist/bin",
  frameworks: [
    {
      canonical: "claude_code",
      pathSlug: "claude-code",
      homeRoot: ".claude",
      runtime: {
        kind: "node-plugin",
        launcher: "claude",
        pluginBins: true,
        gitHelper: "plugin-bundled"
      }
    },
    {
      canonical: "codex",
      pathSlug: "codex",
      homeRoot: ".codex",
      runtime: {
        kind: "node-plugin",
        launcher: "codex",
        pluginBins: true,
        gitHelper: "plugin-bundled"
      }
    },
    {
      canonical: "hermes",
      pathSlug: "hermes",
      homeRoot: ".hermes",
      credentialSnapshot: "credentials.json",
      runtime: {
        kind: "native-python",
        launcher: "hermes",
        pluginBins: false,
        gitHelper: "cli-owned"
      }
    }
  ],
  configSchema: {
    required: ["agentId", "agentSecret", "spellguardBaseUrl"],
    resume: ["lastServerSeq", "knownCredentials"],
    githubCredentials: {
      shape: "map",
      keyedBy: "orgLoginLowercase",
      entryFields: [
        "scopedTokenId",
        "expiresAt",
        "scopedToken",
        "scopeSummary",
        "installationId",
        "revoked"
      ]
    }
  }
};
var MANAGED_MARKER_BASENAME = ".managed";
function spellguardRootDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "spellguard") : join(home, ".config", "spellguard");
}
function managedMarkerPath(root = spellguardRootDir()) {
  return join(root, MANAGED_MARKER_BASENAME);
}
function readManagedMarker(root = spellguardRootDir()) {
  const path = managedMarkerPath(root);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const e = err;
    if (e.code === "ENOENT") return { managed: false };
    return {
      managed: false,
      diagnostic: `managed marker unreadable at ${path}: ${e.message}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker corrupt at ${path}: ${err.message}`
    };
  }
  const marker = parsed;
  if (!marker || typeof marker !== "object" || typeof marker.agent_id !== "string" || marker.agent_id === "") {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} missing agent_id`
    };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (err) {
    return {
      managed: false,
      diagnostic: `managed marker unstatable at ${path}: ${err.message}`
    };
  }
  const perm = stats.mode & 511;
  if (perm & 18) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} is group/world-writable (mode ${perm.toString(8)}); refusing to honor`
    };
  }
  const readerUid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (readerUid !== void 0 && readerUid !== 0 && typeof stats.uid === "number" && stats.uid !== 0 && stats.uid !== readerUid) {
    return {
      managed: false,
      diagnostic: `managed marker at ${path} owned by untrusted uid ${stats.uid} (reader uid ${readerUid}, not root); refusing to honor`
    };
  }
  return { marker, managed: true };
}
function isManagedBox(root = spellguardRootDir()) {
  return readManagedMarker(root).managed;
}
var REGISTER_TIMEOUT_MS = 2e3;
var MAX_ID_BYTES = 256;
function defaultBoxSocketPath() {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : "nouid";
  return join2(tmpdir(), `spellguard-boxdaemon-${euid}`, "tasks.sock");
}
function withinIdBound(value) {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES;
}
function ambientMultiplexerHandle(env = process.env) {
  const pane = env.TMUX_PANE?.trim();
  return pane && withinIdBound(pane) ? pane : void 0;
}
function registerBoxSession(registration, options = {}) {
  if (!withinIdBound(registration.sessionId) || !withinIdBound(registration.framework) || registration.workingDirectory.length === 0) {
    return Promise.resolve("skipped");
  }
  const socketPath = options.socketPath ?? defaultBoxSocketPath();
  const timeoutMs = options.timeoutMs ?? REGISTER_TIMEOUT_MS;
  const frame = JSON.stringify({
    requestId: `session-register-${randomUUID()}`,
    operation: "session.register",
    payload: {
      sessionId: registration.sessionId,
      framework: registration.framework,
      workingDirectory: registration.workingDirectory,
      ...registration.ambientLocation ? { ambientLocation: registration.ambientLocation } : {},
      ...registration.taskId ? { taskId: registration.taskId } : {}
    }
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    const timer = setTimeout(() => finish("no_daemon"), timeoutMs);
    timer.unref?.();
    let response = "";
    socket.on("connect", () => {
      socket.end(frame);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        finish(
          JSON.parse(response).ok === true ? "registered" : "rejected"
        );
      } catch {
        finish("rejected");
      }
    });
    socket.on("error", () => finish("no_daemon"));
  });
}
async function captureSessionStart(stdin, framework, options = {}) {
  let payload;
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    return "skipped";
  }
  if (payload === null || typeof payload !== "object") return "skipped";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const workingDirectory = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  if (!sessionId) return "skipped";
  const env = options.env ?? process.env;
  const taskId = env.SPELLGUARD_TASK_ID?.trim();
  return registerBoxSession(
    {
      sessionId,
      framework,
      workingDirectory,
      ambientLocation: ambientMultiplexerHandle(env),
      ...taskId ? { taskId } : {}
    },
    options
  );
}
export {
  A2A_FRAME_TYPES,
  A2A_PROTOCOL_LIMITS,
  A2A_ROLES,
  A2A_TASK_STATES,
  A2A_TASK_TYPE_PATTERN,
  AGENT_CONTROL_CLOSE_CODES,
  AGENT_CONTROL_PROTOCOL_VERSION,
  AGENT_GONE_HTTP_STATUSES,
  AGENT_SUSPENDED_CLOSE_REASON,
  AGENT_SUSPEND_CAPABILITY,
  AUTH_SUPERSEDED_CLOSE_REASONS,
  AgentControlClient,
  ENV,
  INSTANCE_FINGERPRINT_HEADER,
  INSTANCE_FINGERPRINT_MAX_LEN,
  MANAGED_MARKER_BASENAME,
  PLUGIN_CONTRACT,
  ambientMultiplexerHandle,
  captureSessionStart,
  conservativeJsonSizeBudget,
  createManagementClient,
  defaultBoxSocketPath,
  defaultFetchInstanceId,
  describeGithubCredentialScope,
  frameFamily,
  frameQos,
  isA2aFrame,
  isA2aMessage,
  isA2aTask,
  isAgentGoneStatus,
  isGithubCredentialScope,
  isManagedBox,
  isUpgradeUnauthorized,
  makeErrorSafeWebSocket,
  managedMarkerPath,
  parseServerFrame,
  readManagedMarker,
  registerBoxSession,
  resolveInstanceFingerprint,
  runManagedBootstrap,
  shouldRunManagedBootstrap,
  spellguardRootDir,
  validateA2aAckResult,
  validateA2aContractFrame,
  validateA2aMessage,
  validateA2aTask
};
