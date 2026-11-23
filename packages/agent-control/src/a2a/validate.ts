// SPDX-License-Identifier: Apache-2.0

/**
 * Hand-rolled, dependency-free runtime validators for the canonical A2A v1.0
 * message/task shapes. The vendored `a2a-v1.schema.json` is the canonical
 * REFERENCE artifact (the test-suite validates example payloads against it);
 * these guards are the LEAN runtime enforcement that ships bundled inside the
 * agent plugins, so they intentionally add no schema-validator dependency.
 * They match the same repo style as `protocol.ts`'s parse helpers.
 *
 * NEG-001 invariant: every object shape is validated with a closed key set —
 * any unknown/extra property (e.g. a smuggled `token`/`secret`) fails
 * validation. The vendored schema mirrors this with `additionalProperties:
 * false`, and the cross-language fixture corpus pins the two together.
 */

import {
  A2A_ROLES,
  A2A_TASK_STATES,
  type A2aMessage,
  type A2aTask,
} from './types';

/** Discriminated result of a shape validation. `errors` are `path: reason`. */
export type A2aValidationResult<T> =
  | { valid: true; value: T; errors: [] }
  | { valid: false; value: null; errors: string[] };

type Obj = Record<string, unknown>;

const TASK_STATE_SET: ReadonlySet<string> = new Set(A2A_TASK_STATES);
const ROLE_SET: ReadonlySet<string> = new Set(A2A_ROLES);

const PART_CONTENT_KEYS = ['text', 'raw', 'url', 'data'] as const;
const PART_KEYS = new Set<string>([
  ...PART_CONTENT_KEYS,
  'metadata',
  'filename',
  'mediaType',
]);
const MESSAGE_KEYS = new Set<string>([
  'messageId',
  'role',
  'parts',
  'contextId',
  'taskId',
  'metadata',
  'extensions',
  'referenceTaskIds',
]);
const ARTIFACT_KEYS = new Set<string>([
  'artifactId',
  'parts',
  'name',
  'description',
  'metadata',
  'extensions',
]);
const STATUS_KEYS = new Set<string>(['state', 'message', 'timestamp']);
const TASK_KEYS = new Set<string>([
  'id',
  'status',
  'contextId',
  'artifacts',
  'history',
  'metadata',
]);

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Push a `path: <unknown key>` error for every key not in `allowed`. */
function rejectUnknownKeys(
  obj: Obj,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push(`${path}: unknown field '${key}' is not permitted`);
    }
  }
}

function checkOptionalString(
  obj: Obj,
  key: string,
  path: string,
  errors: string[],
): void {
  if (key in obj && typeof obj[key] !== 'string') {
    errors.push(`${path}.${key}: expected string`);
  }
}

function checkOptionalStringArray(
  obj: Obj,
  key: string,
  path: string,
  errors: string[],
): void {
  if (!(key in obj)) return;
  const arr = obj[key];
  if (!Array.isArray(arr)) {
    errors.push(`${path}.${key}: expected array of string`);
    return;
  }
  arr.forEach((el, i) => {
    if (typeof el !== 'string') {
      errors.push(`${path}.${key}[${i}]: expected string`);
    }
  });
}

function checkOptionalObject(
  obj: Obj,
  key: string,
  path: string,
  errors: string[],
): void {
  if (key in obj && !isPlainObject(obj[key])) {
    errors.push(`${path}.${key}: expected object`);
  }
}

function validatePart(input: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, PART_KEYS, path, errors);

  const contentPresent = PART_CONTENT_KEYS.filter((k) => k in input);
  if (contentPresent.length !== 1) {
    errors.push(
      `${path}: exactly one content field (text|raw|url|data) required, found ${contentPresent.length}`,
    );
  }
  if ('text' in input && typeof input.text !== 'string') {
    errors.push(`${path}.text: expected string`);
  }
  if ('raw' in input && typeof input.raw !== 'string') {
    errors.push(`${path}.raw: expected string`);
  }
  if ('url' in input && typeof input.url !== 'string') {
    errors.push(`${path}.url: expected string`);
  }
  // `data` is google.protobuf.Value — any JSON value is acceptable.
  checkOptionalObject(input, 'metadata', path, errors);
  checkOptionalString(input, 'filename', path, errors);
  checkOptionalString(input, 'mediaType', path, errors);
}

