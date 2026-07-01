// SPDX-License-Identifier: Apache-2.0

export type RenderLevel = 'info' | 'warn' | 'error';

export interface RenderInput {
  level: RenderLevel;
  message: string;
  detail?: string;
}

let __renderedForTest: RenderInput[] = [];

/** Format a render input into its prefixed single line. Shared so the
 *  SessionStart hook wrapper can re-surface the same text via Claude Code's
 *  `systemMessage` channel — stderr (where renderMessage writes) is NOT shown
 *  to the user on a clean hook exit (2026-06-12 real-CLI finding). */
export function formatRenderLine(input: RenderInput): string {
  const prefix =
    input.level === 'error'
      ? '[spellguard error]'
      : input.level === 'warn'
        ? '[spellguard warn]'
        : '[spellguard]';
  return input.detail
    ? `${prefix} ${input.message} — ${input.detail}`
    : `${prefix} ${input.message}`;
}

export function renderMessage(input: RenderInput): void {
  __renderedForTest.push(input);
  process.stderr.write(`${formatRenderLine(input)}\n`);
}

/** Return everything rendered so far and reset the buffer. The SessionStart
 *  hook wrapper drains this to build its `systemMessage` stdout payload. */
export function drainRenderedMessages(): RenderInput[] {
  const drained = __renderedForTest;
  __renderedForTest = [];
  return drained;
}

export function getRenderedForTest(): readonly RenderInput[] {
  return __renderedForTest;
}

export function clearRenderedForTest(): void {
  __renderedForTest = [];
}
