// SPDX-License-Identifier: Apache-2.0

/**
 * Attribute a Bash command to the GitHub repositories it would mutate.
 *
 * This module used to carry its own copy of the separator regex and split the
 * raw command text before tokenizing, so it disagreed with `detectGitOp` about
 * what a command runs (#793): the hook classified with one parser and
 * attributed with another. Both now read the same tokenized segments from
 * `git-command-parser`.
 *
 * Three rules follow from that shared view:
 *  - `cd` is segment-scoped, and the scope nests. A `cd` in segment k sets the
 *    working directory for segments k+1..n, so `cd /worktree && git push origin b`
 *    is attributed to the worktree's remote and not to whatever directory the
 *    session happens to be sitting in; a `cd` inside `( … )` or inside an
 *    unwrapped `sh -c` payload is restored when that subshell closes.
 *  - Every mutation in the command is a target, not just a lone one. A
 *    fetch-merge-push chain, or a push followed by `gh pr create`, resolves each
 *    GitHub target and requires a credential for all of them.
 *  - Failure to attribute is its own state. It is NOT "no credential": the
 *    caller must say what could not be attributed rather than send an operator
 *    hunting for a credential problem that does not exist.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  type ShellSegment,
  commandWordIndex,
  isGhPrCreate,
  parseGitCommand,
  tokenizeShellCommand,
} from './git-command-parser';
import { canonicalizeGitRemote } from './git-remote-canonicalizer';

type GitExec = (cmd: string, opts: { cwd: string; encoding: 'utf8' }) => string;

const PUSH_VALUE_OPTIONS = new Set([
  '-o',
  '--push-option',
  '--receive-pack',
  '--exec',
]);

/**
 * The GitHub targets a command mutates.
 *
 * `unattributed` is deliberately distinct from "no credential": it means the
 * command could not be tied to a repository at all, so no credential question
 * was even asked.
 */
export type CommandGithubTargets =
  | { state: 'no-mutation' }
  | { state: 'resolved'; remoteUrls: string[] }
  | { state: 'unattributed'; reason: string };

interface MutationTarget {
  /** Working directory in effect for this command; null when unknown. */
  cwd: string | null;
  /** True when the directory came from the command itself, not the session. */
  absoluteCwd: boolean;
  /** `<remote>` / URL / `OWNER/REPO` named on the command line. */
  repository?: string;
  explicitGhRepository?: boolean;
  /** Set when the command cannot be attributed at all. */
  unattributed?: string;
}

/**
 * A path we can resolve without running a shell. A leading `~/` is fine — it is
 * this process's own home — but `~someone-else` is not, and neither is anything
 * carrying a variable or a substitution.
 */
function literalPath(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false;
  if (value.startsWith('-')) return false;
  if (value.includes('$') || value.includes('`')) return false;
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    return false;
  }
  return true;
}

/** Expand a leading `~` / `~/` against this process's home directory. */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/** True when the literal path names a directory without needing a cwd. */
function isRootedPath(value: string): boolean {
  return isAbsolute(value) || value === '~' || value.startsWith('~/');
}

function pushRepository(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '--') return args[index + 1];
    const option = word.split('=', 1)[0];
    if (PUSH_VALUE_OPTIONS.has(option) && !word.includes('=')) {
      index++;
    } else if (!word.startsWith('-')) {
      return word;
    }
  }
  return undefined;
}

function applyChdirs(
  chdirs: string[],
  cwd: string | null,
): { cwd: string | null; absolute: boolean } {
  let effective = cwd;
  let absolute = false;
  for (const dir of chdirs) {
    if (!literalPath(dir)) return { cwd: null, absolute };
    if (isRootedPath(dir)) {
      effective = expandHome(dir);
      absolute = true;
    } else if (effective === null) {
      return { cwd: null, absolute };
    } else {
      effective = resolvePath(effective, dir);
    }
  }
  return { cwd: effective, absolute };
}

function gitPushTarget(
  words: string[],
  cwd: string | null,
  cwdFromCommand: boolean,
): MutationTarget | null {
  const git = parseGitCommand(words);
  if (git?.subcommand !== 'push') return null;
  const moved = applyChdirs(git.chdirs, cwd);
  if (git.redirected) {
    return {
      cwd: moved.cwd,
      absoluteCwd: false,
      unattributed:
        'the push carries a git global option (-c / --git-dir / --work-tree / --namespace) that can redirect which remote it writes to',
    };
  }
  return {
    cwd: moved.cwd,
    absoluteCwd: cwdFromCommand || moved.absolute,
    repository: pushRepository(git.args),
  };
}

