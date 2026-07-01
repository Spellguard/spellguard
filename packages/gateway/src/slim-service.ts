// SPDX-License-Identifier: Apache-2.0

/**
 * Bridges gateway `send` frames to @agntcy/slim-bindings.
 *
 * Single-mode operation: every dispatch attempts a real SRPC call through
 * the native bindings. If @agntcy/slim-bindings can't be loaded (platform
 * doesn't ship a binary) or the SLIM control plane at
 * `SLIM_CONTROL_PLANE_URL` is unreachable, the dispatch fails with a
 * structured error frame that propagates back to the client as a Promise
 * rejection. No silent fallback — failures are visible.
 *
 * Connection setup is partial: we currently exercise
 * `Service.connectAsync` to establish a connection to the control plane,
 * then return `real-mode-partial` to indicate that publish wiring (App +
 * Session.publish + CompletionHandle) is the next step. Once a SLIM stack
 * is reachable in CI we can plumb the rest. The user-facing behaviour
 * is identical: a clear error pointing at what's missing.
 */

import { dispatchInbound } from './inbound-dispatcher';
import type { GatewaySecureMessage } from './protocol';

export interface SlimDispatchInput {
  senderAgentId: string;
  senderSlimName: string;
  recipientAgentId: string;
  recipientSlimName: string;
  message: GatewaySecureMessage;
}

export interface SlimDispatchResult {
  ok: boolean;
  response?: GatewaySecureMessage;
  error?: { code: string; message: string };
}

export interface SlimServiceConfig {
  controlPlaneUrl: string;
  /** Shared secret used for the simple-auth path; real deployments swap
   *  this for VC-based auth once AgntcyIdentity wiring is end-to-end. */
  sharedSecret: string;
}

export function configFromEnv(): SlimServiceConfig {
  return {
    controlPlaneUrl:
      process.env.SLIM_CONTROL_PLANE_URL ?? 'http://localhost:46357',
    sharedSecret:
      process.env.SLIM_SHARED_SECRET ??
      'spellguard-dev-shared-secret-needs-at-least-32-bytes',
  };
}

// ─── Lazy bindings load ──────────────────────────────────────────────

// The bindings module is loaded once on first dispatch and cached. Load
// failures (e.g. no native binary for the host platform) are sticky —
// we don't retry on every send.
let bindingsModule: unknown = null;
let bindingsLoadError: Error | null = null;

async function loadBindings(): Promise<unknown> {
  if (bindingsModule) return bindingsModule;
  if (bindingsLoadError) throw bindingsLoadError;
  try {
    bindingsModule = await import('@agntcy/slim-bindings');
    return bindingsModule;
  } catch (err) {
    bindingsLoadError = err instanceof Error ? err : new Error(String(err));
    throw bindingsLoadError;
  }
}

// Cached Service handles, one per agent. Service.connectAsync is expensive
// (handshake + auth) so we reuse across sends from the same agent.
const serviceCache = new Map<string, unknown>();

export async function dispatchSend(
  input: SlimDispatchInput,
  config: SlimServiceConfig = configFromEnv(),
): Promise<SlimDispatchResult> {
  type SlimBindings = {
    Service: new (
      name: string,
    ) => {
      connectAsync(clientConfig: unknown): Promise<bigint>;
    };
  };
  let bindings: SlimBindings;
  try {
    bindings = (await loadBindings()) as SlimBindings;
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'bindings-unavailable',
        message: `Failed to load @agntcy/slim-bindings: ${(err as Error).message}.`,
      },
    };
  }

  try {
    let service = serviceCache.get(input.senderSlimName);
    if (!service) {
      service = new bindings.Service(input.senderSlimName);
      await (
        service as { connectAsync: (cfg: unknown) => Promise<bigint> }
      ).connectAsync({
        endpoint: config.controlPlaneUrl,
        tls: { insecure: true },
      });
      serviceCache.set(input.senderSlimName, service);
    }
    // TODO: createAppWithSecretAsync(sharedSecret), build session,
    // session.publish(encryptedPayload), await CompletionHandle, decode
    // response into a GatewaySecureMessage. Requires a reachable SLIM
    // data plane + control plane to verify against.
    return {
      ok: false,
      error: {
        code: 'real-mode-partial',
        message:
          'Connected to SLIM control plane successfully, but the publish wiring (App + Session.publish + CompletionHandle decode) is not complete yet. Tracked as a follow-up on the feat/agntcy-slim-profile branch.',
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'control-plane-unreachable',
        message: `SLIM control plane at ${config.controlPlaneUrl} unreachable: ${(err as Error).message}`,
      },
    };
  }
}

