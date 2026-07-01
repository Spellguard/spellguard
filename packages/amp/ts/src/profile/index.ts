// SPDX-License-Identifier: Apache-2.0

/**
 * Profile registry + loader.
 *
 * Resolve once at startup via `loadProfile(env)`; pass the returned
 * `ProfileBundle` to anything that needs to send messages, resolve agents,
 * or issue/verify credentials.
 *
 * Default profile is `original` so deployments that don't set the env var
 * behave exactly as they have historically. To run the full AGNTCY stack set
 * `SPELLGUARD_PROFILE=agntcy` (plus the supporting infra — see
 * docs/spellguard-agntcy-profile.md).
 */

import { createAgntcyProfile } from './agntcy';
import { createOriginalProfile } from './original';
import type {
  DirectoryName,
  IdentityName,
  ProfileBundle,
  ProfileEnv,
  ProfileName,
  TransportName,
} from './types';

export type {
  AgentAddress,
  DirectoryName,
  IdentityName,
  IssueCredentialInput,
  IssuedCredential,
  ProfileBundle,
  ProfileEnv,
  ProfileName,
  PublishableRecord,
  SpellguardDirectory,
  SpellguardIdentity,
  SpellguardTransport,
  TransportName,
  VerifiedClaims,
} from './types';

export { createOriginalProfile } from './original';
export {
  AgntcyIdentity,
  DirDirectory,
  SlimTransport,
  createAgntcyProfile,
} from './agntcy';

const KNOWN_PROFILES: ReadonlySet<ProfileName> = new Set<ProfileName>([
  'original',
  'agntcy',
]);

/**
 * Resolve the active profile bundle from environment.
 *
 * Reads `SPELLGUARD_PROFILE` (default: 'original'). Per-layer overrides
 * (`SPELLGUARD_TRANSPORT`, `SPELLGUARD_DIRECTORY`, `SPELLGUARD_IDENTITY`)
 * are recognized but currently only honored when they match the composite
 * profile — mix-and-match wiring lands in a follow-up commit.
 *
 * Unknown profile names fall back to 'original' with a console warning, so a
 * typo in an env var never crashes a deployment.
 */
export function loadProfile(env: ProfileEnv): ProfileBundle {
  const raw = (env.SPELLGUARD_PROFILE ?? 'original').toLowerCase();
  const name: ProfileName = KNOWN_PROFILES.has(raw as ProfileName)
    ? (raw as ProfileName)
    : ((): ProfileName => {
        console.warn(
          `[profile] Unknown SPELLGUARD_PROFILE="${env.SPELLGUARD_PROFILE}", falling back to 'original'`,
        );
        return 'original';
      })();

  if (name === 'agntcy') {
    return createAgntcyProfile(env);
  }
  return createOriginalProfile();
}

/**
 * Test helper: parse the per-layer env overrides into a resolved triple.
 * Exposed so tests can verify the precedence rules without spinning up a
 * full ProfileBundle (which is expensive for SlimTransport).
 */
export function resolveProfileLayers(env: ProfileEnv): {
  transport: TransportName;
  directory: DirectoryName;
  identity: IdentityName;
} {
  const profile = (env.SPELLGUARD_PROFILE ?? 'original').toLowerCase();
  const transportDefault: TransportName =
    profile === 'agntcy' ? 'slim' : 'http';
  const directoryDefault: DirectoryName =
    profile === 'agntcy' ? 'dir' : 'a2a-wellknown';
  const identityDefault: IdentityName =
    profile === 'agntcy' ? 'agntcy-vc' : 'ctls';

  return {
    transport: (env.SPELLGUARD_TRANSPORT as TransportName) ?? transportDefault,
    directory: (env.SPELLGUARD_DIRECTORY as DirectoryName) ?? directoryDefault,
    identity: (env.SPELLGUARD_IDENTITY as IdentityName) ?? identityDefault,
  };
}
