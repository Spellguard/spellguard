/**
 * Phase C: one GitHub credential, keyed by lowercase GitHub org login.
 * The keyed `githubCredentials` map (below) lets a single agent machine hold
 * N tokens — one per org — at once; the legacy top-level
 * `scopedToken`/`scopedTokenId`/`expiresAt` fields are MIRRORED from the first
 * entry for back-compat (decision D13 / D6).
 */
export interface GithubCredentialEntry {
    scopedToken?: string;
    scopedTokenId: string;
    expiresAt: string;
    scopeSummary?: {
        repos: string[];
    };
    installationId?: number;
    revoked?: boolean;
}
export interface SpellguardConfig {
    /**
     * GitHub credential fields. Populated either by the legacy
     * bootstrap-bundled path (older servers) or, under the
     * provider-agnostic protocol, by the persistent credential
     * daemon when it receives a `credential_delivered` frame for the
     * `github` provider. Setup writes the surrounding identity-only fields
     * (`agentId`, `agentSecret`, `agentName`, `spellguardBaseUrl`) and
     * leaves these undefined until the GitHub credential lands.
     */
    scopedToken?: string;
    scopedTokenId?: string;
    expiresAt?: string;
    scopeSummary?: {
        repos: string[];
    };
    agentId: string;
    /**
     * Agent secret issued at bootstrap (`credential_delivered{cause:'bootstrap'}`).
     * The plugin uses this for both the persistent socket (URL query
     * `?agent_secret=`) and REST routes (`X-Spellguard-Agent-Id` +
     * `X-Spellguard-Agent-Secret` headers). It is the only credential the
     * server needs to authenticate the agent end-to-end.
     */
    agentSecret: string;
    spellguardBaseUrl: string;
    revoked?: boolean;
    /**
     * Human-readable, cause-specific reason this credential was torn down,
     * persisted so the next SessionStart can re-surface it to the user.
     * Written by the self-wipe path (P2-T6) when the server supersedes this
     * agent's secret (close code 4409 — attached elsewhere / reassigned). The
     * background daemon often performs the wipe while no interactive session is
     * open, so a one-shot stderr line would be lost; this field survives on disk
     * and SessionStart reads it the same way it reads `revoked`.
     */
    revokedMessage?: string;
    /** Provided in the bootstrap frame by the server. */
    agentName?: string;
    gitAuthorName?: string;
    gitAuthorEmail?: string;
    /**
     * Highest server `seq` the plugin has durably applied.
     * Persisted to disk after every successful frame handler so the
     * agent-control client can send `Resume{last_server_seq}` on
     * reconnect and receive missed frames from the server's ring buffer.
     * Decimal string (uint64). Optional — absent on first run before any
     * frame has been processed.
     */
    lastServerSeq?: string;
    /**
     * Cached projection of credentials the plugin currently holds,
     * sent to the server in `Resume.known_credentials` so divergence
     * detection compares against a real client view rather than an empty
     * one. Without this, every daemon restart trips
     * `maybeEmitAdminReissue` (server's live row vs empty client set =
     * divergence) and silently rotates the GitHub installation token. Only
     * the (provider, scoped_token_id) tuple is needed; the actual
     * `scoped_token` is kept separate for security.
     */
    knownCredentials?: Array<{
        provider: string;
        scoped_token_id: string;
    }>;
    /**
     * Server-pushed provider configuration descriptors, keyed by
     * provider name (e.g. 'github'). Written when the daemon receives a
     * `config_updated` frame. The shape per provider is opaque — it mirrors
     * `agents.provider_config` server-side and is forwarded as-is.
     */
    providerConfig?: Record<string, unknown>;
    /**
     * Phase C: GitHub credentials keyed by lowercase GitHub org login.
     * The legacy top-level scopedToken/scopedTokenId/expiresAt fields are
     * MIRRORED from the first entry for one release (old helper binaries and
     * session-start checks read them); writers must keep both in sync.
     */
    githubCredentials?: Record<string, GithubCredentialEntry>;
}
/** Public alias for consumers who import from the plugin index. */
export type PluginConfig = SpellguardConfig;
/**
 * The legacy single-slot config dir — the shared root with NO framework segment,
 * what an old (pre-isolation) plugin version used. Source of the one-time
 * legacy→framework migration (`migrate-legacy-config.ts`).
 */
