import { type AgentControlClientOptions } from './client';
import { type CredentialDeliveredFrame } from './protocol';
/** Header name the server reads on the upgrade request. */
export declare const INSTANCE_FINGERPRINT_HEADER: "X-Spellguard-Instance-Fingerprint";
/** Max instance-fingerprint length the server accepts. */
export declare const INSTANCE_FINGERPRINT_MAX_LEN = 255;
/** Environment variables read on managed-provisioning first boot. */
export declare const ENV: {
    readonly BOOTSTRAP_NONCE: "SPELLGUARD_BOOTSTRAP_NONCE";
    readonly ENDPOINT: "SPELLGUARD_ENDPOINT";
    readonly AGENT_ID: "SPELLGUARD_AGENT_ID";
    readonly RAILWAY_SERVICE_ID: "RAILWAY_SERVICE_ID";
};
/**
 * `true` when the managed-provisioning path applies on this boot.
 * Used by callers to decide between the managed-bootstrap path and the
 * existing browser-bootstrap path.
 */
export declare function shouldRunManagedBootstrap(env?: NodeJS.ProcessEnv): boolean;
export interface ManagedBootstrapResult {
    /** The agent_id slug echoed back to the caller (same as input). */
    agentId: string;
    /** The `agent_secret` issued by the server in the bootstrap frame. */
    agentSecret: string;
    /** Spellguard API base URL — what the daemon uses for reconnects. */
    spellguardBaseUrl: string;
    /** The instance fingerprint that was sent on the upgrade. */
    instanceFingerprint: string;
    /** The full bootstrap frame, in case the caller wants to inspect it. */
    frame: CredentialDeliveredFrame & {
        cause: 'bootstrap';
    };
}
export interface RunManagedBootstrapOptions {
    /**
     * Env var lookup — swappable for tests. Defaults to `process.env`.
     * Reads `SPELLGUARD_BOOTSTRAP_NONCE` + `SPELLGUARD_ENDPOINT` +
     * `SPELLGUARD_AGENT_ID` + `RAILWAY_SERVICE_ID`.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Override the IMDS fetcher. Defaults to a 1500 ms `fetch` against
     * `http://169.254.169.254/latest/meta-data/instance-id`. Tests pass a
     * stub that returns `null` to simulate "not on AWS".
     */
    fetchInstanceId?: () => Promise<string | null>;
    /**
     * Override the hostname helper for the fallback fingerprint. Defaults
     * to `os.hostname()`.
     */
    hostnameImpl?: () => string;
    /**
     * Override `Date.now` for deterministic fallback fingerprints in tests.
     */
    nowImpl?: () => number;
    /**
     * Logging hook for the IMDS-failed / Railway-missing warning.
     * Defaults to `console.warn`.
     */
    warn?: (msg: string) => void;
    /**
     * Passed straight through to `AgentControlClient`. Tests pass a
     * mock WebSocket class.
     */
    WebSocketImpl?: AgentControlClientOptions['WebSocketImpl'];
    /** Overall timeout waiting for the bootstrap frame. Defaults to 10 min. */
    timeoutMs?: number;
}
/**
 * Resolve the instance fingerprint following the priority order documented
 * in this module's header. Always returns a string; the fallback never
 * throws so the bootstrap upgrade can proceed even when neither detection
 * succeeds. Truncates to `INSTANCE_FINGERPRINT_MAX_LEN` characters.
 */
export declare function resolveInstanceFingerprint(opts?: RunManagedBootstrapOptions): Promise<string>;
/**
 * Open the agent-control socket on the managed-provisioning bootstrap path
 * and resolve with the `credential_delivered{cause:'bootstrap'}` payload.
 *
 * Contract:
 *   - `credentials: []` is the expected initial state (the dashboard pushes
 *     follow-up frames once an admin configures provider credentials). The
 *     promise resolves on the FIRST bootstrap frame — callers MUST persist
 *     `agent_secret` + `agent_id` and then either keep the socket open for
 *     follow-up frames or close it and let the daemon reconnect via
 *     `?agent_secret=`.
 *
 *   - The wrapper closes the client when it resolves so the caller can
 *     safely call e.g. `spawnDaemon` afterward without two sockets
 *     competing for the same channel.
 *
 *   - On any fatal close code (4400/4401/4403), rejects with a typed Error
 *     carrying the close code + reason verbatim.
 */
export declare function runManagedBootstrap(opts?: RunManagedBootstrapOptions): Promise<ManagedBootstrapResult>;
