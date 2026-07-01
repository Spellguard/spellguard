/**
 * Policy decision log emission.
 *
 * Emits a single structured JSON line per policy verdict to the plugin's
 * stdout. Downstream consumed via Cloudflare logpush / agent-host log
 * forwarders.
 *
 * This module intentionally takes NO `@opentelemetry/*` dependency; full
 * OpenTelemetry GenAI dual-attribute emission is not yet implemented.
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
export declare function emitPolicyDecision(d: PolicyDecisionLog): void;
/**
 * Map a Verifier-style result string (`'allow' | 'block' | 'flag' |
 * 'unscanned'`) into the wire-stable `Verdict` enum.
 *
 * - `allow` → `allow`
 * - `block` → `deny`
 * - `flag`  → `warn`
 * - anything else (incl. `unscanned`) → `quarantine`
 */
export declare function toVerdict(result: 'allow' | 'block' | 'flag' | 'unscanned' | string): Verdict;
