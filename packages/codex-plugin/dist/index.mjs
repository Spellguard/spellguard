var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/skills/spellguard-setup.ts
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

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
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    return await new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientMsgId);
        reject(new Error("credential_request_timeout"));
      }, timeoutMs);
      this.#pendingRequests.set(clientMsgId, {
        resolve: resolve5,
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
      await new Promise((resolve5) => setTimeout(resolve5, retryDelay));
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

// src/lib/config-store.ts
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  readdirSync,
  renameSync,
  rmSync,
  statSync as statSync2,
  symlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir as homedir2, platform } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";

// src/lib/framework-slug.ts
var FRAMEWORK_SLUG = "codex";

// src/lib/config-store.ts
function spellguardRootDir2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join2(xdg, "spellguard") : join2(homedir2(), ".config", "spellguard");
}
function legacyConfigDir() {
  return spellguardRootDir2();
}
function defaultConfigDir() {
  return join2(spellguardRootDir2(), FRAMEWORK_SLUG);
}
function defaultConfigPath() {
  return join2(defaultConfigDir(), "config.json");
}
function readPrivateConfigFile(path) {
  const flags = fsConstants.O_RDONLY | (platform() === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("protected config path is not a file");
    if (platform() !== "win32" && (stat.mode & 63) !== 0) {
      throw new Error("protected config file permissions are too broad");
    }
    return readFileSync2(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function gitTokensPath(dir = defaultConfigDir()) {
  return join2(dir, "git-tokens");
}
function servedTokens(config) {
  const served = /* @__PURE__ */ new Set();
  if (config.revoked) return served;
  const entries = Object.values(config.githubCredentials ?? {});
  for (const entry of entries) {
    if (!entry.revoked && entry.scopedToken) served.add(entry.scopedToken);
  }
  if (config.scopedToken && (entries.length === 0 || served.has(config.scopedToken))) {
    served.add(config.scopedToken);
  }
  return served;
}
function keepTokens(config, keep) {
  const kept = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "scopedToken") {
      const token = value;
      if (token !== void 0 && (!token || keep.has(token))) {
        kept[key] = token;
      }
    } else if (key === "githubCredentials" && value) {
      kept[key] = Object.fromEntries(
        Object.entries(
          value
        ).map(([org, entry]) => {
          if (!entry.scopedToken || keep.has(entry.scopedToken)) {
            return [org, entry];
          }
          const { scopedToken: _dropped, ...withoutToken } = entry;
          return [org, withoutToken];
        })
      );
    } else {
      kept[key] = value;
    }
  }
  return kept;
}
function writeConfigSnapshot(path, next) {
  const bak = `${path}.bak`;
  let previous;
  try {
    previous = JSON.parse(readFileSync2(path, "utf-8"));
  } catch {
    previous = void 0;
  }
  if (previous === null || typeof previous !== "object") {
    if (next.revoked) {
      rmSync(bak, { force: true });
      return;
    }
    copyFileSync(path, bak);
  } else {
    const snapshot = keepTokens(
      previous,
      servedTokens(next)
    );
    writeFileSync(bak, JSON.stringify(snapshot, null, 2), {
      encoding: "utf-8",
      mode: 384
    });
  }
  if (platform() !== "win32") chmodSync(bak, 384);
}
function writeGitTokensFile(config, dir = defaultConfigDir(), options = {}) {
  const path = gitTokensPath(dir);
  const lines = [];
  let wildcardToken;
  let usableCount = 0;
  let keyedTotal = 0;
  const keyed = config.revoked ? void 0 : config.githubCredentials;
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
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const content = lines.length === 0 ? "" : `${lines.join("\n")}
`;
  let committed = true;
  const tmpPath = options.onlyIfMissing ? `${path}.${randomUUID()}.tmp` : `${path}.tmp`;
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
  try {
    if (options.onlyIfMissing) linkSync(tmpPath, path);
    else renameSync(tmpPath, path);
  } catch (error) {
    if (!options.onlyIfMissing || !isAlreadyExistsError(error)) throw error;
    committed = false;
  } finally {
    if (options.onlyIfMissing) rmSync(tmpPath, { force: true });
  }
  if (!committed) return;
  const resetMarker = join2(
    dirname2(path),
    "github-grants",
    "current",
    ".reset-tombstone"
  );
  if (!config.revoked && config.scopedToken && existsSync(resetMarker)) {
    rmSync(join2(dirname2(path), "github-grants"), {
      recursive: true,
      force: true
    });
  }
}
function isAlreadyExistsError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function healConfigMode(path, mode) {
  if (mode === 384) return "ok";
  const uid = process.getuid?.();
  let ownerUid;
  try {
    ownerUid = statSync2(path).uid;
  } catch {
    return "unhealable";
  }
  if (uid === void 0 || ownerUid !== uid) return "unhealable";
  try {
    chmodSync(path, 384);
  } catch {
    return "unhealable";
  }
  try {
    if ((statSync2(path).mode & 511) !== 384) return "unhealable";
  } catch {
    return "unhealable";
  }
  return "healed";
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
  if (parsed.githubReissue !== void 0 && (parsed.githubReissue === null || typeof parsed.githubReissue !== "object" || parsed.githubReissue.pending !== true))
    return "githubReissue";
  return null;
}
function readConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return { config: null, reason: "missing" };
  let permissionsHealed = false;
  if (platform() !== "win32") {
    let mode;
    try {
      mode = statSync2(path).mode & 511;
    } catch {
      return { config: null, reason: "missing" };
    }
    const healed = healConfigMode(path, mode);
    if (healed === "unhealable") {
      return {
        config: null,
        reason: "wrong_permissions",
        foundMode: mode.toString(8).padStart(4, "0")
      };
    }
    permissionsHealed = healed === "healed";
  }
  let raw;
  try {
    raw = readFileSync2(path, "utf-8");
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
    return permissionsHealed ? { config: parsed, permissionsHealed: true } : { config: parsed };
  } catch {
    return { config: null, reason: "malformed", malformedField: "json" };
  }
}
function writeConfig(config, path = defaultConfigPath(), testHooks = {}) {
  mkdirSync(dirname2(path), { recursive: true, mode: 448 });
  const persisted = keepTokens(config, servedTokens(config));
  const content = JSON.stringify(persisted, null, 2);
  if (existsSync(path)) {
    try {
      writeConfigSnapshot(path, persisted);
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
  writeGitTokensFile(persisted, dirname2(path));
  testHooks.beforeConfigCommit?.();
  renameSync(tmpPath, path);
}
function markConfigRevoked(path = defaultConfigPath(), testHooks = {}) {
  const result = readConfig(path);
  if (result.config) {
    invalidateActiveGithubGrantGeneration(
      dirname2(path),
      testHooks,
      result.config.agentId
    );
    testHooks.afterV5Invalidation?.();
    writeConfig({ ...result.config, revoked: true }, path);
  }
}
function syncPath(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function requireRealDirectory(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe GitHub generation directory: ${path}`);
  }
}
function removeSiblingGenerations(generations, activeName) {
  requireRealDirectory(generations);
  for (const entry of readdirSync(generations, { withFileTypes: true })) {
    if (entry.name === activeName) continue;
    const candidate = join2(generations, entry.name);
    if (dirname2(candidate) !== generations) {
      throw new Error("unsafe GitHub generation cleanup target");
    }
    const stat = lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(candidate, { recursive: true });
    } else {
      rmSync(candidate);
    }
  }
  syncPath(generations);
}
function invalidateActiveGithubGrantGeneration(configDir, testHooks = {}, configuredAgentId) {
  const root = join2(configDir, "github-grants");
  const generations = join2(root, "generations");
  const deliveryId = randomUUID();
  const generationName = `0-${deliveryId}`;
  const generation = join2(generations, generationName);
  mkdirSync(root, { recursive: true, mode: 448 });
  requireRealDirectory(root);
  if (!existsSync(generations)) mkdirSync(generations, { mode: 448 });
  requireRealDirectory(generations);
  mkdirSync(generation, { mode: 448 });
  mkdirSync(join2(generation, "tokens"), { mode: 448 });
  let agentId = configuredAgentId;
  if (!agentId) {
    try {
      const active = JSON.parse(
        readPrivateConfigFile(join2(root, "current", "state.json"))
      );
      if (typeof active.agentId === "string") agentId = active.agentId;
      else if (typeof active.grants?.[0]?.agent_id === "string")
        agentId = active.grants[0].agent_id;
    } catch {
    }
  }
  writeFileSync(
    join2(generation, "state.json"),
    JSON.stringify({
      protocolVersion: 5,
      ...agentId ? { agentId } : {},
      deliveryId,
      grantSetRevision: "0",
      grants: []
    }),
    { mode: 384 }
  );
  writeFileSync(join2(generation, "manifest.tsv"), "\n", { mode: 384 });
  writeFileSync(join2(generation, ".reset-tombstone"), "", { mode: 384 });
  syncPath(join2(generation, "state.json"));
  syncPath(join2(generation, "manifest.tsv"));
  syncPath(join2(generation, ".reset-tombstone"));
  syncPath(join2(generation, "tokens"));
  syncPath(generation);
  syncPath(generations);
  testHooks.beforeV5Activation?.();
  const pendingCurrent = join2(root, `.current.${randomUUID()}.tmp`);
  symlinkSync(join2("generations", generationName), pendingCurrent);
  renameSync(pendingCurrent, join2(root, "current"));
  syncPath(root);
  testHooks.afterV5Activation?.();
  testHooks.beforeV5Cleanup?.();
  removeSiblingGenerations(generations, generationName);
}

// src/lib/daemon-spawn.ts
import {
  execFileSync,
  spawn
} from "node:child_process";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync3,
  realpathSync,
  renameSync as renameSync2,
  rmSync as rmSync2,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { platform as platform2 } from "node:os";
import { basename, dirname as dirname3, join as join3, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
var HEALTH_SCHEMA_VERSION = 1;
var DEFAULT_HEARTBEAT_MAX_AGE_MS = 5e3;
var DEFAULT_READINESS_TIMEOUT_MS = 3e3;
var DEFAULT_STOP_TIMEOUT_MS = 1e3;
var RECONCILE_LOCK_TIMEOUT_MS = 4e3;
var DEFAULT_STARTUP_COOLDOWN_MS = 1e4;
var FINALIZATION_RESERVE_MS = 25;
var FORCE_KILL_RESERVE_MS = 25;
var FLOCK_PATHS = ["/usr/bin/flock", "/bin/flock"];
var LOCK_HOLDER_SCRIPT = "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0))";
function agentsDir(configDir) {
  return join3(configDir, "agents");
}
function daemonPidFilePath(configDir, agentId) {
  return join3(agentsDir(configDir), `${agentId}.pid`);
}
function daemonHealthFilePath(configDir, agentId) {
  return join3(agentsDir(configDir), `${agentId}.health.json`);
}
function daemonLockPath(configDir, agentId) {
  return join3(agentsDir(configDir), `${agentId}.reconcile.lock`);
}
function daemonStartupStatePath(configDir, agentId) {
  return join3(agentsDir(configDir), `${agentId}.startup-state.json`);
}
function daemonScriptPath() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const devPath = join3(
    here,
    "..",
    "..",
    "bin",
    "spellguard-credential-daemon.ts"
  );
  const builtPath = join3(here, "spellguard-credential-daemon.mjs");
  const runningFromDist = here.endsWith(`${sep}dist${sep}bin`) || here.endsWith("/dist/bin");
  if (runningFromDist && existsSync2(builtPath)) return realpathSync(builtPath);
  if (existsSync2(devPath)) return realpathSync(devPath);
  return resolve(builtPath);
}
function daemonArtifactId(scriptPath = daemonScriptPath()) {
  const canonicalPath = existsSync2(scriptPath) ? realpathSync(scriptPath) : resolve(scriptPath);
  const hash = createHash("sha256");
  hash.update(canonicalPath);
  hash.update("\0");
  hash.update(readFileSync3(canonicalPath));
  return hash.digest("hex");
}
function readDaemonPid(pidPath) {
  try {
    const raw = readFileSync3(pidPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}
function readDaemonHealth(configDir, agentId) {
  try {
    const value = JSON.parse(
      readFileSync3(daemonHealthFilePath(configDir, agentId), "utf8")
    );
    if (!isDaemonHealthRecord(value)) return null;
    return value;
  } catch {
    return null;
  }
}
function isDaemonHealthRecord(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return record.schemaVersion === HEALTH_SCHEMA_VERSION && typeof record.pid === "number" && typeof record.processStartToken === "string" && typeof record.agentId === "string" && typeof record.configDir === "string" && typeof record.scriptPath === "string" && typeof record.artifactId === "string" && typeof record.instanceId === "string" && typeof record.heartbeatAt === "string" && (record.processState === "starting" || record.processState === "ready") && (record.transportState === "connecting" || record.transportState === "connected" || record.transportState === "error") && (record.credentialState === "missing" || record.credentialState === "valid" || record.credentialState === "near_expiry" || record.credentialState === "refresh_pending" || record.credentialState === "expired" || record.credentialState === "revoked");
}
function readStartupAttempt(configDir, agentId) {
  try {
    const value = JSON.parse(
      readFileSync3(daemonStartupStatePath(configDir, agentId), "utf8")
    );
    if (!value || typeof value !== "object") return null;
    const record = value;
    if (record.schemaVersion !== 1 || typeof record.artifactId !== "string" || typeof record.retryAfter !== "string") {
      return null;
    }
    if (record.kind === "failure" && record.reason === "startup_failed" && typeof record.failedAt === "string") {
      return {
        schemaVersion: 1,
        kind: "failure",
        artifactId: record.artifactId,
        failedAt: record.failedAt,
        retryAfter: record.retryAfter,
        reason: "startup_failed"
      };
    }
    if (record.kind === "pending" && Number.isInteger(record.pid) && typeof record.pid === "number" && record.pid > 1 && typeof record.observedAt === "string") {
      return {
        schemaVersion: 1,
        kind: "pending",
        artifactId: record.artifactId,
        pid: record.pid,
        observedAt: record.observedAt,
        retryAfter: record.retryAfter
      };
    }
    return null;
  } catch {
    return null;
  }
}
function writeStartupAttempt(configDir, agentId, record) {
  const path = daemonStartupStatePath(configDir, agentId);
  const tempPath = `${path}.${randomUUID2()}.tmp`;
  writeFileSync2(tempPath, `${JSON.stringify(record)}
`, { mode: 384 });
  chmodSync2(tempPath, 384);
  renameSync2(tempPath, path);
}
function clearStartupAttempt(configDir, agentId) {
  rmSync2(daemonStartupStatePath(configDir, agentId), { force: true });
}
function activeStartupAttempt(configDir, agentId, artifactId) {
  const record = readStartupAttempt(configDir, agentId);
  if (record?.artifactId !== artifactId) return null;
  const retryAfter = Date.parse(record.retryAfter);
  return Number.isFinite(retryAfter) && retryAfter > Date.now() ? record : null;
}
async function ensureCredentialDaemonRunning(args) {
  const { config } = args;
  if (!config.agentSecret || !config.agentId) {
    return { daemon: "skipped", reason: "missing_credentials" };
  }
  const configDir = resolve(args.configDir ?? defaultConfigDir());
  const deadlineAtMs = args.deadlineAtMs ?? Date.now() + (args.reconcileTimeoutMs ?? RECONCILE_LOCK_TIMEOUT_MS) + (args.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) + (args.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  const scopedArgs = { ...args, configDir, deadlineAtMs };
  if (remainingMs(deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  mkdirSync2(agentsDir(configDir), { recursive: true, mode: 448 });
  if (platform2() === "darwin") {
    return reconcileUnderLock(scopedArgs, { isHeld: () => true }, false);
  }
  if (platform2() !== "linux") {
    return { daemon: "unavailable", reason: "unsupported_platform" };
  }
  const lock = await acquireReconcileLock(
    daemonLockPath(configDir, config.agentId),
    Math.min(
      deadlineAtMs - FINALIZATION_RESERVE_MS,
      Date.now() + (args.reconcileTimeoutMs ?? RECONCILE_LOCK_TIMEOUT_MS)
    )
  );
  if (!lock) {
    return {
      daemon: "unavailable",
      reason: remainingMs(deadlineAtMs) <= FINALIZATION_RESERVE_MS ? "deadline_exhausted" : "reconcile_busy"
    };
  }
  try {
    return await reconcileUnderLock(scopedArgs, lock, true);
  } finally {
    lock.release();
  }
}
async function reconcileUnderLock(args, permit, allowSafeReplacement) {
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const scriptPath = daemonScriptPath();
  const artifactId = daemonArtifactId(scriptPath);
  const classification = classifyDaemon({
    agentId: args.config.agentId,
    configDir: args.configDir,
    scriptPath,
    artifactId,
    heartbeatMaxAgeMs: args.heartbeatMaxAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS
  });
  if (classification.kind === "current" && classification.health) {
    if (allowSafeReplacement && permit.isHeld() && remainingMs(args.deadlineAtMs) > FINALIZATION_RESERVE_MS) {
      clearStartupAttempt(args.configDir, args.config.agentId);
    }
    return resultFromHealth("already-running", classification.health);
  }
  if (classification.kind === "starting" && classification.health) {
    if (allowSafeReplacement && permit.isHeld() && remainingMs(args.deadlineAtMs) > FINALIZATION_RESERVE_MS) {
      clearStartupAttempt(args.configDir, args.config.agentId);
    }
    return {
      daemon: "starting",
      pid: classification.health.pid,
      transport: classification.health.transportState,
      credentialState: classification.health.credentialState
    };
  }
  if (!allowSafeReplacement && classification.kind !== "missing" && classification.kind !== "dead") {
    return {
      daemon: "unavailable",
      reason: "unsupported_safe_replacement",
      pid: classification.pid,
      detail: "this platform leaves a live non-current daemon untouched because serialized safe replacement is unavailable"
    };
  }
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const startupAttempt = allowSafeReplacement ? activeStartupAttempt(args.configDir, args.config.agentId, artifactId) : null;
  if (startupAttempt) {
    return {
      daemon: "unavailable",
      reason: "startup_cooldown",
      ...startupAttempt.kind === "pending" ? { pid: startupAttempt.pid } : {},
      detail: startupAttempt.kind === "pending" ? `the previous daemon start is still pending; retry after ${startupAttempt.retryAfter}` : `daemon startup failed; retry after ${startupAttempt.retryAfter}`
    };
  }
  if (classification.kind === "unverifiable") {
    return {
      daemon: "unavailable",
      reason: "foreign_or_unverifiable",
      pid: classification.pid,
      detail: "a live daemon-like process could not be tied to this config root"
    };
  }
  if (classification.kind === "foreign") {
    if (!permit.isHeld()) return reconcileLockLost();
    if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
      return deadlineExhausted();
    }
    if (classification.pid && !unlinkPidIfUnchanged(
      daemonPidFilePath(args.configDir, args.config.agentId),
      classification.pid
    )) {
      return {
        daemon: "unavailable",
        reason: "foreign_or_unverifiable",
        pid: classification.pid,
        detail: "daemon PID record changed during reconciliation"
      };
    }
  }
  let replacement;
  if ((classification.kind === "obsolete" || classification.kind === "unhealthy") && classification.pid && classification.snapshot) {
    const stopped = await stopOwnedProcess({
      snapshot: classification.snapshot,
      agentId: args.config.agentId,
      configDir: args.configDir,
      instanceId: classification.health?.instanceId,
      deadlineAtMs: Math.min(
        args.deadlineAtMs - FINALIZATION_RESERVE_MS,
        Date.now() + (args.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
      ),
      canMutate: permit.isHeld
    });
    if (!stopped) {
      return {
        daemon: "unavailable",
        reason: remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS ? "deadline_exhausted" : "stop_failed",
        pid: classification.pid
      };
    }
    replacement = { pid: classification.pid, reason: classification.kind };
  }
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  if (!permit.isHeld()) return reconcileLockLost();
  removeStaleArtifacts(args.configDir, args.config.agentId);
  const instanceId = randomUUID2();
  const spawnFn = args.spawnDaemon ?? defaultSpawnDaemon;
  const childEnv = { ...process.env };
  if (scriptPath.endsWith(".ts")) {
    childEnv.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--import tsx"].filter(Boolean).join(" ");
  }
  if (!permit.isHeld()) return reconcileLockLost();
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const child = spawnFn(
    process.execPath,
    [
      scriptPath,
      args.config.agentId,
      "--config-dir",
      args.configDir,
      "--instance-id",
      instanceId,
      "--artifact-id",
      artifactId,
      ...args.cwd ? ["--cwd", args.cwd] : []
    ],
    { detached: true, stdio: "ignore", env: childEnv }
  );
  if (!child) return { daemon: "spawned" };
  if (!permit.isHeld()) return reconcileLockLost();
  const cooldownMs = Math.max(
    0,
    args.startupCooldownMs ?? DEFAULT_STARTUP_COOLDOWN_MS
  );
  if (allowSafeReplacement && child.pid) {
    const observedAt = /* @__PURE__ */ new Date();
    writeStartupAttempt(args.configDir, args.config.agentId, {
      schemaVersion: 1,
      kind: "pending",
      artifactId,
      pid: child.pid,
      observedAt: observedAt.toISOString(),
      retryAfter: new Date(observedAt.getTime() + cooldownMs).toISOString()
    });
  }
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  const readiness = await waitForReadiness({
    child,
    agentId: args.config.agentId,
    configDir: args.configDir,
    instanceId,
    artifactId,
    deadlineAtMs: Math.min(
      args.deadlineAtMs - FINALIZATION_RESERVE_MS,
      Date.now() + (args.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS)
    )
  });
  if (!permit.isHeld()) return reconcileLockLost();
  if (remainingMs(args.deadlineAtMs) <= FINALIZATION_RESERVE_MS) {
    return deadlineExhausted();
  }
  if (readiness.kind === "failed") {
    const now = /* @__PURE__ */ new Date();
    const retryAfter = new Date(now.getTime() + cooldownMs).toISOString();
    if (allowSafeReplacement && readiness.reason === "startup_failed") {
      writeStartupAttempt(args.configDir, args.config.agentId, {
        schemaVersion: 1,
        kind: "failure",
        artifactId,
        failedAt: now.toISOString(),
        retryAfter,
        reason: "startup_failed"
      });
    }
    return {
      daemon: "unavailable",
      reason: readiness.reason,
      pid: child.pid,
      exitCode: readiness.exitCode,
      signal: readiness.signal
    };
  }
  if (allowSafeReplacement) {
    clearStartupAttempt(args.configDir, args.config.agentId);
  }
  if (readiness.kind === "starting") {
    return {
      daemon: "starting",
      pid: readiness.health.pid,
      transport: readiness.health.transportState,
      credentialState: readiness.health.credentialState
    };
  }
  if (replacement) {
    return {
      daemon: "restarted",
      pid: readiness.health.pid,
      replacedPid: replacement.pid,
      reason: replacement.reason,
      state: "ready",
      transport: readiness.health.transportState,
      credentialState: readiness.health.credentialState
    };
  }
  return resultFromHealth("spawned", readiness.health);
}
function deadlineExhausted() {
  return { daemon: "unavailable", reason: "deadline_exhausted" };
}
function reconcileLockLost() {
  return {
    daemon: "unavailable",
    reason: "reconcile_busy",
    detail: "the reconciliation lock holder exited before completion"
  };
}
function resultFromHealth(daemon, health) {
  const shared = {
    pid: health.pid,
    state: "ready",
    transport: health.transportState,
    credentialState: health.credentialState
  };
  return daemon === "already-running" ? { daemon: "already-running", ...shared } : { daemon: "spawned", ...shared };
}
function classifyDaemon(args) {
  const pidPath = daemonPidFilePath(args.configDir, args.agentId);
  const pid = readDaemonPid(pidPath);
  if (!pid) return { kind: existsSync2(pidPath) ? "dead" : "missing" };
  if (!processExists(pid)) return { kind: "dead", pid };
  const snapshot = readProcessSnapshot(pid);
  if (!snapshot) return { kind: "unverifiable", pid };
  const health = readDaemonHealth(args.configDir, args.agentId);
  const ownership = daemonProcessOwnership(
    snapshot,
    args.agentId,
    args.configDir,
    health
  );
  if (ownership !== "owned") {
    return {
      kind: ownership,
      pid,
      snapshot,
      health: health ?? void 0
    };
  }
  if (!health || health.pid !== pid) {
    return { kind: "unhealthy", pid, snapshot, health: health ?? void 0 };
  }
  if (health.artifactId !== args.artifactId || resolve(health.scriptPath) !== resolve(args.scriptPath)) {
    return { kind: "obsolete", pid, snapshot, health };
  }
  const heartbeatAge = Date.now() - Date.parse(health.heartbeatAt);
  if (health.processState === "starting" && Number.isFinite(heartbeatAge) && heartbeatAge <= args.heartbeatMaxAgeMs && health.processStartToken === snapshot.startToken) {
    return { kind: "starting", pid, snapshot, health };
  }
  if (health.processState !== "ready" || !Number.isFinite(heartbeatAge) || heartbeatAge > args.heartbeatMaxAgeMs || health.processStartToken !== snapshot.startToken) {
    return { kind: "unhealthy", pid, snapshot, health };
  }
  return { kind: "current", pid, snapshot, health };
}
function processExists(pid) {
  if (platform2() === "linux") {
    try {
      const stat = readFileSync3(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen >= 0) {
        const state = stat.slice(closeParen + 2).trim().split(/\s+/, 1)[0];
        if (state === "Z") return false;
      }
    } catch {
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function readProcessSnapshot(pid) {
  if (!processExists(pid)) return null;
  if (platform2() === "linux") {
    try {
      const stat = readFileSync3(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return null;
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const startToken = fields[19];
      if (!startToken) return null;
      const argv = readFileSync3(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
      const environment = Object.fromEntries(
        readFileSync3(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(Boolean).map((entry) => {
          const index = entry.indexOf("=");
          return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
        })
      );
      return {
        pid,
        startToken,
        argv,
        commandLine: argv.join(" "),
        environment
      };
    } catch {
      return null;
    }
  }
  if (platform2() === "darwin") {
    try {
      const startToken = execFileSync(
        "ps",
        ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8" }
      ).trim();
      const commandLine = execFileSync(
        "ps",
        ["-ww", "-p", String(pid), "-o", "command="],
        { encoding: "utf8" }
      ).trim();
      return {
        pid,
        startToken,
        argv: parseObservedCommandLine(commandLine),
        commandLine,
        environment: null
      };
    } catch {
      return null;
    }
  }
  return null;
}
function parseObservedCommandLine(commandLine) {
  if (!commandLine || /["'\\]/.test(commandLine)) return [];
  return commandLine.split(/\s+/);
}
function daemonProcessOwnership(snapshot, agentId, configDir, health) {
  if (health) {
    if (health.pid !== snapshot.pid || health.processStartToken !== snapshot.startToken || health.agentId !== agentId || resolve(health.configDir) !== resolve(configDir)) {
      return "foreign";
    }
  }
  if (snapshot.argv.length === 0 || !snapshot.commandLine) {
    return "unverifiable";
  }
  const scriptIndex = snapshot.argv.findIndex(
    (arg) => /^spellguard-credential-daemon\.(?:mjs|ts)$/.test(basename(arg))
  );
  if (scriptIndex < 0 || snapshot.argv[scriptIndex + 1] !== agentId) {
    return "foreign";
  }
  const configuredRoot = flagValue(snapshot.argv, "--config-dir");
  if (configuredRoot) {
    return resolve(configuredRoot) === resolve(configDir) ? "owned" : "foreign";
  }
  const environmentRoot = defaultConfigDirFromEnvironment(snapshot.environment);
  if (!environmentRoot) return "unverifiable";
  return resolve(environmentRoot) === resolve(configDir) ? "owned" : "foreign";
}
function signalOwnedCredentialDaemon(args) {
  const first = readProcessSnapshot(args.pid);
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (!first || daemonProcessOwnership(first, args.agentId, args.configDir, health) !== "owned") {
    return false;
  }
  const second = readProcessSnapshot(args.pid);
  if (!second || second.startToken !== first.startToken || daemonProcessOwnership(second, args.agentId, args.configDir, health) !== "owned") {
    return false;
  }
  try {
    process.kill(args.pid, args.signal);
    return true;
  } catch {
    return false;
  }
}
function defaultConfigDirFromEnvironment(environment) {
  if (!environment) return null;
  if (environment.XDG_CONFIG_HOME) {
    return join3(environment.XDG_CONFIG_HOME, "spellguard", "codex");
  }
  const home = environment.HOME;
  return home ? join3(home, ".config", "spellguard", "codex") : null;
}
function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}
async function stopOwnedProcess(args) {
  if (remainingMs(args.deadlineAtMs) <= 0 || !args.canMutate() || !sameOwnedProcess(args) || remainingMs(args.deadlineAtMs) <= 0) {
    return false;
  }
  try {
    process.kill(args.snapshot.pid, "SIGTERM");
  } catch {
    return !processExists(args.snapshot.pid);
  }
  const gracefulDeadlineAtMs = Math.max(
    Date.now(),
    args.deadlineAtMs - FORCE_KILL_RESERVE_MS
  );
  if (await waitForProcessExit(args.snapshot.pid, gracefulDeadlineAtMs))
    return true;
  if (remainingMs(args.deadlineAtMs) <= 0 || !args.canMutate() || !sameOwnedProcess(args) || remainingMs(args.deadlineAtMs) <= 0) {
    return false;
  }
  try {
    process.kill(args.snapshot.pid, "SIGKILL");
  } catch {
    return !processExists(args.snapshot.pid);
  }
  return waitForProcessExit(args.snapshot.pid, args.deadlineAtMs);
}
function sameOwnedProcess(args) {
  const current = readProcessSnapshot(args.snapshot.pid);
  if (!current || current.startToken !== args.snapshot.startToken) return false;
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (args.instanceId && health && health.instanceId !== args.instanceId) {
    return false;
  }
  return daemonProcessOwnership(current, args.agentId, args.configDir, health) === "owned";
}
async function waitForProcessExit(pid, deadlineAtMs) {
  while (remainingMs(deadlineAtMs) > 0) {
    if (!processExists(pid)) return true;
    await delay(Math.min(25, remainingMs(deadlineAtMs)));
  }
  return !processExists(pid);
}
function unlinkPidIfUnchanged(path, expectedPid) {
  if (readDaemonPid(path) !== expectedPid) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return !existsSync2(path);
  }
}
function removeStaleArtifacts(configDir, agentId) {
  rmSync2(daemonPidFilePath(configDir, agentId), { force: true });
  rmSync2(daemonHealthFilePath(configDir, agentId), { force: true });
}
async function waitForReadiness(args) {
  while (remainingMs(args.deadlineAtMs) > 0) {
    const health2 = readDaemonHealth(args.configDir, args.agentId);
    if (health2?.instanceId === args.instanceId && health2.artifactId === args.artifactId && health2.processState === "ready") {
      return { kind: "ready", health: health2 };
    }
    if (args.child.exitCode !== null || args.child.signalCode !== null) {
      return {
        kind: "failed",
        reason: "startup_failed",
        exitCode: args.child.exitCode,
        signal: args.child.signalCode
      };
    }
    await delay(Math.min(25, remainingMs(args.deadlineAtMs)));
  }
  const health = readDaemonHealth(args.configDir, args.agentId);
  if (health?.instanceId === args.instanceId && health.artifactId === args.artifactId && health.processState === "starting" && processExists(health.pid)) {
    return { kind: "starting", health };
  }
  return {
    kind: "failed",
    reason: "readiness_timeout",
    exitCode: args.child.exitCode,
    signal: args.child.signalCode
  };
}
async function acquireReconcileLock(path, deadlineAtMs) {
  const timeoutMs = remainingMs(deadlineAtMs);
  if (timeoutMs <= 0) return null;
  const flockPath = FLOCK_PATHS.find((candidate) => existsSync2(candidate));
  if (!flockPath) return null;
  writeFileSync2(path, "", { flag: "a", mode: 384 });
  chmodSync2(path, 384);
  const child = spawn(
    flockPath,
    [
      "--wait",
      String(Math.max(timeoutMs, 1) / 1e3),
      "--no-fork",
      path,
      process.execPath,
      "-e",
      LOCK_HOLDER_SCRIPT
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );
  return waitForLockHolder(child, deadlineAtMs);
}
async function waitForLockHolder(child, deadlineAtMs) {
  return new Promise((resolveLock) => {
    let settled = false;
    let held = false;
    let output = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveLock(result);
    };
    const fail = () => {
      held = false;
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      finish(null);
    };
    const timer = setTimeout(fail, remainingMs(deadlineAtMs));
    child.once("error", fail);
    child.stdin?.once("error", fail);
    child.once("exit", () => {
      held = false;
      finish(null);
    });
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (!output.includes("locked\n")) return;
      held = true;
      finish({
        isHeld: () => held && child.exitCode === null && child.signalCode === null,
        release: () => {
          if (!held) return;
          held = false;
          if (child.stdin?.writable) {
            child.stdin.end();
          } else if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
          }
        }
      });
    });
  });
}
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function remainingMs(deadlineAtMs) {
  return Math.max(0, deadlineAtMs - Date.now());
}
function defaultSpawnDaemon(execPath, args, opts) {
  const child = spawn(execPath, args, opts);
  child.unref();
  return child;
}

// src/lib/plugin-sync.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname4, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var FRAMEWORK = "codex";
var TIMEOUT_MS = 5e3;
function readPluginVersion() {
  try {
    const here = dirname4(fileURLToPath2(import.meta.url));
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
      fetchImpl: (input, init) => (options.fetchImpl ?? fetch)(input, {
        ...init,
        signal: controller.signal
      })
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
    console.error(
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

// src/lib/sqlite-self-install.ts
import { spawn as spawn2 } from "node:child_process";
import { accessSync, constants as fsConstants2, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname5, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/lib/sqlite-backend.ts
import { createRequire } from "node:module";
var localRequire = typeof __require === "function" ? __require : createRequire(import.meta.url);
function suppressSqliteExperimentalWarning() {
  const original = process.emitWarning;
  process.emitWarning = ((warning, ...rest) => {
    const optsOrType = rest[0];
    const type = typeof optsOrType === "object" && optsOrType !== null ? optsOrType.type : optsOrType;
    const name = typeof warning === "object" ? warning?.name : void 0;
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    const isSqliteExperimental = type === "ExperimentalWarning" || name === "ExperimentalWarning" || typeof message === "string" && message.includes("SQLite is an experimental");
    if (isSqliteExperimental) return;
    return original.call(process, warning, ...rest);
  });
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
    const backend2 = adaptNodeSqlite(mod.DatabaseSync);
    const probe = backend2.open(":memory:");
    probe.exec("CREATE TABLE __probe (x); DROP TABLE __probe;");
    probe.close();
    return backend2;
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
  const here = dirname5(fileURLToPath3(import.meta.url));
  return resolve3(here, "..", "..");
}
function isWritable(dir) {
  try {
    accessSync(dir, fsConstants2.W_OK);
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
    mkdirSync3(resolve3(pluginRoot, "node_modules"), { recursive: true });
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

// src/lib/stop-daemons.ts
import { readFileSync as readFileSync5, readdirSync as readdirSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join4 } from "node:path";
function stopLocalDaemons(opts) {
  const dir = join4(opts?.configDir ?? defaultConfigDir(), "agents");
  const kill = opts?.killImpl ?? process.kill.bind(process);
  let entries;
  try {
    entries = readdirSync2(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return [];
  }
  const stopped = [];
  for (const f of entries) {
    const p = join4(dir, f);
    let pid;
    try {
      pid = Number.parseInt(readFileSync5(p, "utf8").trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const agentId = f.slice(0, -".pid".length);
    const signalled = opts?.killImpl ? (() => {
      try {
        kill(pid, "SIGTERM");
        return true;
      } catch {
        return false;
      }
    })() : signalOwnedCredentialDaemon({
      pid,
      agentId,
      configDir: opts?.configDir ?? defaultConfigDir(),
      signal: "SIGTERM"
    });
    if (!signalled) continue;
    stopped.push(pid);
    try {
      unlinkSync2(p);
    } catch {
    }
  }
  return stopped;
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
      message: "Spellguard: an existing credential is present and no interactive terminal is available. Printing the current identity. To act on it non-interactively, re-run with --choice reauthorize | additional | print."
    });
    return "print_identity";
  }
  const ask = opts.promptFn ? opts.promptFn : (q) => {
    const rl = createInterface({
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout
    });
    return new Promise((resolve5) => {
      rl.question(q, (answer) => {
        rl.close();
        resolve5(answer);
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
      message: "Spellguard: bootstrap frame was malformed (missing credentials array). Re-run @spellguard-setup."
    };
  }
  if (!frame.agent_secret) {
    return {
      ok: false,
      reason: "missing_agent_secret",
      message: "Spellguard: server bootstrap response missing agent_secret \u2014 out-of-date server version. Please upgrade the server and re-run @spellguard-setup."
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
        lines.push(
          `  scope=${describeGithubCredentialScope(existing.config.scopeSummary)}`
        );
      } else {
        lines.push(
          "  github=not connected (complete the dashboard GitHub-App install to grant repo access)"
        );
      }
      lines.push(
        "No changes made. Re-run @spellguard-setup to choose a different action."
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
      message: `Spellguard: bootstrap timed out waiting for browser approval (${e.message}). Re-run @spellguard-setup to try again.`
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
  const managed = (args.isManagedBox ?? isManagedBox)();
  const daemonResult = managed ? { daemon: "skipped", reason: "managed_box" } : await ensureCredentialDaemonRunning({
    config: writtenConfig,
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
      "  IMPORTANT \u2014 restart your Codex session ONCE now. The git + gh",
      "  credential helpers are wired via ~/.codex/config.toml, which Codex",
      "  reads only at startup. After this one restart, token rotation needs",
      "  no further restarts (and your machine-global ~/.gitconfig is untouched)."
    );
    renderMessage({ level: "info", message: lines.join("\n") });
    return { ok: true, daemon: daemonResult, githubCredential: "bundled" };
  }
  const daemonLine = (() => {
    switch (daemonResult.daemon) {
      case "spawned":
        return "  The credential daemon is running and listening for it.";
      case "restarted":
        return `  Spellguard replaced an obsolete or unhealthy credential daemon. The new daemon is running (pid ${daemonResult.pid}).`;
      case "already-running":
        return `  The credential daemon is already running (pid ${daemonResult.pid}) and listening for it.`;
      case "starting":
        return `  The credential daemon is starting (pid ${daemonResult.pid}); credential delivery is pending.`;
      case "skipped":
        return daemonResult.reason === "managed_box" ? "  The managed-box daemon owns credential delivery on this machine." : `  Credential-daemon startup was skipped (${daemonResult.reason}).`;
      case "unavailable":
        return `  WARNING: the credential daemon is unavailable (${daemonResult.reason}). Inspect the daemon log before requesting a new credential.`;
      default: {
        const exhaustive = daemonResult;
        return exhaustive;
      }
    }
  })();
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
  if ((daemonResult.daemon === "spawned" || daemonResult.daemon === "restarted" || daemonResult.daemon === "already-running") && waitMs > 0) {
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
      message: `Spellguard: GitHub credential received \u2014 scope=${describeGithubCredentialScope(delivered.scopeSummary)}.${author}
  IMPORTANT \u2014 restart your Codex session ONCE now so the git + gh credential
  helpers (wired via ~/.codex/config.toml, which Codex reads only at startup)
  take effect. After this one restart, token rotation needs no restart.`
    });
    return { ok: true, daemon: daemonResult, githubCredential: "delivered" };
  }
  renderMessage({
    level: daemonResult.daemon === "unavailable" ? "warn" : "info",
    message: daemonResult.daemon === "unavailable" ? `Spellguard: GitHub credential is still missing because the credential daemon is unavailable (${daemonResult.reason}). Inspect the daemon log and installed plugin version before requesting a new credential.` : [
      "Spellguard: GitHub credential not delivered yet. The daemon keeps",
      "  listening and writes it to your local config when the dashboard",
      "  GitHub App install completes. Once it lands, restart your Codex",
      "  session once so Codex reads the git and gh helper settings from",
      "  ~/.codex/config.toml. Re-run @spellguard-setup to check status."
    ].join("\n")
  });
  return { ok: true, daemon: daemonResult, githubCredential: "pending" };
}
var DEFAULT_CREDENTIAL_WAIT_MS = 5 * 6e4;
async function waitForGithubCredential(timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastProgressAt = started;
  const delay2 = (ms) => new Promise((resolve5) => setTimeout(resolve5, ms));
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
    await delay2(pollIntervalMs);
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
  return new Promise((resolve5) => {
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
      resolve5(result);
    };
    const timer = setTimeout(() => {
      settle({
        ok: false,
        reason: "bootstrap_timeout",
        message: "Spellguard: bootstrap timed out or channel unavailable (bootstrap_timeout). Re-run @spellguard-setup to try again."
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
            message = `Spellguard bootstrap failed: ${reason || "unknown error"}. Re-run @spellguard-setup to try again.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            message = `Spellguard: authentication failed (${reason || "auth_failed"}); the nonce may already have been consumed by another session. Re-run @spellguard-setup.`;
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            message = `Spellguard: agent ownership check failed (${reason || "agent_ownership"}). Confirm you're signed in to the correct organization and re-run @spellguard-setup.`;
            break;
          default:
            message = `Spellguard: bootstrap channel closed unexpectedly (code=${code}${reason ? `, reason=${reason}` : ""}). Re-run @spellguard-setup to try again.`;
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
    return "Spellguard: you are not a member of any Spellguard organization. Ask your admin to invite you, then re-run @spellguard-setup.";
  }
  if (code === "nonce_expired") {
    return "Spellguard: bootstrap timed out (nonce expired). Re-run @spellguard-setup.";
  }
  if (code === "github_consent_declined") {
    return "Spellguard: GitHub authorization was declined. Re-run @spellguard-setup to retry.";
  }
  if (code === "sso_failure") {
    return "Spellguard: SSO failed mid-setup. Re-run @spellguard-setup.";
  }
  if (code === "session_mismatch") {
    return "Spellguard: the browser session that completed setup does not match the one that started it. Sign in to the Spellguard dashboard with the same account, then re-run @spellguard-setup.";
  }
  if (code === "membership_lost") {
    return "Spellguard: your organization membership was revoked during setup. Contact your organization admin, then re-run @spellguard-setup.";
  }
  if (code === "github_exchange_failed") {
    return "Spellguard: GitHub rejected the authorization code (likely transient). Re-run @spellguard-setup and complete the GitHub consent screen again.";
  }
  if (code === "github_identity_failed") {
    return "Spellguard: could not read your GitHub identity (GitHub /user call failed). Re-run @spellguard-setup; if this keeps happening, contact support.";
  }
  if (code === "validation_error") {
    return "Spellguard: the setup link was malformed or expired. Re-run @spellguard-setup to get a fresh link.";
  }
  return `Spellguard setup failed: ${errMsg}`;
}

// src/hooks/session-start.ts
import { join as join11 } from "node:path";

// src/lib/codex-config-probe.ts
import { existsSync as existsSync3, readFileSync as readFileSync6 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
function probeCodexHooksFlag(opts = {}) {
  const path = opts.configPath ?? join5(opts.homeDirOverride ?? homedir3(), ".codex", "config.toml");
  if (!existsSync3(path)) {
    return { state: "unknown", reason: "config.toml absent" };
  }
  let raw;
  try {
    raw = readFileSync6(path, "utf-8");
  } catch (err) {
    return { state: "unknown", reason: `read failed: ${String(err)}` };
  }
  const lines = raw.split("\n");
  let inFeaturesSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed === "") continue;
    if (trimmed.startsWith("[")) {
      inFeaturesSection = trimmed === "[features]";
      continue;
    }
    if (inFeaturesSection) {
      const m = /^codex_hooks\s*=\s*(true|false|"true"|"false")$/i.exec(
        trimmed
      );
      if (m) {
        return m[1].toLowerCase().includes("true") ? { state: "enabled" } : { state: "disabled" };
      }
    }
  }
  return { state: "unknown", reason: "codex_hooks key not present" };
}

// src/lib/codex-credential-helper-install.ts
import { dirname as dirname6, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/lib/codex-shell-env-policy.ts
import {
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync7,
  renameSync as renameSync3,
  writeFileSync as writeFileSync3
} from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join6 } from "node:path";

// ../../node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class _TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// ../../node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// ../../node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
        let match = date.match(DATE_TIME_RE);
        if (match) {
          if (!match[1]) {
            hasDate = false;
            date = `0000-01-01T${date}`;
          }
          hasTime = !!match[2];
          hasTime && date[10] === " " && (date = date.replace(" ", "T"));
          if (match[2] && +match[2] > 23) {
            date = "";
          } else {
            offset = match[3] || null;
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z" || this.#offset === "z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// ../../node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// ../../node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// ../../node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// ../../node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// ../../node_modules/smol-toml/dist/stringify.js
var BARE_KEY = /^[a-z0-9-_]+$/i;
var HAS_WELLFORMED = !!"".isWellFormed;
function extendedTypeOf(obj) {
  let type = typeof obj;
  if (type === "object") {
    if (Array.isArray(obj))
      return "array";
    if (typeof obj.getUTCDate === "function" && obj instanceof Date)
      return "date";
    if (globalThis.Temporal) {
      if (obj.until) {
        if (obj instanceof Temporal.ZonedDateTime)
          return "temporal/tz+uc";
        if (obj instanceof Temporal.PlainDateTime || obj instanceof Temporal.PlainDate)
          return "temporal/uc";
        if (obj instanceof Temporal.PlainTime || obj instanceof Temporal.Instant)
          return "temporal";
        if (obj instanceof Temporal.PlainYearMonth)
          return "temporal/x";
      } else if (obj.toPlainDate && obj instanceof Temporal.PlainMonthDay || obj.negated && obj instanceof Temporal.Duration) {
        return "temporal/x";
      }
    }
  }
  return type;
}
function isArrayOfTables(obj) {
  for (let i = 0; i < obj.length; i++) {
    if (extendedTypeOf(obj[i]) !== "object")
      return false;
  }
  return obj.length != 0;
}
function formatWellFormedStringUnchecked(s) {
  return JSON.stringify(s).replaceAll("\x7F", "\\u007f");
}
function formatString(s) {
  return formatWellFormedStringUnchecked(HAS_WELLFORMED ? s.toWellFormed() : s);
}
function formatKey(s) {
  if (BARE_KEY.test(s))
    return s;
  if (HAS_WELLFORMED && !s.isWellFormed())
    throw new RangeError("key contains illegal lone surrogates");
  return formatWellFormedStringUnchecked(s);
}
function stringifyValue(val, type, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  switch (type) {
    // @ts-expect-error -- intentional fallthrough case
    case "number":
      if (isNaN(val))
        return "nan";
      if (val === Infinity)
        return "inf";
      if (val === -Infinity)
        return "-inf";
      if (Number.isInteger(val) && (numberAsFloat || !Number.isSafeInteger(val)))
        return val.toFixed(1);
    case "bigint":
    case "boolean":
    case "temporal":
      return val.toString();
    case "string":
      return formatString(val);
    case "date":
      if (isNaN(val.getTime()))
        throw new TypeError("cannot serialize invalid date");
      return val.toISOString();
    case "object":
      return stringifyInlineTable(val, depth, numberAsFloat, strictTemporal);
    case "array":
      return stringifyArray(val, depth, numberAsFloat, strictTemporal);
    // @ts-expect-error -- intentional fallthrough case
    case "temporal/tz+uc":
      if (strictTemporal) {
        let tz = val.timeZoneId;
        let tzc = tz.charCodeAt(0);
        if (
          // Classic offset
          tzc !== 43 && tzc !== 45 && // Fast pre-check pass; see below for the actually accepted values
          (tzc !== 85 && tzc !== 71 && tzc !== 90 && tzc !== 69 || // UTC and its aliases; Temporal implementations don't all canonicalise unfortunately
          tz !== "UTC" && tz !== "UCT" && tz !== "Universal" && tz !== "Zulu" && // GMT is a TZ but it's for all intents and purposes equivalent to UTC. Safe to downgrade.
          !tz.startsWith("GMT") && tz !== "Greenwich" && // Etc/* are all safe to downgrade to offset (either UTC, GMT, or offset)
          !tz.startsWith("Etc/"))
        ) {
          throw new TypeError("Temporal objects with an IANA timezone are not allowed in Temporal strict mode");
        }
      }
    case "temporal/uc":
      if (strictTemporal && val.calendarId !== "iso8601")
        throw new TypeError("Temporal objects with a non-default calendar are not allowed in Temporal strict mode");
      return val.toString({
        calendarName: "never",
        timeZoneName: "never"
      });
    case "temporal/x":
      throw new TypeError("Unsupported " + val[Symbol.toStringTag]);
  }
}
function stringifyInlineTable(obj, depth, numberAsFloat, strictTemporal) {
  let keys = Object.keys(obj);
  if (keys.length === 0)
    return "{}";
  let res = "{ ";
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (i)
      res += ", ";
    res += formatKey(k) + " = " + stringifyValue(obj[k], extendedTypeOf(obj[k]), depth - 1, numberAsFloat, strictTemporal);
  }
  return res + " }";
}
function stringifyArray(array, depth, numberAsFloat, strictTemporal) {
  if (array.length === 0)
    return "[]";
  let res = "[ ";
  for (let i = 0; i < array.length; i++) {
    if (i)
      res += ", ";
    if (array[i] === null || array[i] === void 0) {
      throw new TypeError("arrays cannot contain null or undefined values");
    }
    res += stringifyValue(array[i], extendedTypeOf(array[i]), depth - 1, numberAsFloat, strictTemporal);
  }
  return res + " ]";
}
function stringifyArrayTable(array, key, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let res = "";
  for (let i = 0; i < array.length; i++) {
    res += `${res && "\n"}[[${key}]]
`;
    res += stringifyTable(0, array[i], key, depth, numberAsFloat, strictTemporal);
  }
  return res;
}
function stringifyTable(tableKey, obj, prefix, depth, numberAsFloat, strictTemporal) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let preamble = "";
  let tables = "";
  let keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (obj[k] !== null && obj[k] !== void 0) {
      let type = extendedTypeOf(obj[k]);
      if (type === "symbol" || type === "function") {
        throw new TypeError(`cannot serialize values of type '${type}'`);
      }
      let key = formatKey(k);
      if (type === "array" && isArrayOfTables(obj[k])) {
        tables += (tables && "\n") + stringifyArrayTable(obj[k], prefix ? `${prefix}.${key}` : key, depth - 1, numberAsFloat, strictTemporal);
      } else if (type === "object") {
        let tblKey = prefix ? `${prefix}.${key}` : key;
        tables += (tables && "\n") + stringifyTable(tblKey, obj[k], tblKey, depth - 1, numberAsFloat, strictTemporal);
      } else {
        preamble += key;
        preamble += " = ";
        preamble += stringifyValue(obj[k], type, depth, numberAsFloat, strictTemporal);
        preamble += "\n";
      }
    }
  }
  if (tableKey && (preamble || !tables))
    preamble = preamble ? `[${tableKey}]
${preamble}` : `[${tableKey}]`;
  return preamble && tables ? `${preamble}
${tables}` : preamble || tables;
}
function stringify(obj, { maxDepth = 1e3, numbersAsFloat = false, strictTemporal = false } = {}) {
  if (extendedTypeOf(obj) !== "object") {
    throw new TypeError("stringify can only be called with an object");
  }
  let str = stringifyTable(0, obj, "", maxDepth, numbersAsFloat, strictTemporal);
  if (str[str.length - 1] !== "\n")
    return str + "\n";
  return str;
}

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