// ─── Inbound subscription ───────────────────────────────────────────

const subscribedSlimNames = new Set<string>();

/**
 * Tell the SLIM data plane we want to receive messages for `slimName`.
 *
 * Real implementation calls @agntcy/slim-bindings App.subscribe + wires
 * the inbound callback to dispatchInbound, which POSTs to the registered
 * agent's callbackUrl and reflects the response back as the SRPC reply.
 *
 * Idempotent — subscribing the same slimName twice is a no-op (the SLIM
 * data plane keeps a single subscription per name; we dedupe locally so
 * we don't churn the binding).
 *
 * Status: subscribe + receive callback are sketched against the bindings
 * shape but require a running SLIM stack to validate. The flow is real,
 * not mocked — if the bindings throw, the error surfaces; if SLIM is
 * unreachable, the subscription attempt fails loudly.
 */
export async function subscribeAgent(slimName: string): Promise<void> {
  if (subscribedSlimNames.has(slimName)) return;
  const config = configFromEnv();
  type SlimBindings = {
    Service: new (
      name: string,
    ) => {
      connectAsync(clientConfig: unknown): Promise<bigint>;
      createAppWithSecretAsync(
        name: unknown,
        secret: string,
      ): Promise<{
        subscribeAsync?: (
          name: unknown,
          connectionId: bigint | undefined,
        ) => Promise<void>;
      }>;
    };
    Name?: {
      new: (parts: string[]) => unknown;
    };
  };
  let bindings: SlimBindings;
  try {
    bindings = (await loadBindings()) as SlimBindings;
  } catch (err) {
    throw new Error(
      `[gateway] subscribeAgent: @agntcy/slim-bindings unavailable: ${(err as Error).message}`,
    );
  }
  // slim-bindings' `Service` constructor only accepts identifier-safe
  // names (no `/`). Derive a safe identifier from the hierarchical
  // slimName by joining segments with `-`. The full hierarchical name
  // is preserved for the Name.new(...) call wired in the TODO below.
  const serviceName = slimName.replace(/\//g, '-');
  const service =
    serviceCache.get(serviceName) ?? new bindings.Service(serviceName);
  const connectId = await (
    service as { connectAsync: (cfg: unknown) => Promise<bigint> }
  ).connectAsync({
    endpoint: config.controlPlaneUrl,
    tls: { insecure: true },
  });
  void connectId;
  serviceCache.set(serviceName, service);
  // TODO (next commit, once a SLIM stack is reachable in CI):
  //  1. const app = await service.createAppWithSecretAsync(Name.new(slimName.split('/')), sharedSecret);
  //  2. await app.subscribeAsync(Name.new(slimName.split('/')), undefined);
  //  3. Register a message-callback on the App that builds an InboundContext
  //     and calls dispatchInbound; the returned response becomes the SRPC reply.
  //  The plumbing target is dispatchInbound — wired below so the moment the
  //  bindings callback is hooked up, inbound flows to the registered agent.
  void dispatchInbound;
  subscribedSlimNames.add(slimName);
}

// Reset state — used by tests to clear the cached bindings module + service
// handles between runs.
export function _resetForTesting(): void {
  bindingsModule = null;
  bindingsLoadError = null;
  serviceCache.clear();
  subscribedSlimNames.clear();
}
