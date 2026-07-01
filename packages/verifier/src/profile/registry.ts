// SPDX-License-Identifier: Apache-2.0

/**
 * Profile bundle singleton for the Verifier.
 *
 * One bundle per Verifier process. Initialised once at startup
 * (`initProfile(env)`); read from the router / discovery code via
 * `getActiveProfile()`. Stays in scope across requests so cached state
 * (SlimTransport WebSocket connection, DirDirectory http client) survives.
 *
 * When SPELLGUARD_PROFILE=original the bundle is still allocated but never
 * consumed by router/discovery — the existing HTTP / A2A code path is
 * authoritative. The conditional branches gating on `bundle.profile` keep
 * the original-profile hot path bit-identical to its pre-refactor shape.
 */

import {
  type ProfileBundle,
  type SpellguardDirectory,
  loadProfile,
} from '@spellguard/amp/profile';

let activeProfile: ProfileBundle | null = null;

// Optional directory override injected by the Node entrypoint (server.ts).
// The real AGNTCY dir client (GrpcDirDirectory) is gRPC + Node-only, so it
// CANNOT be imported here — registry.ts is bundled into the Cloudflare-Workers
// verifier (original profile). server.ts (Node-only, never on Workers)
// constructs it and calls setDirectoryOverride() before initProfile(); we
// graft it onto the agntcy bundle in place of amp's REST DirDirectory.
let directoryOverride: SpellguardDirectory | null = null;

/**
 * Inject the directory implementation the agntcy bundle should use. Called by
 * the Node entrypoint with a GrpcDirDirectory before initProfile(). No-op for
 * original profile (the directory is never consumed there).
 */
export function setDirectoryOverride(directory: SpellguardDirectory): void {
  directoryOverride = directory;
}

/**
 * Resolve the profile bundle from environment and cache it. Idempotent —
 * subsequent calls return the cached bundle without re-resolving env.
 */
export function initProfile(
  env: NodeJS.ProcessEnv = process.env,
): ProfileBundle {
  if (activeProfile) return activeProfile;
  const bundle = loadProfile({
    SPELLGUARD_PROFILE: env.SPELLGUARD_PROFILE,
    SPELLGUARD_TRANSPORT: env.SPELLGUARD_TRANSPORT,
    SPELLGUARD_DIRECTORY: env.SPELLGUARD_DIRECTORY,
    SPELLGUARD_IDENTITY: env.SPELLGUARD_IDENTITY,
    SPELLGUARD_SLIM_GATEWAY_URL:
      env.SPELLGUARD_SLIM_GATEWAY_URL ?? env.SPELLGUARD_SLIM_SIDECAR_URL,
    SPELLGUARD_DIR_URL: env.SPELLGUARD_DIR_URL,
    SPELLGUARD_IDENTITY_ISSUER_URL: env.SPELLGUARD_IDENTITY_ISSUER_URL,
  });
  // In agntcy mode, swap amp's REST DirDirectory for the injected gRPC client
  // (the real AGNTCY dir speaks gRPC). Falls back to amp's directory if no
  // override was injected (e.g. an agntcy unit test without a dir node).
  activeProfile =
    bundle.profile === 'agntcy' && directoryOverride
      ? { ...bundle, directory: directoryOverride }
      : bundle;
  return activeProfile;
}

/**
 * Return the currently active profile bundle. Returns null if `initProfile`
 * has never been called. Router / discovery code branches on
 * `bundle?.profile === 'agntcy'`; a null return is the same as original
 * profile (skip agntcy-specific code paths).
 */
export function getActiveProfile(): ProfileBundle | null {
  return activeProfile;
}

/**
 * Test helper — reset the singleton so a different env can be loaded.
 */
export function _resetActiveProfileForTesting(): void {
  activeProfile = null;
  directoryOverride = null;
}
