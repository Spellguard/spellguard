// SPDX-License-Identifier: Apache-2.0

export interface PlatformInfo {
  platform: NodeJS.Platform | string;
  release: string;
}

export interface PlatformCheckResult {
  ok: boolean;
  message?: string;
}

export function isPlatformSupported(info: PlatformInfo): PlatformCheckResult {
  if (info.platform === 'darwin') return { ok: true };
  if (info.platform === 'linux') return { ok: true }; // includes WSL — WSL surfaces as linux to Node
  if (info.platform === 'win32') {
    return {
      ok: false,
      message:
        'Spellguard: Native Windows is not supported in MVP; please use WSL (Windows Subsystem for Linux).',
    };
  }
  return {
    ok: false,
    message: `Spellguard: unsupported platform "${info.platform}"; supported platforms are macOS, Linux, and WSL.`,
  };
}
