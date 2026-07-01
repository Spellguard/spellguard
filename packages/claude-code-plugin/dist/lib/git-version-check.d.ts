export interface GitVersion {
    major: number;
    minor: number;
    patch: number;
}
export declare function parseGitVersion(stdout: string): GitVersion | null;
export declare function isGitVersionSupported(v: GitVersion): boolean;
export declare function detectGitVersion(): GitVersion | null;
