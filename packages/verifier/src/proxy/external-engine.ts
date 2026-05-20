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
 *   - failBehavior: what to do on error ('allow' | 'block' | 'warn', default 'allow')
 */

import type {
  PolicyDetection,
  PolicyEngine,
  PolicyEvalContext,
} from './policy-evaluator-types';

export class ExternalEngine implements PolicyEngine {
  readonly name = 'external';

  async evaluate(ctx: PolicyEvalContext): Promise<PolicyDetection[]> {
    const endpoint = ctx.binding.externalEndpoint;
    if (!endpoint) {
      return this.handleError(ctx, 'No externalEndpoint configured on binding');
    }

    const timeout = ctx.binding.externalTimeout ?? 5000;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: ctx.content,
          policyId: ctx.binding.policyId,
          policySlug: ctx.binding.policySlug,
          config: ctx.binding.config,
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
    const behavior = ctx.binding.failBehavior ?? 'allow';

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
