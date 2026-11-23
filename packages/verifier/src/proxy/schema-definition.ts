// SPDX-License-Identifier: Apache-2.0

import {
  type Schema,
  type ValidationResult,
  Validator,
  dereference,
  encodePointer,
  format,
  initialBaseURI,
  validate,
} from '@cfworker/json-schema';
import draft7MetaSchema from './draft-07-meta-schema.json';

export type SchemaDefinition = Schema | boolean;

export class SchemaDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaDefinitionError';
  }
}

const DRAFT7_DIALECTS = new Set([
  'http://json-schema.org/draft-07/schema',
  'http://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
]);

function isSchemaObject(value: unknown): value is Schema {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneDefinition(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new SchemaDefinitionError('Schema definition must be JSON data');
  }
}

const strictDraft7MetaSchema = cloneDefinition(draft7MetaSchema);
if (!isSchemaObject(strictDraft7MetaSchema)) {
  throw new Error('The bundled Draft 7 meta-schema is malformed');
}

strictDraft7MetaSchema.additionalProperties = false;
if (strictDraft7MetaSchema.properties) {
  strictDraft7MetaSchema.properties = Object.fromEntries(
    Object.entries(strictDraft7MetaSchema.properties).filter(
      ([keyword]) =>
        keyword !== 'contentMediaType' && keyword !== 'contentEncoding',
    ),
  );
}

const schemaMetaValidator = new Validator(strictDraft7MetaSchema, '7', false);
const knownSchemaKeywords = new Set(
  Object.keys(strictDraft7MetaSchema.properties ?? {}),
);
const supportedFormats = new Set(Object.keys(format));

function schemaError(path: string, detail: string): SchemaDefinitionError {
  return new SchemaDefinitionError(`Invalid JSON Schema at ${path}: ${detail}`);
}

function validateDialect(schema: Schema): void {
  if (schema.$schema !== undefined && !DRAFT7_DIALECTS.has(schema.$schema)) {
    throw schemaError('$schema', 'only the Draft 7 dialect is supported');
  }
}

interface SchemaReference {
  baseUri: string;
  path: string;
  ref: string;
}

interface SchemaTraversal {
  dependencyLocations: DependencyLocation[];
  references: SchemaReference[];
}

interface DependencyLocation {
  baseUri: string;
  dependencies: NonNullable<Schema['dependencies']>;
  pointer: string;
  schema: Schema;
}

function visitSchemaValue(
  value: unknown,
  path: string,
  pointer: string,
  baseUri: string,
  traversal: SchemaTraversal,
  ancestors: Set<Schema>,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'boolean') {
    return;
  }
  if (!isSchemaObject(value)) {
    throw schemaError(path, 'schema value is malformed');
  }
  visitSchema(value, path, pointer, baseUri, traversal, ancestors);
}

function visitSchemaMap(
  value: unknown,
  path: string,
  pointer: string,
  baseUri: string,
  traversal: SchemaTraversal,
  ancestors: Set<Schema>,
): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw schemaError(path, 'schema map is malformed');
  }
  for (const [key, child] of Object.entries(value)) {
    visitSchemaValue(
      child,
      `${path}/${key}`,
      `${pointer}/${encodePointer(key)}`,
      baseUri,
      traversal,
      ancestors,
    );
  }
}

function visitSchemaArray(
  value: unknown,
  path: string,
  pointer: string,
  baseUri: string,
  traversal: SchemaTraversal,
  ancestors: Set<Schema>,
): void {
  if (!Array.isArray(value)) {
    throw schemaError(path, 'schema array is malformed');
  }
  for (let index = 0; index < value.length; index += 1) {
    visitSchemaValue(
      value[index],
      `${path}/${index}`,
      `${pointer}/${index}`,
      baseUri,
      traversal,
      ancestors,
    );
  }
}

