// SPDX-License-Identifier: Apache-2.0

import {
  runManagedBootstrap,
  shouldRunManagedBootstrap,
} from '@spellguard/agent-control';
import { runApplyBundle } from '../src/lib/apply-bundle';
import { readConfig, writeConfig } from '../src/lib/config-store';
import {
  SETUP_USAGE,
  UsageError,
  parseSetupArgv,
} from '../src/lib/setup-cli-args';
import { runSpellguardSetup } from '../src/skills/spellguard-setup';

/**
 * Entry-point dispatcher (mirrors the Claude Code plugin).
 *
 *   1. If `SPELLGUARD_BOOTSTRAP_NONCE` is set, run the managed-provisioning
 *      claim flow — the path the spellguard CLI's `setup` (and any managed
 *      cloud first-boot) triggers. Persists agent_secret/agent_id/endpoint to
 *      the standard config so the runtime + daemon find it.
 *   2. Otherwise, run the interactive browser-bootstrap flow.
 */
async function main() {
  // OFFLINE credential-apply (CLI "sub-5s setup", REQ-CLI): the Spellguard CLI
  // already holds the agent identity + GitHub credential(s) from an HTTP
  // response and pipes them as a JSON bundle on STDIN. `--apply-bundle` writes
  // the same on-disk surfaces a managed-bootstrap frame would — with NO socket
  // and NO network call. Detected BEFORE the managed-bootstrap env check and the
  // interactive flow so the secret never reaches a real provisioning round-trip.
  if (process.argv.slice(2).includes('--apply-bundle')) {
    await runApplyBundle();
    return;
  }

  if (shouldRunManagedBootstrap(process.env)) {
    await runManagedFlow();
    return;
  }

  // Flag handling FIRST — `--help` (and any typo'd flag) must never start a
  // real setup flow (I9: `--help` used to mint a nonce and open the
  // bootstrap channel).
  let parsed: ReturnType<typeof parseSetupArgv>;
  try {
    parsed = parseSetupArgv(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${SETUP_USAGE}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (parsed.action === 'help') {
    process.stdout.write(`${SETUP_USAGE}\n`);
    return;
  }

  try {
    // `--base-url` overrides the SPELLGUARD_BASE_URL env default;
    // `--agent-id` is the lost-config recovery escape hatch; `--choice`
    // answers the existing-credential menu non-interactively — the ONLY way
    // to reach re-authorize when the wrapper runs without a TTY (I14).
    const result = await runSpellguardSetup({
      ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
      ...(parsed.agentId ? { agentIdOverride: parsed.agentId } : {}),
      ...(parsed.choice
        ? { existingConfigChoice: async () => parsed.choice as never }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(result ?? {})}\n`);
  } catch (err) {
    process.stderr.write(
      `spellguard-setup failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.exit(1);
  }
}

async function runManagedFlow(): Promise<void> {
  const env = process.env;
  const agentIdInEnv = env.SPELLGUARD_AGENT_ID ?? '';
  // Idempotency guard — skip if a non-revoked config already exists for the
  // same agent_id (the nonce is one-shot; re-running would 4401).
  const existing = readConfig();
  if (
    existing.config &&
    !existing.config.revoked &&
    existing.config.agentId === agentIdInEnv &&
    existing.config.agentSecret
  ) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        reason: 'already_provisioned',
        agentId: existing.config.agentId,
      })}\n`,
    );
    return;
  }
  try {
    const result = await runManagedBootstrap();
    // Persist a minimal config so the runtime + daemon pick up agent_secret.
    // The managed-bootstrap path has no GitHub credential yet (the protocol
    // ships `credentials: []`); the daemon's credential-request flow replaces
    // these placeholders when the dashboard pushes a real GH cred.
    writeConfig({
      scopedToken: '',
      scopedTokenId: '',
      agentId: result.agentId,
      agentSecret: result.agentSecret,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString(),
      scopeSummary: { repos: [] },
      spellguardBaseUrl: result.spellguardBaseUrl,
      lastServerSeq: result.frame.seq,
      knownCredentials: [],
      revoked: false,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        mode: 'managed-bootstrap',
        agentId: result.agentId,
        instanceFingerprint: result.instanceFingerprint,
      })}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `spellguard-setup (managed-bootstrap) failed: ${(err as Error)?.message ?? err}\n`,
    );
    process.exit(1);
  }
}

main();
