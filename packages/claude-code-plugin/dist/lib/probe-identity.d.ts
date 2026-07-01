export type IdentityProbeResult = 'ok' | 'gone' | 'transient';
/**
 * Cheap server-side liveness check for the locally-stored identity, used by
 * /spellguard-setup BEFORE offering the existing-credential menu (I13).
 *
 * Local config can be stale: an agent deleted in the dashboard while this
 * machine was offline still has `revoked: false` on disk. Probing
 * `GET /v1/credentials/github/status` (the same endpoint session-start uses;
 * `requireAgentSecret` runs before any param handling, so a deleted agent is
 * 401 regardless of params) lets setup fall straight through to fresh
 * provisioning instead of offering a menu for a ghost.
 *
 * 404 ambiguity (do not "simplify" this): for an identity-only config there
 * is no scopedTokenId yet, so a 404 can mean "credential not found" for a
 * perfectly ALIVE agent. Therefore:
 * - config HAS scopedTokenId → 'gone' on 401/403/404/410
 * - identity-only config     → 'gone' on 401 ONLY
 * - network error / 5xx / anything else → 'transient' (never block setup on
 *   a blip — the menu path is the safe fallback)
 */
export declare function probeAgentIdentity(opts: {
    baseUrl: string;
    agentId: string;
    agentSecret: string;
    scopedTokenId?: string;
    fetchImpl?: typeof fetch;
}): Promise<IdentityProbeResult>;