function ghMutationTarget(
  words: string[],
  cwd: string | null,
  cwdFromCommand: boolean,
): MutationTarget | null {
  if (!isGhPrCreate(words)) return null;
  const ghIndex = commandWordIndex(words, 'gh');
  for (let index = ghIndex + 1; index < words.length; index++) {
    const word = words[index];
    if (word === '--repo' || word === '-R') {
      const repository = words[index + 1];
      return repository
        ? { cwd, absoluteCwd: true, repository, explicitGhRepository: true }
        : {
            cwd,
            absoluteCwd: false,
            unattributed: '`gh pr create --repo` was given no repository',
          };
    }
    if (word.startsWith('--repo=')) {
      return {
        cwd,
        absoluteCwd: true,
        repository: word.slice('--repo='.length),
        explicitGhRepository: true,
      };
    }
    if (word.startsWith('-R') && word.length > 2) {
      return {
        cwd,
        absoluteCwd: true,
        repository: word.slice(2),
        explicitGhRepository: true,
      };
    }
  }
  return { cwd, absoluteCwd: cwdFromCommand };
}

/** Apply a segment's directory change to the running working directory. */
function applyDirectoryChange(
  words: string[],
  cwd: string | null,
): { cwd: string | null; absolute: boolean } | null {
  if (commandWordIndex(words, 'popd') >= 0)
    return { cwd: null, absolute: false };
  const cdIndex = Math.max(
    commandWordIndex(words, 'cd'),
    commandWordIndex(words, 'pushd'),
  );
  if (cdIndex < 0) return null;
  const operand = words
    .slice(cdIndex + 1)
    .find((word) => !word.startsWith('-'));
  // A bare `cd` goes to $HOME and `cd -` to $OLDPWD; neither is knowable here.
  if (!literalPath(operand) || operand === undefined) {
    return { cwd: null, absolute: false };
  }
  if (isRootedPath(operand)) {
    return { cwd: expandHome(operand), absolute: true };
  }
  if (cwd === null) return { cwd: null, absolute: false };
  return { cwd: resolvePath(cwd, operand), absolute: false };
}

