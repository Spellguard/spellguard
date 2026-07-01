import { type SpellguardConfig, readConfig } from './config-store';
export interface ClaudeCodeHookPayload {
    session_id?: string;
    cwd?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    duration_ms?: number;
    tool_use_id?: string;
}
export interface AdaptedHookInput {
    toolName: string;
    /**
     * For Bash tool calls we wrap the entire `tool_input.command` string in a
     * single-element array. The plugin's downstream code (`detectGitOp`,
     * `runPreToolUse`) joins this back with `' '`, so a one-element array
     * round-trips the original command verbatim. For non-Bash tools this
     * is empty — the typed input still has a non-undefined value.
     */
    toolArgs: string[];
    cwd: string;
    remoteUrl?: string;
    agentId: string;
    scopedTokenId: string;
    agentSecret: string;
    clientSessionId: string;
    /** Full `${spellguardBaseUrl}/v1/observations` URL. */
    endpoint: string;
    toolInput: Record<string, unknown>;
    /** PostToolUse tool-call wall-clock time (fallback window source). */
    durationMs?: number;
    /** Tool-use id shared by Pre/Post — keys the command-start timing handoff. */
    toolUseId?: string;
    /** Pass-through of the resolved plugin config (for hooks that need extras). */
    pluginConfig: SpellguardConfig;
}
export interface AdaptHookPayloadOptions {
    /** Test seam: override the config reader. */
    readConfigImpl?: typeof readConfig;
    /** Test seam: override the git-remote probe. */
    execImpl?: (cmd: string, opts: {
        cwd: string;
        encoding: 'utf8';
    }) => string;
}
/**
 * Returns the adapted input, or `null` if the plugin is unconfigured (no
 * `~/.config/spellguard/config.json` yet) or its config can't be read.
 * Caller treats `null` as "skip silently" — the plugin can't usefully
 * observe anything without credentials.
 */
export declare function adaptHookPayload(payload: ClaudeCodeHookPayload, opts?: AdaptHookPayloadOptions): AdaptedHookInput | null;