function visitSchema(
  schema: Schema,
  path: string,
  pointer: string,
  baseUri: string,
  traversal: SchemaTraversal,
  ancestors: Set<Schema>,
): void {
  if (ancestors.has(schema)) {
    throw schemaError(path, 'circular schema definitions are not supported');
  }
  ancestors.add(schema);

  let resolvedBaseUri = baseUri;
  try {
    if (schema.$id !== undefined) {
      resolvedBaseUri = new URL(schema.$id, baseUri).href;
    }
  } catch {
    throw schemaError(`${path}/$id`, 'schema identifier is malformed');
  }
  const currentPointer = schema.$id === undefined ? pointer : '';

  for (const keyword of Object.keys(schema)) {
    if (!knownSchemaKeywords.has(keyword)) {
      throw schemaError(`${path}/${keyword}`, 'unsupported schema keyword');
    }
  }

  if (schema.dependencies !== undefined) {
    if (
      schema.dependencies === null ||
      typeof schema.dependencies !== 'object' ||
      Array.isArray(schema.dependencies)
    ) {
      throw schemaError(`${path}/dependencies`, 'dependency map is malformed');
    }
    traversal.dependencyLocations.push({
      schema,
      baseUri: resolvedBaseUri,
      pointer: currentPointer,
      dependencies: schema.dependencies,
    });
  }

  validateDialect(schema);
  if (
    schema.format !== undefined &&
    (typeof schema.format !== 'string' || !supportedFormats.has(schema.format))
  ) {
    throw schemaError(`${path}/format`, 'unsupported schema format');
  }

  if (schema.$ref !== undefined) {
    traversal.references.push({
      baseUri: resolvedBaseUri,
      path: `${path}/$ref`,
      ref: schema.$ref,
    });
  }

  visitSchemaValue(
    schema.additionalItems,
    `${path}/additionalItems`,
    `${currentPointer}/additionalItems`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.additionalProperties,
    `${path}/additionalProperties`,
    `${currentPointer}/additionalProperties`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.contains,
    `${path}/contains`,
    `${currentPointer}/contains`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.else,
    `${path}/else`,
    `${currentPointer}/else`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.if,
    `${path}/if`,
    `${currentPointer}/if`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.not,
    `${path}/not`,
    `${currentPointer}/not`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.propertyNames,
    `${path}/propertyNames`,
    `${currentPointer}/propertyNames`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );
  visitSchemaValue(
    schema.then,
    `${path}/then`,
    `${currentPointer}/then`,
    resolvedBaseUri,
    traversal,
    ancestors,
  );

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      visitSchemaArray(
        schema.items,
        `${path}/items`,
        `${currentPointer}/items`,
        resolvedBaseUri,
        traversal,
        ancestors,
      );
    } else {
      visitSchemaValue(
        schema.items,
        `${path}/items`,
        `${currentPointer}/items`,
        resolvedBaseUri,
        traversal,
        ancestors,
      );
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (schema[keyword] !== undefined) {
      visitSchemaArray(
        schema[keyword],
        `${path}/${keyword}`,
        `${currentPointer}/${keyword}`,
        resolvedBaseUri,
        traversal,
        ancestors,
      );
    }
  }

  for (const keyword of [
    'definitions',
    'patternProperties',
    'properties',
  ] as const) {
    visitSchemaMap(
      schema[keyword],
      `${path}/${keyword}`,
      `${currentPointer}/${keyword}`,
      resolvedBaseUri,
      traversal,
      ancestors,
    );
  }

  if (schema.dependencies !== undefined) {
    for (const [key, dependency] of Object.entries(schema.dependencies)) {
      if (Array.isArray(dependency)) {
        continue;
      }
      visitSchemaValue(
        dependency,
        `${path}/dependencies/${key}`,
        `${currentPointer}/dependencies/${encodePointer(key)}`,
        resolvedBaseUri,
        traversal,
        ancestors,
      );
    }
  }

  ancestors.delete(schema);
}

