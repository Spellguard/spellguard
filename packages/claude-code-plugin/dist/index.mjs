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
var FRAMEWORK_SLUG = "claude-code";

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
function writeGitTokensFile(config, dir = defaultConfigDir()) {
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
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync3,
  realpathSync,
  renameSync as renameSync2,
  unlinkSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname3, join as join3, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  if (runningFromDist && existsSync2(builtPath)) return builtPath;
  if (existsSync2(devPath)) return devPath;
  return builtPath;
}
function readDaemonPid(pidPath) {
  if (!existsSync2(pidPath)) return null;
  try {
    const raw = readFileSync3(pidPath, "utf-8").trim();
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
  const pidDir = join3(configDir, "agents");
  const pidPath = join3(pidDir, `${config.agentId}.pid`);
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
  chmodSync as chmodSync3,
  copyFileSync as copyFileSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync3,
  writeFileSync as writeFileSync3
} from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve2 } from "node:path";
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
  return resolve2(HERE, "..", "..", "bin", "spellguard-git-helper");
}
function ensureStableHelper(configDir) {
  const bundled = bundledHelperPath();
  try {
    const dest = join4(configDir, "bin", "spellguard-git-helper");
    mkdirSync3(dirname4(dest), { recursive: true });
    copyFileSync2(bundled, dest);
    chmodSync3(dest, 493);
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
    writeFileSync3(spec.envFilePath, `${lines.join("\n")}
`, "utf-8");
  }
}
function clearGitConfigEnv(envFilePath) {
  if (!envFilePath) return;
  writeFileSync3(envFilePath, "export GIT_CONFIG_COUNT=0\n", "utf-8");
}

