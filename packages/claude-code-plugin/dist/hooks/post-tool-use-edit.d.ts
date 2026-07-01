import type { openEditStore } from '../lib/edit-store';
type Store = ReturnType<typeof openEditStore>;
export interface SessionContext {
    sessionId: string;
    agentId: string;
    workingDir: string;
}
export interface ToolInput {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
}
export declare function recordEditFromToolUse(input: {
    store: Store;
    sessionContext: SessionContext;
    toolName: string;
    toolInput: ToolInput;
}): Promise<void>;
export {};
