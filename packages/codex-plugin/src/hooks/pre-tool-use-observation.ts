// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * PreToolUse hook — observes git-mutating tool calls and emits observations.
 *
 * Claude Code's runtime can call this hook before each tool execution. We filter
 * for git-mutating commands (push, pr_open via `gh pr create`, branch creation)
 * and emit a scope-filtered observation via the observation pipeline.
 *
 * Includes a status-check fallback — when a git op is detected we
 * also probe `/v1/credentials/github/status`. On status=revoked or
 * HTTP 401/403/404/410 we return a block decision to Claude Code. Per the
 * fail-closed policy for credential states, network timeouts also return
 * `allow` so we don't hard-block the user when the control plane is
 * unreachable — the local credential-monitor + on-disk revoked flag remain
 * the authoritative enforcement path.
 *
 * Note: this hook runs as a fresh node process per call (Claude Code's hook
 * runtime spawns a new process from `bin/run-pre-tool-use.mjs` each time),
 * so an in-memory rate-limit cache is dead code. The broker's per-route
 * rate limit (RATE_LIMITER_STRICT, see workers/services/github/rate-limit.ts)
 * is the authoritative throttle.
 *
 * Substring `cmd.includes('git push')` matches are replaced with the
 * `detectGitOp` tokenized parser (see `../lib/git-command-parser`).
 */
import {
  createManagementClient,
  isAgentGoneStatus,
} from '@spellguard/agent-control';
import { markBashCommandStart } from '../lib/bash-command-timing';
import { type GitOp, detectGitOp } from '../lib/git-command-parser';
import { canonicalizeGitRemote } from '../lib/git-remote-canonicalizer';
import { ObservationQueue } from '../lib/observation-emitter';
import type { OperationType } from '../lib/observation-emitter';
import {
  type ObserveResult,
  observeGitOperation,
} from '../lib/observation-pipeline';

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
export type PreToolUseDecision =
  | { decision: 'block'; message: string }
  | { decision: 'allow'; observation?: ObserveResult | null }
  | { decision: 'skip' };

// Maps tool-name + args → high-level OperationType expected by the
// observation pipeline. Wraps `detectGitOp` (lower-level git-only parsing)
// and adds the `gh pr create` branch.
export function detectGitOperation(
  toolName: string,
  args: string[],
): OperationType | null {
  if (toolName !== 'Bash' && toolName !== 'bash') return null;
  const cmd = args.join(' ');
  const op = detectGitOp(cmd);
  if (op === 'push') return 'push';
  if (op === 'checkout_new_branch' || op === 'switch_new_branch')
    return 'branch_create';
  // gh pr create is outside detectGitOp's scope (it's not a `git` subcommand).
  // Use a separate anchored match.
  if (/(^|&&|;|\|\|)\s*gh\s+pr\s+create(\s|$)/.test(cmd)) return 'pr_open';
  return null;
}

function resolveRemoteUrl(input: PreToolUseInput): string | null {
  if (input.remoteUrl) return input.remoteUrl;
  return process.env.SPELLGUARD_CURRENT_REMOTE ?? null;
}

const STATUS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe `/v1/credentials/github/status`. Returns:
 *   - 'block'  when server returns 401/403/404/410 or status=revoked
 *   - 'allow'  when valid or rate-limited (cached)
 *   - 'allow'  on network/timeout failure (fail-open for transient errors)
 */
async function probeStatus(args: {
  baseUrl: string;
  agentId: string;
  agentSecret: string;
  scopedTokenId: string;
  fetchImpl: typeof fetch;
}): Promise<'block' | 'allow'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    const api = createManagementClient({
      baseUrl: args.baseUrl,
      agentId: args.agentId,
      agentSecret: args.agentSecret,
      fetchImpl: (input, init) =>
        args.fetchImpl(input, { ...init, signal: controller.signal }),
    });
    const { data, error, response } = await api.GET(
      '/credentials/github/status',
      { params: { query: { scoped_token_id: args.scopedTokenId } } },
    );
    // Post-auth-consolidation, /credentials/github/status returns
    // 403 (operator session attempted on agent-only surface) and 404 (agent
    // unknown) for revoked / offboarded agents — not just 401/410. Treat all
    // four as terminal block; otherwise quarantined agents could keep
    // executing git pushes with the cached GitHub token until its natural
    // ~1h expiry.
    if (isAgentGoneStatus(response?.status)) return 'block';
    if (error) return 'allow'; // other 4xx/5xx → fail-open (transient)
    if ((data as { status?: string })?.status === 'revoked') return 'block';
    return 'allow';
  } catch {
    // Timeout or network error: fail-open. The local credential-monitor +
    // Spellguard credential helper remain the authoritative enforcement gate.
    return 'allow';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Internal helper: executes only the scope-filtered observation-emission path.
 * Kept exported so tests and legacy callers can exercise observation logic
 * without triggering the status-check probe. New call sites should prefer
 * `runPreToolUse`, which is the runtime entrypoint (see plugin.json).
 */
export async function emitPreToolUseObservation(
  input: PreToolUseInput,
): Promise<ObserveResult | null> {
  const op = detectGitOperation(input.toolName, input.toolArgs);
  if (!op) return null;

  const remoteUrl = resolveRemoteUrl(input);
  if (!remoteUrl) return null;

  const canon = canonicalizeGitRemote(remoteUrl);
  if (!canon || canon.isSsh) return null;

  const queue = input.queue ?? new ObservationQueue({ capacity: 100 });

  const baseUrl =
    input.spellguardBaseUrl ??
    input.endpoint.replace(/\/v1\/observations\/?$/, '');

  return observeGitOperation(
    {
      operationType: op,
      remoteUrl,
      agentId: input.agentId,
      scopedTokenId: input.scopedTokenId,
      clientSessionId: input.clientSessionId,
    },
    {
      spellguardBaseUrl: baseUrl,
      agentId: input.agentId,
      agentSecret: input.agentSecret,
      queue,
    },
  );
}

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
export type CodexPreToolUseOutput =
  | {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'deny';
        permissionDecisionReason: string;
      };
    }
  | {
      hookSpecificOutput?: {
        hookEventName: 'PreToolUse';
        permissionDecision: 'allow';
      };
      continue: true;
    }
  | Record<string, never>;

