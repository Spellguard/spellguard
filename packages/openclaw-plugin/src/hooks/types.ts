// SPDX-License-Identifier: Apache-2.0

export interface HookEvaluateResult {
  result: 'allow' | 'block' | 'flag' | 'unscanned';
  detections: Array<{
    engine: string;
    policy: string;
    confidence: number;
    detail: string;
  }>;
}

export interface HookConfig {
  verifierUrl: string;
  agentId: string;
  /**
   * Immutable `agents.id` UUID (set by the managed-provisioning claim flow,
   * Task 11). Used as the stable identifier on emitted policy decision
   * logs. May be empty in OSS standalone mode where no management server
   * has issued a UUID.
   */
  agentUuid?: string;
  managementUrl?: string;
  failOpen?: boolean;
  verifierTimeout?: number;
}
