// SPDX-License-Identifier: Apache-2.0

/**
 * Spellguard SDK for building external policy servers.
 *
 * @example
 * ```typescript
 * import { BasePolicyEngine, servePolicyEngine } from '@spellguard/policy-sdk';
 *
 * class MyPolicy extends BasePolicyEngine {
 *   name = 'my-policy';
 *
 *   evaluate(request) {
 *     const detections = [];
 *     if (request.content.includes('badword')) {
 *       detections.push(this.detection('badword', 0.9, 'Found bad word'));
 *     }
 *     return detections;
 *   }
 * }
 *
 * servePolicyEngine(new MyPolicy(), { port: 3100 });
 * ```
 */

// Types
export type {
  Detection,
  PolicyRequest,
  PolicyResponse,
  PolicyEngine,
  ServerConfig,
} from './types';

// Base engine class
export { BasePolicyEngine } from './engine';

// Server utilities
export {
  createPolicyApp,
  createPolicyServer,
  servePolicyEngine,
} from './server';
