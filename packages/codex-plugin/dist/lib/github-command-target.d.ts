type GitExec = (cmd: string, opts: {
    cwd: string;
    encoding: 'utf8';
}) => string;
/**
 * The GitHub targets a command mutates.
 *
 * `unattributed` is deliberately distinct from "no credential": it means the
 * command could not be tied to a repository at all, so no credential question
 * was even asked.
 */
export type CommandGithubTargets = {
    state: 'no-mutation';
} | {
    state: 'resolved';
    remoteUrls: string[];
} | {
    state: 'unattributed';
    reason: string;
};
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
export declare function attributeCommandGithubTargets(toolName: string, args: string[], cwd: string, exec: GitExec): CommandGithubAttribution;
/** Targets only — see `attributeCommandGithubTargets`. */
export declare function resolveCommandGithubTargets(toolName: string, args: string[], cwd: string, exec: GitExec): CommandGithubTargets;
/**
 * Whether EVERY mutation target can be resolved without the session cwd. Codex
 * does not always supply the execution directory, and the session directory is
 * not a reliable stand-in for it.
 */
export declare function hasExplicitGithubMutationTarget(args: string[], cwd: string): boolean;
/**
 * The remote URL an observation is attributed to: the first resolved mutation
 * target, or the repository the command is standing in when it mutates nothing.
 */
export declare function resolveCommandGithubRemote(toolName: string, args: string[], cwd: string, exec: GitExec): string | undefined;
export {};
