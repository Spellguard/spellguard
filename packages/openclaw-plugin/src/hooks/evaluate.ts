// SPDX-License-Identifier: Apache-2.0

import { getConfig } from '@spellguard/client';
import { normalizeContent } from './normalizers/registry';
import type { HookConfig, HookEvaluateResult } from './types';

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

  const timeout = config.verifierTimeout ?? 5000;

  try {
    // The Verifier's /v1/mcp/evaluate endpoint requires a management-issued JWT
    // in the Authorization header (verified via MANAGEMENT_PUBLIC_KEY).
    // Prefer the Verifier URL discovered via the Spellguard client's
    // discoverAndConfigure() flow over the static hook config — the
    // discovered URL points to the actual Verifier, while the config may
    // point to the management server.
    const clientConfig = getConfig();
    const verifierUrl = clientConfig?.verifierUrl || config.verifierUrl;
    const url = `${verifierUrl}/v1/mcp/evaluate`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (clientConfig?.managementToken) {
      headers.Authorization = `Bearer ${clientConfig.managementToken}`;
    }

    // Normalize platform-specific markup to plain text before evaluation.
    // Slack has no normalizer registered — content passes through unchanged.
    const platform = context?.channel ?? '';
    const normalizedContent = normalizeContent(content, platform);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
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