export function toCodexPreToolUseOutput(
  decision: PreToolUseDecision,
): CodexPreToolUseOutput {
  if (decision.decision === 'block') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    };
  }
  if (decision.decision === 'skip') {
    return {};
  }
  return { continue: true };
}

/**
 * Codex-flavored entrypoint. Wraps `runPreToolUse` (host-agnostic) and
 * translates the internal decision into Codex's hookSpecificOutput
 * envelope. Registered in `hooks/hooks.json` via `bin/run-pre-tool-use.ts`.
 */
export async function runPreToolUseCodex(
  input: PreToolUseInput,
): Promise<CodexPreToolUseOutput> {
  const decision = await runPreToolUse(input);
  return toCodexPreToolUseOutput(decision);
}

/**
 * Runtime PreToolUse entrypoint registered in `plugin.json`. Runs the
 * status-check probe first (block on revoked/401/410), then falls through to
 * scope-filtered observation emission. Function name follows the
 * `run<HookName>` convention shared with `runSessionStart` / `runMonitorTick`.
 *
 * Return shape is a `PreToolUseDecision` — Claude Code's PreToolUse runtime
 * honors `{ decision: 'block', message }` to abort the pending tool call.
 */
export async function runPreToolUse(
  input: PreToolUseInput,
): Promise<PreToolUseDecision> {
  // Stamp the command's start time for EVERY Bash call (before the git-op gate
  // below, which returns early for non-git commands like heredocs). The
  // PostToolUse Bash-edit capture consumes this to window which files this
  // command authored. Best-effort — never throws.
  if (input.toolName === 'Bash' || input.toolName === 'bash') {
    markBashCommandStart({
      rootDir: input.editsRootDir ?? join(homedir(), '.spellguard'),
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now(),
    });
  }

  const op = detectGitOperation(input.toolName, input.toolArgs);
  if (!op) return { decision: 'skip' };

  // Status probe first so a revoked credential short-circuits observation
  // emission. The probe runs on every call — the broker's RATE_LIMITER_STRICT
  // is the authoritative throttle (each hook is a fresh node process, so an
  // in-memory cache here was dead code).
  const baseUrl =
    input.spellguardBaseUrl ??
    input.endpoint.replace(/\/v1\/observations\/?$/, '');
  const fetchImpl = input.statusFetchImpl ?? fetch;
  const verdict = await probeStatus({
    baseUrl,
    agentId: input.agentId,
    agentSecret: input.agentSecret,
    scopedTokenId: input.scopedTokenId,
    fetchImpl,
  });
  if (verdict === 'block') {
    return {
      decision: 'block',
      message:
        'Spellguard credential revoked. Run @spellguard-setup to re-authorize.',
    };
  }

  const observation = await emitPreToolUseObservation(input);
  return { decision: 'allow', observation };
}

/**
 * @deprecated Legacy export retained for backward compat. New callers should
 * use `runPreToolUse` (the plugin.json runtime entry) or
 * `emitPreToolUseObservation` (the pure observation helper).
 */
export const runPreToolUseObservation = emitPreToolUseObservation;

/**
 * @deprecated Alias for `runPreToolUse` retained for callers that imported
 * the previous transitional name. Prefer `runPreToolUse`.
 */
export const runPreToolUseHook = runPreToolUse;

// Provide a default export so Claude Code's plugin runtime can invoke the
// hook without depending on a specific named-export convention. The default
// is the full decision-returning entry (status-check → block OR observation).
export default runPreToolUseCodex;

export type { GitOp };
