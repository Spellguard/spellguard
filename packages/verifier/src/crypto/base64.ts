// SPDX-License-Identifier: Apache-2.0

/**
 * Base64 for whole message payloads and envelopes.
 *
 * A message carries its attachments as base64 inside a payload that is
 * itself encrypted and base64-encoded, so the Verifier encodes and decodes
 * megabytes on every such message. Where the runtime has native base64 on
 * Uint8Array (`toBase64` / `Uint8Array.fromBase64`, as Cloudflare Workers
 * do) it is used; elsewhere (Node 22, the Fargate Verifier) the JavaScript
 * path below runs exactly as before. Both give the same strings and bytes;
 * tests pin it.
 */

interface NativeBase64Bytes {
  toBase64(): string;
}

interface NativeBase64Constructor {
  fromBase64(base64: string): Uint8Array;
}

function nativeEncoder(bytes: Uint8Array): NativeBase64Bytes | undefined {
  const candidate = bytes as Uint8Array & Partial<NativeBase64Bytes>;
  return typeof candidate.toBase64 === 'function'
    ? (candidate as NativeBase64Bytes)
    : undefined;
}

function nativeDecoder(): NativeBase64Constructor | undefined {
  const candidate = Uint8Array as unknown as Partial<NativeBase64Constructor>;
  return typeof candidate.fromBase64 === 'function'
    ? (candidate as NativeBase64Constructor)
    : undefined;
}

/** The JavaScript encoder: chunked String.fromCharCode, then btoa. */
export function bytesToBase64Js(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** The JavaScript decoder: atob, then one byte per character. */
export function base64ToBytesJs(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = nativeEncoder(bytes);
  return native ? native.toBase64() : bytesToBase64Js(bytes);
}

export function base64ToBytes(base64: string): Uint8Array {
  const native = nativeDecoder();
  return native ? native.fromBase64(base64) : base64ToBytesJs(base64);
}
