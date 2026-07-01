import { ObservationQueue } from '../lib/observation-emitter';
import { type ObserveResult } from '../lib/observation-pipeline';
export interface PostToolUseInput {
    toolName: string;
    toolArgs: string[];
    cwd: string;
    remoteUrl?: string;
    agentId: string;
    scopedTokenId: string;
    clientSessionId: string;
    endpoint: string;
    agentSecret: string;
    queue?: ObservationQueue;
    /** Test seam: override the child_process.execSync call. */
    execImpl?: (cmd: string, opts?: {
        cwd?: string;
    }) => string;
    /**
     * Structured tool input from Claude Code's PostToolUse event. Used to
     * persist Edit/Write tool calls into the local edit store. Optional so
     * pre-existing callers (e.g. test fixtures that only exercise the git
     * commit path) keep working without modification.
     */
    toolInput?: Record<string, unknown>;
    /**
     * Override the rootDir under which the edit store is opened. Defaults to
     * `~/.spellguard`. Test-injectable so unit tests can use a temp dir and
     * avoid polluting the developer's real `~/.spellguard/edits.db`.
     */
    editsRootDir?: string;
    /**
     * PostToolUse `duration_ms` for the Bash command, when Claude Code provides
     * it. FALLBACK source for the Bash-edit capture's command window — the primary
     * source is the PreToolUse-stamped command start (see `toolUseId`). `duration_ms`
     * is documented OPTIONAL, so the capture never depends on it alone.
     */
    durationMs?: number;
    /**
     * The tool-use id (shared by PreToolUse and PostToolUse for the same call).
     * Used to look up the PreToolUse-stamped command start time so the capture's
     * mtime window covers the command's real runtime. Falls back to the session
     * id when absent.
     */
    toolUseId?: string;
}
export type PostToolUseDecision = {
    decision: 'allow';
    observation?: ObserveResult | null;
} | {
    decision: 'skip';
};
/**
 * Runtime PostToolUse entrypoint registered in `plugin.json`. Emits a `commit`
 * observation after a `git commit` Bash call completes successfully.
 */
export declare function runPostToolUse(input: PostToolUseInput): Promise<PostToolUseDecision>;
export default runPostToolUse;
