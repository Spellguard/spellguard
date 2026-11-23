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
import { type A2aMessage, type A2aTask } from './types';
/** Discriminated result of a shape validation. `errors` are `path: reason`. */
export type A2aValidationResult<T> = {
    valid: true;
    value: T;
    errors: [];
} | {
    valid: false;
    value: null;
    errors: string[];
};
/**
 * Validate an unknown value as a canonical A2A v1.0 message. Rejects unknown
 * fields (NEG-001) so no credential/secret can be smuggled through the shape.
 */
export declare function validateA2aMessage(input: unknown): A2aValidationResult<A2aMessage>;
/**
 * Validate an unknown value as a canonical A2A v1.0 task. Rejects unknown
 * fields (NEG-001) so no credential/secret can be smuggled through the shape.
 */
export declare function validateA2aTask(input: unknown): A2aValidationResult<A2aTask>;
/** Boolean type guard form, for callers that only need the yes/no. */
export declare function isA2aMessage(input: unknown): input is A2aMessage;
/** Boolean type guard form, for callers that only need the yes/no. */
export declare function isA2aTask(input: unknown): input is A2aTask;
