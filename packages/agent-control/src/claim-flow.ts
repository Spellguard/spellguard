// SPDX-License-Identifier: Apache-2.0

/**
 * Managed-provisioning claim-flow client.
 *
 * Sits on top of `AgentControlClient` and orchestrates the first-boot path
 * on a managed agent host (Lightsail instance / Railway service):
 *
 *   1. Detects env vars:
 *      - `SPELLGUARD_BOOTSTRAP_NONCE`  — single-use bootstrap nonce minted at
 *        Provision time (kind=`managed-provisioning`).
 *      - `SPELLGUARD_ENDPOINT`         — Spellguard API base URL (e.g.
 *        `https://console.spellguard.ai`).
 *      - `SPELLGUARD_AGENT_ID`         — the agent_id slug that
 *        `cloud-init` / start-script writes into the host environment. The
 *        server already created the agents row at provision time, so the
 *        client does NOT mint a new UUID here (unlike the browser-bootstrap
 *        path which is client-driven).
 *
 *   2. Extracts the instance fingerprint, in order:
 *      - Lightsail / AWS EC2: IMDS v1 at
 *        `http://169.254.169.254/latest/meta-data/instance-id` (no auth
 *        required, ~10 ms LAN-local fetch).
 *      - Railway: `RAILWAY_SERVICE_ID` env var (Railway exposes it in every
 *        service's runtime env).
 *      - Fallback: `unknown-${hostname()}-${Date.now()}` — the server
 *        accepts any value <=255 chars; the warning is for observability.
 *
 *   3. Opens the agent-control socket in `mode:'managed-bootstrap'` with:
 *      - URL `/v1/agent-control/channel/{agent_id}?nonce=<bootstrap_nonce>`
 *      - Header `X-Spellguard-Instance-Fingerprint: <fingerprint>`
 *
 *   4. Waits for `credential_delivered{cause:'bootstrap'}` from the server.
 *      The frame carries:
 *      - `agent_secret` (always)
 *      - `credentials: []` initially (the dashboard pushes follow-up
 *        `credential_delivered` frames once an admin configures provider
 *        credentials). An empty array is NOT an error — the client just
 *        persists the agent_secret + agent_id and keeps the socket open for
 *        the follow-up frames.
 *
 *   5. Persists `{agentId, agentSecret, spellguardBaseUrl}` to the same
 *      on-disk config the browser-bootstrap path writes (so the daemon
 *      and subsequent reconnects find it via the existing
 *      `~/.config/spellguard/config.json` path).
 *
 * Subsequent reconnects go through the existing `mode:'secret'` path with
 * `?agent_secret=` — see `AgentControlClient#buildProtocols`.
 */

import { hostname } from 'node:os';
import {
  AgentControlClient,
  type AgentControlClientOptions,
  type StartCredentials,
} from './client';
import {
  AGENT_CONTROL_CLOSE_CODES,
  type CredentialDeliveredFrame,
} from './protocol';

/** Header name the server reads on the upgrade request. */
export const INSTANCE_FINGERPRINT_HEADER =
  'X-Spellguard-Instance-Fingerprint' as const;

/** Max instance-fingerprint length the server accepts. */
export const INSTANCE_FINGERPRINT_MAX_LEN = 255;

/** Environment variables read on managed-provisioning first boot. */
export const ENV = {
  BOOTSTRAP_NONCE: 'SPELLGUARD_BOOTSTRAP_NONCE',
  ENDPOINT: 'SPELLGUARD_ENDPOINT',
  AGENT_ID: 'SPELLGUARD_AGENT_ID',
  RAILWAY_SERVICE_ID: 'RAILWAY_SERVICE_ID',
} as const;

/**
 * `true` when the managed-provisioning path applies on this boot.
 * Used by callers to decide between the managed-bootstrap path and the
 * existing browser-bootstrap path.
 */
