export interface MonitorTickDeps {
    fetchImpl?: typeof fetch;
    envFilePath?: string;
    scopeCachePath?: string;
    allowlistPath?: string;
}
export interface MonitorTickResult {
    status: 'valid' | 'near_expiry' | 'expired' | 'revoked' | 'superseded' | 'unknown';
    scopeRefreshed: boolean;
}
export declare function runMonitorTick(deps?: MonitorTickDeps): Promise<MonitorTickResult>;
