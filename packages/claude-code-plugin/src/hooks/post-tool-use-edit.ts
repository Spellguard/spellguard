// SPDX-License-Identifier: Apache-2.0

/**
 * PostToolUse hook helper — records `Edit` and `Write` tool calls into the
 * local SQLite edit store.
 *
 * This is invoked by `runPostToolUse` (post-tool-use-observation.ts) for
 * every PostToolUse event. We filter to just `Edit`/`Write` here so the
 * caller can unconditionally delegate; non-Edit/Write tool names are a
 * no-op.
 *
 * Content derivation:
 *   - Edit  → contentBefore = old_string, contentAfter = new_string
 *   - Write → contentBefore = '',        contentAfter = content
 *
 * If the resulting before/after are identical (replay, dry-run, etc.) we
 * skip the record entirely so the diff-overlap algorithm has a
 * clean stream of real changes to work with.
 */

import { relative } from 'node:path';
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

export async function recordEditFromToolUse(input: {
  store: Store;
  sessionContext: SessionContext;
  toolName: string;
  toolInput: ToolInput;
}): Promise<void> {
  if (input.toolName !== 'Edit' && input.toolName !== 'Write') return;
  const absPath = input.toolInput.file_path;
  if (!absPath) return;

  const relPath = relative(input.sessionContext.workingDir, absPath);
  const contentBefore =
    input.toolName === 'Edit' ? (input.toolInput.old_string ?? '') : '';
  const contentAfter =
    input.toolName === 'Edit'
      ? (input.toolInput.new_string ?? '')
      : (input.toolInput.content ?? '');
  if (contentBefore === contentAfter) return;

  // lineStart/lineEnd are not stored on EditRecord — they were previously
  // tracked as 1..N but only meaningful for full-file Write ops; misleading for
  // Edit substitutions. The diff-overlap algorithm walks contentAfter
  // text directly, so the columns were dead weight on every row.
  await input.store.record({
    workingDir: input.sessionContext.workingDir,
    filePath: relPath,
    contentBefore,
    contentAfter,
    sessionId: input.sessionContext.sessionId,
    agentId: input.sessionContext.agentId,
    timestamp: new Date().toISOString(),
  });
}