// src/lib/codex-shell-env-policy.ts
function gitSlotKeys() {
  const keys = ["GIT_CONFIG_COUNT"];
  for (let i = 0; i <= 12; i++) {
    keys.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`);
  }
  return keys;
}
var MANAGED_SET_KEYS = [
  ...gitSlotKeys(),
  "GH_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN"
];
function configTomlPath(codexHome) {
  const home = codexHome ?? process.env.CODEX_HOME ?? join6(homedir4(), ".codex");
  return join6(home, "config.toml");
}
function omit(obj, keys) {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.has(k)));
}
function buildGitSlots(helperPath, gitAuthorName, gitAuthorEmail, sshRewrite = isSshRewriteEnabled(), sshRewriteRepo) {
  const hasAuthor = Boolean(gitAuthorName) && Boolean(gitAuthorEmail);
  const set = {
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: helperPath,
    GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_3: helperPath,
    GIT_CONFIG_KEY_4: "credential.https://gist.github.com.helper",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "credential.https://gist.github.com.helper",
    GIT_CONFIG_VALUE_5: helperPath,
    GIT_CONFIG_KEY_6: "credential.https://github.com.useHttpPath",
    GIT_CONFIG_VALUE_6: "true"
  };
  let idx = 7;
  if (sshRewrite) {
    for (const rule of sshRewriteEntries(sshRewriteRepo)) {
      set[`GIT_CONFIG_KEY_${idx}`] = rule.key;
      set[`GIT_CONFIG_VALUE_${idx}`] = rule.value;
      idx++;
    }
  }
  if (hasAuthor) {
    set[`GIT_CONFIG_KEY_${idx}`] = "user.name";
    set[`GIT_CONFIG_VALUE_${idx}`] = gitAuthorName;
    idx++;
    set[`GIT_CONFIG_KEY_${idx}`] = "user.email";
    set[`GIT_CONFIG_VALUE_${idx}`] = gitAuthorEmail;
    idx++;
  }
  return { GIT_CONFIG_COUNT: String(idx), ...set };
}
function readConfig2(path) {
  if (!existsSync4(path)) return { cfg: {}, exists: false, parsed: true };
  try {
    return {
      cfg: parse(readFileSync7(path, "utf-8")),
      exists: true,
      parsed: true
    };
  } catch {
    return { cfg: {}, exists: true, parsed: false };
  }
}
function writeConfig2(path, cfg) {
  const dir = join6(path, "..");
  mkdirSync4(dir, { recursive: true, mode: 448 });
  const tmp = `${path}.spellguard.tmp`;
  writeFileSync3(tmp, stringify(cfg), { mode: 384 });
  renameSync3(tmp, path);
}
function installCodexShellEnvPolicy(args) {
  const path = configTomlPath(args.codexHome);
  const { cfg, exists, parsed } = readConfig2(path);
  if (exists && !parsed) return;
  const sepRaw = cfg.shell_environment_policy;
  const sep3 = sepRaw && typeof sepRaw === "object" ? sepRaw : {};
  const existingSet = sep3.set && typeof sep3.set === "object" ? sep3.set : {};
  const userVars = omit(existingSet, MANAGED_SET_KEYS);
  const existingGh = existingSet.GH_CONFIG_DIR;
  const effectiveGh = args.ghConfigDir ?? (typeof existingGh === "string" ? existingGh : void 0);
  const nextSet = {
    ...userVars,
    ...buildGitSlots(
      args.helperPath,
      args.gitAuthorName,
      args.gitAuthorEmail,
      args.sshRewrite,
      args.sshRewriteRepo
    ),
    // Defense in depth: Codex's default shell policy strips token-shaped env
    // names, but explicit empties ensure ambient GitHub auth can never outrank
    // the pinned per-agent GH_CONFIG_DIR if that default changes.
    GH_TOKEN: "",
    GITHUB_TOKEN: ""
  };
  if (effectiveGh) nextSet.GH_CONFIG_DIR = effectiveGh;
  cfg.shell_environment_policy = {
    ...omit(sep3, ["inherit", "set"]),
    inherit: "core",
    set: nextSet
  };
  writeConfig2(path, cfg);
}
function clearCodexShellEnvPolicy(args) {
  const path = configTomlPath(args?.codexHome);
  const { cfg, exists, parsed } = readConfig2(path);
  if (!exists || !parsed) return;
  const sepRaw = cfg.shell_environment_policy;
  if (!sepRaw || typeof sepRaw !== "object") return;
  const sep3 = sepRaw;
  const existingSet = sep3.set && typeof sep3.set === "object" ? sep3.set : {};
  const userVars = omit(existingSet, MANAGED_SET_KEYS);
  const rebuilt = Object.keys(userVars).length > 0 ? { ...sep3, set: userVars } : omit(sep3, ["set"]);
  const nonInherit = Object.keys(rebuilt).filter((k) => k !== "inherit");
  const cleaned = nonInherit.length === 0 ? omit(cfg, ["shell_environment_policy"]) : { ...cfg, shell_environment_policy: rebuilt };
  writeConfig2(path, cleaned);
}

// src/lib/codex-credential-helper-install.ts
function bundledHelperPath() {
  const here = dirname6(fileURLToPath4(import.meta.url));
  return join7(here, "..", "..", "bin", "spellguard-git-helper");
}
function installCodexCredentialHelper(args) {
  try {
    installCodexShellEnvPolicy({
      helperPath: args.helperPath ?? bundledHelperPath(),
      ghConfigDir: args.ghConfigDir,
      gitAuthorName: args.gitAuthorName,
      gitAuthorEmail: args.gitAuthorEmail,
      sshRewrite: args.sshRewrite,
      sshRewriteRepo: args.sshRewriteRepo,
      codexHome: args.codexHome
    });
  } catch {
  }
}
function clearCodexCredentialHelper(args) {
  try {
    clearCodexShellEnvPolicy({ codexHome: args?.codexHome });
  } catch {
  }
}

// src/lib/env-file-writer.ts
import {
  appendFileSync,
  chmodSync as chmodSync3,
  copyFileSync as copyFileSync2,
  existsSync as existsSync5,
  mkdirSync as mkdirSync5,
  writeFileSync as writeFileSync4
} from "node:fs";
import { dirname as dirname7, join as join8, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
var HERE = dirname7(fileURLToPath5(import.meta.url));
function bundledHelperPath2() {
  return resolve4(HERE, "..", "..", "bin", "spellguard-git-helper");
}
function ensureStableHelper(configDir) {
  const bundled = bundledHelperPath2();
  try {
    const dest = join8(configDir, "bin", "spellguard-git-helper");
    mkdirSync5(dirname7(dest), { recursive: true });
    copyFileSync2(bundled, dest);
    chmodSync3(dest, 493);
    return dest;
  } catch {
    return bundled;
  }
}
function clearGitConfigEnv(envFilePath) {
  if (!envFilePath) return;
  writeFileSync4(envFilePath, "export GIT_CONFIG_COUNT=0\n", "utf-8");
}

// src/lib/gh-config-dir.ts
import { join as join9 } from "node:path";
function ghConfigDirPath(configDir, agentId) {
  return join9(configDir, "gh", agentId);
}

// src/lib/git-version-check.ts
import { execFileSync as execFileSync2 } from "node:child_process";
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
    const out = execFileSync2("git", ["--version"], { encoding: "utf-8" });
    return parseGitVersion(out);
  } catch {
    return null;
  }
}

// src/lib/heal-leaked-global-gitconfig.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync6, mkdirSync as mkdirSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname8 } from "node:path";
var SPELLGUARD_HELPER_MARK = "spellguard-git-helper";
var SPELLGUARD_AUTHOR_RE = /\(spellguard:/i;
function readGlobal(key) {
  try {
    return execFileSync3("git", ["config", "--global", "--get", key], {
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
  } catch {
    return void 0;
  }
}
function unsetGlobalAll(key) {
  try {
    execFileSync3("git", ["config", "--global", "--unset-all", key], {
      stdio: "ignore"
    });
  } catch {
  }
}
function healLeakedGlobalGitConfig(markerPath) {
  if (existsSync6(markerPath)) return;
  try {
    const helper = readGlobal("credential.https://github.com.helper");
    if (helper?.includes(SPELLGUARD_HELPER_MARK)) {
      unsetGlobalAll("credential.https://github.com.helper");
      unsetGlobalAll("credential.https://github.com.useHttpPath");
    }
    const name = readGlobal("user.name");
    if (name && SPELLGUARD_AUTHOR_RE.test(name)) {
      unsetGlobalAll("user.name");
      unsetGlobalAll("user.email");
    }
  } catch {
  }
  try {
    mkdirSync6(dirname8(markerPath), { recursive: true, mode: 448 });
    writeFileSync5(
      markerPath,
      "spellguard codex: one-time global ~/.gitconfig leak heal complete\n",
      { mode: 384 }
    );
  } catch {
  }
}

// src/lib/migrate-legacy-config.ts
import {
  copyFileSync as copyFileSync3,
  existsSync as existsSync7,
  mkdirSync as mkdirSync7,
  renameSync as renameSync4,
  rmSync as rmSync3,
  writeFileSync as writeFileSync6
} from "node:fs";
import { join as join10 } from "node:path";
function moveFile(src, dst) {
  if (!existsSync7(src)) return false;
  try {
    renameSync4(src, dst);
    return true;
  } catch {
    try {
      copyFileSync3(src, dst);
      rmSync3(src, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
function migrateLegacyConfig(opts = {}) {
  const legacyDir = opts.legacyDir ?? legacyConfigDir();
  const frameworkDir = opts.frameworkDir ?? defaultConfigDir();
  const marker = join10(legacyDir, ".migrated");
  if (existsSync7(marker))
    return { migrated: false, reason: "already-migrated" };
  const legacyConfig = join10(legacyDir, "config.json");
  if (!existsSync7(legacyConfig)) {
    return { migrated: false, reason: "no-legacy-config" };
  }
  const frameworkConfig = join10(frameworkDir, "config.json");
  if (existsSync7(frameworkConfig)) {
    return { migrated: false, reason: "framework-already-configured" };
  }
  const stop = opts.stopLegacyDaemons ?? ((dir) => stopLocalDaemons({ configDir: dir }));
  try {
    stop(legacyDir);
  } catch {
  }
  mkdirSync7(frameworkDir, { recursive: true, mode: 448 });
  if (!moveFile(legacyConfig, frameworkConfig)) {
    return { migrated: false, reason: "move-failed" };
  }
  moveFile(join10(legacyDir, "git-tokens"), join10(frameworkDir, "git-tokens"));
  const legacyAgents = join10(legacyDir, "agents");
  if (existsSync7(legacyAgents)) {
    try {
      renameSync4(legacyAgents, join10(frameworkDir, "agents"));
    } catch {
    }
  }
  writeFileSync6(
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

// src/lib/ssh-remote-detect.ts
import { execFileSync as execFileSync4 } from "node:child_process";

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
    const out = execFileSync4("git", ["remote", "-v"], {
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
    const out = execFileSync4("git", ["remote", "-v"], {
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
  const ensureDaemonRunning = deps.ensureDaemonRunning ?? ensureCredentialDaemonRunning;
  const hooksFlag = probeCodexHooksFlag();
  if (hooksFlag.state === "disabled") {
    renderMessage({
      level: "warn",
      message: "Spellguard: detected `codex_hooks = false` in ~/.codex/config.toml. Enable it with `[features] codex_hooks = true` so SessionStart / PreToolUse / PostToolUse hooks fire."
    });
  }
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
  const managed = (deps.isManagedBox ?? isManagedBox)();
  if (!managed) {
    healLeakedGlobalGitConfig(
      join11(
        deps.configDir ?? defaultConfigDir(),
        ".codex-global-gitconfig-healed"
      )
    );
  }
  if (!deps.readConfigImpl) migrateLegacyConfig();
  const readResult = (deps.readConfigImpl ?? readConfig)();
  if (!readResult.config) {
    if (readResult.reason === "malformed") {
      renderMessage({
        level: "error",
        message: `Spellguard: config file exists but is malformed (failing field: ${readResult.malformedField ?? "unknown"}). A .bak snapshot sits next to ~/.config/spellguard/config.json \u2014 inspect/restore it, or delete the file and re-run \`@spellguard-setup\`.`
      });
      return { ok: false, reason: "malformed" };
    }
    if (readResult.reason === "wrong_permissions") {
      renderMessage({
        level: "error",
        message: `Spellguard: ${defaultConfigPath()} has mode ${readResult.foundMode ?? "other than 0600"} and is owned by another user, so it could not be read or repaired. Your agent identity is intact \u2014 fix the owner/mode (\`chown\` it back to you, then \`chmod 600\`) rather than re-running \`@spellguard-setup\`.`
      });
      return { ok: false, reason: "wrong_permissions" };
    }
    renderMessage({
      level: "info",
      message: "Spellguard not configured \u2014 run `@spellguard-setup` to provision a credential."
    });
    return { ok: false, reason: readResult.reason ?? "missing" };
  }
  if (readResult.permissionsHealed) {
    renderMessage({
      level: "warn",
      message: `Spellguard: ${defaultConfigPath()} had unsafe permissions; Spellguard restored mode 0600 automatically.`
    });
  }
  if (readResult.config.agentId && readResult.config.spellguardBaseUrl && readResult.config.agentSecret) {
    void syncFrameworkIdentity({
      agentId: readResult.config.agentId,
      managementUrl: readResult.config.spellguardBaseUrl,
      agentSecret: readResult.config.agentSecret,
      fetchImpl: deps.fetchImpl
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
  const configDir = deps.configDir ?? defaultConfigDir();
  const ghConfigDir = ghConfigDirPath(configDir, readResult.config.agentId);
  const writeEnvFile = () => {
    if (managed) return;
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else {
      installCodexCredentialHelper({
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
    const daemonResult2 = managed ? { daemon: "skipped", reason: "managed_box" } : await ensureDaemonRunning({
      config: readResult.config,
      spawnDaemon: deps.spawnDaemon,
      configDir: deps.configDir,
      cwd
    });
    renderMessage({
      level: "error",
      message: readResult.config.revokedMessage ? `Spellguard: ${readResult.config.revokedMessage}` : daemonResult2.daemon === "unavailable" ? `Spellguard: this credential has been revoked, and the credential daemon is unavailable (${daemonResult2.reason}). Inspect the daemon log and installed plugin version before requesting a replacement.` : "Spellguard: this credential has been revoked. Spellguard is waiting for a replacement credential; if git stays blocked, run `spellguard doctor --repair` (non-destructive) before re-running `@spellguard-setup`."
    });
    return { ok: false, reason: "revoked", daemonResult: daemonResult2 };
  }
  if (!readResult.config.scopedTokenId || !readResult.config.scopedToken || !readResult.config.expiresAt || !readResult.config.scopeSummary) {
    const daemonResult2 = managed ? { daemon: "skipped", reason: "managed_box" } : await ensureDaemonRunning({
      config: readResult.config,
      spawnDaemon: deps.spawnDaemon,
      configDir: deps.configDir,
      cwd
    });
    renderMessage({
      level: daemonResult2.daemon === "unavailable" ? "error" : "info",
      message: daemonResult2.daemon === "unavailable" ? `Spellguard: agent identity is present, but GitHub is not connected and the credential daemon is unavailable (${daemonResult2.reason}). Inspect the daemon log and installed plugin version. Do not request a new credential until the local process state is understood.` : "Spellguard: agent identity present; GitHub not yet connected. Open your Spellguard dashboard and complete the GitHub App install on this agent. The credential owner will write the token to your local config when it arrives. Git operations remain unprotected until the credential lands."
    });
    return { ok: true, daemonResult: daemonResult2, reason: "identity_only" };
  }
  const initialConfig = readResult.config;
  const scopedTokenId = initialConfig.scopedTokenId;
  const daemonResult = managed ? { daemon: "skipped", reason: "managed_box" } : await ensureDaemonRunning({
    config: initialConfig,
    spawnDaemon: deps.spawnDaemon,
    configDir: deps.configDir,
    cwd
  });
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
  let statusResult;
  try {
    statusResult = await api.GET("/credentials/github/status", {
      params: { query: { scoped_token_id: scopedTokenId } },
      headers: scopedTokenForProbe ? { "X-Spellguard-Scoped-Token": scopedTokenForProbe } : void 0
    });
  } catch {
    renderMessage({
      level: "error",
      message: "Spellguard: could not verify credential status because the control-plane transport failed. The local credential state is unchanged. Inspect the daemon and retry before requesting a new credential."
    });
    return { ok: false, reason: "status_failed", daemonResult };
  }
  const { data, error, response } = statusResult;
  if (error) {
    const httpStatus = response?.status;
    const needsReconnect = isAgentGoneStatus(httpStatus);
    renderMessage({
      level: "error",
      message: needsReconnect ? `Spellguard: your agent is no longer recognized by the server (HTTP ${httpStatus}). This usually means the credential was revoked or the Spellguard environment was reset. Run \`@spellguard-setup\` to reconnect this agent.` : `Spellguard: could not verify credential status with the server (${error.error?.code ?? error.error?.message ?? "unknown error"}). The local credential state is unchanged. Inspect the daemon and retry before requesting a new credential.`
      // openapi-fetch error envelope: { error: { code, message } }
    });
    return { ok: false, reason: "status_failed", daemonResult };
  }
  const status = data.status;
  if (status === "revoked") {
    (deps.markConfigRevokedImpl ?? markConfigRevoked)();
    renderMessage({
      level: "error",
      message: "Spellguard: this credential has been revoked. Run `@spellguard-setup` to provision a new one."
    });
    return { ok: false, reason: "revoked", daemonResult };
  }
  let activeConfig = initialConfig;
  if (status === "near_expiry") {
    renderMessage({
      level: "info",
      message: "Spellguard: credential approaching expiry; daemon will refresh in background."
    });
  }
  if (status === "expired") {
    const pollFn = deps.pollForFreshCredential ?? defaultPollForFreshCredential;
    const fresh = await pollFn(activeConfig.expiresAt, 5e3);
    if (!fresh) {
      const daemonHealth = readDaemonHealth(configDir, activeConfig.agentId);
      const daemonDetail = daemonResult.daemon === "unavailable" ? `The credential daemon is unavailable (${daemonResult.reason}).` : daemonHealth?.transportState === "error" ? "The credential daemon is running, but its control-plane transport is failing." : "The credential daemon is running and the refresh is still pending.";
      renderMessage({
        level: "error",
        message: `Spellguard: credential is expired. ${daemonDetail} No replacement arrived within 5 seconds. Inspect the daemon log and verify actual git or gh access before requesting a new credential.`
      });
      return { ok: false, reason: "expired_no_refresh", daemonResult };
    }
    activeConfig = fresh;
  }
  if (!managed) {
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else {
      installCodexCredentialHelper({
        gitAuthorName: activeConfig.gitAuthorName,
        gitAuthorEmail: activeConfig.gitAuthorEmail,
        ghConfigDir,
        helperPath: ensureStableHelper(configDir),
        sshRewriteRepo
      });
    }
  }
  const minutesLeft = Math.max(
    0,
    Math.floor(
      (new Date(activeConfig.expiresAt).getTime() - Date.now()) / 6e4
    )
  );
  const scopeText = activeConfig.scopeSummary.mode === "all" ? `scope=${describeGithubCredentialScope(activeConfig.scopeSummary)}` : `repos=${activeConfig.scopeSummary.repos.length}`;
  renderMessage({
    level: "info",
    message: `Spellguard: agent credentials injected \u2014 agent=${activeConfig.agentId}, ${scopeText}, expires in ${minutesLeft} minutes`
  });
  return { ok: true, daemonResult };
}
async function defaultPollForFreshCredential(initialExpiresAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const initialTs = new Date(initialExpiresAt).getTime();
  const delay2 = (ms) => new Promise((resolve5) => setTimeout(resolve5, ms));
  while (Date.now() < deadline) {
    await delay2(500);
    const result = readConfig();
    if (result.config?.expiresAt && new Date(result.config.expiresAt).getTime() > initialTs) {
      return result.config;
    }
  }
  return null;
}

// src/hooks/pre-tool-use-observation.ts
import { homedir as homedir6 } from "node:os";
import { join as join14 } from "node:path";

// src/lib/bash-command-timing.ts
import {
  chmodSync as chmodSync4,
  mkdirSync as mkdirSync8,
  readFileSync as readFileSync8,
  readdirSync as readdirSync3,
  rmSync as rmSync4,
  statSync as statSync3,
  writeFileSync as writeFileSync7
} from "node:fs";
import { join as join12 } from "node:path";
var TIMING_SUBDIR = "bash-timing";
var STALE_MS = 60 * 60 * 1e3;
function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200) || "nokey";
}
function timingDir(rootDir) {
  return join12(rootDir, TIMING_SUBDIR);
}
function markBashCommandStart(input) {
  try {
    const dir = timingDir(input.rootDir);
    mkdirSync8(dir, { recursive: true });
    try {
      chmodSync4(dir, 448);
    } catch {
    }
    writeFileSync7(join12(dir, `${safeKey(input.key)}.txt`), String(input.nowMs), {
      mode: 384
    });
  } catch {
  }
}
function consumeBashCommandStart(input) {
  const dir = timingDir(input.rootDir);
  const file = join12(dir, `${safeKey(input.key)}.txt`);
  let result = null;
  try {
    const raw = readFileSync8(file, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n)) result = n;
  } catch {
    result = null;
  }
  try {
    rmSync4(file, { force: true });
  } catch {
  }
  pruneStale(dir, input.nowMs);
  return result;
}
function pruneStale(dir, nowMs) {
  try {
    for (const entry of readdirSync3(dir)) {
      const p = join12(dir, entry);
      try {
        if (nowMs - statSync3(p).mtimeMs > STALE_MS) rmSync4(p, { force: true });
      } catch {
      }
    }
  } catch {
  }
}

// src/lib/git-command-parser.ts
var WHITESPACE = /\s/;
var SHELL_WRAPPERS = ["sh", "bash", "zsh", "dash", "ksh"];
var SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c$/;
function nestedShellPayload(words) {
  for (const shell of SHELL_WRAPPERS) {
    const shellIndex = commandWordIndex(words, shell);
    if (shellIndex < 0) continue;
    for (let index = shellIndex + 1; index < words.length; index++) {
      if (SHELL_COMMAND_FLAG_RE.test(words[index])) {
        return words[index + 1] ?? null;
      }
    }
    return null;
  }
  const evalIndex = commandWordIndex(words, "eval");
  if (evalIndex >= 0 && words.length > evalIndex + 1) {
    return words.slice(evalIndex + 1).join(" ");
  }
  return null;
}
function tokenizeShellCommand(command, depth = 0) {
  if (typeof command !== "string") return null;
  const segments = [];
  let words = [];
  let current = "";
  let started = false;
  let failed = false;
  const heredocs = [];
  let index = 0;
  const flushWord = () => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };
  const flushSegment = () => {
    flushWord();
    const segment = { words };
    if (depth === 0) {
      const payload = nestedShellPayload(words);
      if (payload !== null) {
        const nested = tokenizeShellCommand(payload, depth + 1);
        if (!nested) failed = true;
        else segment.nested = nested;
      }
    }
    segments.push(segment);
    words = [];
  };
  const append = (value) => {
    current += value;
    started = true;
  };
  const readWord = (from) => {
    let cursor = from;
    while (cursor < command.length && WHITESPACE.test(command[cursor])) {
      if (command[cursor] === "\n") return { value: "", next: cursor };
      cursor++;
    }
    let value = "";
    while (cursor < command.length) {
      const char = command[cursor];
      if (WHITESPACE.test(char) || isSeparatorStart(command, cursor)) break;
      if (char === "\\") {
        if (cursor + 1 >= command.length) return null;
        value += command[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === "'" || char === '"') {
        const end = command.indexOf(char, cursor + 1);
        if (end < 0) return null;
        value += command.slice(cursor + 1, end);
        cursor = end + 1;
        continue;
      }
      value += char;
      cursor++;
    }
    return { value, next: cursor };
  };
  const consumeHeredocBodies = (from) => {
    let cursor = from;
    while (heredocs.length > 0) {
      const doc = heredocs.shift();
      if (!doc) break;
      for (; ; ) {
        const end = command.indexOf("\n", cursor);
        const raw = command.slice(cursor, end < 0 ? command.length : end);
        const line = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        cursor = end < 0 ? command.length : end + 1;
        if (line === doc.delimiter || end < 0) break;
      }
    }
    return cursor;
  };
  while (index < command.length) {
    const char = command[index];
    if (char === "\n") {
      flushSegment();
      index = consumeHeredocBodies(index + 1);
      continue;
    }
    if (char === "#" && !started) {
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= command.length) return null;
      if (command[index + 1] === "\n") {
        index += 2;
        continue;
      }
      append(command[index + 1]);
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      append(command.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === '"') {
      const scanned = scanDoubleQuoted(command, index);
      if (!scanned) return null;
      append(scanned.value);
      index = scanned.next;
      continue;
    }
    if (char === "$" && command[index + 1] === "'") {
      const scanned = scanDollarQuoted(command, index + 1);
      if (!scanned) return null;
      append(scanned.value);
      index = scanned.next;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      if (end < 0) return null;
      append(command.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      const end = matchingParenthesis(command, index + 1);
      if (end < 0) return null;
      append(command.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    const redirection = scanRedirection(command, index, current, started);
    if (redirection) {
      if (redirection.consumedFdDigits) {
        current = current.slice(0, current.length - redirection.fdDigits);
        started = current.length > 0;
      }
      flushWord();
      if (redirection.heredoc) {
        const delimiter = readWord(redirection.next);
        if (!delimiter) return null;
        heredocs.push({
          delimiter: delimiter.value,
          stripTabs: redirection.stripTabs
        });
        index = delimiter.next;
        continue;
      }
      const target = readWord(redirection.next);
      if (!target) return null;
      index = target.next;
      continue;
    }
    const separator = separatorAt(command, index);
    if (separator) {
      flushSegment();
      if (separator === "(" || separator === ")") {
        segments.push({
          words: [],
          subshell: separator === "(" ? "open" : "close"
        });
      }
      index += separator.length;
      continue;
    }
    if (WHITESPACE.test(char)) {
      flushWord();
      index++;
      continue;
    }
    append(char);
    index++;
  }
  flushSegment();
  return failed ? null : segments;
}
function scanDoubleQuoted(command, start) {
  let value = "";
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\" && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      const end = matchingParenthesis(command, index + 1);
      if (end < 0) return null;
      value += command.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index++;
  }
  return null;
}
function scanDollarQuoted(command, start) {
  let value = "";
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\" && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    if (char === "'") return { value, next: index + 1 };
    value += char;
    index++;
  }
  return null;
}
function matchingParenthesis(command, open) {
  let depth = 0;
  for (let index = open; index < command.length; index++) {
    const char = command[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}
var SEPARATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "(", ")"];
function separatorAt(command, index) {
  for (const separator of SEPARATORS) {
    if (command.startsWith(separator, index)) return separator;
  }
  return null;
}
function isSeparatorStart(command, index) {
  return separatorAt(command, index) !== null;
}
function scanRedirection(command, index, current, started) {
  const char = command[index];
  const isFdPrefixed = started && /^\d+$/.test(current);
  if (char === "&") {
    if (command[index + 1] !== ">") return null;
    return {
      next: index + (command.startsWith("&>>", index) ? 3 : 2),
      heredoc: false,
      stripTabs: false,
      consumedFdDigits: false,
      fdDigits: 0
    };
  }
  if (char !== "<" && char !== ">") return null;
  const fdDigits = isFdPrefixed ? current.length : 0;
  if (command.startsWith("<<<", index)) {
    return {
      next: index + 3,
      heredoc: false,
      stripTabs: false,
      consumedFdDigits: isFdPrefixed,
      fdDigits
    };
  }
  if (command.startsWith("<<", index)) {
    const stripTabs = command[index + 2] === "-";
    return {
      next: index + (stripTabs ? 3 : 2),
      heredoc: true,
      stripTabs,
      consumedFdDigits: isFdPrefixed,
      fdDigits
    };
  }
  let length = 1;
  const next = command[index + 1];
  if (next === ">" || next === "&" || next === "|") length = 2;
  return {
    next: index + length,
    heredoc: false,
    stripTabs: false,
    consumedFdDigits: isFdPrefixed,
    fdDigits
  };
}
var ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
var OPENING_RESERVED_WORDS = /* @__PURE__ */ new Set([
  "{",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until"
]);
var PREFIX_VALUE_OPTIONS = /* @__PURE__ */ new Map([
  [
    "sudo",
    /* @__PURE__ */ new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"])
  ],
  ["env", /* @__PURE__ */ new Set(["-u", "-C", "-S", "--unset", "--chdir"])],
  ["command", /* @__PURE__ */ new Set()],
  ["exec", /* @__PURE__ */ new Set(["-a"])],
  ["time", /* @__PURE__ */ new Set(["-f", "-o"])],
  ["nohup", /* @__PURE__ */ new Set()],
  ["timeout", /* @__PURE__ */ new Set(["-s", "-k", "--signal", "--kill-after"])],
  [
    "xargs",
    /* @__PURE__ */ new Set([
      "-n",
      "-L",
      "-I",
      "-P",
      "-s",
      "-d",
      "-E",
      "-a",
      "--max-args",
      "--max-lines",
      "--replace",
      "--max-procs",
      "--max-chars",
      "--delimiter",
      "--eof",
      "--arg-file"
    ])
  ]
]);
function skipPrefixOptions(words, index, valueOptions) {
  let at = index;
  while (at < words.length && words[at].startsWith("-") && words[at] !== "-") {
    if (words[at] === "--") return at + 1;
    at += valueOptions.has(words[at]) ? 2 : 1;
  }
  return at;
}
function commandWordIndex(words, name) {
  let index = skipOpeners(words, 0);
  let next = skipCommandPrefix(words, index);
  while (next !== index) {
    if (next < 0) return -1;
    index = skipOpeners(words, next);
    next = skipCommandPrefix(words, index);
  }
  return words[index] === name ? index : -1;
}
function skipOpeners(words, index) {
  let at = index;
  while (at < words.length && (OPENING_RESERVED_WORDS.has(words[at]) || ENV_ASSIGNMENT_RE.test(words[at] ?? ""))) {
    at++;
  }
  return at;
}
function skipCommandPrefix(words, index) {
  const prefix = words[index];
  const valueOptions = PREFIX_VALUE_OPTIONS.get(prefix);
  if (!valueOptions) return index;
  if (prefix === "command" && isLookupOnly(words, index + 1)) return -1;
  const end = skipPrefixOptions(words, index + 1, valueOptions);
  return prefix === "timeout" ? end + 1 : end;
}
function isLookupOnly(words, index) {
  for (let at = index; words[at]?.startsWith("-"); at++) {
    if (/^-[A-Za-z]*[vV]/.test(words[at])) return true;
  }
  return false;
}
var GIT_GLOBAL_VALUE_OPTIONS = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env"
]);
var GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "--no-pager",
  "--paginate",
  "-p",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks"
]);
var GIT_DIRECTORY_OPTIONS = /* @__PURE__ */ new Set(["-C"]);
function parseGitCommand(words) {
  const gitIndex = commandWordIndex(words, "git");
  if (gitIndex < 0) return null;
  const chdirs = [];
  let redirected = false;
  let index = gitIndex + 1;
  while (index < words.length) {
    const word = words[index];
    if (!word.startsWith("-")) break;
    const [name] = word.split("=", 1);
    if (GIT_GLOBAL_FLAGS.has(word)) {
      index++;
      continue;
    }
    if (word.includes("=") && GIT_GLOBAL_VALUE_OPTIONS.has(name)) {
      if (!GIT_DIRECTORY_OPTIONS.has(name)) redirected = true;
      else chdirs.push(word.slice(name.length + 1));
      index++;
      continue;
    }
    if (word.startsWith("-C") && word.length > 2) {
      chdirs.push(word.slice(2));
      index++;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) {
      const value = words[index + 1];
      if (value === void 0) return { chdirs, redirected: true, args: [] };
      if (GIT_DIRECTORY_OPTIONS.has(word)) chdirs.push(value);
      else redirected = true;
      index += 2;
      continue;
    }
    redirected = true;
    index++;
  }
  const subcommand = words[index];
  return {
    chdirs,
    redirected,
    subcommand,
    args: subcommand === void 0 ? [] : words.slice(index + 1)
  };
}
function hasNewBranchFlag(args, flags) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--") return false;
    if (flags.includes(args[index])) {
      const name = args[index + 1];
      return name !== void 0 && name.length > 0 && !name.startsWith("-");
    }
  }
  return false;
}
function flattenShellSegments(segments) {
  return segments.flatMap(
    (segment) => segment.nested ? [segment, ...segment.nested] : [segment]
  );
}
function segmentGitOp(words) {
  const git = parseGitCommand(words);
  if (!git?.subcommand) return null;
  if (git.subcommand === "push") return "push";
  if (git.subcommand === "checkout" && hasNewBranchFlag(git.args, ["-b", "-B"]))
    return "checkout_new_branch";
  if (git.subcommand === "switch" && hasNewBranchFlag(git.args, ["-b", "-B", "-c"]))
    return "switch_new_branch";
  if (git.subcommand === "commit" && !git.args.includes("--help") && !git.args.includes("-h"))
    return "commit";
  return null;
}
var UNPARSEABLE_GIT_SCAN = /\bgit\b[^\n;&|]*\b(?:push|commit|checkout|switch)\b/;
var UNPARSEABLE_GH_SCAN = /\bgh\b[^\n;&|]*\bpr\s+create\b/;
var UNPARSEABLE_MATERIALIZE_SCAN = /\bgit\b[^\n;&|]*\b(?:merge|rebase|cherry-pick|revert|pull|reset|restore|stash|checkout|switch)\b/;
var UNPARSEABLE_AMEND_SCAN = /--amend\b/;
function detectGitOp(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return null;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_GIT_SCAN.test(cmd) ? "unparseable" : null;
  for (const segment of flattenShellSegments(segments)) {
    const op = segmentGitOp(segment.words);
    if (op) return op;
  }
  return null;
}
function detectGhPrCreate(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_GH_SCAN.test(cmd);
  return flattenShellSegments(segments).some(
    (segment) => isGhPrCreate(segment.words)
  );
}
function isGhPrCreate(words) {
  const ghIndex = commandWordIndex(words, "gh");
  if (ghIndex < 0) return false;
  const prIndex = words.indexOf("pr", ghIndex + 1);
  return prIndex > 0 && words[prIndex + 1] === "create";
}
var MATERIALIZING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "pull",
  "reset",
  "restore"
]);
var NEW_BRANCH_FLAGS = ["-b", "-B", "-c", "-C"];
function detectTreeMaterializingGitOp(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_MATERIALIZE_SCAN.test(cmd);
  return flattenShellSegments(segments).some(({ words }) => {
    const git = parseGitCommand(words);
    if (!git?.subcommand) return false;
    if (MATERIALIZING_SUBCOMMANDS.has(git.subcommand)) return true;
    if (git.subcommand === "stash")
      return git.args[0] === "pop" || git.args[0] === "apply";
    if (git.subcommand !== "checkout" && git.subcommand !== "switch")
      return false;
    return !git.args.some((arg) => NEW_BRANCH_FLAGS.includes(arg));
  });
}
function isAmendCommit(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) {
    return UNPARSEABLE_GIT_SCAN.test(cmd) && UNPARSEABLE_AMEND_SCAN.test(cmd);
  }
  return flattenShellSegments(segments).some(({ words }) => {
    const git = parseGitCommand(words);
    if (git?.subcommand !== "commit") return false;
    return git.args.some(
      (arg) => arg === "--amend" || arg.startsWith("--amend=")
    );
  });
}

