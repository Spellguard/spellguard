// SPDX-License-Identifier: Apache-2.0

/**
 * External HTTPS policy engine.
 *
 * Delegates policy evaluation to an external HTTP(S) endpoint.
 * The endpoint receives a JSON POST with { content, policyId, policySlug, config }
 * and must return a JSON array of PolicyDetection objects:
 *   [{ "type": "...", "confidence": 0.95, "message": "..." }]
 *
 * Configuration is read from the binding:
 *   - externalEndpoint: the URL to POST to (required)
 *   - externalTimeout: request timeout in ms (default 5000)
 *   - externalMtlsCert: reserved for future mTLS support
 *   - failBehavior: what to do on error ('allow' | 'block' | 'warn', default 'block')
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

/**
 * The Spellguard guard engine (management's `/v1/guard-engine/evaluate`, which
 * forwards the `guard-*` policies to the GPU pool) authenticates each
 * evaluation with a key in `config.key`. That key is the
 * Verifier's own secret (`GUARD_ENGINE_POLICY_KEY`), never part of a binding:
 * it is added to the request only when the endpoint sits on the guard
 * engine's own origin (`GUARD_ENGINE_BASE_URL`), so a customer's external
 * endpoint never receives it, and nothing in management's database holds it.
 */
export function guardEngineKeyFor(
  endpoint: string,
  env: Record<string, string | undefined>,
): string | null {
  const key = env.GUARD_ENGINE_POLICY_KEY?.trim();
  return key && onGuardEngineOrigin(endpoint, env) ? key : null;
}

/** Whether `endpoint` sits on the configured guard engine's origin, exactly. */
function onGuardEngineOrigin(
  endpoint: string,
  env: Record<string, string | undefined>,
): boolean {
  const base = env.GUARD_ENGINE_BASE_URL?.trim();
  if (!base) return false;
  try {
    return new URL(endpoint).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export class ExternalEngine implements PolicyEngine {
  readonly name = 'external';

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDetection[]> {
    const endpoint = ctx.binding.externalEndpoint;
    if (!endpoint) {
      return this.handleError(ctx, 'No externalEndpoint configured on binding');
    }

    const timeout = ctx.binding.externalTimeout ?? 5000;
    const guardKey = guardEngineKeyFor(endpoint, process.env);
    const config = guardKey
      ? { ...(ctx.binding.config ?? {}), key: guardKey }
      : ctx.binding.config;
    const headers = { 'Content-Type': 'application/json' };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: ctx.content,
          policyId: ctx.binding.policyId,
          policySlug: ctx.binding.policySlug,
          ...(guardKey && ctx.agentId ? { agentId: ctx.agentId } : {}),
          config,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        return this.handleError(
          ctx,
          `External endpoint returned HTTP ${response.status}`,
        );
      }

      const body = await response.json();

      if (!Array.isArray(body)) {
        return this.handleError(
          ctx,
          'External endpoint returned non-array response',
        );
      }

      // Validate and normalize each detection
      return body
        .filter(
          (
            d: unknown,
          ): d is { type: string; confidence: number; message?: string } =>
            typeof d === 'object' &&
            d !== null &&
            typeof (d as Record<string, unknown>).type === 'string' &&
            typeof (d as Record<string, unknown>).confidence === 'number',
        )
        .map((d) => ({
          type: d.type,
          confidence: d.confidence,
          message: d.message,
        }));
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `External endpoint timed out after ${timeout}ms`
          : `External endpoint request failed: ${err instanceof Error ? err.message : String(err)}`;
      return this.handleError(ctx, message);
    }
  }

  private handleError(
    ctx: PolicyEvalContext,
    message: string,
  ): PolicyDetection[] {
    const behavior = ctx.binding.failBehavior ?? 'block';

    if (behavior === 'block') {
      return [
        {
          type: 'external-error',
          confidence: 1.0,
          message,
        },
      ];
    }

    if (behavior === 'warn') {
      console.warn(
        `[spellguard/external] ${message} (policy ${ctx.binding.policyId})`,
      );
    }

    return [];
  }
}