function run(exec: GitExec, cwd: string, command: string): string | undefined {
  try {
    return exec(command, { cwd, encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function namedRemoteUrl(
  exec: GitExec,
  cwd: string,
  name: string,
): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  return run(exec, cwd, `git remote get-url --push ${name}`);
}

function defaultRemoteName(exec: GitExec, cwd: string): string | undefined {
  const branch = run(exec, cwd, 'git symbolic-ref --quiet --short HEAD');
  if (branch && /^[A-Za-z0-9._/-]+$/.test(branch)) {
    const pushRemote = run(
      exec,
      cwd,
      `git config --get branch.${branch}.pushRemote`,
    );
    if (pushRemote) return pushRemote;
  }
  const pushDefault = run(exec, cwd, 'git config --get remote.pushDefault');
  if (pushDefault) return pushDefault;
  if (branch && /^[A-Za-z0-9._/-]+$/.test(branch)) {
    const remote = run(exec, cwd, `git config --get branch.${branch}.remote`);
    if (remote && remote !== '.') return remote;
  }
  const remotes =
    run(exec, cwd, 'git remote')?.split(/\s+/).filter(Boolean) ?? [];
  if (remotes.length === 1) return remotes[0];
  return remotes.includes('origin') ? 'origin' : undefined;
}

function repositoryToUrl(
  exec: GitExec,
  cwd: string | null,
  repository: string,
): string | undefined {
  if (canonicalizeGitRemote(repository)) return repository;
  if (/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return `https://github.com/${repository}`;
  }
  return cwd === null ? undefined : namedRemoteUrl(exec, cwd, repository);
}

function remoteUrlForCwd(exec: GitExec, cwd: string): string | undefined {
  const remote = defaultRemoteName(exec, cwd);
  return remote ? namedRemoteUrl(exec, cwd, remote) : undefined;
}

interface ScannedCommand {
  targets: MutationTarget[];
  /** Directory in effect for the last `git` segment, for the no-mutation case. */
  fallbackCwd: string;
}

interface ScanState {
  targets: MutationTarget[];
  cwd: string | null;
  cwdFromCommand: boolean;
  fallbackCwd: string;
}

/**
 * Walk tokenized segments in order, tracking the working directory.
 *
 * Directory scope nests: a `(` pushes the current directory and the matching
 * `)` restores it, and an unwrapped `sh -c` payload runs with the directory in
 * effect at that point and cannot change it for what follows. Without that,
 * `(cd /w && git MUT) && git MUT` attributed the SECOND push to `/w`.
 */
function scanSegments(segments: ShellSegment[], state: ScanState): void {
  const stack: Array<{ cwd: string | null; fromCommand: boolean }> = [];
  for (const segment of segments) {
    if (segment.subshell === 'open') {
      stack.push({ cwd: state.cwd, fromCommand: state.cwdFromCommand });
      continue;
    }
    if (segment.subshell === 'close') {
      const restored = stack.pop();
      if (restored) {
        state.cwd = restored.cwd;
        state.cwdFromCommand = restored.fromCommand;
      }
      continue;
    }
    const { words } = segment;
    if (words.length === 0) continue;
    const target =
      gitPushTarget(words, state.cwd, state.cwdFromCommand) ??
      ghMutationTarget(words, state.cwd, state.cwdFromCommand);
    if (target) state.targets.push(target);
    const git = parseGitCommand(words);
    if (git) {
      const moved = applyChdirs(git.chdirs, state.cwd);
      if (moved.cwd !== null) state.fallbackCwd = moved.cwd;
    }
    if (segment.nested) {
      const saved = { cwd: state.cwd, fromCommand: state.cwdFromCommand };
      scanSegments(segment.nested, state);
      state.cwd = saved.cwd;
      state.cwdFromCommand = saved.fromCommand;
    }
    const directory = applyDirectoryChange(words, state.cwd);
    if (directory) {
      state.cwd = directory.cwd;
      state.cwdFromCommand =
        state.cwd !== null && (directory.absolute || state.cwdFromCommand);
    }
  }
}

function scanCommand(
  command: string,
  sessionCwd: string,
): ScannedCommand | null {
  const segments = tokenizeShellCommand(command);
  if (!segments) return null;
  const state: ScanState = {
    targets: [],
    cwd: sessionCwd,
    cwdFromCommand: false,
    fallbackCwd: sessionCwd,
  };
  scanSegments(segments, state);
  return { targets: state.targets, fallbackCwd: state.fallbackCwd };
}

function isBashTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'bash';
}

/** The GitHub attribution of one tool call: its targets and its observation remote. */
export interface CommandGithubAttribution {
  targets: CommandGithubTargets;
  /** Remote URL an observation is attributed to, when there is one. */
  remoteUrl?: string;
}

/**
 * Resolve every GitHub repository this command would mutate, plus the remote an
 * observation is attributed to.
 *
 * `unattributed` carries a reason the caller surfaces verbatim; it never means
 * a credential is missing.
 */
export function attributeCommandGithubTargets(
  toolName: string,
  args: string[],
  cwd: string,
  exec: GitExec,
): CommandGithubAttribution {
  if (!isBashTool(toolName)) return { targets: { state: 'no-mutation' } };
  const scanned = scanCommand(args.join(' '), cwd);
  if (!scanned) {
    return {
      targets: {
        state: 'unattributed',
        reason:
          'the command could not be parsed as a shell command (an unterminated quote or substitution)',
      },
    };
  }
  if (scanned.targets.length === 0) {
    return {
      targets: { state: 'no-mutation' },
      remoteUrl: remoteUrlForCwd(exec, scanned.fallbackCwd),
    };
  }

  const remoteUrls: string[] = [];
  for (const target of scanned.targets) {
    if (target.unattributed) {
      return {
        targets: { state: 'unattributed', reason: target.unattributed },
      };
    }
    const url = target.repository
      ? repositoryToUrl(exec, target.cwd, target.repository)
      : target.cwd === null
        ? undefined
        : remoteUrlForCwd(exec, target.cwd);
    if (!url) {
      return {
        targets: {
          state: 'unattributed',
          reason:
            target.cwd === null
              ? 'the directory the GitHub command runs in could not be determined from the command text'
              : `no push remote could be resolved for ${target.repository ? `"${target.repository}" in ` : ''}${target.cwd}`,
        },
      };
    }
    if (!remoteUrls.includes(url)) remoteUrls.push(url);
  }
  return {
    targets: { state: 'resolved', remoteUrls },
    remoteUrl: remoteUrls[0],
  };
}

/** Targets only — see `attributeCommandGithubTargets`. */
export function resolveCommandGithubTargets(
  toolName: string,
  args: string[],
  cwd: string,
  exec: GitExec,
): CommandGithubTargets {
  return attributeCommandGithubTargets(toolName, args, cwd, exec).targets;
}

/**
 * Whether EVERY mutation target can be resolved without the session cwd. Codex
 * does not always supply the execution directory, and the session directory is
 * not a reliable stand-in for it.
 */
export function hasExplicitGithubMutationTarget(
  args: string[],
  cwd: string,
): boolean {
  const scanned = scanCommand(args.join(' '), cwd);
  if (!scanned || scanned.targets.length === 0) return false;
  return scanned.targets.every((target) => {
    if (target.unattributed) return false;
    if (target.absoluteCwd) return true;
    if (!target.repository) return false;
    if (canonicalizeGitRemote(target.repository)) return true;
    return (
      target.explicitGhRepository === true &&
      /^[^/\s]+\/[^/\s]+$/.test(target.repository)
    );
  });
}

/**
 * The remote URL an observation is attributed to: the first resolved mutation
 * target, or the repository the command is standing in when it mutates nothing.
 */
export function resolveCommandGithubRemote(
  toolName: string,
  args: string[],
  cwd: string,
  exec: GitExec,
): string | undefined {
  return attributeCommandGithubTargets(toolName, args, cwd, exec).remoteUrl;
}
