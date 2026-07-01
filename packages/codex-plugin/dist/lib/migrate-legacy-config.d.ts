/**
 * One-time migration of a legacy single-slot `<root>/config.json` (pre
 * per-framework isolation, B1) into THIS framework's subdir
 * (`<root>/<framework>/`). Without it, an upgraded machine reads the new
 * framework path and looks unconfigured even though its identity is on disk.
 *
 * MOVE, never copy — a copied identity would leave the same agentId/agentSecret
 * live in two slots (two daemons, one secret), worse than the bug it fixes.
 *
 * Decision: when BOTH frameworks are installed, the FIRST to start after upgrade
 * claims the legacy identity (writes the shared `.migrated` marker); the other
 * starts empty and must re-run setup. Rare, and the legacy identity belonged to
 * whatever was last set up. The marker lives at the SHARED root so both
 * frameworks see it — a second framework's start (or a second call) is a no-op.
 *
 * Best-effort and idempotent; never overwrites a framework that already has its
 * own config.json (that framework's legacy config is left for an as-yet-empty
 * framework to claim later).
 *
 * NOTE: byte-identical to `packages/claude-code-plugin/src/lib/migrate-legacy-config.ts`
 * — keep the two mirrored (verify-codex-claude-parity).
 */
export interface MigrateLegacyConfigResult {
    migrated: boolean;
    reason: 'migrated' | 'already-migrated' | 'no-legacy-config' | 'framework-already-configured' | 'move-failed';
}
export declare function migrateLegacyConfig(opts?: {
    legacyDir?: string;
    frameworkDir?: string;
    /** Injectable for tests; defaults to `stopLocalDaemons({ configDir })`. */
    stopLegacyDaemons?: (dir: string) => void;
}): MigrateLegacyConfigResult;
