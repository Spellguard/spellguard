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
}): DynamicStructuredTool<T, z.output<T>, z.input<T>> {
  // The input and output types are spelled out with zod's own inference.
  // LangChain's defaults go through its zod-interop types, which can't
  // resolve a zod 4 schema while T is still generic, so `func` below would
  // not type-check against them.
  return new DynamicStructuredTool<T, z.output<T>, z.input<T>>({
    name: options.name,
    description: options.description,
    schema: options.schema,
    // No catch around the checks (#1418): `checkToolPolicy` never throws and
    // fails closed unless `failOpen` is configured. A catch here that carried
    // on ran the tool, or returned its output, with no policy decision.
    func: async (input: z.infer<T>): Promise<string> => {
      const inp = await checkToolPolicy('input', options.name, input);
      if (inp.effect === 'block') return inp.message ?? '[BLOCKED]';
      if (inp.effect === 'redact') return inp.message ?? '[BLOCKED]';

      const result = await options.func(input);

      const out = await checkToolPolicy('output', options.name, input, result);
      if (out.effect === 'block') return out.message ?? '[BLOCKED]';
      if (out.effect === 'redact') return String(out.data ?? '');

      return result;
    },
  });
}
