// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseGitVersion(stdout: string): GitVersion | null {
  const m = stdout.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isGitVersionSupported(v: GitVersion): boolean {
  if (v.major > 2) return true;
  if (v.major < 2) return false;
  return v.minor >= 31;
}

export function detectGitVersion(): GitVersion | null {
  try {
    const out = execFileSync('git', ['--version'], { encoding: 'utf-8' });
    return parseGitVersion(out);
  } catch {
    return null;
  }
}
