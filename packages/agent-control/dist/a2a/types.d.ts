/**
 * Canonical A2A (Agent2Agent) v1.0 message/task/part shapes — TypeScript
 * mirror of the vendored `a2a-v1.schema.json` in this directory.
 *
 * These are the payload SHAPES the Spellguard permissioned collaboration
 * plane carries over the existing agent-control WebSocket. This module is
 * SHAPES ONLY: no agent card, no JSON-RPC/gRPC binding, no transport frames,
 * and NO runtime dependency (the wire frames that carry these shapes are a
 * separate concern — see `protocol.ts`, which this module does not touch).
 *
 * Faithful to A2A v1.0 (github.com/a2aproject/A2A `specification/a2a.proto`,
 * proto package `lf.a2a.v1`). v1.0 breaking changes vs v0.3 reflected here:
 *   - unified `Part` model with NO `kind` discriminator (a `kind` field is a
 *     rejected unknown property);
 *   - enums use the SCREAMING_SNAKE representation with the proto value
 *     prefix stripped (proto `TASK_STATE_SUBMITTED` -> `SUBMITTED`,
 *     `ROLE_USER` -> `USER`);
 *   - messages carry a required `messageId`.
 *
 * Field names follow the proto3 lowerCamelCase JSON mapping.
 *
 * The `A2a`-prefixed names here are intentionally distinct from the unrelated
 * draft-era `A2AAdapter` in an internal test harness.
 *
 * NEG-009 scope: these object envelopes are closed by the canonical runtime
 * validators/schema. A2A extension interiors (`data` and `metadata`) remain
 * open exactly as the standard defines them; callers can put arbitrary JSON
 * there, and Spellguard makes no content-screening or containment claim.
 */
/**
 * The 8 standard A2A v1.0 task lifecycle states (proto `TaskState` minus the
 * `TASK_STATE_UNSPECIFIED` sentinel, value prefix stripped). Ordered to match
 * the proto's declaration order.
 */
export declare const A2A_TASK_STATES: readonly ["SUBMITTED", "WORKING", "INPUT_REQUIRED", "COMPLETED", "CANCELED", "FAILED", "REJECTED", "AUTH_REQUIRED"];
export type A2aTaskState = (typeof A2A_TASK_STATES)[number];
/** Sender role (proto `Role` minus `ROLE_UNSPECIFIED`, value prefix stripped). */
export declare const A2A_ROLES: readonly ["USER", "AGENT"];
export type A2aRole = (typeof A2A_ROLES)[number];
/**
 * Unified v1.0 Part. Exactly one of the content fields (`text` | `raw` |
 * `url` | `data`) is present; `metadata`/`filename`/`mediaType` are optional
 * and orthogonal to the content oneof. There is deliberately NO `kind` field.
 */
export interface A2aPart {
    /** Plain-text content. */
    text?: string;
    /** File byte content, base64-encoded (proto `bytes` -> JSON base64 string). */
    raw?: string;
    /** A URL pointing at the file's content. */
    url?: string;
    /** Arbitrary structured data (proto `google.protobuf.Value`) — any JSON value. */
    data?: unknown;
    /** Optional metadata for this part. */
    metadata?: Record<string, unknown>;
    /** Optional filename for a file part. */
    filename?: string;
    /** MIME type of the part content. */
    mediaType?: string;
}
/** One unit of communication. Required: `messageId`, `role`, `parts`. */
export interface A2aMessage {
    messageId: string;
    role: A2aRole;
    parts: A2aPart[];
    contextId?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
    extensions?: string[];
    referenceTaskIds?: string[];
}
/** A task output. Required: `artifactId`, `parts`. */
export interface A2aArtifact {
    artifactId: string;
    parts: A2aPart[];
    name?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    extensions?: string[];
}
/** The status container of a task. Required: `state`. */
export interface A2aTaskStatus {
    state: A2aTaskState;
    /** An optional message associated with the status. */
    message?: A2aMessage;
    /** ISO-8601 / RFC-3339 timestamp the status was recorded. */
    timestamp?: string;
}
/** The core unit of action. Required: `id`, `status`. */
export interface A2aTask {
    id: string;
    status: A2aTaskStatus;
    contextId?: string;
    artifacts?: A2aArtifact[];
    history?: A2aMessage[];
    metadata?: Record<string, unknown>;
}