// src/lib/gh-config-dir.ts
import { join as join5 } from "node:path";
function ghConfigDirPath(configDir, agentId) {
  return join5(configDir, "gh", agentId);
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

// src/lib/migrate-legacy-config.ts
import {
  copyFileSync as copyFileSync3,
  existsSync as existsSync4,
  mkdirSync as mkdirSync4,
  renameSync as renameSync3,
  rmSync as rmSync2,
  writeFileSync as writeFileSync4
} from "node:fs";
import { join as join7 } from "node:path";

// src/lib/stop-daemons.ts
import { readFileSync as readFileSync4, readdirSync as readdirSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join6 } from "node:path";
function stopLocalDaemons(opts) {
  const dir = join6(opts?.configDir ?? defaultConfigDir(), "agents");
  const kill = opts?.killImpl ?? process.kill.bind(process);
  let entries;
  try {
    entries = readdirSync2(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return [];
  }
  const stopped = [];
  for (const f of entries) {
    const p = join6(dir, f);
    let pid;
    try {
      pid = Number.parseInt(readFileSync4(p, "utf8").trim(), 10);
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
      unlinkSync2(p);
    } catch {
    }
  }
  return stopped;
}

// src/lib/migrate-legacy-config.ts
function moveFile(src, dst) {
  if (!existsSync4(src)) return false;
  try {
    renameSync3(src, dst);
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
  const marker = join7(legacyDir, ".migrated");
  if (existsSync4(marker))
    return { migrated: false, reason: "already-migrated" };
  const legacyConfig = join7(legacyDir, "config.json");
  if (!existsSync4(legacyConfig)) {
    return { migrated: false, reason: "no-legacy-config" };
  }
  const frameworkConfig = join7(frameworkDir, "config.json");
  if (existsSync4(frameworkConfig)) {
    return { migrated: false, reason: "framework-already-configured" };
  }
  const stop = opts.stopLegacyDaemons ?? ((dir) => stopLocalDaemons({ configDir: dir }));
  try {
    stop(legacyDir);
  } catch {
  }
  mkdirSync4(frameworkDir, { recursive: true, mode: 448 });
  if (!moveFile(legacyConfig, frameworkConfig)) {
    return { migrated: false, reason: "move-failed" };
  }
  moveFile(join7(legacyDir, "git-tokens"), join7(frameworkDir, "git-tokens"));
  const legacyAgents = join7(legacyDir, "agents");
  if (existsSync4(legacyAgents)) {
    try {
      renameSync3(legacyAgents, join7(frameworkDir, "agents"));
    } catch {
    }
  }
  writeFileSync4(
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
import { readFileSync as readFileSync5 } from "node:fs";
import { dirname as dirname5, resolve as resolve3 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var FRAMEWORK = "claude_code";
var TIMEOUT_MS = 5e3;
function readPluginVersion() {
  try {
    const here = dirname5(fileURLToPath3(import.meta.url));
    const pkg = JSON.parse(
      readFileSync5(resolve3(here, "..", "..", "package.json"), "utf8")
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
import { readFileSync as readFileSync6, readdirSync as readdirSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname6, join as join8 } from "node:path";
function bashQuote2(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function healOneCapture(file, name, email) {
  let content;
  try {
    content = readFileSync6(file, "utf-8");
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
    writeFileSync5(file, healed, "utf-8");
  } catch {
  }
}
function healSessionEnvIdentity(envFilePath, gitAuthorName, gitAuthorEmail) {
  if (!envFilePath || !gitAuthorName || !gitAuthorEmail) return;
  try {
    const dir = dirname6(envFilePath);
    for (const entry of readdirSync3(dir)) {
      if (/^sessionstart-hook-.*\.sh$/.test(entry)) {
        healOneCapture(join8(dir, entry), gitAuthorName, gitAuthorEmail);
      }
    }
  } catch {
  }
}

// src/lib/ssh-remote-detect.ts
import { execFileSync as execFileSync3 } from "node:child_process";

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
    const out = execFileSync3("git", ["remote", "-v"], {
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
    const out = execFileSync3("git", ["remote", "-v"], {
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
    if (readResult.reason === "wrong_permissions") {
      renderMessage({
        level: "error",
        message: `Spellguard: ${defaultConfigPath()} has mode ${readResult.foundMode ?? "other than 0600"} and is owned by another user, so it could not be read or repaired. Your agent identity is intact \u2014 fix the owner/mode (\`chown\` it back to you, then \`chmod 600\`) rather than re-running \`/spellguard-setup\`.`
      });
      return { ok: false, reason: "wrong_permissions" };
    }
    renderMessage({
      level: "info",
      message: "Spellguard not configured \u2014 run `/spellguard-setup` to provision a credential."
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
  const managed = (deps.isManagedBox ?? isManagedBox)();
  const envFilePath = deps.claudeEnvFile ?? process.env.CLAUDE_ENV_FILE;
  if (!managed && !envFilePath) {
    renderMessage({
      level: "error",
      message: "Spellguard: CLAUDE_ENV_FILE environment variable not set; cannot inject git credential helper."
    });
    return { ok: false, reason: "no_claude_env_file" };
  }
  const configDir = deps.configDir ?? defaultConfigDir();
  const ghConfigDir = ghConfigDirPath(configDir, readResult.config.agentId);
  const writeEnvFile = () => {
    if (managed) return;
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else if (envFilePath) {
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
    const daemonResult2 = managed ? { daemon: "skipped", reason: "managed_box" } : ensureCredentialDaemonRunning({
      config: readResult.config,
      cwd,
      envFilePath,
      spawnDaemon: deps.spawnDaemon,
      configDir: deps.configDir
    });
    renderMessage({
      level: "error",
      message: readResult.config.revokedMessage ? `Spellguard: ${readResult.config.revokedMessage}` : "Spellguard: this credential has been revoked. Spellguard is waiting for a replacement credential; if git stays blocked, run `spellguard doctor --repair` (non-destructive) before re-running `/spellguard-setup`."
    });
    return { ok: false, reason: "revoked", daemonResult: daemonResult2 };
  }
  if (!readResult.config.scopedTokenId || !readResult.config.scopedToken || !readResult.config.expiresAt || !readResult.config.scopeSummary) {
    const daemonResult2 = managed ? { daemon: "skipped", reason: "managed_box" } : ensureCredentialDaemonRunning({
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
  let statusResult;
  try {
    statusResult = await api.GET("/credentials/github/status", {
      params: { query: { scoped_token_id: scopedTokenId } },
      headers: scopedTokenForProbe ? { "X-Spellguard-Scoped-Token": scopedTokenForProbe } : void 0
    });
  } catch {
    renderMessage({
      level: "error",
      message: "Spellguard: could not verify your credential with the server (network error). This is usually transient \u2014 check your connection and restart the session. If it persists, run `/spellguard-setup`."
    });
    return { ok: false, reason: "status_failed" };
  }
  const { data, error, response } = statusResult;
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
  const daemonResult = managed ? { daemon: "skipped", reason: "managed_box" } : ensureCredentialDaemonRunning({
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
  if (!managed) {
    if (deps.writeEnvFileImpl) {
      deps.writeEnvFileImpl();
    } else if (envFilePath) {
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
  const delay = (ms) => new Promise((resolve5) => setTimeout(resolve5, ms));
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
import { homedir as homedir4 } from "node:os";
import { join as join11 } from "node:path";

// src/lib/bash-command-timing.ts
import {
  chmodSync as chmodSync4,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync7,
  readdirSync as readdirSync4,
  rmSync as rmSync3,
  statSync as statSync3,
  writeFileSync as writeFileSync6
} from "node:fs";
import { join as join9 } from "node:path";
var TIMING_SUBDIR = "bash-timing";
var STALE_MS = 60 * 60 * 1e3;
function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200) || "nokey";
}
function timingDir(rootDir) {
  return join9(rootDir, TIMING_SUBDIR);
}
function markBashCommandStart(input) {
  try {
    const dir = timingDir(input.rootDir);
    mkdirSync5(dir, { recursive: true });
    try {
      chmodSync4(dir, 448);
    } catch {
    }
    writeFileSync6(join9(dir, `${safeKey(input.key)}.txt`), String(input.nowMs), {
      mode: 384
    });
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

// src/lib/observation-emitter.ts
import { randomUUID as randomUUID2 } from "node:crypto";
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
    event_uuid: input.eventUuid ?? randomUUID2(),
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
import { homedir as homedir3 } from "node:os";
import { join as join10 } from "node:path";

// src/lib/observation-scope.ts
import { existsSync as existsSync5, readFileSync as readFileSync8 } from "node:fs";
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
    raw = readFileSync8(path, "utf-8");
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
  existsSync as existsSync6,
  mkdirSync as mkdirSync6,
  readFileSync as readFileSync9,
  writeFileSync as writeFileSync7
} from "node:fs";
import { platform as platform2 } from "node:os";
import { dirname as dirname7 } from "node:path";
var REFRESH_INTERVAL_MS = 30 * 60 * 1e3;
function readScopeCache(path) {
  if (!existsSync6(path)) return null;
  try {
    const raw = readFileSync9(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.serverScope) || typeof parsed.refreshedAt !== "number")
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeScopeCache(path, scope) {
  mkdirSync6(dirname7(path), { recursive: true });
  writeFileSync7(path, JSON.stringify(scope), { mode: 384 });
  if (platform2() !== "win32") {
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
  return join10(
    xdg ?? join10(homedir3(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join10(
    xdg ?? join10(homedir3(), ".config"),
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
function isBashTool(toolName) {
  return toolName === "Bash" || toolName === "bash";
}
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
      rootDir: input.editsRootDir ?? join11(homedir4(), ".spellguard"),
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now()
    });
  }
  const op = detectGitOperation(input.toolName, input.toolArgs);
  const unreadable = op === null && isBashTool(input.toolName) && detectGitOp(input.toolArgs.join(" ")) === "unparseable";
  if (unreadable) return credentialDecision(input) ?? { decision: "skip" };
  if (!op) return { decision: "skip" };
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
      message: "Spellguard credential revoked. Run /spellguard-setup to re-authorize."
    };
  }
  const observation = await emitPreToolUseObservation(input);
  return { decision: "allow", observation };
}
var runPreToolUseObservation = emitPreToolUseObservation;
var runPreToolUseHook = runPreToolUse;

// src/monitors/credential-monitor.ts
import { homedir as homedir5 } from "node:os";
import { join as join12 } from "node:path";
function defaultScopeCachePath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join12(
    xdg ?? join12(homedir5(), ".config"),
    "spellguard",
    "observation-scope.json"
  );
}
function defaultAllowlistPath2() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join12(
    xdg ?? join12(homedir5(), ".config"),
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
import { accessSync, constants as fsConstants2, mkdirSync as mkdirSync7 } from "node:fs";
import { dirname as dirname8, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

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
  return resolve4(here, "..", "..");
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
    mkdirSync7(resolve4(pluginRoot, "node_modules"), { recursive: true });
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
        lines.push(
          `  scope=${describeGithubCredentialScope(existing.config.scopeSummary)}`
        );
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
  const managed = (args.isManagedBox ?? isManagedBox)();
  const daemonResult = managed ? { daemon: "skipped", reason: "managed_box" } : ensureCredentialDaemonRunning({
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
      message: `Spellguard: GitHub credential received \u2014 scope=${describeGithubCredentialScope(delivered.scopeSummary)}.${author}
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
  const delay = (ms) => new Promise((resolve5) => setTimeout(resolve5, ms));
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
