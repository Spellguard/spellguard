import type { CommitEvent } from '../monitors/commit-watcher';
import { type CommitDiffFile } from './diff-overlap';
import type { openEditStore } from './edit-store';
export declare function emitCommitObservation(input: {
    store: ReturnType<typeof openEditStore>;
    diffProvider: (sha: string) => Promise<Record<string, CommitDiffFile>>;
    fetch: typeof fetch;
    apiBase: string;
    agentId: string;
    agentSecret: string;
    workingDir: string;
    remoteUrl: string;
    commitEvent: CommitEvent;
    sessionContext: {
        sessionId: string;
        agentId: string;
    };
}): Promise<void>;
