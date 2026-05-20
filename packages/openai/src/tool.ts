// SPDX-License-Identifier: Apache-2.0

/**
 * Spellguard-wrapped tool for OpenAI function-calling.
 *
 * The OpenAI SDK defines tools as JSON schemas and dispatches them
 * manually (unlike AI SDK's `tool()` helper). This wrapper wraps the
 * user-provided execute function with policy checks, matching the
 * same API shape as the AI SDK and LangChain wrappers.
 */

import { checkToolPolicy } from '@spellguard/client';

export interface SpellguardToolOptions<TArgs = unknown, TResult = unknown> {
  /** Tool name — used to identify the tool in policy checks. */
  name: string;
  /** Tool description (passed through to OpenAI). */
  description: string;
  /** JSON Schema for the tool parameters (passed through to OpenAI). */
  parameters: Record<string, unknown>;
  /** Execute function — receives parsed args, returns result. */
  execute: (args: TArgs) => Promise<TResult>;
}

export interface SpellguardToolDefinition<TArgs = unknown, TResult = unknown> {
  /** OpenAI tool definition for `tools: [...]` in chat.completions.create. */
  definition: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
  /** Policy-checked execute function. Call this in your tool dispatch. */
  execute: (args: TArgs) => Promise<TResult | string | null>;
}

/**
 * Create a Spellguard-wrapped OpenAI tool.
 *
 * Returns both the OpenAI tool definition (for the `tools` array) and
 * a wrapped execute function (for your dispatch switch/map).
 *
 * ```typescript
 * import { spellguardTool } from '@spellguard/openai';
 *
 * const getWeather = spellguardTool({
 *   name: 'getWeather',
 *   description: 'Get weather for a city',
 *   parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
 *   execute: async (args) => fetchWeather(args.city),
 * });
 *
 * // Pass definition to OpenAI
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o',
 *   tools: [getWeather.definition],
 *   messages,
 * });
 *
 * // Dispatch with policy checks
 * const result = await getWeather.execute(parsedArgs);
 * ```
 */
export function spellguardTool<TArgs = unknown, TResult = unknown>(
  options: SpellguardToolOptions<TArgs, TResult>,
): SpellguardToolDefinition<TArgs, TResult> {
  return {
    definition: {
      type: 'function',
      function: {
        name: options.name,
        description: options.description,
        parameters: options.parameters,
      },
    },
    execute: async (args: TArgs): Promise<TResult | string | null> => {
      try {
        const inp = await checkToolPolicy('input', options.name, args);
        if (inp.effect === 'block')
          return (inp.message ?? '[BLOCKED]') as TResult | string;
        if (inp.effect === 'redact')
          return (inp.message ?? '[BLOCKED]') as TResult | string;
      } catch {
        // Fail open
      }

      const result = await options.execute(args);

      try {
        const out = await checkToolPolicy('output', options.name, args, result);
        if (out.effect === 'block')
          return (out.message ?? '[BLOCKED]') as TResult | string;
        if (out.effect === 'redact')
          return (out.data ?? null) as TResult | null;
      } catch {
        // Fail open
      }

      return result;
    },
  };
}
