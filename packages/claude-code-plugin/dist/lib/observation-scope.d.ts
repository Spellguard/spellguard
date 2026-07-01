export interface RepoTuple {
    owner: string;
    repo: string;
}
export interface ScopeContext {
    serverScope: RepoTuple[];
    userAllowlist: RepoTuple[];
    cacheRefreshedAt: number;
}
export interface AllowlistResult {
    allowlist: RepoTuple[];
    parseError?: string;
}
export declare function isInEffectiveScope(target: RepoTuple, ctx: ScopeContext): boolean;
export declare function loadUserAllowlist(path: string): AllowlistResult;
