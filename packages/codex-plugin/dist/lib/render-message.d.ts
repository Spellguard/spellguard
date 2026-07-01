export type RenderLevel = 'info' | 'warn' | 'error';
export interface RenderInput {
    level: RenderLevel;
    message: string;
    detail?: string;
}
/** Format a render input into its prefixed single line. Shared so the
 *  SessionStart hook wrapper can re-surface the same text via Claude Code's
 *  `systemMessage` channel — stderr (where renderMessage writes) is NOT shown
 *  to the user on a clean hook exit (2026-06-12 real-CLI finding). */
export declare function formatRenderLine(input: RenderInput): string;
export declare function renderMessage(input: RenderInput): void;
/** Return everything rendered so far and reset the buffer. The SessionStart
 *  hook wrapper drains this to build its `systemMessage` stdout payload. */
export declare function drainRenderedMessages(): RenderInput[];
export declare function getRenderedForTest(): readonly RenderInput[];
export declare function clearRenderedForTest(): void;
