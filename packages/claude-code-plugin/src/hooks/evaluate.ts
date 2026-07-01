// SPDX-License-Identifier: Apache-2.0

/**
 * Policy evaluation hook.
 *
 * This module does NOT perform runtime URL discovery — it receives its
 * Verifier URL through the static `HookConfig.verifierUrl` threaded from the
 * bootstrap flow, which avoids a cross-package dependency and keeps the
 * published plugin lean.
 */

import { emitPolicyDecision, toVerdict } from '../policy/decision-log';
import { normalizeContent } from './normalizers/registry';
import type { HookConfig, HookEvaluateResult } from './types';

/**
 * Emit a single `spellguard.policy.decision` log line for `result` and
 * return the result unchanged. Centralizes the emission call so every
 * verdict-producing path in `evaluateContent` logs exactly once.
 */
function logAndReturn(
  config: HookConfig,
  result: HookEvaluateResult,
  fallbackEngine: string,
  fallbackReason: string,
): HookEvaluateResult {
  const primary = result.detections[0];
  emitPolicyDecision({
    agent_uuid: config.agentUuid ?? '',
    agent_id: config.agentId,
    verdict: toVerdict(result.result),
    engine: primary?.engine ?? fallbackEngine,
    reason: primary?.detail ?? fallbackReason,
    timestamp: new Date().toISOString(),
  });
  return result;
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
    return logAndReturn(
      config,
      { result: 'unscanned', detections: [] },
      'spellguard-plugin',
      'standalone-mode: gateway tool-guard skipped',
    );
  }

  const timeout = config.verifierTimeout ?? 5000;

  try {
    const url = `${config.verifierUrl}/v1/mcp/evaluate`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

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
    const verifierResult = (await response.json()) as HookEvaluateResult;
    return logAndReturn(
      config,
      verifierResult,
      'spellguard-plugin',
      `verifier-decision: ${verifierResult.result}`,
    );
  } catch {
    if (config.failOpen) {
      return logAndReturn(
        config,
        { result: 'unscanned', detections: [] },
        'spellguard-plugin',
        'fail-open: Verifier unreachable',
      );
    }
    return logAndReturn(
      config,
      {
        result: 'block',
        detections: [
          {
            engine: 'spellguard-plugin',
            policy: 'fail-closed',
            confidence: 1.0,
            detail: 'Verifier unreachable',
          },
        ],
      },
      'spellguard-plugin',
      'fail-closed: Verifier unreachable',
    );
  }
}
