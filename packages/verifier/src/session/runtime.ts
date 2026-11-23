// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime services the session policies use, as one object.
 *
 * `createVerifierApp` builds it from `VerifierAppOptions` and hands it to the
 * legs that need it, the way it hands `nonceStore` to the admin route. No
 * module global holds it, so two app instances (tests) never share a store.
 */

import { POLICY_TYPE_REGISTRY } from '@spellguard/amp';
import type { ResolvedPolicyConfig } from '../proxy/policy-evaluator-types';
import type { DecisionModelClient } from './decision-model';
import type { DocumentExtractor, DocumentReader } from './document-extractor';
import { sessionKey } from './keys';
import { createMemorySessionStore } from './memory-session-store';
import type { SessionHandle, SessionStore } from './session-store';

export interface SessionServices {
  store?: SessionStore;
  /** The ingest gate's reader; without it attachments take the legacy path. */
  documentReader?: DocumentReader;
  documentExtractor?: DocumentExtractor;
  decisionModel?: DecisionModelClient;
}

/**
 * The policy types whose engine reads the session ledger: the registry's
 * `session` family. An agent bound to none of them gets no ledger: nothing
 * is recorded for it, and no session store call is made on its legs.
 */
export const SESSION_POLICY_TYPES: ReadonlySet<string> = new Set(
  POLICY_TYPE_REGISTRY.filter((entry) => entry.engineFamily === 'session').map(
    (entry) => entry.type,
  ),
);

/** Whether any of the agent's bindings, in either direction, reads a session. */
export function usesSessionPolicies(
  config: Pick<ResolvedPolicyConfig, 'inbound' | 'outbound'> | null | undefined,
): boolean {
  if (!config) return false;
  return [...config.inbound, ...config.outbound].some((b) =>
    SESSION_POLICY_TYPES.has(b.policyType),
  );
}

/**
 * The session store a Node Verifier serves. Local development (dev mode or
 * mock mode, the same switches `createVerifierApp` reads) gets the in-memory
 * store. A deployed Node Verifier (the Fargate task) gets none: there is no
 * encrypted store for it in this version, so its session policies report
 * `session_unavailable` rather than keep conversations in plain memory.
 */
export function nodeSessionStoreFor(
  env: Record<string, string | undefined>,
): SessionStore | undefined {
  const devOrMock =
    env.VERIFIER_DEV_MODE === 'true' || env.VERIFIER_MOCK_MODE === 'true';
  return devOrMock ? createMemorySessionStore() : undefined;
}

/**
 * Open `agentId`'s session for `correlationId`, or return undefined when
 * there is none to open: no store on this runtime, no correlation id on the
 * leg, or no session policy bound to the agent. A store that fails to open
 * is logged and treated as absent; the session policies then report
 * `session_unavailable` and act on their `failBehavior`.
 */
export async function openAgentSession(
  services: SessionServices,
  agentId: string,
  correlationId: string | undefined,
  config: Pick<ResolvedPolicyConfig, 'inbound' | 'outbound'> | null | undefined,
): Promise<SessionHandle | undefined> {
  if (!services.store || !correlationId || !usesSessionPolicies(config)) {
    return undefined;
  }
  try {
    return await services.store.open(sessionKey(agentId, correlationId));
  } catch (err) {
    console.warn(
      `[Verifier] Session store could not open a session for ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