export function shouldRunManagedBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = env[ENV.BOOTSTRAP_NONCE];
  return typeof v === 'string' && v.length > 0;
}

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
  frame: CredentialDeliveredFrame & { cause: 'bootstrap' };
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
export async function resolveInstanceFingerprint(
  opts: RunManagedBootstrapOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  // 1. Lightsail / AWS IMDS v1 (no auth required).
  const fetchInstanceId = opts.fetchInstanceId ?? defaultFetchInstanceId;
  try {
    const id = await fetchInstanceId();
    if (id && id.length > 0) return truncate(id, INSTANCE_FINGERPRINT_MAX_LEN);
  } catch {
    // Fall through to Railway / hostname.
  }

  // 2. Railway env var.
  const railwayId = env[ENV.RAILWAY_SERVICE_ID];
  if (typeof railwayId === 'string' && railwayId.length > 0) {
    return truncate(railwayId, INSTANCE_FINGERPRINT_MAX_LEN);
  }

  // 3. Fallback — observability warning + unique-per-boot value.
  const host = (opts.hostnameImpl ?? hostname)();
  const now = (opts.nowImpl ?? Date.now)();
  warn(
    'spellguard: instance fingerprint detection failed (no AWS IMDS, no RAILWAY_SERVICE_ID); using fallback. Server-side correlation will be best-effort.',
  );
  return truncate(`unknown-${host}-${now}`, INSTANCE_FINGERPRINT_MAX_LEN);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Default IMDS v1 fetcher. Times out at 1.5 s — IMDS is LAN-local and
 * typically replies in under 10 ms; a longer timeout would delay startup
 * on non-AWS hosts where the link-local IP times out at the TCP layer.
 *
 * Returns `null` on any failure (timeout, non-200, network error). The
 * caller treats `null` the same as a thrown error: fall through to the
 * next detection method.
 */
async function defaultFetchInstanceId(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(
      'http://169.254.169.254/latest/meta-data/instance-id',
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
export async function runManagedBootstrap(
  opts: RunManagedBootstrapOptions = {},
): Promise<ManagedBootstrapResult> {
  const env = opts.env ?? process.env;
  const nonce = env[ENV.BOOTSTRAP_NONCE];
  const endpoint = env[ENV.ENDPOINT];
  const agentId = env[ENV.AGENT_ID];

  if (!nonce) {
    throw new Error(
      `${ENV.BOOTSTRAP_NONCE} is required for managed-provisioning bootstrap`,
    );
  }
  if (!endpoint) {
    throw new Error(
      `${ENV.ENDPOINT} is required for managed-provisioning bootstrap`,
    );
  }
  if (!agentId) {
    throw new Error(
      `${ENV.AGENT_ID} is required for managed-provisioning bootstrap`,
    );
  }

  const instanceFingerprint = await resolveInstanceFingerprint(opts);
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return await new Promise<ManagedBootstrapResult>((resolve, reject) => {
    let settled = false;
    let client: AgentControlClient | null = null;

    const settle = (
      err: Error | null,
      result?: ManagedBootstrapResult,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else if (result) resolve(result);
    };

    const timer = setTimeout(() => {
      settle(
        new Error(
          `spellguard: managed-bootstrap timed out after ${Math.floor(timeoutMs / 1000)}s waiting for credential_delivered{cause:'bootstrap'}`,
        ),
      );
    }, timeoutMs);

    const credentials = (): StartCredentials => ({
      mode: 'managed-bootstrap',
      nonce,
    });

    client = new AgentControlClient({
      apiBaseUrl: endpoint,
      agentId,
      credentials,
      upgradeHeaders: { [INSTANCE_FINGERPRINT_HEADER]: instanceFingerprint },
      onCredentialDelivered: (frame: CredentialDeliveredFrame) => {
        if (frame.cause !== 'bootstrap') {
          // Stale replay / out-of-order; ignore — defensive only.
          return;
        }
        if (!frame.agent_secret) {
          settle(
            new Error(
              'spellguard: bootstrap frame missing agent_secret — server bug or out-of-date server version',
            ),
          );
          return;
        }
        // Per the provider-agnostic credential channel design, the bootstrap
        // frame carries the agent_secret + optional staged bootstrap provider
        // descriptors (Slack / Discord / Teams / model creds). This shared
        // claim-flow itself does NOT persist those descriptors — it only
        // resolves the secret + hands the frame back to the caller. Who
        // applies the staged descriptors is framework-specific:
        //   • Managed OpenClaw: the OpenClaw setup CLI
        //     (`openclaw-spellguard-setup.ts` → `applyBootstrapCredentials`)
        //     reads `frame` and writes credentials.json + merges openclaw.json
        //     before the daemon starts.
        //   • Claude Code / Codex / Hermes: DEFERRED — those agent types are
        //     not yet selectable in the provisioning wizard (greyed "soon"), so
        //     their clients ignore non-github descriptors gracefully for now.
        //     Full wiring + type-4 tests land when those types light up.
        // Steady-state provider credentials still flow later over the
        // long-lived agent-control-channel via `credential_delivered` frames
        // once the plugin's credential-service takes over.
        const bootstrapFrame = frame as CredentialDeliveredFrame & {
          cause: 'bootstrap';
        };
        settle(null, {
          agentId,
          agentSecret: frame.agent_secret,
          spellguardBaseUrl: endpoint,
          instanceFingerprint,
          frame: bootstrapFrame,
        });
      },
      onSeqAdvanced: () => {
        // No cursor persistence during first-run managed bootstrap — the
        // caller writes the config after we resolve. Subsequent reconnects
        // open a fresh secret-mode socket and the daemon's persistence
        // hooks take over.
      },
      onFatalClose: (code, reason) => {
        let label: string;
        switch (code) {
          case AGENT_CONTROL_CLOSE_CODES.BOOTSTRAP_ERROR:
            label = 'bootstrap_error';
            break;
          case AGENT_CONTROL_CLOSE_CODES.AUTH_FAILED:
            label = 'auth_failed';
            break;
          case AGENT_CONTROL_CLOSE_CODES.AGENT_OWNERSHIP:
            label = 'agent_ownership';
            break;
          default:
            label = `code_${code}`;
        }
        settle(
          new Error(
            `spellguard: managed-bootstrap channel closed (${label}${reason ? `: ${reason}` : ''})`,
          ),
        );
      },
      onError: (err) => {
        // Informational — the fatal path is onFatalClose. Server-emitted
        // `error` frames arrive here as a parsed Error from #dispatch.
        const msg = err.message ?? '';
        if (msg.includes('server:')) {
          settle(
            new Error(`spellguard: managed-bootstrap server error: ${msg}`),
          );
        }
        // Non-server errors are logged-only — the timeout covers stalls.
      },
      ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
    });

    client.start();
  });
}
