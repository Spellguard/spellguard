// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * PreToolUse hook — observes git-mutating tool calls and emits observations.
 *
 * Codex's runtime calls this hook before each tool execution. We filter
 * for git-mutating commands (push, pr_open via `gh pr create`, branch creation)
 * and emit a scope-filtered observation via the observation pipeline.
 *
 * Includes a status-check fallback — when a git op is detected we
 * also probe `/v1/credentials/github/status`. On status=revoked or
 * HTTP 401/403/404/410 we emit a Codex `permissionDecision: 'deny'`.
 *
 * This probe FAILS OPEN on anything inconclusive: a timeout, a network error,
 * and any other non-terminal 4xx/5xx all return `allow`, so a control plane
 * that is unreachable does not hard-block the user. The fail-CLOSED guarantee
 * for credential state lives elsewhere — in the local credential-monitor and
 * the on-disk revoked flag, which are the authoritative enforcement path. This
 * hook is a fast terminal-state backstop on top of them, not the gate.
 *
 * Note: this hook runs as a fresh node process per call (Codex's hook
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
import {
  type GitOp,
  detectGhPrCreate,
  detectGitOp,
} from '../lib/git-command-parser';
import { canonicalizeGitRemote } from '../lib/git-remote-canonicalizer';
import type { GithubCredentialState } from '../lib/github-grant-generation';
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
  /**
   * @deprecated Superseded by `githubCredentialState`, which distinguishes the
   * four ways there is no usable credential. Still honoured when the newer
   * field is absent. False when config is identity-only, locally revoked, or
   * V5 is unusable.
   */
  localCredentialAvailable?: boolean;
  /**
   * The credential answer for this command's GitHub targets. `expired` passes
   * through: git runs, the Spellguard credential helper refreshes on use, and a
   * token that cannot be refreshed fails closed at git or at GitHub. Blocking
   * it here made the dead-daemon recovery path unreachable from a coding-agent
   * session (#781).
   */
  githubCredentialState?: GithubCredentialState;
  /** Why attribution failed, when `githubCredentialState` is `unattributed`. */
  githubTargetReason?: string;
  githubTargetContext?: 'resolved' | 'execution-directory-missing';
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
  if (!isBashTool(toolName)) return null;
  const cmd = args.join(' ');
  const op = detectGitOp(cmd);
  if (op === 'push') return 'push';
  if (op === 'checkout_new_branch' || op === 'switch_new_branch')
    return 'branch_create';
  // gh pr create is outside detectGitOp's scope (it's not a `git` subcommand),
  // but it reads the SAME tokenized segments so the classifier and the
  // attribution resolver cannot disagree about what a command runs.
  if (detectGhPrCreate(cmd)) return 'pr_open';
  return null;
}

/**
 * The block an agent sees when Spellguard cannot tell which repository a
 * command writes to. It must name what could not be attributed and how to
 * re-phrase the command, and must never read as a credential failure — the
 * old text sent operators hunting a credential problem that did not exist
 * (#793). Modelled on Codex's `execution-directory-missing` precedent.
 */
function unattributedMessage(input: PreToolUseInput): string {
  const parts = [
    'Spellguard could not work out which GitHub repository this command writes to, so it cannot check the credential for that repository.',
  ];
  if (input.githubTargetReason) {
    parts.push(
      `Spellguard could not attribute it because ${input.githubTargetReason}.`,
    );
  }
  parts.push(
    'Re-run the GitHub step as its own command, naming the target explicitly — for example `git -C /absolute/path/to/worktree push origin <branch>` or `gh pr create --repo OWNER/REPO` — and keep the intended repository unchanged.',
    'This is NOT a credential failure: credential checks still apply, and nothing needs repairing or re-authorizing.',
  );
  return parts.join(' ');
}

/**
 * Collapse the credential answer into a decision. `expired` is deliberately
 * NOT a block: see `PreToolUseInput.githubCredentialState`.
 */
function credentialDecision(input: PreToolUseInput): PreToolUseDecision | null {
  const state =
    input.githubCredentialState ??
    (input.localCredentialAvailable === false ? 'unavailable' : undefined);
  if (state === undefined || state === 'available' || state === 'expired') {
    return null;
  }
  if (state === 'unattributed') {
    return { decision: 'block', message: unattributedMessage(input) };
  }
  return {
    decision: 'block',
    message:
      'Spellguard credential unavailable for this GitHub target. Mutation is blocked until a matching credential is available.',
  };
}

function isBashTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'bash';
}

function isAgentAuthoredFileTool(toolName: string): boolean {
  return toolName === 'apply_patch';
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
/**
 * KNOWN ATTRIBUTION GAP (#781, item 4). When `githubCredentialState` is
 * `expired`, the scoped token id on this observation is the id of the grant the
 * pull-on-use refresh is about to SUPERSEDE — git runs next, the credential
 * helper mints a successor, and the push travels on that successor's token. The
 * observation therefore names the predecessor.
 *
 * It is not corrected after the fact. PostToolUse re-reads the V5 generation
 * from disk in a fresh process, so it would see the successor id, but it emits
 * an observation only for `commit`; there is no post-push observation to carry
 * the corrected id, and adding a second push observation would double-count
 * every push. Recording the predecessor id is also the useful half of the fact:
 * it is the id the server can follow to the successor it minted. Closing the
 * gap properly needs a refresh-aware field on the observation contract, which
 * is a server-side change and out of this plugin's scope.
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
  if (isBashTool(input.toolName) || isAgentAuthoredFileTool(input.toolName)) {
    markBashCommandStart({
      rootDir: input.editsRootDir ?? join(homedir(), '.spellguard'),
      key: input.toolUseId || input.clientSessionId,
      nowMs: Date.now(),
    });
  }

  const op = detectGitOperation(input.toolName, input.toolArgs);
  // A command the tokenizer could not read AT ALL, whose raw text mentions a
  // git mutation, is not "no git op here" — it is "I do not know what this
  // runs". `detectGitOp` answers `'unparseable'` for exactly that case, and the
  // adapter has already resolved the command as `unattributed`. Treating it as
  // "no op" switched the gate silently OFF: an unterminated quote inside a
  // trailing `# it's done` comment was enough.
  const unreadable =
    op === null &&
    isBashTool(input.toolName) &&
    detectGitOp(input.toolArgs.join(' ')) === 'unparseable';
  if (unreadable) return credentialDecision(input) ?? { decision: 'skip' };
  if (!op) return { decision: 'skip' };

  if (input.githubTargetContext === 'execution-directory-missing') {
    return {
      decision: 'block',
      message:
        'Codex did not supply the command execution directory. The session directory is not a reliable GitHub target. Retry with git -C /absolute/worktree push ... or gh pr create --repo OWNER/REPO. Keep the intended repository unchanged. Credential checks still apply; do not repair credentials based on this message.',
    };
  }

  const credential = credentialDecision(input);
  if (credential) return credential;

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

// Provide a default export so Codex's plugin runtime can invoke the hook
// without depending on a specific named-export convention. The default is
// `runPreToolUseCodex` — the Codex-shaped wrapper (status-check → deny OR
// observation), not the internal `PreToolUseDecision` entry above.
export default runPreToolUseCodex;

export type { GitOp };
