// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { z } from 'zod';

const RequirementSchema = z.object({
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});

const FrameworkSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  publisher: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  logoUrl: z.string().optional(),
  version: z.string().optional(),
  requirements: z.array(RequirementSchema).min(1),
});

const FrameworksFileSchema = z.object({
  frameworks: z.array(FrameworkSchema).min(1),
});

export type ComplianceFramework = z.infer<typeof FrameworkSchema>;
export type ComplianceRequirement = z.infer<typeof RequirementSchema>;

export function loadComplianceFrameworks(
  filePath: string,
): ComplianceFramework[] {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseJsonc(raw);
  try {
    const validated = FrameworksFileSchema.parse(parsed);
    return validated.frameworks;
  } catch (err) {
    throw new Error(`Invalid compliance frameworks file: ${filePath}`, {
      cause: err,
    });
  }
}

export interface ComplianceLookupEntry {
  frameworkId: string;
  title: string;
}

export function buildComplianceLookup(
  frameworks: ComplianceFramework[],
): Map<string, ComplianceLookupEntry> {
  const lookup = new Map<string, ComplianceLookupEntry>();
  for (const fw of frameworks) {
    for (const req of fw.requirements) {
      lookup.set(req.identifier, {
        frameworkId: fw.id,
        title: req.title,
      });
    }
  }
  return lookup;
}
