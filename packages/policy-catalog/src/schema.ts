// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

const CATALOG_POLICY_TYPES = [
  'builtin',
  'regex',
  'dsl',
  'keyword',
  'schema',
  'contains',
  'time-window',
  'code',
  'toxicity',
  'nsfw-blocker',
  'topic-boundary',
  'injection',
  'secrets',
  'url',
  'loop',
  'exfiltration',
  'financial-disclaimer',
  'phi-guardian',
  'action-allowlist',
  'privilege-escalation',
  'citation-enforcer',
  'self-harm-prevention',
  'path-traversal',
  'path-sandbox',
  'command-allowlist',
  'argument-injection',
  'sandbox-escape',
  'ssrf',
  'scheme-allowlist',
  'flow-exfiltration',
  'network-injection-scan',
  'query-injection',
  'ddl-block',
  'write-block',
  'recipient-allowlist',
  'output-risk-scan',
  'sequence-gate',
  'scope-isolation',
  'payload-size-limit',
  'memory-injection-scan',
  'input-injection-scan',
  'invocation-rate-limit',
  'irreversible-gate',
  'output-size-limit',
  'data-flow-taint',
] as const;

const ProvenanceSchema = z.object({
  source: z.string().min(1),
  dateAdded: z.string().min(1),
  reference: z.string().optional(),
});

const DefaultBindingSchema = z.object({
  direction: z.enum(['inbound', 'outbound', 'both']),
  effect: z.enum(['block', 'flag', 'rate_limit']),
  priority: z.number().int(),
});

export const CatalogEntrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(CATALOG_POLICY_TYPES),
  level: z.enum(['system', 'org']),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  failBehavior: z.enum(['block', 'allow', 'warn']).optional(),
  config: z.record(z.unknown()),
  defaultBinding: DefaultBindingSchema,
  compliance: z.array(z.string()).optional(),
  provenance: ProvenanceSchema,
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogFileSchema = z.object({
  policies: z.array(CatalogEntrySchema).min(1),
});

export type CatalogFile = z.infer<typeof CatalogFileSchema>;
