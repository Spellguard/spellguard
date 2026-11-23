import type { GithubGrantCredentialDescriptor, GithubGrantsBundleFrame } from '@spellguard/agent-control';
/** The single machine-wide git author identity a grant set is issued under. */
interface GitAuthorIdentity {
    name: string;
    email: string;
}
interface GenerationState {
    protocolVersion: 5;
    /** Agent identity whose revision sequence this generation belongs to. */
    agentId: string;
    deliveryId: string;
    grantSetRevision: string;
    grants: Array<Omit<GithubGrantCredentialDescriptor, 'scoped_token'>>;
    /**
     * The author identity this generation was issued under. Non-secret, and part
     * of the generation itself so the activated set is self-describing. Absent on
     * a zero-grant set (nothing issued it) and on generations written by builds
     * that predate the identity fix.
     *
     * Diagnostic only today: no code path reads this back out of state.json —
     * the identity a session actually git-commits under comes from config.json's
     * `gitAuthorName`/`gitAuthorEmail`, written by `establishGitAuthorIdentity`
     * below. Kept anyway (not removed) so an operator inspecting a generation
     * directory on disk can see which identity it was issued under without
     * cross-referencing server-side audit logs — cheap and harmless to persist.
     */
    gitAuthor?: GitAuthorIdentity;
}
/**
 * Stage a complete token/config/helper generation, fsync it, then switch one
 * symlink. Readers therefore see the old or new full set across a crash, never
 * a mixture. No token is present in state.json or the manifest.
 */
export declare function applyGithubGrantBundle(configDir: string, frame: GithubGrantsBundleFrame, testHooks?: {
    beforeActivate?: () => void | Promise<void>;
}): Promise<void>;
export declare function readActiveGithubGrantState(configDir: string): Promise<GenerationState | null>;
/**
 * The V5 answer for ONE GitHub remote.
 *
 * Five states, not a boolean, because the four ways there is no usable
 * credential are not the same fact and must not produce the same message
 * (#781, #793):
 *  - `available`  — a covering grant that has not expired.
 *  - `expired`    — a covering grant whose token has expired. Its scoped token
 *                   id is exactly the input the pull-on-use refresh supersedes,
 *                   so callers pass it through: git runs, the credential helper
 *                   refreshes, and an unrefreshable token fails closed at git
 *                   or at GitHub. Blocking here made the recovery path
 *                   unreachable from a coding-agent session.
 *  - `absent`     — no V5 authority on disk at all; the caller's legacy V4
 *                   fallback is permitted.
 *  - `unavailable`— a V5 authority exists but is malformed, wrong-agent, or
 *                   carries no grant covering this remote. Authoritative:
 *                   fail closed, no fallback.
 *  - `unattributed`— no GitHub remote was supplied to resolve against. Nothing
 *                   was asked about a credential; saying one is unavailable
 *                   sends operators hunting a problem that does not exist.
 */
export type ActiveGithubGrantResolution = {
    state: 'absent' | 'unavailable' | 'unattributed';
} | {
    state: 'available' | 'expired';
    scopedTokenId: string;
    /** Absent only on a legacy V4 credential that carries no expiry. */
    expiresAt?: string;
};
/** The five answers a GitHub credential lookup can give. */
export type GithubCredentialState = ActiveGithubGrantResolution['state'];
export interface ActiveGithubGrantExpiryEntry {
    scopedTokenId: string;
    expiresAt: string;
}
export type ActiveGithubGrantExpiryResolution = {
    state: 'absent' | 'unavailable';
} | {
    state: 'available';
    entries: ActiveGithubGrantExpiryEntry[];
};
export type ActiveGithubGrantPrimaryTokenResolution = {
    state: 'absent' | 'unavailable';
} | {
    state: 'available';
    token: string | null;
};
/**
 * Resolve the non-secret token id selected by the helper-consumed V5 current
 * generation for one GitHub remote. The token file is opened only for private
 * regular-file metadata; its secret bytes never enter this process or the hook
 * payload. `absent` alone permits the caller's legacy V4 fallback. Any present
 * but malformed/incomplete generation is authoritative and fails closed. An
 * expired covering grant resolves to `expired`, not to nothing: see the state
 * documentation on `ActiveGithubGrantResolution`.
 */
export declare function resolveActiveGithubGrantCredential(configDir: string, remoteUrl: string | undefined, agentId: string, options?: {
    afterCurrentReadlink?: () => void;
}): ActiveGithubGrantResolution;
/**
 * Read the non-secret expiry descriptors from the helper-consumed V5 current
 * generation. Expired members remain valid inputs here because they are the
 * entries most urgently needing refresh. Any present but malformed,
 * incomplete, revoked, or wrong-agent generation is authoritative unavailable;
 * only a truly absent V5 root permits the daemon's legacy V4 census.
 */
export declare function readActiveGithubGrantExpiryEntries(configDir: string, agentId: string, options?: {
    afterCurrentReadlink?: () => void;
}): ActiveGithubGrantExpiryResolution;
/**
 * Read the primary token from the helper-consumed V5 authority so custom
 * framework projections can be reconstructed after a daemon restart. A
 * present but malformed or wrong-agent generation is authoritative and fails
 * closed; only an absent V5 authority permits legacy V4 fallback.
 */
export declare function readActiveGithubGrantPrimaryToken(configDir: string, agentId: string, options?: {
    afterCurrentReadlink?: () => void;
}): ActiveGithubGrantPrimaryTokenResolution;
/**
 * Resolve legacy V4 status identity against the helper's authoritative TSV.
 * Companion token bytes are compared only to bind the helper artifact to the
 * config identity, then zeroed immediately; this resolver never returns or logs
 * them. A helper-first rotation therefore blocks until config commits too.
 */
export declare function resolveLegacyGithubCredential(config: import('./config-store').SpellguardConfig, configDir: string, remoteUrl: string | undefined): ActiveGithubGrantResolution;
export {};
