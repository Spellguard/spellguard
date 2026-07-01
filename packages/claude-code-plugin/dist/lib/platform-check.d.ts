export interface PlatformInfo {
    platform: NodeJS.Platform | string;
    release: string;
}
export interface PlatformCheckResult {
    ok: boolean;
    message?: string;
}
export declare function isPlatformSupported(info: PlatformInfo): PlatformCheckResult;
