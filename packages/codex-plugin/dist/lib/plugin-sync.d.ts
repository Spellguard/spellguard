/**
 * Canonical framework slug for the WIRE/DB (`agents.framework`) — distinct from
 * the on-disk path slug in `framework-slug.ts`. Shared by both the startup
 * plugin-sync AND the bootstrap_request frame so the value the server records
 * at creation matches what plugin-sync reconciles to.
 */
export declare const FRAMEWORK = "codex";
export declare function syncFrameworkIdentity(options: {
    agentId: string;
    managementUrl: string;
    agentSecret: string;
}): Promise<void>;
