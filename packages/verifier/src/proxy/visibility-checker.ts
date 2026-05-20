// SPDX-License-Identifier: Apache-2.0

export interface VisibilityEntry {
  entityType: 'agent' | 'org' | 'group';
  entityId: string;
}

export interface VisibilityData {
  isInternal: boolean;
  effectiveInternal: boolean;
  groups: Array<{ id: string; isInternal: boolean }>;
  allowlist: VisibilityEntry[];
  blocklist: VisibilityEntry[];
}

export interface SenderContext {
  agentId: string;
  organizationId: string;
  groupIds: string[];
}

export interface VisibilityResult {
  allowed: boolean;
  reason?: string;
}

function matchesEntry(sender: SenderContext, entry: VisibilityEntry): boolean {
  switch (entry.entityType) {
    case 'agent':
      return sender.agentId === entry.entityId;
    case 'org':
      return sender.organizationId === entry.entityId;
    case 'group':
      return sender.groupIds.includes(entry.entityId);
    default:
      console.warn(
        `[VisibilityChecker] Unknown entity type in visibility entry: ${(entry as VisibilityEntry).entityType}`,
      );
      return false;
  }
}

/**
 * Check whether a sender is allowed to discover/message a recipient
 * based on the recipient's visibility rules.
 *
 * Algorithm:
 * 1. Blocklist check (absolute precedence -- any match = denied)
 * 2. If recipient is not internal -> allowed
 * 3. If recipient is internal -> allowlist check (must match)
 */
export function checkVisibility(
  sender: SenderContext,
  recipientVisibility: VisibilityData,
): VisibilityResult {
  // Step 1: Blocklist check (absolute precedence)
  for (const entry of recipientVisibility.blocklist) {
    if (matchesEntry(sender, entry)) {
      return {
        allowed: false,
        reason: `Sender blocked by ${entry.entityType} blocklist entry`,
      };
    }
  }

  // Step 2: Not internal -> allow
  if (!recipientVisibility.effectiveInternal) {
    return { allowed: true };
  }

  // Step 3: Internal -> check allowlist
  for (const entry of recipientVisibility.allowlist) {
    if (matchesEntry(sender, entry)) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: 'Sender not on allowlist for internal agent',
  };
}
