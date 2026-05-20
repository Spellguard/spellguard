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
  managementUrl?: string;
  failOpen?: boolean;
  verifierTimeout?: number;
}