function validateParts(input: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array of parts`);
    return;
  }
  if (input.length < 1) {
    errors.push(`${path}: at least one part required`);
  }
  input.forEach((p, i) => validatePart(p, `${path}[${i}]`, errors));
}

function validateMessageInto(
  input: unknown,
  path: string,
  errors: string[],
): void {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, MESSAGE_KEYS, path, errors);

  if (typeof input.messageId !== 'string' || input.messageId.length === 0) {
    errors.push(`${path}.messageId: required non-empty string`);
  }
  if (typeof input.role !== 'string' || !ROLE_SET.has(input.role)) {
    errors.push(
      `${path}.role: required, must be one of ${A2A_ROLES.join(' | ')}`,
    );
  }
  if (!('parts' in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, 'contextId', path, errors);
  checkOptionalString(input, 'taskId', path, errors);
  checkOptionalObject(input, 'metadata', path, errors);
  checkOptionalStringArray(input, 'extensions', path, errors);
  checkOptionalStringArray(input, 'referenceTaskIds', path, errors);
}

function validateArtifactInto(
  input: unknown,
  path: string,
  errors: string[],
): void {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, ARTIFACT_KEYS, path, errors);

  if (typeof input.artifactId !== 'string' || input.artifactId.length === 0) {
    errors.push(`${path}.artifactId: required non-empty string`);
  }
  if (!('parts' in input)) {
    errors.push(`${path}.parts: required`);
  } else {
    validateParts(input.parts, `${path}.parts`, errors);
  }
  checkOptionalString(input, 'name', path, errors);
  checkOptionalString(input, 'description', path, errors);
  checkOptionalObject(input, 'metadata', path, errors);
  checkOptionalStringArray(input, 'extensions', path, errors);
}

function validateStatusInto(
  input: unknown,
  path: string,
  errors: string[],
): void {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, STATUS_KEYS, path, errors);

  if (typeof input.state !== 'string' || !TASK_STATE_SET.has(input.state)) {
    errors.push(
      `${path}.state: required, must be one of ${A2A_TASK_STATES.join(' | ')}`,
    );
  }
  if ('message' in input) {
    validateMessageInto(input.message, `${path}.message`, errors);
  }
  checkOptionalString(input, 'timestamp', path, errors);
}

function validateTaskInto(
  input: unknown,
  path: string,
  errors: string[],
): void {
  if (!isPlainObject(input)) {
    errors.push(`${path}: expected object`);
    return;
  }
  rejectUnknownKeys(input, TASK_KEYS, path, errors);

  if (typeof input.id !== 'string' || input.id.length === 0) {
    errors.push(`${path}.id: required non-empty string`);
  }
  if (!('status' in input)) {
    errors.push(`${path}.status: required`);
  } else {
    validateStatusInto(input.status, `${path}.status`, errors);
  }
  checkOptionalString(input, 'contextId', path, errors);
  if ('artifacts' in input) {
    if (!Array.isArray(input.artifacts)) {
      errors.push(`${path}.artifacts: expected array`);
    } else {
      input.artifacts.forEach((a, i) =>
        validateArtifactInto(a, `${path}.artifacts[${i}]`, errors),
      );
    }
  }
  if ('history' in input) {
    if (!Array.isArray(input.history)) {
      errors.push(`${path}.history: expected array`);
    } else {
      input.history.forEach((m, i) =>
        validateMessageInto(m, `${path}.history[${i}]`, errors),
      );
    }
  }
  checkOptionalObject(input, 'metadata', path, errors);
}

/**
 * Validate an unknown value as a canonical A2A v1.0 message. Rejects unknown
 * fields (NEG-001) so no credential/secret can be smuggled through the shape.
 */
export function validateA2aMessage(
  input: unknown,
): A2aValidationResult<A2aMessage> {
  const errors: string[] = [];
  validateMessageInto(input, 'message', errors);
  return errors.length === 0
    ? { valid: true, value: input as A2aMessage, errors: [] }
    : { valid: false, value: null, errors };
}

/**
 * Validate an unknown value as a canonical A2A v1.0 task. Rejects unknown
 * fields (NEG-001) so no credential/secret can be smuggled through the shape.
 */
export function validateA2aTask(input: unknown): A2aValidationResult<A2aTask> {
  const errors: string[] = [];
  validateTaskInto(input, 'task', errors);
  return errors.length === 0
    ? { valid: true, value: input as A2aTask, errors: [] }
    : { valid: false, value: null, errors };
}

/** Boolean type guard form, for callers that only need the yes/no. */
export function isA2aMessage(input: unknown): input is A2aMessage {
  return validateA2aMessage(input).valid;
}

/** Boolean type guard form, for callers that only need the yes/no. */
export function isA2aTask(input: unknown): input is A2aTask {
  return validateA2aTask(input).valid;
}
