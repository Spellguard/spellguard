export interface LogAllRefUpdatesResult {
    /** Whether to surface the warning to the user. */
    shouldWarn: boolean;
    /**
     * Optional reason for the chosen result. Useful for unit assertion and
     * structured logs; the renderMessage call site only uses shouldWarn.
     */
    reason: 'enabled' | 'disabled' | 'unset' | 'git-failed';
}
export declare function checkLogAllRefUpdates(cwd: string): LogAllRefUpdatesResult;
