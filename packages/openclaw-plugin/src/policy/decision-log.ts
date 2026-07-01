// SPDX-License-Identifier: Apache-2.0

/**
 * Policy decision log emission (REQ-004).
 *
 * Emits a single structured JSON line per policy verdict to the plugin's
 * stdout. Downstream consumed via Cloudflare logpush / agent-host log
 * forwarders.
 *
 * Full OpenTelemetry GenAI dual-attribute emission is deferred to Phase 1
 * per PRD Out of Scope. We intentionally take NO `@opentelemetry/*`
 * dependency in Phase 0.
 */

export type Verdict = 'allow' | 'deny' | 'warn' | 'quarantine';

export interface PolicyDecisionLog {
  agent_uuid: string;
  agent_id: string;
  verdict: Verdict;
  engine: string;
  reason: string;
  timestamp: string;
}

/**
 * Emit a single `spellguard.policy.decision` JSON line on stdout.
 *
 * One call == one line. Callers must invoke this exactly once per verdict.
 */
export function emitPolicyDecision(d: PolicyDecisionLog): void {
  process.stdout.write(
    `${JSON.stringify({ source: 'spellguard.policy.decision', ...d })}\n`,
  );
}

/**
 * Map a Verifier-style result string (`'allow' | 'block' | 'flag' |
 * 'unscanned'`) into the wire-stable `Verdict` enum.
 *
 * - `allow` → `allow`
 * - `block` → `deny`
 * - `flag`  → `warn`
 * - anything else (incl. `unscanned`) → `quarantine`
 */
export function toVerdict(
  result: 'allow' | 'block' | 'flag' | 'unscanned' | string,
): Verdict {
  switch (result) {
    case 'allow':
      return 'allow';
    case 'block':
      return 'deny';
    case 'flag':
      return 'warn';
    default:
      return 'quarantine';
  }
}
