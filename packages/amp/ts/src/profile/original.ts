// SPDX-License-Identifier: Apache-2.0

/**
 * Original profile: HTTP transport + A2A discovery + CTLS channel tokens.
 *
 * These implementations are thin shells. The real work is delegated to the
 * existing call sites in `@spellguard/client` (attestation.ts, discovery.ts)
 * and `@spellguard/verifier` (router.ts). They exist here so the rest of the
 * codebase can program against `ProfileBundle` without conditional branches.
 *
 * Important: under the original profile, the *existing* code paths in
 * client/verifier are still the source of truth — this bundle is a typed
 * facade so agntcy-profile code can be developed against a stable API. A
 * future refactor (post-demo) can move the HTTP fetch calls into
 * `HttpTransport.send` directly and delete the duplication.
 */

import type { SecureMessage } from '../types/index';
import type {
  AgentAddress,
  IssueCredentialInput,
  IssuedCredential,
  ProfileBundle,
  PublishableRecord,
  SpellguardDirectory,
  SpellguardIdentity,
  SpellguardTransport,
  VerifiedClaims,
} from './types';

// ─────────────────────────────────────────────────────────────────────
// HttpTransport — facade over the existing HTTP/JSON-RPC code paths
// ─────────────────────────────────────────────────────────────────────

class HttpTransport implements SpellguardTransport {
  readonly name = 'http';

  send(_to: AgentAddress, _msg: SecureMessage): Promise<SecureMessage> {
    throw new Error(
      'HttpTransport.send: not invoked in original profile — the existing ChannelImpl.send path in @spellguard/client/attestation.ts is still authoritative. This facade exists so agntcy-profile code can be developed against a stable interface.',
    );
  }

  sendUnilateral(
    _a2aAgentUrl: string,
    _msg: SecureMessage,
  ): Promise<SecureMessage> {
    throw new Error(
      'HttpTransport.sendUnilateral: not invoked in original profile — see ChannelImpl.sendToA2A in @spellguard/client/attestation.ts.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// A2ADirectory — facade over the existing discovery code paths
// ─────────────────────────────────────────────────────────────────────

class A2ADirectory implements SpellguardDirectory {
  readonly name = 'a2a-wellknown';

  resolve(_agentNameOrUrl: string): Promise<AgentAddress | null> {
    throw new Error(
      'A2ADirectory.resolve: not invoked in original profile — see resolveAgentCard in @spellguard/client/discovery.ts.',
    );
  }

  publish(_card: PublishableRecord): Promise<void> {
    // A2A publication is implicit: the agent's own HTTP endpoint serves
    // its agent.json. Nothing to do here.
    return Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────────
// CtlsIdentity — facade over the existing channel-token flow
// ─────────────────────────────────────────────────────────────────────

class CtlsIdentity implements SpellguardIdentity {
  readonly name = 'ctls';

  issueCredential(_input: IssueCredentialInput): Promise<IssuedCredential> {
    throw new Error(
      'CtlsIdentity.issueCredential: not invoked in original profile — see Verifier /agents/register in @spellguard/verifier/proxy/router.ts.',
    );
  }

  verifyCredential(_credential: string): Promise<VerifiedClaims | null> {
    throw new Error(
      'CtlsIdentity.verifyCredential: not invoked in original profile — see channel-token lookup in @spellguard/verifier.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Bundle factory
// ─────────────────────────────────────────────────────────────────────

export function createOriginalProfile(): ProfileBundle {
  return {
    profile: 'original',
    transport: new HttpTransport(),
    directory: new A2ADirectory(),
    identity: new CtlsIdentity(),
  };
}
