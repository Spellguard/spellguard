import type { SpawnOptions } from 'node:child_process';
import { type AgentControlClientOptions, type CredentialDescriptor, type GithubCredentialDescriptor } from '@spellguard/agent-control';
import { type DaemonResult } from '../lib/daemon-spawn';
import { ensureSqliteBackend } from '../lib/sqlite-self-install';
/**
 * Poll GET /v1/bootstrap/channel-token/:nonce until the dashboard-side
 * /bootstrap/context call has minted the HMAC-signed channel token, then
 * return the pair the plugin needs to open the production WebSocket.
 *
 * The bootstrap WS route requires ?ct=&userId= when
 * BOOTSTRAP_CHANNEL_SECRET is set (production). The plugin has no way to
 * acquire those server-side, so it polls the endpoint every 2 s up to
 * 10 minutes.
 *
 * Exported for unit testing.
 */
export declare function pollChannelToken(apiBaseUrl: string, nonce: string, opts?: {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    maxAttempts?: number;
    fetchImpl?: typeof fetch;
}): Promise<{
    channelToken: string;
    userId: string;
    /** Real org ID returned by the server. Always present — the lobby
     *  validates ?orgId= against organization_members. */
    orgId: string;
    agentName: string;
    reason?: string;
    /** C9: bound EXISTING agent UUID on a select-existing reattach. When present,
     *  the channel MUST be opened with THIS id (not the locally-generated one) or
     *  the lobby's attach-upgrade rejects the URL/bound mismatch with a 401. */
    agentId?: string;
}>;
/**
 * Record this plugin's initiating framework on the freshly-minted nonce so the
 * dashboard's "select existing agent" door can scope its list to same-framework
 * agents (P2-T7 / D17, FR-7). Best-effort: the framework drives ONLY the
 * select-existing affordance; a failure here must NOT block the create-new
 * bootstrap path (the dashboard simply shows the empty/create-new fallback).
 *
 * @internal Exported for unit testing.
 */
export declare function registerInitiatingFramework(baseUrl: string, nonce: string, opts?: {
    fetchImpl?: typeof fetch;
}): Promise<void>;
/**
 * Menu choices.
 * 1 — print current identity and exit cleanly (no provisioning)
 * 2 — provision additional agent (browser flow; new row, existing config stays)
 * 3 — re-authorize (current replacement path; new config overwrites existing)
 */
export type ExistingConfigChoice = 'print_identity' | 'provision_additional' | 'reauthorize';
export declare function promptExistingConfigChoice(opts: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    promptFn?: (question: string) => Promise<string>;
}): Promise<ExistingConfigChoice>;
/**
 * Validate a `credential_delivered` frame and pull
 * out the GitHub credential + device token. Extracted from the main setup
 * flow so `runSpellguardSetup` stays under the cognitive-complexity budget
 * and so the structural validation has its own focused unit-test surface.
 *
 * Returns flattened fields rather than the descriptor itself so callers
 * don't need a non-null assertion on `scoped_token` (which the helper has
 * already verified is present).
 *
 * @internal Exported for unit testing only. Production callers should not
 * import this — use `runSpellguardSetup` instead.
 */
export type ExtractedBootstrapIdentity = {
    ok: true;
    agentSecret: string;
    ghCred?: GithubCredentialDescriptor;
} | {
    ok: false;
    reason: 'malformed_credentials_array' | 'missing_agent_secret';
    message: string;
};
/**
 * @internal Exported for unit testing only.
 *
 * Extract the bootstrap identity (agent_secret) from the bootstrap delivery
 * frame. A GitHub credential descriptor MAY also be present — this is the
 * legacy bootstrap-bundled path — and is returned alongside the identity for
 * the caller to persist. When absent (the default), the caller
 * writes the minimal identity-only config and the persistent credential
 * daemon will pick up the GitHub credential later when it arrives via a
 * dedicated `credential_delivered` frame.
 *
 * Defends against two malformed-response classes:
 *   1. `credentials` is not an array (wire-level corruption).
 *   2. Missing `agent_secret` on the bootstrap envelope (the server always
 *      sets it; absence means an out-of-date server build).
 */