export declare function legacyConfigDir(): string;
export declare function defaultConfigDir(): string;
export declare function defaultConfigPath(): string;
/**
 * Phase C (decision D13): the daemon-maintained companion file the POSIX-sh
 * git helper reads to select a token by repo-owner — NO JSON parsing in sh.
 * Lives next to config.json, mode 0600, one `<orgLoginLower>\t<token>` line
 * per unrevoked entry plus a `*\t<token>` wildcard fallback line.
 */
export declare function gitTokensPath(dir?: string): string;
/**
 * Regenerate the `git-tokens` companion file (decision D13) from a config.
 *
 * One TAB-separated line per UNREVOKED keyed entry (`<orgLoginLower>\t<token>`).
 * A `*\t<token>` wildcard line is emitted ONLY for a genuinely SINGLE-ORG
 * config: a keyed map with exactly one TOTAL entry (usable), or the legacy
 * single-slot `scopedToken` when the keyed map is absent — it preserves the
 * no-`path=` back-compat behavior for legacy git. Any keyed map with ≥2 TOTAL
 * entries (revoked ones included) omits the wildcard (PR #338 review CR-004):
 * a multi-org wildcard hands a SIBLING org's token to any repo owner outside
 * the agent's usable set — and counting REVOKED entries matters, because a
 * multi-org agent revoked down to one usable sibling would otherwise re-grow
 * a wildcard that serves that sibling's token for pushes to the REVOKED org
 * (the exact leak the review reproduced). Without the wildcard, the git
 * helper fails closed for unknown/revoked owners and prints its actionable
 * stderr notice instead of presenting the wrong org's credential.
 *
 * When no usable token exists the stale file is removed so a revoked-down-to-
 * zero config never leaves a live token on disk.
 */
export declare function writeGitTokensFile(config: SpellguardConfig, dir?: string): void;
export interface ReadConfigResult {
    config: SpellguardConfig | null;
    reason?: 'missing' | 'malformed' | 'wrong_permissions';
    /**
     * When `reason === 'malformed'`: WHICH validation failed ('json' for an
     * unparseable file). A malformed-but-present config used to be silently
     * indistinguishable from a missing one, which masked operator confusion
     * about "vanished" configs (plan Task 2.5, 2026-06-11).
     */
    malformedField?: string;
}
export declare function readConfig(path?: string): ReadConfigResult;
export declare function writeConfig(config: SpellguardConfig, path?: string): void;
export declare function markConfigRevoked(path?: string): void;
/**
 * P2-T6 self-wipe: clear THIS agent's on-disk GitHub credential material after
 * the server superseded its secret (close code 4409 — attached elsewhere or
 * reassigned), and persist a cause-specific `revokedMessage` so the next
 * SessionStart re-surfaces it (the wipe usually happens in the background
 * daemon while no interactive session is open, so a one-shot stderr line is
 * not enough).
 *
 * Wipes the credential-bearing fields (scoped token, org-keyed map, provider
 * config, cursor projection) while preserving the agent IDENTITY
 * (`agentId`/`agentSecret`/`spellguardBaseUrl`) so the setup command →
 * "select existing agent" can re-attach this machine. `revoked: true` keeps it
 * on the same SessionStart re-surface path as a server-pushed revoke. The
 * companion `git-tokens` file is dropped automatically by `writeConfig` →
 * `writeGitTokensFile` (no usable token remains). No-op when there is no
 * config on disk.
 */
export declare function markConfigSuperseded(message: string, path?: string): void;
export declare function clearConfig(path?: string): void;
