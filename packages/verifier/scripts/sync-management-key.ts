#!/usr/bin/env tsx
// SPDX-License-Identifier: Apache-2.0

/**
 * sync-management-key — copy MANAGEMENT_PUBLIC_KEY from the management
 * worker's `.dev.vars` into the Verifier's `.env` so the two stay in lockstep
 * on local-dev stacks.
 *
 * Why: the Verifier's `/v1/mcp/evaluate` (and related) endpoints verify the
 * `X-Spellguard-Management-Token` JWT against MANAGEMENT_PUBLIC_KEY. If the
 * management worker signs with one Ed25519 key and the Verifier verifies
 * against a different one, every plugin policy-evaluate call returns
 * `401 Invalid management token` and the embedded Spellguard plugin
 * fail-closes — silently dropping every Slack/Discord/Teams message that
 * reaches an OpenClaw agent.
 *
 * Production deployments wire the same key into both via the deploy
 * pipeline; local dev hasn't had a similar guarantee, so each fresh repo
 * clone could ship a Verifier `.env.example` with a stale demo key.
 * Running this script (and the corresponding pnpm task) every time after
 * `pnpm run db:setup` keeps the two sides aligned.
 *
 * Run:
 *   pnpm tsx packages/verifier/scripts/sync-management-key.ts
 *
 * Or via the canonical pnpm task:
 *   pnpm run verifier:sync-key
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const MANAGEMENT_DEV_VARS = resolve(REPO_ROOT, 'packages/management/.dev.vars');
const VERIFIER_ENV = resolve(REPO_ROOT, 'packages/verifier/.env');

function extractEnvValue(content: string, name: string): string | null {
  // Match `NAME="value"` or `NAME=value`. The management `.dev.vars`
  // wraps the multi-line PEM in double-quotes with \n escapes — we treat
  // the value as opaque and copy it verbatim, preserving quoting.
  const re = new RegExp(`^${name}=(.*)$`, 'm');
  const m = re.exec(content);
  return m ? m[1] : null;
}

function upsertEnvValue(content: string, name: string, value: string): string {
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, `${name}=${value}`);
  }
  return `${content.trimEnd()}\n${name}=${value}\n`;
}

function main(): void {
  if (!existsSync(MANAGEMENT_DEV_VARS)) {
    console.error(
      `[sync-management-key] FAIL: ${MANAGEMENT_DEV_VARS} not found.\nRun \`pnpm --filter @spellguard/management run dev\` (or copy .dev.vars.example) first.`,
    );
    process.exit(1);
  }
  if (!existsSync(VERIFIER_ENV)) {
    console.error(
      `[sync-management-key] FAIL: ${VERIFIER_ENV} not found.\nCopy \`packages/verifier/.env.example\` to \`packages/verifier/.env\` first.`,
    );
    process.exit(1);
  }

  const mgmtContent = readFileSync(MANAGEMENT_DEV_VARS, 'utf-8');
  const pubKey = extractEnvValue(mgmtContent, 'MANAGEMENT_PUBLIC_KEY');
  if (!pubKey) {
    console.error(
      '[sync-management-key] FAIL: MANAGEMENT_PUBLIC_KEY not found in management .dev.vars',
    );
    process.exit(1);
  }

  const verifierContent = readFileSync(VERIFIER_ENV, 'utf-8');
  const current = extractEnvValue(verifierContent, 'MANAGEMENT_PUBLIC_KEY');
  if (current === pubKey) {
    console.log('[sync-management-key] OK — already in sync');
    return;
  }

  const updated = upsertEnvValue(
    verifierContent,
    'MANAGEMENT_PUBLIC_KEY',
    pubKey,
  );
  writeFileSync(VERIFIER_ENV, updated, 'utf-8');
  console.log('[sync-management-key] OK — MANAGEMENT_PUBLIC_KEY updated');
}

main();
