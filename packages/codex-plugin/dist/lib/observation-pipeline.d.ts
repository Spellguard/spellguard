import { type ObservationEvent, type ObservationQueue, type OperationType } from './observation-emitter';
export interface ObserveInput {
    operationType: OperationType;
    remoteUrl: string;
    branch?: string;
    headSha?: string;
    prNumber?: number;
    commitsCount?: number;
    /** Commit message for `commit` observations (PostToolUse hook). */
    commitMessage?: string;
    agentId: string;
    scopedTokenId: string;
    clientSessionId: string;
}
export interface ObservePipelineDeps {
    spellguardBaseUrl: string;
    agentId: string;
    agentSecret: string;
    fetchImpl?: typeof fetch;
    scopeCachePath?: string;
    allowlistPath?: string;
    queue: ObservationQueue;
}
export interface ObserveResult {
    emitted: boolean;
    reason?: 'out_of_scope' | 'invalid_remote' | 'stale_cache' | 'delivered' | 'queued';
    event?: ObservationEvent;
}
export declare function observeGitOperation(input: ObserveInput, deps: ObservePipelineDeps): Promise<ObserveResult>;
