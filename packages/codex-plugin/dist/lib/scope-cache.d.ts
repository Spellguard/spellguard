import type { RepoTuple } from './observation-scope';
export interface CachedScope {
    serverScope: RepoTuple[];
    refreshedAt: number;
}
export declare function readScopeCache(path: string): CachedScope | null;
export declare function writeScopeCache(path: string, scope: CachedScope): void;
export declare function shouldRefreshCache(cache: CachedScope | null, now?: number): boolean;
