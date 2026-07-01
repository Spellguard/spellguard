import type { HookConfig, HookEvaluateResult } from './types';
export declare function evaluateContent(config: HookConfig, content: string, direction: 'inbound' | 'outbound', context?: {
    channel?: string;
    tool?: string;
}): Promise<HookEvaluateResult>;
