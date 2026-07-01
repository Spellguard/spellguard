// SPDX-License-Identifier: Apache-2.0

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
export const GITHUB_APP_REQUIRED_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
  members: 'read',
  administration: 'read',
} as const;