// src/lib/observation-emitter.ts
import { randomUUID as randomUUID3 } from "node:crypto";
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
    event_uuid: input.eventUuid ?? randomUUID3(),
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
  opts;
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

// src/lib/observation-pipeline.ts
import { homedir as homedir5 } from "node:os";
import { join as join13 } from "node:path";

// src/lib/observation-scope.ts
import { existsSync as existsSync8, readFileSync as readFileSync9 } from "node:fs";
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
  if (!existsSync8(path)) return { allowlist: [] };
  let raw;
  try {
    raw = readFileSync9(path, "utf-8");
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
  chmodSync as chmodSync5,
  existsSync as existsSync9,
  mkdirSync as mkdirSync9,
  readFileSync as readFileSync10,
  writeFileSync as writeFileSync8
} from "node:fs";
import { platform as platform3 } from "node:os";
import { dirname as dirname9 } from "node:path";
var REFRESH_INTERVAL_MS = 30 * 60 * 1e3;
function readScopeCache(path) {
  if (!existsSync9(path)) return null;
  try {
    const raw = readFileSync10(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.serverScope) || typeof parsed.refreshedAt !== "number")
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeScopeCache(path, scope) {
  mkdirSync9(dirname9(path), { recursive: true });
  writeFileSync8(path, JSON.stringify(scope), { mode: 384 });
  if (platform3() !== "win32") {
    chmodSync5(path, 384);
  }
}
function shouldRefreshCache(cache, now = Date.now()) {
  if (!cache) return true;
  return now - cache.refreshedAt >= REFRESH_INTERVAL_MS;
}

// src/lib/observation-pipeline.ts
function defaultScopeCachePath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join13(
    xdg ?? join13(homedir5(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join13(
    xdg ?? join13(homedir5(), ".config"),
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
  if (!isBashTool(toolName)) return null;
  const cmd = args.join(" ");
  const op = detectGitOp(cmd);
  if (op === "push") return "push";
  if (op === "checkout_new_branch" || op === "switch_new_branch")
    return "branch_create";
  if (detectGhPrCreate(cmd)) return "pr_open";
  return null;
}
function unattributedMessage(input) {
  const parts = [
    "Spellguard could not work out which GitHub repository this command writes to, so it cannot check the credential for that repository."
  ];
  if (input.githubTargetReason) {
    parts.push(
      `Spellguard could not attribute it because ${input.githubTargetReason}.`
    );
  }
  parts.push(
    "Re-run the GitHub step as its own command, naming the target explicitly \u2014 for example `git -C /absolute/path/to/worktree push origin <branch>` or `gh pr create --repo OWNER/REPO` \u2014 and keep the intended repository unchanged.",
    "This is NOT a credential failure: credential checks still apply, and nothing needs repairing or re-authorizing."
  );
  return parts.join(" ");
}
function credentialDecision(input) {
  const state = input.githubCredentialState ?? (input.localCredentialAvailable === false ? "unavailable" : void 0);
  if (state === void 0 || state === "available" || state === "expired") {
    return null;
  }
  if (state === "unattributed") {
    return { decision: "block", message: unattributedMessage(input) };
  }
  return {
    decision: "block",
    message: "Spellguard credential unavailable for this GitHub target. Mutation is blocked until a matching credential is available."
  };
}
function isBashTool(toolName) {
  return toolName === "Bash" || toolName === "bash";
}
function isAgentAuthoredFileTool(toolName) {
  return toolName === "apply_patch";
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
function toCodexPreToolUseOutput(decision) {
  if (decision.decision === "block") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.message
      }
    };
  }
  if (decision.decision === "skip") {
    return {};
  }
  return { continue: true };
}
async function runPreToolUseCodex(input) {
  const decision = await runPreToolUse(input);
  return toCodexPreToolUseOutput(decision);
}
async function runPreToolUse(input) {
  if (isBashTool(input.toolName) || isAgentAuthoredFileTool(input.toolName)) {
    markBashCommandStart({
      rootDir: input.editsRootDir ?? join14(homedir6(), ".spellguard"),
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now()
    });
  }
  const op = detectGitOperation(input.toolName, input.toolArgs);
  const unreadable = op === null && isBashTool(input.toolName) && detectGitOp(input.toolArgs.join(" ")) === "unparseable";
  if (unreadable) return credentialDecision(input) ?? { decision: "skip" };
  if (!op) return { decision: "skip" };
  if (input.githubTargetContext === "execution-directory-missing") {
    return {
      decision: "block",
      message: "Codex did not supply the command execution directory. The session directory is not a reliable GitHub target. Retry with git -C /absolute/worktree push ... or gh pr create --repo OWNER/REPO. Keep the intended repository unchanged. Credential checks still apply; do not repair credentials based on this message."
    };
  }
  const credential = credentialDecision(input);
  if (credential) return credential;
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
      message: "Spellguard credential revoked. Run @spellguard-setup to re-authorize."
    };
  }
  const observation = await emitPreToolUseObservation(input);
  return { decision: "allow", observation };
}

