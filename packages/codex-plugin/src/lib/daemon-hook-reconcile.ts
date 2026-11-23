// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { isManagedBox } from '@spellguard/agent-control';
import { defaultConfigDir, readConfig } from './config-store';
import {
  type DaemonResult,
  ensureCredentialDaemonRunning,
} from './daemon-spawn';

export const ACTIVE_HOOK_DEADLINE_MS = 750;

/**
 * Demand-driven daemon recovery for hooks that run during an active session.
 * Managed boxes stand down because the Go box daemon owns credential delivery.
 */
export async function reconcileDaemonForActiveHook(args: {
  cwd: string;
  configDir?: string;
  isManagedBox?: () => boolean;
}): Promise<DaemonResult> {
  const configDir = args.configDir ?? defaultConfigDir();
  if ((args.isManagedBox ?? isManagedBox)()) {
    return { daemon: 'skipped', reason: 'managed_box' };
  }
  const result = readConfig(join(configDir, 'config.json'));
  if (!result.config) {
    return { daemon: 'skipped', reason: 'missing_credentials' };
  }
  const deadlineAtMs = Date.now() + ACTIVE_HOOK_DEADLINE_MS;
  return ensureCredentialDaemonRunning({
    config: result.config,
    configDir,
    cwd: args.cwd,
    deadlineAtMs,
    readinessTimeoutMs: ACTIVE_HOOK_DEADLINE_MS,
    stopTimeoutMs: ACTIVE_HOOK_DEADLINE_MS,
    reconcileTimeoutMs: ACTIVE_HOOK_DEADLINE_MS,
  });
}
