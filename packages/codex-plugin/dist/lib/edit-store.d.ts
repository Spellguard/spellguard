export interface EditRecord {
    workingDir: string;
    filePath: string;
    contentBefore: string;
    contentAfter: string;
    sessionId: string;
    agentId: string;
    timestamp: string;
}
export declare function openEditStore(opts: {
    rootDir: string;
}): {
    record(_r: EditRecord): Promise<void>;
    queryByDir(_input: {
        workingDir: string;
        sinceIso?: string;
    }): Promise<EditRecord[]>;
    pruneOlderThan(_input: {
        olderThanIso: string;
    }): Promise<void>;
    close(): void;
};
