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
    /** Spellguard API base URL — used by the credential socket. */
    spellguardBaseUrl: z.string().url().optional(),
    selfUrl: z.string().url(),
    agentId: AgentIdSchema,
    /**
     * Immutable `agents.id` UUID populated by the managed-provisioning
     * claim flow (Task 11). Optional in OSS standalone mode where no
     * management server has issued a UUID.
     */
    agentUuid: z.string().uuid().optional(),
    codeHash: z.string().default('sha256:dev-placeholder'),
    expectedVerifierImageHash: z.string().default('sha384:dev-placeholder'),
    /**
     * before_dispatch Verifier-evaluate timeout (ms). Optional; the hook
     * defaults to 10s. Raise it on slow/proxied verifier paths (e.g. a
     * managed bot reaching the verifier through a dev tunnel) so a healthy
     * but slow round-trip doesn't fail-closed with "Verifier unreachable".
     */
    verifierTimeout: z.number().int().positive().optional(),
    /**
     * @deprecated since Stream B — replaced by the credential socket. Will be
     * removed in two minor releases. Run `openclaw spellguard setup` to
     * migrate.
     */
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
