// SPDX-License-Identifier: Apache-2.0

import { generateText as originalGenerateText } from 'ai';
import type { LanguageModel } from 'ai';
import { modelIdOf, reportAiSdkUsage } from './usage-telemetry';

/**
 * Model to use for intent detection.
 * Should be a fast, cheap model for analyzing prompts.
 */
let intentDetectionModel: LanguageModel | null = null;

/**
 * Raw detect function set by adapter packages (openai, langchain).
 * Takes priority over the AI SDK intentDetectionModel when set.
 */
let intentDetectFn: ((prompt: string) => Promise<string[]>) | null = null;

/**
 * Set the model to use for intent detection.
 * Should be a fast, low-latency model — small/haiku-tier or GPT-4o-mini class.
 */
export function setIntentDetectionModel(model: LanguageModel): void {
  intentDetectionModel = model;
}

/**
 * Set a raw detect function for agent-reference detection.
 * Used by adapter packages (@spellguard/openai, @spellguard/langchain)
 * so they can use their native SDK for detection without requiring
 * AI SDK dependencies.
 */
export function setIntentDetectFn(
  fn: (prompt: string) => Promise<string[]>,
): void {
  intentDetectFn = fn;
}

/**
 * Get the configured intent detection model.
 */
export function getIntentDetectionModel(): LanguageModel {
  if (!intentDetectionModel) {
    throw new Error(
      'Intent detection model not configured. Call setIntentDetectionModel() first.',
    );
  }
  return intentDetectionModel;
}

/**
 * System prompt for agent-reference intent detection.
 * Shared between the ai-sdk and LangChain integrations.
 */
export const AGENT_DETECTION_SYSTEM_PROMPT = `You analyze prompts to detect references to other AI agents.
Extract agent names/identifiers mentioned in the prompt.
Return ONLY a JSON array of agent IDs (lowercase, hyphenated), or empty array if none.

Rules:
- Agent names often follow patterns like "Agent X", "agent-x", "the X agent"
- Convert to lowercase with hyphens: "Agent B" → "agent-b"
- Only extract explicit agent references, not general mentions of agents
- If unsure, return empty array

Examples:
- "get data from Agent B" → ["agent-b"]
- "ask the analytics-agent to process this" → ["analytics-agent"]
- "have Agent C and Agent D collaborate" → ["agent-c", "agent-d"]
- "hello world" → []
- "I need an agent to help me" → []
- "send this to the report-generator" → ["report-generator"]`;

/**
 * Detect agent references in a natural language prompt.
 * Uses AI to understand the user's intent and extract agent names.
 *
 * Examples:
 *   "analyze data from Agent B" → ["agent-b"]
 *   "ask Agent C and Agent D about X" → ["agent-c", "agent-d"]
 *   "what's 2+2?" → []
 *   "get the report from the analytics-agent" → ["analytics-agent"]
 */
export async function detectAgentReferences(prompt: string): Promise<string[]> {
  // 1. Custom detect function (set by adapter packages)
  if (intentDetectFn) {
    try {
      const result = await intentDetectFn(prompt);
      if (result.length > 0) return result;
    } catch (error) {
      console.warn(
        `[Intent] Custom detect function failed, falling back to pattern matching: ${error}`,
      );
    }
    return detectAgentReferencesPattern(prompt);
  }

  // 2. AI SDK model (set by setIntentDetectionModel)
  if (intentDetectionModel) {
    try {
      const analysis = await originalGenerateText({
        model: intentDetectionModel,
        system: AGENT_DETECTION_SYSTEM_PROMPT,
        prompt: prompt,
        maxTokens: 100,
      });

      // (§6.1): the intent-detection call is a real (small)
      // inference billed to the org — emit its usage. Already awaited above, so
      // this is a pure additive read; fire-and-forget + fail-open.
      const intentModelId = (analysis as { response?: { modelId?: string } })
        .response?.modelId;
      reportAiSdkUsage(
        analysis.usage,
        intentModelId ?? modelIdOf(intentDetectionModel),
      );

      const text = analysis.text.trim();
      const jsonMatch = text.match(/\[.*\]/s);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as string[];
        if (result.length > 0) return result;
      }
    } catch (error) {
      console.warn(`[Intent] Failed to detect agent references: ${error}`);
    }
    // AI returned empty or failed — fall through to pattern matching
    return detectAgentReferencesPattern(prompt);
  }

  // 3. Pattern matching fallback
  return detectAgentReferencesPattern(prompt);
}

/**
 * Pattern-based fallback for agent reference detection.
 * Less accurate than LLM but works without API calls.
 */
function detectAgentReferencesPattern(prompt: string): string[] {
  const agents: string[] = [];
  const lowerPrompt = prompt.toLowerCase();

  // Pattern: "Agent X" or "agent X"
  const agentPattern = /agent[\s-]([a-z0-9]+)/gi;
  for (const match of lowerPrompt.matchAll(agentPattern)) {
    const agentName = `agent-${match[1].toLowerCase()}`;
    if (!agents.includes(agentName)) {
      agents.push(agentName);
    }
  }

  // Pattern: "the X-agent" or "X-agent"
  const suffixPattern = /(?:the\s+)?([a-z0-9]+)-agent/gi;
  for (const match of lowerPrompt.matchAll(suffixPattern)) {
    const agentName = `${match[1].toLowerCase()}-agent`;
    if (!agents.includes(agentName)) {
      agents.push(agentName);
    }
  }

  // Pattern: "@agent-name" explicit mention
  const atMentionPattern = /@([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)/gi;
  for (const match of lowerPrompt.matchAll(atMentionPattern)) {
    const agentName = match[1].toLowerCase();
    if (!agents.includes(agentName)) {
      agents.push(agentName);
    }
  }

  // Pattern: kebab-case names that look like agents
  const kebabPattern =
    /(?:from|to|ask|tell|consult|send\s+to|get\s+from)\s+@?([a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)/gi;
  for (const match of lowerPrompt.matchAll(kebabPattern)) {
    const agentName = match[1].toLowerCase();
    if (!agents.includes(agentName)) {
      agents.push(agentName);
    }
  }

  return agents;
}

/**
 * Check if a prompt contains any agent references.
 * Faster than full detection - useful for early filtering.
 */
export function mightContainAgentReference(prompt: string): boolean {
  const lowerPrompt = prompt.toLowerCase();

  // Quick checks for common patterns
  if (/@[a-z0-9]+-[a-z0-9]/i.test(lowerPrompt)) return true;
  if (/agent[\s-][a-z0-9]/i.test(lowerPrompt)) return true;
  if (/[a-z0-9]+-agent/i.test(lowerPrompt)) return true;
  if (/(?:from|to|ask|tell|consult)\s+@?[a-z0-9]+-[a-z0-9]/i.test(lowerPrompt))
    return true;

  return false;
}
