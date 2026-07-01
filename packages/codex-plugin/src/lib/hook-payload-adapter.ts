// SPDX-License-Identifier: Apache-2.0

// Adapter that translates a raw Claude Code hook payload (snake_case fields
// over stdin) into the camelCase input shape the plugin's
// runPreToolUse / runPostToolUse functions expect, merging in the
// per-agent credentials persisted at `~/.config/spellguard/config.json`.
//
// Why this exists: Claude Code's hook runtime sends payloads like
//   { session_id, cwd, tool_name, tool_input, ... }
// but the plugin's typed `PreToolUseInput` / `PostToolUseInput` use camelCase
// (`toolName`, `toolInput`, `clientSessionId`) AND require additional
// credential fields (`agentId`, `scopedTokenId`, `agentSecret`, `endpoint`)
// that Claude Code can't know about — those live in the plugin's own
// on-disk config. Without this adapter, the bin scripts passed the raw
// snake_case payload straight to the typed function, so
// `input.toolName === 'Edit'` was always false and the hook silently no-op'd
// on every invocation.

import { execSync } from 'node:child_process';
import { type SpellguardConfig, readConfig } from './config-store';

export interface ClaudeCodeHookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // PostToolUse carries `duration_ms` (the tool call's wall-clock time). The
  // Bash-edit capture uses it as a FALLBACK window source.
  duration_ms?: number;
  // Shared by PreToolUse and PostToolUse for the same tool call — used to hand
  // off the command's start time from Pre to Post (bash-command-timing).
  tool_use_id?: string;
  // Other fields (transcript_path, permission_mode, hook_event_name,
  // tool_response) are not consumed by the plugin's observation path and are
  // intentionally ignored here.
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
  execImpl?: (cmd: string, opts: { cwd: string; encoding: 'utf8' }) => string;
}

/**
 * Returns the adapted input, or `null` if the plugin is unconfigured (no
 * `~/.config/spellguard/config.json` yet) or its config can't be read.
 * Caller treats `null` as "skip silently" — the plugin can't usefully
 * observe anything without credentials.
 */
export function adaptHookPayload(
  payload: ClaudeCodeHookPayload,
  opts: AdaptHookPayloadOptions = {},
): AdaptedHookInput | null {
  const reader = opts.readConfigImpl ?? readConfig;
  const { config } = reader();
  if (!config) return null;
  if (config.revoked) return null;
  // Identity-only configs (bootstrap done, GitHub not yet connected
  // through the credential channel) cannot observe — the /v1/observations
  // route keys evidence by scoped_token_id. Skip silently and let the
  // operator complete the dashboard's GitHub-App install; the credential
  // daemon will write `scopedTokenId` to disk once the credential lands,
  // and the next hook invocation will pick it up.
  if (!config.scopedTokenId) return null;
  const scopedTokenIdResolved = config.scopedTokenId;

  const toolName = payload.tool_name ?? '';
  const cwd = payload.cwd ?? process.cwd();
  const toolInput = payload.tool_input ?? {};

  const toolArgs: string[] = [];
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    toolArgs.push(toolInput.command);
  }

  const exec =
    opts.execImpl ??
    ((c: string, o: { cwd: string; encoding: 'utf8' }) =>
      execSync(c, o).toString());

  let remoteUrl: string | undefined;
  try {
    remoteUrl = exec('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (!remoteUrl) remoteUrl = undefined;
  } catch {
    // not a git repo / no origin — leave undefined; downstream skips.
  }

  const baseUrl = config.spellguardBaseUrl.replace(/\/$/, '');

  return {
    toolName,
    toolArgs,
    cwd,
    remoteUrl,
    agentId: config.agentId,
    scopedTokenId: scopedTokenIdResolved,
    agentSecret: config.agentSecret,
    clientSessionId: payload.session_id ?? '',
    endpoint: `${baseUrl}/v1/observations`,
    toolInput,
    durationMs:
      typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined,
    toolUseId:
      typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined,
    pluginConfig: config,
  };
}
