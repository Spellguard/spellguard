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
     * Immutable `agents.id` UUID (set by the managed-provisioning claim flow).
     * Used as the stable identifier on emitted policy decision logs. May be
     * empty in standalone mode where no Spellguard backend has issued a UUID.
     */
    agentUuid?: string;
    managementUrl?: string;
    failOpen?: boolean;
    verifierTimeout?: number;
}
