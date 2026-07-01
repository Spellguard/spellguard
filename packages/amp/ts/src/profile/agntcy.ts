// SPDX-License-Identifier: Apache-2.0

/**
 * AGNTCY profile: AGNTCY SLIM data plane (transport) + AGNTCY Directory /
 * `dir` (discovery) + AGNTCY Identity Verifiable Credentials.
 *
 * (Formerly the `slim` profile — renamed because it is the whole AGNTCY
 * stack, not just the SLIM transport. The `SlimTransport` class below keeps
 * its name: it genuinely implements the AGNTCY SLIM transport layer.)
 *
 * All three layers are real:
 * - `SlimTransport` opens a WebSocket to the Spellguard gateway (which
 *   wraps `@agntcy/slim-bindings` natively) and dispatches `send` frames.
 *   The gateway talks to a SLIM data plane / control plane; reachability
 *   failures surface as Promise rejections at the call site.
 * - `DirDirectory` hits the AGNTCY `dir` node's REST API for resolve +
 *   publish. Unreachable / 5xx responses propagate as resolution failures.
 * - `AgntcyIdentity` issues + verifies Ed25519-signed JWT Verifiable
 *   Credentials (real W3C VC format). The issuer key is generated once at
 *   process start; the verifier uses the matching public key. Inter-process
 *   verification requires the issuer's public JWK to be shared (Phase 5+
 *   work — typically published at `.well-known/jwks.json`).
 *
 * There is no per-layer mock toggle. The single `SPELLGUARD_PROFILE`
 * env var picks between the original profile and this one. If real SLIM /
 * dir / identity infrastructure isn't running, calls fail loudly with
 * structured errors — they do not silently fall back.
 */

import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import type { JWK, KeyLike } from 'jose';
import type { SecureMessage } from '../types/index';
import type {
  AgentAddress,
  IssueCredentialInput,
  IssuedCredential,
  ProfileBundle,
  ProfileEnv,
  PublishableRecord,
  SpellguardDirectory,
  SpellguardIdentity,
  SpellguardTransport,
  VerifiedClaims,
} from './types';

const PROTOCOL_VERSION = '0.1';
const SUBPROTOCOL = `spellguard-slim-v${PROTOCOL_VERSION}`;

// ─────────────────────────────────────────────────────────────────────
// SlimTransport — WebSocket bridge to the gateway running @agntcy/slim
// ─────────────────────────────────────────────────────────────────────

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    handler: (ev: { data?: unknown }) => void,
  ): void;
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => MinimalWebSocket;

function resolveWebSocketCtor(): WebSocketConstructor | null {
  const global = globalThis as { WebSocket?: unknown };
  if (typeof global.WebSocket === 'function') {
    return global.WebSocket as WebSocketConstructor;
  }
  return null;
}

interface PendingRequest {
  resolve: (msg: SecureMessage) => void;
  reject: (err: Error) => void;
}

class SlimTransport implements SpellguardTransport {
  readonly name = 'gateway';
  private ws: MinimalWebSocket | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private boundAgent: { agentId: string; slimName: string } | null = null;

  constructor(private readonly sidecarUrl: string) {}

  bindAgent(agentId: string, slimName: string): void {
    if (this.boundAgent) {
      if (
        this.boundAgent.agentId !== agentId ||
        this.boundAgent.slimName !== slimName
      ) {
        throw new Error(
          `SlimTransport already bound to ${this.boundAgent.agentId} (${this.boundAgent.slimName}); cannot rebind to ${agentId} (${slimName})`,
        );
      }
      return;
    }
    this.boundAgent = { agentId, slimName };
  }

