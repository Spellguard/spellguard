/**
 * Canonical GitHub App permission set Spellguard-issued tokens scope within.
 *
 * **This constant is the source of truth.** The App's *effective* permissions
 * live at github.com under the App settings page and must be kept in sync;
 * drift between this constant and the App settings is caught by the test suite.
 *
 * This set lives here rather than on the plugin manifest because Claude Code's
 * current manifest schema does not allow extension fields.
 */
export declare const GITHUB_APP_REQUIRED_PERMISSIONS: {
    readonly contents: "write";
    readonly pull_requests: "write";
    readonly issues: "write";
    readonly metadata: "read";
    readonly members: "read";
    readonly administration: "read";
};
