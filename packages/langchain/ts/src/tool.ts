// SPDX-License-Identifier: Apache-2.0

/**
 * Spellguard-wrapped LangChain tool.
 *
 * Wraps a DynamicStructuredTool so that input params and output results
 * are checked against Spellguard tool policies via the Verifier.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { checkToolPolicy } from '@spellguard/client';
import type { z } from 'zod';

/**
 * Create a Spellguard-wrapped LangChain tool.
 *
 * Input-phase redact is treated as block (cannot meaningfully redact input
 * before execution — same behavior as the AI SDK wrapper).
 */
export function spellguardTool<T extends z.ZodObject<z.ZodRawShape>>(options: {
  name: string;
  description: string;
  schema: T;
  func: (input: z.infer<T>) => Promise<string>;
}): DynamicStructuredTool<T> {
  return new DynamicStructuredTool<T>({
    name: options.name,
    description: options.description,
    schema: options.schema,
    func: async (input: z.infer<T>): Promise<string> => {
      try {
        const inp = await checkToolPolicy('input', options.name, input);
        if (inp.effect === 'block') return inp.message ?? '[BLOCKED]';
        if (inp.effect === 'redact') return inp.message ?? '[BLOCKED]';
      } catch {
        // Fail open
      }

      const result = await options.func(input);

      try {
        const out = await checkToolPolicy(
          'output',
          options.name,
          input,
          result,
        );
        if (out.effect === 'block') return out.message ?? '[BLOCKED]';
        if (out.effect === 'redact') return String(out.data ?? '');
      } catch {
        // Fail open
      }

      return result;
    },
  });
}
