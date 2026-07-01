export interface CommitDiffFile {
    addedLines: string[];
    removedLines: string[];
}
export interface AgentEdit {
    contentBefore: string;
    contentAfter: string;
    timestamp: string;
}
export interface AttributionResult {
    overallPercentage: number;
    agentAttributedLines: number;
    totalChangedLines: number;
    perFile: Record<string, {
        percentage: number;
        attributedLines: number;
        totalLines: number;
    }>;
}
export declare function computeAttribution(input: {
    commitDiffByFile: Record<string, CommitDiffFile>;
    agentEditsByFile: Record<string, AgentEdit[]>;
}): AttributionResult;
