// SPDX-License-Identifier: Apache-2.0

// HERMETIC-SUITE SEAL: strip host-injected git env config before any test runs.
//
// A dev machine running a live Spellguard-wired agent session carries git
// config injected through the ENVIRONMENT — GIT_CONFIG_COUNT /
// GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> (+ GIT_ASKPASS) — i.e. the plugin's
// own credential + insteadOf wiring. git treats env config as highest-
// precedence, so ANY test that spawns a child process inherits it, and test
// outcomes then depend on the HOST's live credential state, not the code (a
// revoked machine credential flipped the ssh-remote-rewrite tests red with no
// code change). Unit tests must be hermetic: scrub the injection once, up
// front, for the whole suite. CI is unaffected (clean runners carry none), and
// tests that exercise these vars set them themselves after this runs.

const INJECTED_GIT_ENV_RE =
  /^(GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_ASKPASS|SSH_ASKPASS)$/;

for (const key of Object.keys(process.env)) {
  if (INJECTED_GIT_ENV_RE.test(key)) {
    delete process.env[key];
  }
}

// Never let a test hang on an interactive git credential prompt.
process.env.GIT_TERMINAL_PROMPT = '0';
