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
import { resolve } from 'node:path';
import { detectGitOperation } from '../hooks/pre-tool-use-observation';
import {
  type SpellguardConfig,
  defaultConfigDir,
  readConfig,
} from './config-store';
import {
  type CommandGithubTargets,
  attributeCommandGithubTargets,
  hasExplicitGithubMutationTarget,
} from './github-command-target';
import {
  type GithubCredentialState,
  resolveActiveGithubGrantCredential,
  resolveLegacyGithubCredential,
} from './github-grant-generation';

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
  /**
   * @deprecated Derived from `githubCredentialState`; kept so callers that
   * predate the five-state representation keep working. True for `available`
   * AND `expired` — an expired grant still has a scoped token id, and the
   * refresh that replaces it only happens if git is allowed to run.
   */
  localCredentialAvailable: boolean;
  /** The authoritative credential answer for this command's GitHub targets. */
  githubCredentialState: GithubCredentialState;
  /**
   * Why attribution failed, when `githubCredentialState` is `unattributed`.
   * Surfaced verbatim in the hook's block message so the operator is told what
   * could not be attributed instead of being sent after a phantom credential.
   */
  githubTargetReason?: string;
  githubTargetContext: 'resolved' | 'execution-directory-missing';
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
  /** Test seam: override the framework credential directory. */
  configDir?: string;
}

interface ResolvedGithubCredential {
  state: GithubCredentialState;
  scopedTokenId: string;
}

/** Resolve one GitHub remote: V5 authority first, legacy V4 only when absent. */
function resolveOneRemote(
  config: SpellguardConfig,
  configDir: string,
  remoteUrl: string,
): ResolvedGithubCredential {
  const v5 = resolveActiveGithubGrantCredential(
    configDir,
    remoteUrl,
    config.agentId,
  );
  if (v5.state === 'available' || v5.state === 'expired') {
    return { state: v5.state, scopedTokenId: v5.scopedTokenId };
  }
  if (v5.state !== 'absent') return { state: v5.state, scopedTokenId: '' };
  const v4 = resolveLegacyGithubCredential(config, configDir, remoteUrl);
  return v4.state === 'available'
    ? { state: 'available', scopedTokenId: v4.scopedTokenId }
    : { state: 'absent', scopedTokenId: '' };
}

function blocks(state: GithubCredentialState): boolean {
  return (
    state === 'absent' || state === 'unavailable' || state === 'unattributed'
  );
}

/**
 * Resolve the credential answer for EVERY GitHub target this command mutates.
 * One unresolvable target blocks the whole command — a chain that pushes to two
 * repositories needs a grant for both — while the scoped token id reported for
 * the observation stays the one the observed remote belongs to.
 */
function resolveGithubCredential(
  config: SpellguardConfig,
  configDir: string,
  targets: CommandGithubTargets,
  remoteUrl: string | undefined,
): ResolvedGithubCredential {
  if (config.revoked) return { state: 'unavailable', scopedTokenId: '' };
  if (targets.state === 'unattributed') {
    return { state: 'unattributed', scopedTokenId: '' };
  }
  const remotes =
    targets.state === 'resolved'
      ? targets.remoteUrls
      : remoteUrl
        ? [remoteUrl]
        : [];
  if (remotes.length === 0) return { state: 'unattributed', scopedTokenId: '' };
  const resolved = remotes.map((url) =>
    resolveOneRemote(config, configDir, url),
  );
  const blocking = resolved.find((entry) => blocks(entry.state));
  if (blocking) return { state: blocking.state, scopedTokenId: '' };
  return resolved[0];
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

  const toolName = payload.tool_name ?? '';
  const sessionCwd = payload.cwd ?? process.cwd();
  const toolInput = payload.tool_input ?? {};
  const executionCwd = toolInput.workdir ?? toolInput.cwd;
  const hasExecutionCwd =
    typeof executionCwd === 'string' && executionCwd.length > 0;
  const cwd = hasExecutionCwd ? resolve(sessionCwd, executionCwd) : sessionCwd;

  const toolArgs = commandArgForTool(toolName, toolInput);

  const exec =
    opts.execImpl ??
    ((c: string, o: { cwd: string; encoding: 'utf8' }) =>
      execSync(c, o).toString());

  const operation = detectGitOperation(toolName, toolArgs);
  const missingExecutionCwd =
    (operation === 'push' || operation === 'pr_open') &&
    !hasExecutionCwd &&
    !hasExplicitGithubMutationTarget(toolArgs, sessionCwd);
  const attribution = missingExecutionCwd
    ? undefined
    : attributeCommandGithubTargets(toolName, toolArgs, cwd, exec);
  const remoteUrl = attribution?.remoteUrl;

  const credential: ResolvedGithubCredential = attribution
    ? resolveGithubCredential(
        config,
        opts.configDir ?? defaultConfigDir(),
        attribution.targets,
        remoteUrl,
      )
    : { state: 'unattributed', scopedTokenId: '' };
  // Identity-only, locally revoked, out-of-scope, and incomplete V5 states
  // still reach PreToolUse so GitHub mutations fail closed. No secret is read
  // from the V5 token artifact; only the state.json scoped token id is adapted.
  // An EXPIRED grant is NOT one of those states: it still identifies the
  // credential the pull-on-use refresh supersedes, and blocking it made that
  // refresh unreachable from inside a coding-agent session (#781).
  const localCredentialAvailable = !blocks(credential.state);

  const baseUrl = config.spellguardBaseUrl.replace(/\/$/, '');

  return {
    toolName,
    toolArgs,
    cwd,
    remoteUrl,
    agentId: config.agentId,
    scopedTokenId: credential.scopedTokenId,
    localCredentialAvailable,
    githubCredentialState: credential.state,
    githubTargetReason:
      attribution?.targets.state === 'unattributed'
        ? attribution.targets.reason
        : missingExecutionCwd
          ? 'Codex did not supply the command execution directory'
          : undefined,
    githubTargetContext: missingExecutionCwd
      ? 'execution-directory-missing'
      : 'resolved',
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

function commandArgForTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): string[] {
  if (
    (toolName === 'Bash' || toolName === 'apply_patch') &&
    typeof toolInput.command === 'string'
  ) {
    return [toolInput.command];
  }
  return [];
}