  async init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const ctor = resolveWebSocketCtor();
    if (!ctor) {
      throw new Error(
        '[agntcy profile] No WebSocket implementation available. Workers and modern Node provide globalThis.WebSocket; older Node needs `import { WebSocket } from "ws"` polyfilled into globalThis.',
      );
    }
    if (!this.boundAgent) {
      throw new Error(
        '[agntcy profile] SlimTransport.init called before bindAgent — call transport.bindAgent(agentId, slimName) first.',
      );
    }
    const bound = this.boundAgent;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const ws = new ctor(this.sidecarUrl, SUBPROTOCOL);
      this.ws = ws;
      const timeout = setTimeout(
        () => reject(new Error('[agntcy profile] gateway handshake timed out')),
        5000,
      );
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            agentId: bound.agentId,
            slimName: bound.slimName,
            version: PROTOCOL_VERSION,
          }),
        );
      });
      ws.addEventListener('message', (ev) => {
        const raw =
          typeof ev.data === 'string'
            ? ev.data
            : ev.data instanceof Uint8Array
              ? new TextDecoder().decode(ev.data)
              : '';
        let frame: {
          type?: string;
          requestId?: string;
          message?: SecureMessage;
          code?: string;
        };
        try {
          frame = JSON.parse(raw) as typeof frame;
        } catch {
          return;
        }
        if (frame.type === 'welcome') {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (frame.type === 'send-result' && frame.requestId && frame.message) {
          const pending = this.pending.get(frame.requestId);
          this.pending.delete(frame.requestId);
          pending?.resolve(frame.message);
          return;
        }
        if (frame.type === 'error') {
          const err = new Error(
            `[agntcy profile] gateway error: ${frame.code ?? 'unknown'} — ${(frame as { message?: string }).message ?? ''}`,
          );
          if (frame.requestId) {
            const pending = this.pending.get(frame.requestId);
            this.pending.delete(frame.requestId);
            pending?.reject(err);
          } else {
            clearTimeout(timeout);
            reject(err);
          }
        }
      });
      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('[agntcy profile] gateway WebSocket error'));
      });
    });
    return this.readyPromise;
  }

  async send(to: AgentAddress, msg: SecureMessage): Promise<SecureMessage> {
    await this.init();
    const ws = this.ws;
    if (!ws) {
      throw new Error('[agntcy profile] SlimTransport.send: WebSocket missing');
    }
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    return new Promise<SecureMessage>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      ws.send(
        JSON.stringify({
          type: 'send',
          requestId,
          to: { agentId: to.agentId, slimName: to.slimName },
          message: msg,
        }),
      );
    });
  }

  async sendUnilateral(
    a2aAgentUrl: string,
    msg: SecureMessage,
    method: 'tasks/send' | 'tasks/get' = 'tasks/send',
  ): Promise<SecureMessage> {
    // External A2A agents speak HTTP/JSON-RPC, not SLIM. Bridge to plain
    // HTTP without going through the SLIM data plane — this is the
    // Verifier-as-bridge path agreed in Fork-4.
    const response = await fetch(a2aAgentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        method,
        params: {
          id: msg.id,
          message: {
            role: 'user',
            parts: [{ type: 'text', text: msg.encryptedPayload }],
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(
        `[agntcy profile] unilateral A2A bridge failed: ${response.status} ${await response.text()}`,
      );
    }
    const data = (await response.json()) as {
      result?: { artifacts?: Array<{ parts: Array<{ text: string }> }> };
    };
    const text = data.result?.artifacts?.[0]?.parts?.[0]?.text ?? '';
    return {
      id: `resp-${msg.id}`,
      sender: a2aAgentUrl,
      recipient: msg.sender,
      encryptedPayload: text,
      timestamp: Date.now(),
    };
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.readyPromise = null;
    this.pending.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────
// DirDirectory — AGNTCY dir over HTTP
// ─────────────────────────────────────────────────────────────────────

interface DirRecordWire {
  agentId: string;
  slimName?: string;
  url?: string;
  skills?: string[];
  org?: string;
}

class DirDirectory implements SpellguardDirectory {
  readonly name = 'agntcy-dir';

  constructor(private readonly dirUrl: string) {}

  async resolve(agentNameOrUrl: string): Promise<AgentAddress | null> {
    // Full URLs pass through unchanged — they're not directory entries,
    // they're the endpoint itself.
    if (
      agentNameOrUrl.startsWith('http://') ||
      agentNameOrUrl.startsWith('https://')
    ) {
      return { agentId: agentNameOrUrl, url: agentNameOrUrl };
    }
    const url = `${this.dirUrl.replace(/\/$/, '')}/v1/records/by-name/${encodeURIComponent(agentNameOrUrl)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `[agntcy profile] dir resolve ${agentNameOrUrl} -> HTTP ${response.status}`,
      );
    }
    const record = (await response.json()) as Partial<DirRecordWire>;
    if (!record.agentId) return null;
    return {
      agentId: record.agentId,
      slimName: record.slimName,
      url: record.url,
    };
  }

  async publish(card: PublishableRecord): Promise<void> {
    const url = `${this.dirUrl.replace(/\/$/, '')}/v1/records`;
    const isHttpEndpoint = card.endpoint.startsWith('http');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: card.agentId,
        slimName: isHttpEndpoint ? undefined : card.endpoint,
        url: isHttpEndpoint ? card.endpoint : undefined,
        skills: card.skills,
        org: card.org,
      } satisfies DirRecordWire),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `[agntcy profile] dir publish ${card.agentId} -> HTTP ${response.status}`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// AgntcyIdentity — Ed25519 JWT Verifiable Credentials
// ─────────────────────────────────────────────────────────────────────
//
// Real W3C-style VC issuance. The process generates an EdDSA keypair on
// first use (lazy) and signs short-lived JWTs as credentials. Each VC
// embeds the agentId as `sub`, the CTLS attestation evidence digest as
// the `attestationHash` claim, and a `codeAttested` boolean.
//
// `issuer` defaults to the configured issuerUrl so multi-issuer
// deployments can route verification to the right key. For single-issuer
// dev / demo deployments the issuer is whoever holds the in-process key.
//
// Cross-process verification requires the issuer's public JWK to be
// shared. The public JWK is exposed via `getPublicJwk()` so an upstream
// `/.well-known/jwks.json` handler can serve it (typically wired up by
// the Verifier or Management plane — Phase 5+ work).

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

class AgntcyIdentity implements SpellguardIdentity {
  readonly name = 'agntcy-vc';
  private keyPromise: Promise<{
    privateKey: KeyLike;
    publicKey: KeyLike;
    publicJwk: JWK;
  }> | null = null;

  constructor(private readonly issuerUrl: string) {}

  private async getKey(): Promise<{
    privateKey: KeyLike;
    publicKey: KeyLike;
    publicJwk: JWK;
  }> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
          crv: 'Ed25519',
          extractable: true,
        });
        const publicJwk = await exportJWK(publicKey);
        publicJwk.alg = 'EdDSA';
        publicJwk.use = 'sig';
        return { privateKey, publicKey, publicJwk };
      })();
    }
    return this.keyPromise;
  }

  /** Public JWK for the in-process issuer key. Wire into /.well-known/jwks.json. */
  async getPublicJwk(): Promise<JWK> {
    const key = await this.getKey();
    return key.publicJwk;
  }

  async issueCredential(
    input: IssueCredentialInput,
  ): Promise<IssuedCredential> {
    const { privateKey } = await this.getKey();
    const ttlSeconds = input.ttlSeconds ?? 3600;
    const attestationHash = await sha256Hex(input.attestationEvidence);
    const credential = await new SignJWT({
      attestationHash,
      codeAttested: input.attestationEvidence.length > 0,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'vc+jwt' })
      .setIssuer(this.issuerUrl)
      .setSubject(input.agentId)
      .setAudience('spellguard-verifier')
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    return {
      credential,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  async verifyCredential(credential: string): Promise<VerifiedClaims | null> {
    try {
      const { publicKey } = await this.getKey();
      const { payload } = await jwtVerify(credential, publicKey, {
        issuer: this.issuerUrl,
        audience: 'spellguard-verifier',
      });
      if (typeof payload.sub !== 'string') return null;
      const codeAttested =
        typeof payload.codeAttested === 'boolean'
          ? payload.codeAttested
          : false;
      const attestationHash =
        typeof payload.attestationHash === 'string'
          ? payload.attestationHash
          : undefined;
      return {
        agentId: payload.sub,
        codeAttested,
        claims: {
          ...(attestationHash !== undefined ? { attestationHash } : {}),
          iss: payload.iss,
          exp: payload.exp,
        },
      };
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Bundle factory
// ─────────────────────────────────────────────────────────────────────

export function createAgntcyProfile(env: ProfileEnv): ProfileBundle {
  const sidecarUrl = env.SPELLGUARD_SLIM_GATEWAY_URL ?? 'ws://localhost:46358';
  const dirUrl = env.SPELLGUARD_DIR_URL ?? 'http://localhost:8888';
  const issuerUrl =
    env.SPELLGUARD_IDENTITY_ISSUER_URL ?? 'http://localhost:8889';

  return {
    profile: 'agntcy',
    transport: new SlimTransport(sidecarUrl),
    directory: new DirDirectory(dirUrl),
    identity: new AgntcyIdentity(issuerUrl),
  };
}

export { SlimTransport, DirDirectory, AgntcyIdentity };
