// SPDX-License-Identifier: Apache-2.0

/**
 * The `agent-conduct` config reader for the engine
 * (internal design notes). The reader itself is shared with
 * management's creation schema (`@spellguard/amp` agent-conduct.ts), so the
 * two refuse the same profiles; here it compiles fact patterns with the
 * Verifier's own ReDoS guard and caches the result per config object, so a
 * binding's patterns compile once.
 */

import {
  type AgentConductReadResult,
  readAgentConductProfile,
  readAgentConductStructure,
} from '@spellguard/amp';
import { safeRegex } from './builtin-engine';

export type {
  AgentConductFact,
  AgentConductOutputRule,
  AgentConductProfile,
} from '@spellguard/amp';

/** An identifier fact's pattern judges one whole token, ignoring case. */
export function compileFactPattern(source: string): RegExp | undefined {
  return safeRegex(`^(?:${source})$`, 'iu') ?? undefined;
}

const cache = new WeakMap<object, AgentConductReadResult>();

/** A binding's profile, as the engine reads it. */
export function agentConductConfig(config: unknown): AgentConductReadResult {
  if (typeof config !== 'object' || config === null) {
    return readAgentConductProfile(config, compileFactPattern);
  }
  let result = cache.get(config);
  if (!result) {
    result = readAgentConductProfile(config, compileFactPattern);
    cache.set(config, result);
  }
  return result;
}

/**
 * A profile's structure, including transports no leg observes yet. For the
 * measurement fixtures only (tests/fixtures/agent-conduct), whose cases model
 * the plugin legs of phase 3.
 */
export function agentConductStructure(config: unknown): AgentConductReadResult {
  return readAgentConductStructure(config, compileFactPattern);
}
