// SPDX-License-Identifier: Apache-2.0

/**
 * Wire format for HTTP-over-SLIM between the Gateway and the Verifier.
 *
 * The Gateway serialises the entire inbound HTTP request — method,
 * path, headers, body — into a small JSON envelope, base64-encodes the
 * body so binary payloads round-trip safely, and publishes the bytes
 * to the Verifier's SLIM address. The Verifier deserialises, calls
 * `app.fetch(request)`, and serialises the response back the same way.
 *
 * Co-located in the gateway package on purpose: both sides import it
 * via the `@spellguard/gateway/wire` subpath so the format is defined
 * in exactly one place. (See package.json `exports` entry.)
 */

export interface SlimHttpRequest {
  /** HTTP method as upper-case string ("GET", "POST", ...). */
  method: string;
  /** Path + query, e.g. "/proxy/forward?foo=1". Origin is irrelevant
   *  — the Verifier reconstructs Request with a synthetic origin. */
  path: string;
  /** Headers as a plain object. Multi-value headers join with ",". */
  headers: Record<string, string>;
  /** Base64-encoded request body. Empty string for body-less requests. */
  body: string;
}

export interface SlimHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const WIRE_VERSION = 1 as const;

interface SlimEnvelope<T> {
  v: typeof WIRE_VERSION;
  payload: T;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8');

export function encodeRequest(req: SlimHttpRequest): Uint8Array {
  const envelope: SlimEnvelope<SlimHttpRequest> = {
    v: WIRE_VERSION,
    payload: req,
  };
  return TEXT_ENCODER.encode(JSON.stringify(envelope));
}

export function decodeRequest(bytes: Uint8Array): SlimHttpRequest {
  const envelope = JSON.parse(
    TEXT_DECODER.decode(bytes),
  ) as SlimEnvelope<SlimHttpRequest>;
  if (envelope.v !== WIRE_VERSION) {
    throw new Error(
      `gateway wire version mismatch: got ${envelope.v}, expected ${WIRE_VERSION}`,
    );
  }
  return envelope.payload;
}

export function encodeResponse(res: SlimHttpResponse): Uint8Array {
  const envelope: SlimEnvelope<SlimHttpResponse> = {
    v: WIRE_VERSION,
    payload: res,
  };
  return TEXT_ENCODER.encode(JSON.stringify(envelope));
}

export function decodeResponse(bytes: Uint8Array): SlimHttpResponse {
  const envelope = JSON.parse(
    TEXT_DECODER.decode(bytes),
  ) as SlimEnvelope<SlimHttpResponse>;
  if (envelope.v !== WIRE_VERSION) {
    throw new Error(
      `gateway wire version mismatch: got ${envelope.v}, expected ${WIRE_VERSION}`,
    );
  }
  return envelope.payload;
}

// ─── Browser-safe base64 (Workers + Node both have Buffer or atob/btoa) ──

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(s: string): Uint8Array {
  if (s === '') return new Uint8Array();
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ─── Helpers for Hono / fetch Request / Response interop ─────────────

export async function requestToWire(req: Request): Promise<SlimHttpRequest> {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? new Uint8Array()
      : new Uint8Array(await req.arrayBuffer());
  return {
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
    body: bytesToBase64(body),
  };
}

export async function responseToWire(res: Response): Promise<SlimHttpResponse> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    headers,
    body: bytesToBase64(body),
  };
}

export function wireToRequest(req: SlimHttpRequest, origin: string): Request {
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : base64ToBytes(req.body);
  return new Request(`${origin}${req.path}`, {
    method: req.method,
    headers: req.headers,
    body,
  });
}

export function wireToResponse(res: SlimHttpResponse): Response {
  return new Response(base64ToBytes(res.body), {
    status: res.status,
    headers: res.headers,
  });
}
