// SPDX-License-Identifier: Apache-2.0

// Probe `git config core.logAllRefUpdates` and decide whether to
// warn at session start that commit observations may be lost. The commit
// watcher tails `.git/logs/HEAD`, which is only written when this config
// is true (the default). Disabling it in CI checkouts or custom configs
// silently breaks the watcher; the warning gives operators a one-line
// pointer back to the cause.

import { execFileSync } from 'node:child_process';

export interface LogAllRefUpdatesResult {
  /** Whether to surface the warning to the user. */
  shouldWarn: boolean;
  /**
   * Optional reason for the chosen result. Useful for unit assertion and
   * structured logs; the renderMessage call site only uses shouldWarn.
   */
  reason: 'enabled' | 'disabled' | 'unset' | 'git-failed';
}

export function checkLogAllRefUpdates(cwd: string): LogAllRefUpdatesResult {
  try {
    const out = execFileSync(
      'git',
      ['config', '--get', 'core.logAllRefUpdates'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString()
      .trim()
      .toLowerCase();
    if (out === 'false' || out === '0') {
      return { shouldWarn: true, reason: 'disabled' };
    }
    return { shouldWarn: false, reason: 'enabled' };
  } catch {
    // Config unset → git returns non-zero (or repo missing). Default is
    // `true`, so unset means the reflog is being written; no warning.
    return { shouldWarn: false, reason: 'unset' };
  }
}
