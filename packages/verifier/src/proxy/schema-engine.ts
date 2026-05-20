// SPDX-License-Identifier: Apache-2.0

/**
 * Schema policy engine.
 *
 * Validates that message content (assumed JSON) conforms to a JSON Schema.
 * Useful for enforcing structured agent-to-agent protocols.
 *
 * Config shape (on binding.config):
 *   schema: object                 — JSON Schema (draft-07 compatible)
 *   mode?: 'full' | 'partial'     — default: 'full'
 *     'full'    = content must be valid JSON matching schema
 *     'partial' = extract JSON from content, validate that
 *   extractPattern?: string        — regex to extract JSON (partial mode)
 *   label?: string                 — detection label, default: 'schema-violation'
 *
 * Example binding config:
 *   {
 *     "schema": {
 *       "type": "object",
 *       "required": ["action", "target"],
 *       "properties": {
 *         "action": { "type": "string", "enum": ["read", "write", "delete"] },
 *         "target": { "type": "string" }
 *       },
 *       "additionalProperties": false
 *     },
 *     "mode": "full"
 *   }
 */

import Ajv from 'ajv';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

const ajv = new Ajv({ allErrors: true });

const MAX_BLOCK_SIZE = 65_536; // 64 KB
const MAX_NESTING_DEPTH = 64;

// Cache compiled validators keyed by JSON-stringified schema
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

function getValidator(schema: object) {
  const key = JSON.stringify(schema);
  let validator = validatorCache.get(key);
  if (!validator) {
    validator = ajv.compile(schema);
    validatorCache.set(key, validator);
  }
  return validator;
}

/**
 * Extract JSON blocks from mixed content.
 * Looks for top-level { ... } or [ ... ] blocks.
 */
function extractWithPattern(
  content: string,
  extractPattern: string,
): string[] | null {
  try {
    const regex = new RegExp(extractPattern, 'g');
    const matches = [...content.matchAll(regex)];
    return matches.map((m) => m[1] || m[0]);
  } catch {
    return null;
  }
}

function findBalancedBlock(content: string, start: number): string | null {
  const open = content[start];
  const close = open === '{' ? '}' : ']';
  let depth = 1;
  let j = start + 1;
  let inString = false;
  let escaped = false;
  while (j < content.length && depth > 0) {
    // Bail out if the block exceeds size or nesting limits
    if (j - start > MAX_BLOCK_SIZE) return null;
    if (depth > MAX_NESTING_DEPTH) return null;

    const ch = content[j];
    if (escaped) {
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
    }
    j++;
  }
  return depth === 0 ? content.slice(start, j) : null;
}

function extractJsonBlocks(content: string, extractPattern?: string): string[] {
  if (extractPattern) {
    const result = extractWithPattern(content, extractPattern);
    if (result) return result;
  }

  const blocks: string[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === '{' || content[i] === '[') {
      const block = findBalancedBlock(content, i);
      if (block) {
        blocks.push(block);
        i += block.length;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

/**
 * Sanitize AJV instancePath to avoid leaking internal schema structure.
 * Converts "/data/nested/secret" → "data.nested.secret" and truncates long paths.
 */
function sanitizePath(instancePath: string): string {
  if (!instancePath) return 'root';
  // Strip leading slash, replace remaining slashes with dots
  const cleaned = instancePath.replace(/^\//, '').replace(/\//g, '.');
  // Truncate overly long paths
  if (cleaned.length > 60) return `${cleaned.slice(0, 57)}...`;
  return cleaned;
}

export class SchemaEngine implements PolicyEngine {
  readonly name = 'schema';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    const schema = cfg?.schema;
    if (!schema || typeof schema !== 'object') {
      return [];
    }

    const mode = (cfg?.mode as string) || 'full';
    const label = (cfg?.label as string) || 'schema-violation';
    const extractPattern = cfg?.extractPattern as string | undefined;

    const validator = getValidator(schema as object);

    if (mode === 'partial') {
      return this.evaluatePartial(
        ctx.content,
        validator,
        label,
        extractPattern,
      );
    }

    return this.evaluateFull(ctx.content, validator, label);
  }

  private evaluateFull(
    content: string,
    validator: ReturnType<typeof ajv.compile>,
    label: string,
  ): PolicyDetection[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [
        {
          type: label,
          confidence: 1.0,
          message: 'Invalid JSON: content is not valid JSON',
        },
      ];
    }

    if (validator(parsed)) {
      return [];
    }

    const errors = validator.errors ?? [];
    return [
      {
        type: label,
        confidence: 1.0,
        message: `JSON validation failed: ${errors.map((e) => `${sanitizePath(e.instancePath || '')}${e.message ? ` ${e.message}` : ''}`).join('; ')}`,
      },
    ];
  }

  private evaluatePartial(
    content: string,
    validator: ReturnType<typeof ajv.compile>,
    label: string,
    extractPattern?: string,
  ): PolicyDetection[] {
    const blocks = extractJsonBlocks(content, extractPattern);
    if (blocks.length === 0) {
      return [];
    }

    const detections: PolicyDetection[] = [];
    for (const block of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        detections.push({
          type: label,
          confidence: 1.0,
          message: `Invalid JSON block: ${block.slice(0, 50)}...`,
        });
        continue;
      }

      if (!validator(parsed)) {
        const errors = validator.errors ?? [];
        detections.push({
          type: label,
          confidence: 1.0,
          message: `JSON validation failed: ${errors.map((e) => `${sanitizePath(e.instancePath || '')}${e.message ? ` ${e.message}` : ''}`).join('; ')}`,
        });
      }
    }

    return detections;
  }
}
