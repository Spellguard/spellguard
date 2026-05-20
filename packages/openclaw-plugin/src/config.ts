// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

const AgentIdSchema = z
  .string()
  .regex(
    /^[a-z0-9-]+$/,
    'Agent ID must be lowercase alphanumeric with hyphens',
  );

export const SpellguardConfigSchema = z
  .object({
    verifierUrl: z.string().url().optional(),
    managementUrl: z.string().url().optional(),
    selfUrl: z.string().url(),
    agentId: AgentIdSchema,
    codeHash: z.string().default('sha256:dev-placeholder'),
    expectedVerifierImageHash: z.string().default('sha384:dev-placeholder'),
    agentSecret: z.string().min(1).optional(),
    gatewayPort: z.number().optional().default(18789),
  })
  .refine((c) => c.verifierUrl || c.managementUrl, {
    message: 'Either verifierUrl or managementUrl must be provided',
  });

export type SpellguardConfig = z.infer<typeof SpellguardConfigSchema>;

export function loadConfig(raw: unknown): SpellguardConfig {
  return SpellguardConfigSchema.parse(raw);
}

/** Derive AgentCard from config (no user duplication needed). */
export function buildAgentCard(config: SpellguardConfig) {
  return {
    name: config.agentId,
    url: config.selfUrl,
    skills: [
      {
        id: 'spellguard',
        name: 'Spellguard',
        description: 'Auditable agent communication',
      },
    ],
  };
}