// src/hooks/post-tool-use-observation.ts
import { execFileSync as execFileSync7, execSync } from "node:child_process";
import { homedir as homedir7 } from "node:os";
import { join as join17 } from "node:path";

// src/lib/bash-edit-capture.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import { lstatSync as lstatSync2, readFileSync as readFileSync11, realpathSync as realpathSync2, statSync as statSync4 } from "node:fs";
import { join as join16, posix, sep as sep2 } from "node:path";

// src/lib/edit-store.ts
import { chmodSync as chmodSync6, existsSync as existsSync10, mkdirSync as mkdirSync10 } from "node:fs";
import { join as join15 } from "node:path";
var backend = loadSqliteBackend();
var warnedDegraded = false;
function noopStore() {
  if (!warnedDegraded) {
    warnedDegraded = true;
    process.stderr.write(
      "[spellguard-plugin] edit-store unavailable (no SQLite backend: node:sqlite not flag-free on this Node and better-sqlite3 not installed). Edit history will not be recorded; commit-observation correlation is degraded. Run /spellguard-setup or upgrade to Node 24+ to enable it.\n"
    );
  }
  return {
    async record(_r) {
    },
    async queryByDir(_input) {
      return [];
    },
    async pruneOlderThan(_input) {
    },
    close() {
    }
  };
}
function openEditStore(opts) {
  if (!backend) return noopStore();
  mkdirSync10(opts.rootDir, { recursive: true });
  tryChmod(opts.rootDir, 448);
  const dbPath = join15(opts.rootDir, "edits.db");
  const db = backend.open(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      working_dir TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_before TEXT NOT NULL,
      content_after TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS edits_dir_ts ON edits (working_dir, timestamp);
  `);
  const insert = db.prepare(`
    INSERT INTO edits (working_dir, file_path, content_before, content_after, session_id, agent_id, timestamp)
    VALUES (@workingDir, @filePath, @contentBefore, @contentAfter, @sessionId, @agentId, @timestamp)
  `);
  const queryStmt = db.prepare(`
    SELECT working_dir AS workingDir, file_path AS filePath,
           content_before AS contentBefore, content_after AS contentAfter,
           session_id AS sessionId, agent_id AS agentId, timestamp
    FROM edits
    WHERE working_dir = @workingDir AND (@since IS NULL OR timestamp >= @since)
    ORDER BY timestamp ASC
  `);
  const pruneStmt = db.prepare("DELETE FROM edits WHERE timestamp < @cutoff");
  pruneStmt.run({
    cutoff: new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString()
  });
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync10(path)) tryChmod(path, 384);
  }
  return {
    async record(r) {
      insert.run(r);
    },
    async queryByDir(input) {
      return queryStmt.all({
        workingDir: input.workingDir,
        since: input.sinceIso ?? null
      });
    },
    async pruneOlderThan(input) {
      pruneStmt.run({ cutoff: input.olderThanIso });
    },
    close() {
      db.close();
    }
  };
}
function tryChmod(path, mode) {
  try {
    chmodSync6(path, mode);
  } catch {
  }
}

// src/lib/bash-edit-capture.ts
var WINDOW_SLACK_MS = 3e3;
var COMMITTED_WINDOW_SLACK_MS = 1500;
var DEFAULT_WINDOW_MS = 15e3;
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_CANDIDATES = 500;
var BINARY_SNIFF_BYTES = 8e3;
var SECRET_FILE_RES = [
  /^\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i
];
function defaultGitExec(gitRoot) {
  return (args) => {
    try {
      return execFileSync5("git", args, {
        cwd: gitRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return null;
    }
  };
}
function defaultReadFileBytes(absPath) {
  try {
    return readFileSync11(absPath);
  } catch {
    return null;
  }
}
function defaultStatMtimeMs(absPath) {
  try {
    return statSync4(absPath).mtimeMs;
  } catch {
    return null;
  }
}
function defaultIsSymlink(absPath) {
  try {
    return lstatSync2(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}
function defaultRealPath(p) {
  try {
    return realpathSync2(p);
  } catch {
    return null;
  }
}
function isWithin(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep2) ? parent : parent + sep2);
}
function isBinary(buf) {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
function normalizeKey(p) {
  return posix.normalize(p).replace(/^\.\//, "");
}
function isSecretPath(path) {
  const base = path.split("/").pop() ?? path;
  return SECRET_FILE_RES.some((re) => re.test(base));
}
function parsePorcelainZ(out) {
  const parts = out.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      i++;
    }
    if (code === "D " || code === " D") continue;
    if (code[0] === "U" || code[1] === "U" || code === "AA" || code === "DD")
      continue;
    if (path) paths.push(path);
  }
  return paths;
}
function collectCandidatePaths(gitExec, includeCommittedSet) {
  const dirty = /* @__PURE__ */ new Set();
  const status = gitExec([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames"
  ]);
  if (status) for (const p of parsePorcelainZ(status)) dirty.add(p);
  const committed = /* @__PURE__ */ new Set();
  if (includeCommittedSet) {
    const out = gitExec([
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--root",
      "HEAD"
    ]);
    if (out) {
      for (const p of out.split("\0")) if (p && !dirty.has(p)) committed.add(p);
    }
  }
  return { dirty: [...dirty], committed: [...committed] };
}
function computeWindowStart(input) {
  if (input.commandStartedAtMs != null && Number.isFinite(input.commandStartedAtMs)) {
    return input.commandStartedAtMs - input.slack;
  }
  if (input.durationMs != null && input.durationMs >= 0) {
    return input.nowMs - input.durationMs - input.slack;
  }
  return input.nowMs - DEFAULT_WINDOW_MS;
}
function selectFreshPaths(paths, gitRoot, realGitRoot, deps, windowStartMs) {
  const fresh = [];
  for (const path of paths) {
    if (isSecretPath(path)) continue;
    const abs = join16(gitRoot, path);
    if (deps.isSymlink(abs)) continue;
    const real = deps.realPath(abs);
    if (real === null) continue;
    if (realGitRoot !== null && !isWithin(real, realGitRoot)) continue;
    const mtime = deps.statMtimeMs(abs);
    if (mtime === null) continue;
    if (mtime < windowStartMs) continue;
    fresh.push(path);
  }
  return fresh;
}
function readReconcilableText(readFileBytes, abs) {
  const buf = readFileBytes(abs);
  if (!buf) return null;
  if (buf.length > MAX_FILE_BYTES) return null;
  if (isBinary(buf)) return null;
  return buf.toString("utf8");
}
async function buildLedgerMap(store, gitRoot, nowMs) {
  const sinceIso = new Date(nowMs - 24 * 60 * 60 * 1e3).toISOString();
  let ledger = [];
  try {
    ledger = await store.queryByDir({ workingDir: gitRoot, sinceIso });
  } catch {
    ledger = [];
  }
  const latestByPath = /* @__PURE__ */ new Map();
  for (const e of ledger)
    latestByPath.set(normalizeKey(e.filePath), e.contentAfter);
  return latestByPath;
}
async function recordFreshEdits(args) {
  const { store, freshPaths, input, gitExec, readFileBytes, nowMs } = args;
  const latestByPath = await buildLedgerMap(store, input.gitRoot, nowMs);
  const baseRef = input.isCommit && !input.skipCommittedSet ? "HEAD^" : "HEAD";
  let recorded = 0;
  for (const path of freshPaths) {
    const contentAfter = readReconcilableText(
      readFileBytes,
      join16(input.gitRoot, path)
    );
    if (contentAfter === null) continue;
    const key = normalizeKey(path);
    const contentBefore = latestByPath.get(key) ?? gitExec(["show", `${baseRef}:${path}`]) ?? "";
    if (contentAfter === contentBefore) continue;
    await store.record({
      workingDir: input.gitRoot,
      filePath: path,
      contentBefore,
      contentAfter,
      sessionId: input.sessionId,
      agentId: input.agentId,
      timestamp: new Date(nowMs).toISOString()
    });
    latestByPath.set(key, contentAfter);
    recorded++;
  }
  return recorded;
}
async function captureBashEdits(input) {
  const deps = input.deps ?? {};
  const gitExec = deps.gitExec ?? defaultGitExec(input.gitRoot);
  const readFileBytes = deps.readFileBytes ?? defaultReadFileBytes;
  const selectDeps = {
    statMtimeMs: deps.statMtimeMs ?? defaultStatMtimeMs,
    isSymlink: deps.isSymlink ?? defaultIsSymlink,
    realPath: deps.realPath ?? defaultRealPath
  };
  const nowMs = deps.nowMs ?? Date.now();
  const openStore = deps.openStore ?? (() => openEditStore({ rootDir: input.editsRootDir }));
  try {
    const hasRealTiming = input.commandStartedAtMs != null && Number.isFinite(input.commandStartedAtMs) || input.durationMs != null && input.durationMs >= 0;
    const includeCommittedSet = input.isCommit && !input.skipCommittedSet && hasRealTiming;
    const { dirty, committed } = collectCandidatePaths(
      gitExec,
      includeCommittedSet
    );
    if (dirty.length === 0 && committed.length === 0)
      return { recorded: 0, truncated: false };
    const realGitRoot = selectDeps.realPath(input.gitRoot);
    const dirtyWindowStart = computeWindowStart({
      commandStartedAtMs: input.commandStartedAtMs,
      durationMs: input.durationMs,
      nowMs,
      slack: WINDOW_SLACK_MS
    });
    const committedWindowStart = computeWindowStart({
      commandStartedAtMs: input.commandStartedAtMs,
      durationMs: input.durationMs,
      nowMs,
      slack: COMMITTED_WINDOW_SLACK_MS
    });
    const freshSet = /* @__PURE__ */ new Set([
      ...selectFreshPaths(
        dirty,
        input.gitRoot,
        realGitRoot,
        selectDeps,
        dirtyWindowStart
      ),
      ...selectFreshPaths(
        committed,
        input.gitRoot,
        realGitRoot,
        selectDeps,
        committedWindowStart
      )
    ]);
    let freshPaths = [...freshSet];
    if (freshPaths.length === 0) return { recorded: 0, truncated: false };
    let truncated = false;
    if (freshPaths.length > MAX_CANDIDATES) {
      truncated = true;
      process.stderr.write(
        `[bash-edit-capture] ${freshPaths.length} changed files exceed the ${MAX_CANDIDATES} per-command cap; attributing the first ${MAX_CANDIDATES} only.
`
      );
      freshPaths = freshPaths.slice(0, MAX_CANDIDATES);
    }
    const store = openStore();
    try {
      const recorded = await recordFreshEdits({
        store,
        freshPaths,
        input,
        gitExec,
        readFileBytes,
        nowMs
      });
      return { recorded, truncated };
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(
      `[bash-edit-capture] reconcile failed: ${err?.message ?? err}
`
    );
    return { recorded: 0, truncated: false };
  }
}

// src/lib/commit-observation-emitter.ts
import { posix as posix2 } from "node:path";

// src/lib/diff-overlap.ts
function linesAddedByEdit(edit) {
  const before = /* @__PURE__ */ new Set();
  for (const line of edit.contentBefore.split("\n")) {
    if (line.length > 0) before.add(line);
  }
  const added = [];
  for (const line of edit.contentAfter.split("\n")) {
    if (line.length === 0) continue;
    if (!before.has(line)) added.push(line);
  }
  return added;
}
function computeAttribution(input) {
  const perFile = {};
  let totalAttributed = 0;
  let totalLines = 0;
  for (const [path, diff] of Object.entries(input.commitDiffByFile)) {
    const edits = input.agentEditsByFile[path] ?? [];
    const editAddedArrays = edits.map((e) => ({ added: linesAddedByEdit(e), timestamp: e.timestamp })).sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
    const changed = diff.addedLines.filter((l) => l.length > 0);
    const total = changed.length;
    const remaining = /* @__PURE__ */ new Map();
    for (const e of editAddedArrays) {
      for (const line of e.added) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
      }
    }
    let attributed = 0;
    for (const line of changed) {
      const count = remaining.get(line) ?? 0;
      if (count > 0) {
        attributed++;
        remaining.set(line, count - 1);
      }
    }
    perFile[path] = {
      totalLines: total,
      attributedLines: attributed,
      percentage: total === 0 ? 0 : attributed / total
    };
    totalAttributed += attributed;
    totalLines += total;
  }
  return {
    overallPercentage: totalLines === 0 ? 0 : totalAttributed / totalLines,
    agentAttributedLines: totalAttributed,
    totalChangedLines: totalLines,
    perFile
  };
}

// src/lib/commit-observation-emitter.ts
function normalizePath(p) {
  return posix2.normalize(p).replace(/^\.\//, "");
}
async function emitCommitObservation(input) {
  const canon = canonicalizeGitRemote(input.remoteUrl);
  if (!canon) return;
  const repoFullName = `${canon.owner}/${canon.repo}`;
  let rawCommitDiff;
  try {
    rawCommitDiff = await input.diffProvider(input.commitEvent.sha);
  } catch (err) {
    console.error(
      "[commit-observation-emitter] diffProvider failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
  const commitDiffByFile = {};
  for (const [k, v] of Object.entries(rawCommitDiff)) {
    commitDiffByFile[normalizePath(k)] = v;
  }
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
  let edits;
  try {
    edits = await input.store.queryByDir({
      workingDir: input.workingDir,
      sinceIso
    });
  } catch (err) {
    console.error(
      "[commit-observation-emitter] store.queryByDir failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
  const agentEditsByFile = {};
  for (const e of edits) {
    const key = normalizePath(e.filePath);
    agentEditsByFile[key] ??= [];
    agentEditsByFile[key].push({
      // Carry contentBefore through to computeAttribution so it
      // can derive "lines this edit actually added" (and not over-attribute
      // boilerplate the agent merely preserved).
      contentBefore: e.contentBefore.replace(/\r\n/g, "\n"),
      contentAfter: e.contentAfter.replace(/\r\n/g, "\n"),
      timestamp: e.timestamp
    });
  }
  const attribution = computeAttribution({
    commitDiffByFile,
    agentEditsByFile
  });
  const hasAgentAttribution = attribution.overallPercentage > 0;
  const payload = {
    kind: "commit_observation",
    commit_sha: input.commitEvent.sha,
    repo_full_name: repoFullName,
    branch: input.commitEvent.branch,
    parent_sha: input.commitEvent.parentSha,
    // `parentShas` carries every parent for merge commits, alongside
    // `parent_sha`, so the server endpoint can record all parents.
    parent_shas: input.commitEvent.parentShas,
    authored_at: input.commitEvent.authoredAt,
    // Author/committer metadata flows through the plugin path so
    // the activity feed can render meaningful "by <name>" text on commits
    // that never get audit-log expansion (e.g. SSH push from a non-Enterprise
    // org). Read from the local git via readCommitMeta in commit-watcher.
    author_name: input.commitEvent.authorName,
    author_email: input.commitEvent.authorEmail,
    committed_at: input.commitEvent.committedAt,
    committer_name: input.commitEvent.committerName,
    committer_email: input.commitEvent.committerEmail,
    message: input.commitEvent.message,
    session_id: input.sessionContext.sessionId
  };
  if (hasAgentAttribution) {
    payload.agent_id = input.sessionContext.agentId;
    payload.agent_attribution = {
      overall_percentage: attribution.overallPercentage,
      agent_attributed_lines: attribution.agentAttributedLines,
      total_changed_lines: attribution.totalChangedLines,
      // Server schema is z.array(PerFileAttributionEntry) keyed on
      // `path`. The diff-overlap algorithm returns Record<path, ...> for
      // O(1) lookup; convert here at the wire boundary.
      per_file: Object.entries(attribution.perFile).map(([path, v]) => ({
        path,
        agentLines: v.attributedLines,
        totalLines: v.totalLines,
        percentage: v.percentage
      }))
    };
  }
  const api = createManagementClient({
    baseUrl: input.apiBase,
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    fetchImpl: input.fetch
  });
  try {
    const { error, response } = await api.POST("/observations/commit", {
      body: payload
    });
    if (error) {
      console.error("[commit-observation-emitter] POST failed:", {
        status: response.status,
        sha: input.commitEvent.sha,
        repo_full_name: repoFullName
      });
      return;
    }
  } catch (err) {
    console.error(
      "[commit-observation-emitter] POST failed:",
      { sha: input.commitEvent.sha, repo_full_name: repoFullName },
      err
    );
    return;
  }
}

// src/lib/git-root.ts
import { execFileSync as execFileSync6 } from "node:child_process";
function resolveGitRoot(cwd) {
  try {
    return execFileSync6("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return cwd;
  }
}

// src/lib/git-show-parser.ts
var DIFF_HEADER = /^diff --git /;
var PLUS_PLUS_PLUS = /^\+\+\+ (?:b\/(.+)|\/dev\/null\s*$)/;
var MINUS_MINUS_MINUS = /^--- (?:a\/(.+)|\/dev\/null\s*$)/;
var METADATA_PREFIXES = [
  "@@",
  "index ",
  "similarity index ",
  "rename from ",
  "rename to ",
  "new file mode ",
  "deleted file mode ",
  "old mode ",
  "new mode ",
  "Binary files ",
  "\\ No newline at end of file"
];
function isMetadataLine(line) {
  for (const prefix of METADATA_PREFIXES) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}
function parseShowDiff(output) {
  const result = {};
  let current = null;
  let aPath = null;
  let inDiffSection = false;
  for (const line of output.split("\n")) {
    if (DIFF_HEADER.test(line)) {
      current = null;
      aPath = null;
      inDiffSection = true;
      continue;
    }
    if (!inDiffSection) continue;
    const minusMatch = MINUS_MINUS_MINUS.exec(line);
    if (minusMatch) {
      aPath = minusMatch[1] ?? null;
      continue;
    }
    const plusMatch = PLUS_PLUS_PLUS.exec(line);
    if (plusMatch) {
      const path = plusMatch[1] ?? aPath;
      if (path) {
        current = result[path] ?? { addedLines: [], removedLines: [] };
        result[path] = current;
      } else {
        current = null;
      }
      continue;
    }
    if (!current || isMetadataLine(line)) continue;
    if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return result;
}

// src/hooks/post-tool-use-edit.ts
import { relative } from "node:path";
async function recordEditFromToolUse(input) {
  if (input.toolName !== "Edit" && input.toolName !== "Write") return;
  const absPath = input.toolInput.file_path;
  if (!absPath) return;
  const relPath = relative(input.sessionContext.workingDir, absPath);
  const contentBefore = input.toolName === "Edit" ? input.toolInput.old_string ?? "" : "";
  const contentAfter = input.toolName === "Edit" ? input.toolInput.new_string ?? "" : input.toolInput.content ?? "";
  if (contentBefore === contentAfter) return;
  await input.store.record({
    workingDir: input.sessionContext.workingDir,
    filePath: relPath,
    contentBefore,
    contentAfter,
    sessionId: input.sessionContext.sessionId,
    agentId: input.sessionContext.agentId,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
}

// src/hooks/post-tool-use-observation.ts
async function runPostToolUse(input) {
  await recordStructuredEdit(input);
  const isBash = isBashTool2(input.toolName);
  const isApplyPatch = input.toolName === "apply_patch";
  if (!isBash && !isApplyPatch) {
    return { decision: "skip" };
  }
  const cmd = input.toolArgs.join(" ");
  const op = isBash ? detectGitOp(cmd) : null;
  const isCommit = op === "commit";
  await captureToolEditsForCommand(input, cmd, isCommit);
  if (!isBash || !isCommit) return { decision: "skip" };
  if (input.localCredentialAvailable === false) return { decision: "skip" };
  const exec = input.execImpl ?? ((c, opts) => execSync(c, { ...opts, encoding: "utf8" }).toString().trim());
  let sha;
  let branch;
  let message;
  try {
    sha = exec("git rev-parse HEAD", { cwd: input.cwd });
    branch = exec("git rev-parse --abbrev-ref HEAD", { cwd: input.cwd });
    message = exec("git log -1 --pretty=%B", { cwd: input.cwd });
  } catch {
    return { decision: "skip" };
  }
  const remoteUrl = input.remoteUrl ?? (() => {
    try {
      return exec("git config --get remote.origin.url", { cwd: input.cwd });
    } catch {
      return null;
    }
  })() ?? null;
  if (!remoteUrl) return { decision: "skip" };
  const canon = canonicalizeGitRemote(remoteUrl);
  if (!canon || canon.isSsh) return { decision: "skip" };
  const queue = input.queue ?? new ObservationQueue({ capacity: 100 });
  const baseUrl = input.endpoint.replace(/\/v1\/observations\/?$/, "");
  const observation = await observeGitOperation(
    {
      operationType: "commit",
      remoteUrl,
      agentId: input.agentId,
      scopedTokenId: input.scopedTokenId,
      clientSessionId: input.clientSessionId,
      branch,
      headSha: sha,
      commitMessage: message
    },
    {
      spellguardBaseUrl: baseUrl,
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      queue
    }
  );
  await emitRichCommitObservation({
    input,
    exec,
    baseUrl,
    remoteUrl,
    sha,
    branch,
    message
  });
  return { decision: "allow", observation };
}
function tryGitField(exec, cwd, fmt) {
  try {
    return exec(`git log -1 --pretty=tformat:${fmt}`, { cwd }).trim();
  } catch {
    return "";
  }
}
function tryGitFieldOptional(exec, cwd, fmt) {
  const v = tryGitField(exec, cwd, fmt);
  return v.length === 0 ? null : v;
}
async function captureToolEditsForCommand(input, cmd, isCommit) {
  const editsRoot = input.editsRootDir ?? join17(homedir7(), ".spellguard");
  const commandStartedAtMs = consumeBashCommandStart({
    rootDir: editsRoot,
    key: input.toolUseId || input.clientSessionId,
    nowMs: Date.now()
  }) ?? void 0;
  if (detectTreeMaterializingGitOp(cmd)) return;
  const skipCommittedSet = isCommit && (isAmendCommit(cmd) || headHasMultipleParents(input.cwd));
  await captureBashEdits({
    editsRootDir: editsRoot,
    gitRoot: resolveGitRoot(input.cwd),
    sessionId: input.clientSessionId,
    agentId: input.agentId,
    isCommit,
    commandStartedAtMs,
    durationMs: input.durationMs,
    skipCommittedSet
  });
}
function isBashTool2(toolName) {
  return toolName === "Bash" || toolName === "bash";
}
function headHasMultipleParents(cwd) {
  try {
    execFileSync7("git", ["rev-parse", "--verify", "--quiet", "HEAD^2"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}
async function emitRichCommitObservation(args) {
  const { input, exec, baseUrl, remoteUrl, sha, branch, message } = args;
  try {
    const editStoreRoot = input.editsRootDir ?? join17(homedir7(), ".spellguard");
    const commitStore = openEditStore({ rootDir: editStoreRoot });
    try {
      const gitRoot = resolveGitRoot(input.cwd);
      const parentText = tryGitFieldOptional(exec, input.cwd, "%P");
      await emitCommitObservation({
        store: commitStore,
        diffProvider: async (s) => gitShowDiff(gitRoot, s),
        fetch,
        apiBase: baseUrl,
        agentId: input.agentId,
        agentSecret: input.agentSecret,
        workingDir: gitRoot,
        remoteUrl,
        commitEvent: {
          sha,
          branch,
          authoredAt: tryGitField(exec, input.cwd, "%aI"),
          authorName: tryGitFieldOptional(exec, input.cwd, "%an"),
          authorEmail: tryGitFieldOptional(exec, input.cwd, "%ae"),
          committedAt: tryGitFieldOptional(exec, input.cwd, "%cI"),
          committerName: tryGitFieldOptional(exec, input.cwd, "%cn"),
          committerEmail: tryGitFieldOptional(exec, input.cwd, "%ce"),
          message,
          parentSha: parentText?.split(" ")[0] ?? null,
          parentShas: parentText?.split(" ").filter((s) => s.length > 0) ?? [],
          workingDir: gitRoot
        },
        sessionContext: {
          sessionId: input.clientSessionId,
          agentId: input.agentId
        }
      });
    } finally {
      commitStore.close();
    }
  } catch (err) {
    process.stderr.write(
      `[post-tool-use] emitCommitObservation failed: ${err?.message ?? err}
`
    );
  }
}
function gitShowDiff(gitRoot, sha) {
  try {
    const out = execFileSync7("git", ["show", sha], {
      cwd: gitRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return parseShowDiff(out);
  } catch {
    return {};
  }
}
async function recordStructuredEdit(input) {
  if (input.toolName !== "Edit" && input.toolName !== "Write") return;
  const editStore = openEditStore({
    rootDir: input.editsRootDir ?? join17(homedir7(), ".spellguard")
  });
  try {
    try {
      const workingDir = resolveGitRoot(input.cwd);
      await recordEditFromToolUse({
        store: editStore,
        sessionContext: {
          sessionId: input.clientSessionId,
          agentId: input.agentId,
          workingDir
        },
        toolName: input.toolName,
        toolInput: input.toolInput ?? {}
      });
    } catch (err) {
      console.error("[post-tool-use] edit-store record failed:", err);
    }
  } finally {
    editStore.close();
  }
}

// src/monitors/credential-monitor.ts
import { homedir as homedir8 } from "node:os";
import { join as join18 } from "node:path";
function defaultScopeCachePath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join18(
    xdg ?? join18(homedir8(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join18(
    xdg ?? join18(homedir8(), ".config"),
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
export {
  clearCodexCredentialHelper,
  detectGitOperation,
  emitPreToolUseObservation,
  installCodexCredentialHelper,
  observeGitOperation,
  probeCodexHooksFlag,
  runMonitorTick,
  runPostToolUse,
  runPreToolUse,
  runPreToolUseCodex,
  runSessionStart,
  runSpellguardSetup,
  toCodexPreToolUseOutput
};
/*! Bundled license information:

smol-toml/dist/error.js:
smol-toml/dist/primitive.js:
smol-toml/dist/date.js:
smol-toml/dist/extract.js:
smol-toml/dist/util.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
