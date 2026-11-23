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

import type { OutputUnit } from '@cfworker/json-schema';
import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';
import { createSchemaValidator } from './schema-definition';

const MAX_BLOCK_SIZE = 65_536; // 64 KB
const MAX_NESTING_DEPTH = 64;

// Cache validators keyed by the original JSON schema representation.
const validatorCache = new Map<
  string,
  ReturnType<typeof createSchemaValidator>
>();

function getValidator(schema: unknown) {
  let key: string | undefined;
  try {
    key = JSON.stringify(schema);
  } catch {
    throw new Error('Invalid JSON Schema: schema must be JSON data');
  }
  if (key === undefined) {
    throw new Error('Invalid JSON Schema: schema must be JSON data');
  }

  let validator = validatorCache.get(key);
  if (!validator) {
    validator = createSchemaValidator(schema);
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
 * Sanitize validator instance paths to avoid leaking internal schema structure.
 * Converts "/data/nested/secret" → "data.nested.secret" and truncates long paths.
 */
function sanitizePath(instancePath: string): string {
  if (!instancePath || instancePath === '#') return 'root';
  const pointer = instancePath.replace(/^#/, '').replace(/^\//, '');
  const cleaned = pointer
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
  // Truncate overly long paths
  if (cleaned.length > 60) return `${cleaned.slice(0, 57)}...`;
  return cleaned || 'root';
}

function formatValidationError(error: OutputUnit): string {
  const path = sanitizePath(error.instanceLocation);
  if (error.keyword === 'required') {
    const requiredProperty = error.error.match(/required property "([^"]+)"/);
    return requiredProperty
      ? `${path} is missing required property "${requiredProperty[1]}"`
      : `${path} is missing a required property`;
  }
  if (error.keyword === 'additionalProperties') {
    return `${path} has additional properties`;
  }
  if (
    error.keyword === 'enum' ||
    error.keyword === 'const' ||
    error.keyword === 'pattern'
  ) {
    return `${path} does not satisfy ${error.keyword}`;
  }
  return `${path} does not satisfy ${error.keyword || 'the schema'}`;
}

function formatValidationErrors(errors: OutputUnit[]): string {
  return errors.map(formatValidationError).join('; ');
}

export class SchemaEngine implements PolicyEngine {
  readonly name = 'schema';

  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    const cfg = ctx.binding.config;
    const schema = cfg?.schema;
    if (schema === undefined) {
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
    validator: ReturnType<typeof createSchemaValidator>,
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

    const validation = validator.validate(parsed);
    if (validation.valid) {
      return [];
    }

    return [
      {
        type: label,
        confidence: 1.0,
        message: `JSON validation failed: ${formatValidationErrors(validation.errors)}`,
      },
    ];
  }

  private evaluatePartial(
    content: string,
    validator: ReturnType<typeof createSchemaValidator>,
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

      const validation = validator.validate(parsed);
      if (!validation.valid) {
        detections.push({
          type: label,
          confidence: 1.0,
          message: `JSON validation failed: ${formatValidationErrors(validation.errors)}`,
        });
      }
    }

    return detections;
  }
}
