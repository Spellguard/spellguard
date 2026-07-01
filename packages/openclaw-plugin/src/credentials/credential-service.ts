// SPDX-License-Identifier: Apache-2.0
//
// OSS build stub — substituted at export time
// (tools/export/rewriters/stub_openclaw_credential_service.ts).
//
// The credential channel connects to a Spellguard management plane via
// `@spellguard/agent-control`, which is not shipped in the OSS
// distribution. The socket requires a management-issued JWT that does not
// exist in OSS standalone mode (see the standalone-mode guard in
// `evaluateContent`), so this build provides a no-op service that keeps the
// plugin's public surface and types intact.

/** Minimal client surface (OSS stub — no real agent-control client). */
export interface MinimalAgentControlClient {
  start(): void;
  close(): void;
}

export interface CredentialServiceDeps {
  /** Override the on-disk path (tests). */
  storePath?: string;
  /**
   * When the legacy plugin-sync path is also registered, `index.ts` sets
   * this to `false`. No-op in the OSS build.
   */
  reconcileFrameworkOnStart?: boolean;
}

export interface CredentialService {
  start(): Promise<void>;
  stop(): void;
  /**
   * Feature #10: the real service emits a channel-ready frame to the broker
   * when a platform relay socket connects. The OSS stub has no agent-control
   * client, so this is a no-op that only preserves the public surface
   * consumed by `index.ts` (`onRelayReady` -> `signalChannelReady`).
   */
  signalChannelReady(args: {
    reason?: string;
    platform?: string;
    metadata?: Record<string, unknown>;
  }): void;
}

/**
 * OSS no-op: the credential socket requires the closed agent-control plane,
 * so there is nothing to start or stop in a standalone build.
 */
export function createCredentialService(
  _deps: CredentialServiceDeps = {},
): CredentialService {
  return {
    async start(): Promise<void> {
      /* no-op in OSS standalone builds */
    },
    stop(): void {
      /* no-op */
    },
    signalChannelReady(): void {
      /* no-op — no agent-control client to emit a ready frame in OSS */
    },
  };
}