function validateSchemaMeta(value: unknown): SchemaDefinition {
  if (typeof value === 'boolean') return value;
  if (!isSchemaObject(value)) {
    throw schemaError('$', 'schema must be an object or boolean');
  }

  const candidate = cloneDefinition(value);
  if (!isSchemaObject(candidate)) {
    throw schemaError('$', 'schema must be an object');
  }

  let validation: ReturnType<Validator['validate']>;
  try {
    validation = schemaMetaValidator.validate(candidate);
  } catch {
    throw schemaError('$', 'schema does not satisfy the Draft 7 meta-schema');
  }
  if (!validation.valid) {
    throw schemaError('$', 'schema does not satisfy the Draft 7 meta-schema');
  }

  return candidate;
}

class PreparedSchemaValidator {
  constructor(
    private readonly schema: Schema | boolean,
    private readonly lookup: Record<string, Schema | boolean>,
  ) {}

  public validate(instance: unknown): ValidationResult {
    return validate(instance, this.schema, '7', this.lookup, false);
  }
}

interface PreparedSchemaDefinition {
  definition: SchemaDefinition;
  lookup: Record<string, Schema | boolean>;
}

function prepareSchemaDefinition(value: unknown): PreparedSchemaDefinition {
  const definition = validateSchemaMeta(value);

  const traversal: SchemaTraversal = {
    dependencyLocations: [],
    references: [],
  };
  if (isSchemaObject(definition)) {
    visitSchema(definition, '$', '', initialBaseURI.href, traversal, new Set());
  }

  for (const location of traversal.dependencyLocations) {
    // Detach Draft 7 dependency maps while building the lookup. The library
    // treats this container as a schema; its schema-valued entries are
    // registered explicitly below.
    // biome-ignore lint/performance/noDelete: dependency maps must be detached
    delete location.schema.dependencies;
  }

  let lookup: Record<string, Schema | boolean>;
  try {
    lookup = dereference(definition);

    for (const location of traversal.dependencyLocations) {
      const baseURI = new URL(location.baseUri);
      for (const [key, dependency] of Object.entries(location.dependencies)) {
        if (Array.isArray(dependency)) {
          continue;
        }
        const dependencySchema =
          typeof dependency === 'boolean'
            ? dependency
            : isSchemaObject(dependency)
              ? dependency
              : undefined;
        if (dependencySchema === undefined) {
          throw schemaError(
            `$/dependencies/${key}`,
            'schema value is malformed',
          );
        }
        dereference(
          dependencySchema,
          lookup,
          baseURI,
          `${location.pointer}/dependencies/${encodePointer(key)}`,
        );
      }
    }
    for (const reference of traversal.references) {
      let absoluteReference: string;
      try {
        absoluteReference = new URL(reference.ref, reference.baseUri).href;
      } catch {
        throw schemaError(reference.path, 'schema reference is malformed');
      }

      if (!Object.prototype.hasOwnProperty.call(lookup, absoluteReference)) {
        throw schemaError(reference.path, 'unresolved schema reference');
      }
    }
  } catch (error) {
    if (error instanceof SchemaDefinitionError) {
      throw error;
    }
    throw schemaError('$', 'schema validator could not be constructed');
  } finally {
    for (const location of traversal.dependencyLocations) {
      location.schema.dependencies = location.dependencies;
    }
  }

  return { definition, lookup };
}

/**
 * Validates a user-supplied Draft 7 schema before any content is extracted.
 * The returned object is a clone and may safely be dereferenced by the
 * validator without mutating the binding's original configuration.
 */
export function validateSchemaDefinition(value: unknown): SchemaDefinition {
  return prepareSchemaDefinition(value).definition;
}

export function createSchemaValidator(value: unknown): PreparedSchemaValidator {
  const { definition, lookup } = prepareSchemaDefinition(value);
  return new PreparedSchemaValidator(definition, lookup);
}
