// SPDX-License-Identifier: Apache-2.0

/**
 * Operator visibility for the one leg where scope semantics can surprise you.
 *
 * `filterByScope` applies ONE uniform rule to all three legs: a binding
 * governs a leg when it names that leg, names `'all'`, or names nothing
 * (unscoped ≡ `'all'`). On the messages and tools legs that has always been
 * true and surprises nobody. On the **`llm`** leg it means that turning on the
 * gateway silently extends every pre-existing `'all'`/unscoped binding onto
 * model inference — which is precisely how outage #478 happened, when 17
 * unscoped `tool-*` catalog policies began scanning natural-language prompts
 * and one of them denied 100% of agent-chat fan-outs.
 *
 * The semantics are NOT reverting (see `policy-evaluator.ts`'s docstring for
 * why the opposite reading was worse). What was missing was any signal that it
 * had happened. This module supplies it: the first time the gateway evaluates
 * a leg for an agent, it names in the log every binding whose coverage of the
 * `llm` leg comes ONLY from being `'all'`/unscoped. A binding that explicitly
 * asked for `'llm'` is an operator's stated intent, never a surprise, and is
 * never listed.
 */

import type { ResolvedPolicyBinding } from './policy-evaluator-types';

/**
 * The bindings that reach the `llm` leg by default rather than by request:
 * scope `'all'` or no scope at all.
 */
export function bindingsCoveringLlmByDefault(
  bindings: ResolvedPolicyBinding[],
): ResolvedPolicyBinding[] {
  return bindings.filter((b) => !b.scope || b.scope === 'all');
}

/**
 * Warning state, keyed by `<agentId>|<direction>`. The value is the signature
 * of the implicitly-covering set that was last announced, so the warning
 * re-fires when a binding is added or removed but never once per request.
 * Bounded by the agent count on this Verifier, same as the policy cache.
 */
const announced = new Map<string, string>();

/** Test hook — clears the once-per-agent dedup state. */
export function __resetImplicitLlmCoverageWarnings(): void {
  announced.clear();
}

/**
 * Log, at most once per (agent, direction, binding set), the bindings that
 * govern this agent's model calls only because they are `'all'`/unscoped.
 *
 * Takes the UNFILTERED direction list — the same list handed to
 * `filterByScope(…, 'llm')` — so the caller cannot accidentally pass an
 * already-narrowed set and silence the warning.
 */
export function warnImplicitLlmCoverage(
  agentId: string,
  direction: 'inbound' | 'outbound',
  bindings: ResolvedPolicyBinding[],
): void {
  const implicit = bindingsCoveringLlmByDefault(bindings);
  if (implicit.length === 0) return;

  const slugs = implicit.map((b) => b.policySlug ?? b.policyId).sort();
  const signature = slugs.join(',');
  const key = `${agentId}|${direction}`;
  if (announced.get(key) === signature) return;
  announced.set(key, signature);

  console.warn(
    `[Verifier] LLM gateway: ${implicit.length} ${direction} policy binding(s) govern model inference for agent ${agentId} only because they are scoped 'all' or unscoped, not because they named the 'llm' leg: ${slugs.join(', ')}. Scope them explicitly if that is not intended (internal design notes).`,
  );
}
