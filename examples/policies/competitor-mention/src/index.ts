// SPDX-License-Identifier: Apache-2.0

import { BasePolicyEngine, servePolicyEngine } from '@spellguard/policy-sdk';
import type { Detection, PolicyRequest } from '@spellguard/policy-sdk';

class CompetitorMentionPolicy extends BasePolicyEngine {
  name = 'competitor-mention';

  evaluate(request: PolicyRequest): Detection[] {
    const detections: Detection[] = [];

    // Get competitors from config, or use defaults
    const competitors = this.getConfig<string[]>(request, 'competitors', [
      'openai',
      'anthropic',
      'google',
      'microsoft',
      'meta',
    ]);

    const blockMentions = this.getConfig<boolean>(
      request,
      'blockMentions',
      true,
    );
    const minConfidence = this.getConfig<number>(request, 'minConfidence', 0.8);

    // Check for competitor mentions
    const found = this.containsAny(request.content, competitors);

    if (found) {
      detections.push(
        this.detection(
          'competitor-mention',
          minConfidence,
          `Competitor "${found}" mentioned in content`,
          { competitor: found, action: blockMentions ? 'block' : 'flag' },
        ),
      );
    }

    return detections;
  }
}

const port = Number.parseInt(process.env.PORT || '3100');
servePolicyEngine(new CompetitorMentionPolicy(), { port });
