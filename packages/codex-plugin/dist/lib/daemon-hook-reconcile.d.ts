import { type DaemonResult } from './daemon-spawn';
export declare const ACTIVE_HOOK_DEADLINE_MS = 750;
/**
 * Demand-driven daemon recovery for hooks that run during an active session.
 * Managed boxes stand down because the Go box daemon owns credential delivery.
 */
export declare function reconcileDaemonForActiveHook(args: {
    cwd: string;
    configDir?: string;
    isManagedBox?: () => boolean;
}): Promise<DaemonResult>;
