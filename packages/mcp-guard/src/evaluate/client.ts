// SPDX-License-Identifier: Apache-2.0

import type { AuthClient } from '../auth/client';
import type {
  EvaluateBatchRequest,
  EvaluateBatchResponse,
  EvaluateRequest,
  EvaluateResponse,
} from '../types';

export class EvaluateClient {
  constructor(
    private authClient: AuthClient,
    private options: { failOpen: boolean; timeout: number },
  ) {}

  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    try {
      const verifierUrl = this.authClient.getVerifierUrl();
      const token = this.authClient.getToken();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeout);

      const res = await fetch(`${verifierUrl}/v1/mcp/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          `Verifier evaluate failed (${res.status}): ${JSON.stringify(body)}`,
        );
      }

      return (await res.json()) as EvaluateResponse;
    } catch (err) {
      return this.handleError(err);
    }
  }

  async evaluateBatch(
    request: EvaluateBatchRequest,
  ): Promise<EvaluateBatchResponse> {
    try {
      const verifierUrl = this.authClient.getVerifierUrl();
      const token = this.authClient.getToken();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeout);

      const res = await fetch(`${verifierUrl}/v1/mcp/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Verifier batch evaluate failed (${res.status})`);
      }

      return (await res.json()) as EvaluateBatchResponse;
    } catch (err) {
      // In fail-open mode, return all-allow for batch
      if (this.options.failOpen) {
        console.warn(
          '[mcp-guard] Verifier unreachable (fail-open), unscanned batch:',
          err,
        );
        return {
          results: request.messages.map((msg) => ({
            messageId: msg.messageId,
            result: 'unscanned' as const,
            detections: [],
            redactions: [],
          })),
        };
      }
      throw err;
    }
  }

  private handleError(err: unknown): EvaluateResponse {
    if (this.options.failOpen) {
      console.warn(
        '[mcp-guard] Verifier unreachable (fail-open), unscanned:',
        err,
      );
      return { result: 'unscanned', detections: [], redactions: [] };
    }
    // Fail-closed: return block
    const message = err instanceof Error ? err.message : 'Verifier unreachable';
    return {
      result: 'block',
      detections: [
        {
          engine: 'mcp-guard',
          policy: 'verifier-unreachable',
          confidence: 1.0,
          detail: `Spellguard Verifier unreachable — tool call blocked for safety. ${message}`,
        },
      ],
      redactions: [],
    };
  }
}
