export interface CanonicalRemote {
    host: 'github.com';
    owner: string;
    repo: string;
    isSsh: boolean;
}
export declare function canonicalizeGitRemote(raw: string): CanonicalRemote | null;
