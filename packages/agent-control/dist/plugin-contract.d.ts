/**
 * REQ-027 — the versioned, language-neutral PLUGIN INTEGRATION CONTRACT.
 *
 * The Go CLI provisions an agent, then hands off to the framework plugin's
 * TypeScript daemon (D3/REQ-027): it invokes the plugin's bootstrap entry
 * point, writes/reads the plugin's on-disk config, and resolves the plugin's
 * per-framework paths. Those paths, file names, entry-point names, and the
 * config schema are the plugin's INTERNALS — and the Go CLI is a separate
 * binary that can silently drift from them (it already did once: the CLI
 * modeled `githubCredentials` as a slice while the daemon writes a keyed map,
 * so the freshness gate always reported `credential_not_delivered`).
 *
 * This object is the SINGLE SOURCE OF TRUTH for that contract. It is serialized
 * to `packages/spellguard-cli/internal/plugin/plugin-contract.json` (committed,
 * Go-embeddable) by `scripts/gen-plugin-contract.mjs`. Two tests pin everything:
 *   - TS (`tests/unit/plugin-contract/contract.test.ts`): the committed JSON
 *     equals this object AND this object matches the LIVE plugin constants
 *     (FRAMEWORK_SLUG, the config-store path fns, the built bin names).
 *   - Go (`internal/plugin/contract_test.go`): the CLI's path/bin resolution +
 *     its config struct match the embedded contract.
 *
 * So: plugin constants → this object → committed JSON → Go CLI, with a hard
 * failure at every hop on drift. Bump `version` on any incompatible change.
 */
/** A framework's two-form slug + install home root. */
export interface FrameworkContract {
    /** Canonical underscore slug (`agents.framework`, wire). */
    readonly canonical: string;
    /** On-disk/CLI hyphen slug — the `~/.config/spellguard/<pathSlug>/` segment. */
    readonly pathSlug: string;
    /** The framework CLI's home root that holds the installed plugin cache. */
    readonly homeRoot: string;
}
export interface PluginContract {
    readonly version: number;
    /**
     * The plugin config root. `<env[envOverride]>/spellguard` when the override
     * env var is set, else `<home>/<defaultUnderHome>`.
     */
    readonly configRoot: {
        readonly envOverride: string;
        readonly defaultUnderHome: string;
    };
    /** File/dir names INSIDE a framework's config dir. */
    readonly files: {
        readonly config: string;
        readonly gitTokens: string;
        readonly agentsDir: string;
    };
    /** The plugin dist/bin entry points the CLI invokes (REQ-006.5). */
    readonly bins: {
        /** Managed-bootstrap entry point (run with SPELLGUARD_BOOTSTRAP_NONCE). */
        readonly setup: string;
        /** Brings up the plugin daemon. */
        readonly sessionStart: string;
        /** The long-running credential daemon. */
        readonly daemon: string;
    };
    /**
     * Glob (relative to `<home>/<framework.homeRoot>`) that locates the installed
     * plugin's `dist/bin` directory in the framework CLI's plugin cache.
     */
    readonly installCacheGlob: string;
    readonly frameworks: readonly FrameworkContract[];
    /**
     * The canonical config schema the CLI must write (REQ-006.4) and read back
     * without loss. Only the contract-bearing fields are pinned.
     */
    readonly configSchema: {
        /** Always present from bootstrap on; the CLI/daemon require these. */
        readonly required: readonly string[];
        /** Resume cursor — losing these re-triggers a spurious credential rotation. */
        readonly resume: readonly string[];
        /**
         * Per-org GitHub credentials. Pinned as `map` because the CLI once modeled
         * it as a list and silently failed every delivery check (the bug REQ-027
         * exists to prevent). Keyed by lowercase org login.
         */
        readonly githubCredentials: {
            readonly shape: 'map';
            readonly keyedBy: string;
            readonly entryFields: readonly string[];
        };
    };
}
export declare const PLUGIN_CONTRACT: PluginContract;
