import { type GitOp } from '../lib/git-command-parser';
import { ObservationQueue } from '../lib/observation-emitter';
import type { OperationType } from '../lib/observation-emitter';
import { type ObserveResult } from '../lib/observation-pipeline';
export interface PreToolUseInput {
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
    /**
     * Optional base URL for the status-check probe. If absent we derive
     * it from `endpoint` by stripping `/v1/observations`.
     */
    spellguardBaseUrl?: string;
    /** Test seam for the status-check probe. */
    statusFetchImpl?: typeof fetch;
    /**
     * Tool-use id (shared by Pre/Post). Keys the command-start timing handoff
     * the PostToolUse Bash-edit capture consumes. Falls back to the session id.
     */
    toolUseId?: string;
    /** Override the rootDir for the timing sidecar. Defaults to `~/.spellguard`. */
    editsRootDir?: string;
}
/**
 * PreToolUse can return a block decision to Claude Code to prevent
 * the tool from running. The shape matches Claude Code's hook-response
 * convention.
 */
export type PreToolUseDecision = {
    decision: 'block';
    message: string;
} | {
    decision: 'allow';
    observation?: ObserveResult | null;
} | {
    decision: 'skip';
};
export declare function detectGitOperation(toolName: string, args: string[]): OperationType | null;
/**
 * Internal helper: executes only the scope-filtered observation-emission path.
 * Kept exported so tests and legacy callers can exercise observation logic
 * without triggering the status-check probe. New call sites should prefer
 * `runPreToolUse`, which is the runtime entrypoint (see plugin.json).
 */
export declare function emitPreToolUseObservation(input: PreToolUseInput): Promise<ObserveResult | null>;
/**
 * Codex PreToolUse output shape (see
 * https://developers.openai.com/codex/hooks). Codex's blocking shape is:
 *
 *   { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *                           permissionDecision: 'deny' | 'allow',
 *                           permissionDecisionReason: '...' } }
 *
 * The shared `PreToolUseDecision` type lives in the Codex copy too because
 * the observation-emission helper (`emitPreToolUseObservation`) is shared
 * and unchanged. We translate the internal decision into the Codex envelope
 * inside `runPreToolUseCodex` below — leave `runPreToolUse` alone so test
 * fixtures continue to work.
 */
export type CodexPreToolUseOutput = {
    hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'deny';
        permissionDecisionReason: string;
    };
} | {
    hookSpecificOutput?: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
    };
    continue: true;
} | Record<string, never>;
export declare function toCodexPreToolUseOutput(decision: PreToolUseDecision): CodexPreToolUseOutput;
/**
 * Codex-flavored entrypoint. Wraps `runPreToolUse` (host-agnostic) and
 * translates the internal decision into Codex's hookSpecificOutput
 * envelope. Registered in `hooks/hooks.json` via `bin/run-pre-tool-use.ts`.
 */
export declare function runPreToolUseCodex(input: PreToolUseInput): Promise<CodexPreToolUseOutput>;
/**
 * Runtime PreToolUse entrypoint registered in `plugin.json`. Runs the
 * status-check probe first (block on revoked/401/410), then falls through to
 * scope-filtered observation emission. Function name follows the
 * `run<HookName>` convention shared with `runSessionStart` / `runMonitorTick`.
 *
 * Return shape is a `PreToolUseDecision` — Claude Code's PreToolUse runtime
 * honors `{ decision: 'block', message }` to abort the pending tool call.
 */
export declare function runPreToolUse(input: PreToolUseInput): Promise<PreToolUseDecision>;
/**
 * @deprecated Legacy export retained for backward compat. New callers should
 * use `runPreToolUse` (the plugin.json runtime entry) or
 * `emitPreToolUseObservation` (the pure observation helper).
 */
export declare const runPreToolUseObservation: typeof emitPreToolUseObservation;
/**
 * @deprecated Alias for `runPreToolUse` retained for callers that imported
 * the previous transitional name. Prefer `runPreToolUse`.
 */
export declare const runPreToolUseHook: typeof runPreToolUse;
export default runPreToolUseCodex;
export type { GitOp };
