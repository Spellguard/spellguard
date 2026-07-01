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
    scope_summary: {
        repos: string[];
    };
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