export declare function extractBootstrapIdentity(frame: {
    credentials: ReadonlyArray<CredentialDescriptor>;
    agent_secret?: string;
}): ExtractedBootstrapIdentity;
export interface SetupArgs {
    baseUrl?: string;
    /**
     * Override the WebSocket implementation used by AgentControlClient.
     * Preserved for backward compatibility with tests that pass it; forwarded
     * to AgentControlClientOptions.WebSocketImpl.
     */
    WebSocketImpl?: AgentControlClientOptions['WebSocketImpl'];
    /** Called each progress tick with elapsed seconds (test seam). */
    onProgress?: (elapsedSeconds: number) => void;
    /** Progress tick interval in ms (default 30 s). */
    intervalMs?: number;
    /** Test seam: override fetch for the channel-token poll. */
    fetchImpl?: typeof fetch;
    /** Test seam: override poll interval. */
    pollIntervalMs?: number;
    /** Test seam: cap poll attempts. */
    pollMaxAttempts?: number;
    /**
     * Override the three-way menu prompt for tests. When provided, the
     * setup flow does NOT read from stdin and instead calls this resolver.
     * Production callers leave this undefined and the skill uses `readline`.
     */
    existingConfigChoice?: () => Promise<ExistingConfigChoice>;
    /**
     * Override the agent UUID generated for the bootstrap. Useful in
     * integration tests so the caller can pass a pre-seeded agent UUID. When
     * omitted, a new UUIDv4 is generated via `crypto.randomUUID()`.
     */
    agentIdOverride?: string;
    /**
     * Test seam — forwarded to `ensureCredentialDaemonRunning`. Production
     * callers leave this undefined (detached `child_process.spawn` + unref).
     */
    spawnDaemon?: (execPath: string, args: string[], opts: SpawnOptions) => void;
    /**
     * Test seam — PID-file directory for the daemon spawn. Defaults to the
     * real config dir.
     */
    daemonConfigDir?: string;
    /**
     * How long to wait (ms) for the GitHub credential to land on disk after
     * the daemon is started. The dashboard wizard's "Connect GitHub" step
     * usually completes within a minute or two of bootstrap, so waiting lets
     * setup end with positive confirmation instead of a promise. `0` disables
     * the wait. Default: 5 minutes. Timing out is NOT a failure — identity
     * bootstrap already succeeded and the daemon keeps listening.
     */
    credentialWaitMs?: number;
    /** Poll interval for the credential wait (default 2 s). */
    credentialPollIntervalMs?: number;
    /**
     * Test seam — stale-daemon stop performed right before the new config is
     * written. Defaults to `stopLocalDaemons` (pidfile-driven SIGTERM).
     */
    stopDaemons?: (opts?: {
        configDir?: string;
    }) => number[];
}
export interface SetupResult {
    ok: boolean;
    reason?: string;
    /**
     * Outcome of the credential-daemon start attempt. The daemon is the sole
     * consumer of channel-delivered credentials; setup MUST leave one running
     * (2026-06-11 incident: it didn't, and the pushed GitHub credential had no
     * consumer until the next session boundary).
     */
    daemon?: DaemonResult;
    /**
     * Where the GitHub credential stood when setup returned:
     * - 'bundled'   — legacy server shipped it inside the bootstrap frame;
     * - 'delivered' — the daemon wrote it to disk during the bounded wait;
     * - 'pending'   — not yet delivered; the daemon keeps listening and the
     *                 credential lands the moment the dashboard GitHub-App
     *                 install completes.
     */
    githubCredential?: 'delivered' | 'pending' | 'bundled';
}
export declare function runSpellguardSetup(args?: SetupArgs): Promise<SetupResult>;
/**
 * Make sure the local per-line code-attribution store has a usable SQLite
 * backend, self-installing `better-sqlite3` (prebuilt binary, no compile) into
 * the plugin root when none is present. Fully best-effort: any failure prints
 * a friendly "attribution will be degraded" note and returns — it must never
 * fail `/spellguard-setup`.
 *
 * @internal Exported for unit testing.
 */
export declare function ensureAttributionBackend(opts?: {
    ensure?: typeof ensureSqliteBackend;
}): Promise<void>;
