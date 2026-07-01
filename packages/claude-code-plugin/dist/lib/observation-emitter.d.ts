export declare const WHITELIST_FIELDS: readonly ["event_uuid", "agent_id", "scoped_token_id", "operation_type", "target", "timestamp", "client_session_id"];
export declare const WHITELIST_TARGET_FIELDS: readonly ["owner", "repo", "branch", "head_sha", "pr_number", "commits_count", "commit_message"];
export type OperationType = 'push' | 'branch_create' | 'pr_open' | 'commit';
export interface ObservationTarget {
    owner: string;
    repo: string;
    branch?: string;
    head_sha?: string;
    pr_number?: number;
    commits_count?: number;
    commit_message?: string;
}
export interface ObservationEvent {
    event_uuid: string;
    agent_id: string;
    scoped_token_id: string;
    operation_type: OperationType;
    target: ObservationTarget;
    timestamp: string;
    client_session_id: string;
}
export interface BuildObservationInput {
    agentId: string;
    scopedTokenId: string;
    operationType: OperationType;
    target: ObservationTarget & Record<string, unknown>;
    clientSessionId: string;
    eventUuid?: string;
    timestamp?: string;
}
export declare function buildObservationEvent(input: BuildObservationInput): ObservationEvent;
export interface QueueOptions {
    capacity: number;
}
export declare class ObservationQueue {
    private opts;
    private buf;
    constructor(opts: QueueOptions);
    enqueue(event: ObservationEvent): void;
    size(): number;
    drain(): ObservationEvent[];
    peek(): ObservationEvent[];
    prepend(events: ObservationEvent[]): void;
}
export interface EmitOptions {
    endpoint: string;
    agentId: string;
    agentSecret: string;
    fetchImpl?: typeof fetch;
}
export declare function emitOrQueue(event: ObservationEvent, queue: ObservationQueue, opts: EmitOptions): Promise<{
    delivered: boolean;
    status?: number;
}>;
/**
 * Serial flush with head-of-queue bailout.
 *
 * The previous implementation drained the full queue up-front and attempted
 * every event in the snapshot — a network hiccup mid-drain would leave the
 * queue with the remainder of the snapshot re-prepended, but ordering was
 * subtly wrong when a retry succeeded after an earlier failure (the failed
 * event would move to the tail).
 *
 * This implementation removes an event only on a 2xx response; on the first
 * failure it breaks out of the loop, leaving the offender at the head of
 * the queue so the next flush retries it first. Order is preserved end-to-end.
 */
export declare function flushQueue(queue: ObservationQueue, opts: EmitOptions): Promise<{
    flushed: number;
    remaining: number;
}>;
