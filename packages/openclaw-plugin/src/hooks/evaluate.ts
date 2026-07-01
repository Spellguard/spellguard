// SPDX-License-Identifier: Apache-2.0

import { getConfig } from '@spellguard/client';
import { getCachedAgentId } from '../credentials/agent-id-cache';
import { normalizeContent } from './normalizers/registry';
import type { HookConfig, HookEvaluateResult } from './types';

/**
 * Stream B: when the credential socket is active, observation/Verifier-eval
 * payloads should be tagged with the credential-store's agent_id so a
 * rotated or admin-reissued credential keeps the dashboard activity view
 * tied to the correct agent row. Falls back to the static config when the
 * cache is unprimed (legacy / observation-only deployments where the
 * credential service never started).
 *
 * The cache is primed by `createCredentialService().start()` and
 * invalidated by `stop()`; reading from it avoids a sync disk hit on every
 * before_dispatch / before_tool_call / message_sending hook invocation.
 */
function effectiveAgentId(fallback: string): string {
  return getCachedAgentId() ?? fallback;
}

export async function evaluateContent(
  config: HookConfig,
  content: string,
  direction: 'inbound' | 'outbound',
  context?: { channel?: string; tool?: string },
): Promise<HookEvaluateResult> {
  // OSS standalone mode (no management server): /v1/mcp/evaluate requires
  // a management-issued JWT we can't mint, so the call would 401 and the
  // catch below would fail-closed on every tool call. Skip the gateway
  // tool-guard entirely -- verifier-side local bindings still evaluate
  // /messages/send traffic, which is where bilateral policy enforcement
  // actually lives in standalone mode.
  if (!config.managementUrl) {
    return { result: 'unscanned', detections: [] };
  }

  // 5s was too tight: a real bot on a distant/constrained network (or the dev
  // verifier-proxy path) can exceed it on a healthy verifier, fail-closing a
  // working bot with "Verifier unreachable". 10s default tolerates that without
  // being slow to fail on a genuine outage; override via config.verifierTimeout.
  const timeout = config.verifierTimeout ?? 10_000;

  try {
    const clientConfig = getConfig();
    const verifierUrl = clientConfig?.verifierUrl || config.verifierUrl;
    const url = `${verifierUrl}/v1/mcp/evaluate`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (clientConfig?.managementToken) {
      headers.Authorization = `Bearer ${clientConfig.managementToken}`;
    }

    const platform = context?.channel ?? '';
    const normalizedContent = normalizeContent(content, platform);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // Send the slug (config.agentId) — the management-token JWT claim
        // is minted with `agent.agent_id` (slug) at proxy-connect.ts:121,
        // and the Verifier IDOR check at mcp-evaluate.ts:377 compares
        // claim ↔ body strictly. Sending the cached UUID returns 403
        // FORBIDDEN. The legacy `effectiveAgentId(config.agentId)` (cached
        // UUID) is kept for other consumers that need the credential-
        // store's identity pinning across rotations.
        agentId: config.agentId,
        direction,
        platform: context?.channel,
        content: [{ type: 'text', value: normalizedContent }],
        context: context ?? {},
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) throw new Error(`Verifier returned ${response.status}`);
    return (await response.json()) as HookEvaluateResult;
  } catch {
    if (config.failOpen) {
      return { result: 'unscanned', detections: [] };
    }
    return {
      result: 'block',
      detections: [
        {
          engine: 'spellguard-plugin',
          policy: 'fail-closed',
          confidence: 1.0,
          detail: 'Verifier unreachable',
        },
      ],
    };
  }
}
