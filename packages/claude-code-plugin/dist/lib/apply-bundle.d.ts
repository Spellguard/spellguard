/**
 * OFFLINE credential-apply mode for the Spellguard CLI's "sub-5s setup".
 *
 * The Spellguard CLI now receives the agent identity + GitHub credential(s)
 * directly in an HTTP response and hands the plugin a JSON "bundle" on STDIN
 * (NOT argv — the agent secret + scoped token must never hit the process table).
 * This module writes EXACTLY the same on-disk surfaces the managed-bootstrap
 * frame handler writes — but with NO agent-control WebSocket and NO network
 * call — by REUSING the canonical writers:
 *
 *   1. the base identity config (agentId / agentSecret / spellguardBaseUrl /
 *      expiresAt) via `writeConfig` — mirroring `runManagedFlow`'s placeholder
 *      shape so `readConfig` validates it; and
 *   2. the GitHub credential surfaces (config.json `githubCredentials`, the
 *      `git-tokens` TSV, the `CLAUDE_ENV_FILE` git-config exports, and the
 *      per-agent `gh/<agentId>/hosts.yml`) via the EXISTING
 *      `handleCredentialUpdate`, fed a synthesized `credential_delivered` frame.
 *
 * Nothing here is a reimplementation of a writer — every byte lands through the
 * same code path a real `credential_delivered{cause:'bootstrap'}` frame drives.
 */
import type { GithubCredentialScope } from '@spellguard/agent-control';
/** One GitHub credential as delivered in the CLI's HTTP-response bundle. */
export interface BundleGithubCredential {
    provider: 'github';
    credential_id: string;
    scoped_token_id?: string;
    scoped_token: string;
    /** ISO-8601 expiry of this issuance. */
    expires_at: string;
    github_org_login?: string;
    installation_id?: number;
    /**
     * What the credential grants. REQUIRED and discriminated: the bundle is a
     * delivery, and a box must never place a credential whose grant it cannot
     * read. See {@link GithubCredentialScope} — the shape this replaced could not
     * tell "the whole organization" from "no repositories".
     */
    scope_summary: GithubCredentialScope;
    /** Flat author identity — nested into `provider_data` below. */
    git_author_name: string;
    git_author_email: string;
}
/** The full bundle the CLI pipes to `--apply-bundle` on STDIN. */
export interface CredentialBundle {
    agent_id: string;
    agent_secret: string;
    spellguard_base_url: string;
    credentials: BundleGithubCredential[];
}
export interface ApplyBundleResult {
    agentId: string;
    credentialIds: string[];
}
/**
 * Parse + shallow-validate a bundle from raw JSON text. Throws `Error` with a
 * human-readable message on any structural problem (the caller maps it to the
 * `{"ok":false,"error":...}` line + exit 1).
 */
export declare function parseBundle(raw: string): CredentialBundle;
/**
 * Apply a parsed bundle to disk — NO socket, NO network. Writes the base
 * identity config, then drives the GitHub credentials through the canonical
 * `handleCredentialUpdate`.
 *
 * @returns the agent id + the credential ids that were applied.
 */
export declare function applyCredentialBundle(bundle: CredentialBundle): ApplyBundleResult;
/**
 * The `--apply-bundle` entry point: read the bundle from STDIN, apply it, and
 * print ONE line of JSON to stdout. `{"ok":true,...}` + exit 0 on success;
 * `{"ok":false,"error":...}` + exit 1 on any failure.
 */
export declare function runApplyBundle(): Promise<void>;
