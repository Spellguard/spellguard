// SPDX-License-Identifier: Apache-2.0

import type { ContentItem } from './types';

/**
 * The most the guard sends the Verifier for one check. Arguments or a result
 * larger than this are blocked rather than skipped (#1501): an unscanned
 * oversized payload is exactly how a policy is bypassed.
 */
export const MAX_SCAN_BYTES = 512 * 1024;

export type ScanPayload =
  | { ok: true; content: ContentItem[]; bytes: number }
  | { ok: false; bytes: number };

function payload(text: string): ScanPayload {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SCAN_BYTES) return { ok: false, bytes };
  return { ok: true, content: [{ type: 'text', value: text }], bytes };
}

/**
 * A tool call's outbound content: its whole argument object as ONE JSON text
 * part. That is the Verifier's tool-leg contract (`toolArguments` in
 * `mcp-evaluate.ts`): content policies scan every value however deeply it is
 * nested, and an allowlist's parameter rules see the real parameters.
 */
export function argumentsPayload(args: Record<string, unknown>): ScanPayload {
  return payload(JSON.stringify(args));
}

interface ResultBlock {
  type?: unknown;
  text?: unknown;
  resource?: { uri?: unknown; text?: unknown };
  uri?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
}

/**
 * The text of a tool result the agent will read: text blocks, embedded text
 * resources, resource links' names and descriptions, and any structured
 * content. Images, audio and binary resources carry no text to scan.
 */
export function resultText(result: unknown): string {
  if (result === null || typeof result !== 'object') {
    return typeof result === 'string' ? result : '';
  }
  const r = result as {
    content?: unknown;
    structuredContent?: unknown;
    toolResult?: unknown;
  };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content as ResultBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (block.type === 'resource' && block.resource) {
        if (typeof block.resource.text === 'string') {
          parts.push(block.resource.text);
        }
      } else if (block.type === 'resource_link') {
        for (const field of [
          block.name,
          block.title,
          block.description,
          block.uri,
        ]) {
          if (typeof field === 'string' && field) parts.push(field);
        }
      }
    }
  }
  if (r.structuredContent !== undefined) {
    parts.push(JSON.stringify(r.structuredContent));
  }
  if (r.toolResult !== undefined) {
    // The pre-2024-11 compatibility shape.
    parts.push(
      typeof r.toolResult === 'string'
        ? r.toolResult
        : JSON.stringify(r.toolResult),
    );
  }
  return parts.join('\n');
}

/** A tool result's inbound content, or an oversize marker. */
export function resultPayload(result: unknown): ScanPayload | null {
  const text = resultText(result);
  if (text.length === 0) return null;
  return payload(text);
}
