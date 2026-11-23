// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

import { POLICY_TYPES } from '@spellguard/amp';
import type { PolicyType } from '@spellguard/amp';

type CatalogPolicyType = Exclude<PolicyType, 'external' | 'identity-claim'>;

function asNonEmptyTuple<T>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('The policy catalog requires at least one policy type');
  }
  return [first, ...rest];
}

const isCatalogPolicyType = (type: PolicyType): type is CatalogPolicyType =>
  type !== 'external' && type !== 'identity-claim';

const CATALOG_POLICY_TYPES = asNonEmptyTuple(
  POLICY_TYPES.filter(isCatalogPolicyType),
);

const ProvenanceSchema = z.object({
  source: z.string().min(1),
  dateAdded: z.string().min(1),
  reference: z.string().optional(),
});

const DefaultBindingSchema = z.object({
  direction: z.enum(['inbound', 'outbound', 'both']),
  effect: z.enum(['block', 'flag', 'rate_limit']),
  priority: z.number().int(),
  // Which mediation leg the default binding targets. Omitted → 'all', and
  // 'all' means ALL THREE legs: messages, tools AND model inference. The
  // Verifier's `filterByScope` applies one uniform rule, so an omitted scope
  // puts the policy in front of natural-language prompts as soon as an org
  // enables the LLM gateway — that is how outage #478 happened. Name the leg
  // you mean ('messages' / 'tools' / 'llm'); every `tool-*` entry is required
  // to say 'tools' by `tests/policy-catalog/tool-policy-scope-guard.test.ts`.
  scope: z.enum(['all', 'messages', 'tools', 'llm']).optional(),
});

export const CatalogEntrySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    type: z.enum(CATALOG_POLICY_TYPES),
    level: z.enum(['system', 'org']),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    failBehavior: z.enum(['block', 'allow', 'warn']).optional(),
    config: z.record(z.string(), z.unknown()),
    defaultBinding: DefaultBindingSchema.optional(),
    compliance: z.array(z.string()).optional(),
    provenance: ProvenanceSchema,
  })
  // `config.categories` is a two-state switch with a booby trap: engines read
  // `cfg.categories || ALL_CATEGORIES`, so OMITTING the key means "check every
  // category" — but an EMPTY ARRAY is truthy in JS and silently means "check
  // NOTHING". Those two look equivalent to a policy author and are opposites.
  // Reject `[]` so intent is always explicit: omit for all, or list the ones you
  // want. (`injection-web-payloads` shipped `categories: []` and disabled every
  // built-in injection category without anyone noticing.)
  .refine(
    (e) =>
      !(Array.isArray(e.config.categories) && e.config.categories.length === 0),
    {
      message:
        'config.categories must not be an empty array — OMIT the key to check all categories, or list at least one. An empty array silently disables every category.',
      path: ['config', 'categories'],
    },
  );

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogFileSchema = z.object({
  policies: z.array(CatalogEntrySchema).min(1),
});

export type CatalogFile = z.infer<typeof CatalogFileSchema>;
