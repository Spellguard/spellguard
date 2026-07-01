// SPDX-License-Identifier: Apache-2.0

import {
  decryptFromVerifier,
  encryptForVerifier,
} from '@spellguard/amp/client';
import { loadProfile } from '@spellguard/amp/profile';
import type { AgentCard } from '@spellguard/ctls';
import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import {
  configure,
  createAttestationState,
  discoverAndConfigure,
  getClientKeyPair,
  getConfig,
  getOrCreateChannel,
  getVerifierPublicKey,
  runWithAttestationState,
} from './attestation';
import type { AttestationState } from './attestation';
import { runWithHops } from './hop-context';
import { setIntentDetectFn, setIntentDetectionModel } from './intent';
import type {
  IntentDetectionModelOrFactory,
  SpellguardConfigMode,
  SpellguardOptions,
} from './types';

/**
 * Create a Spellguard instance that manages configuration, model lifecycle,
 * and Hono middleware for Verifier callbacks, agent card, and health checks.
 *
 * Call `.middleware()` to get the Hono sub-app to mount on your router.
 * Call `.getModel()` to access the initialized model in route handlers.
 */
export function createSpellguard<E extends object = object, M = unknown>(
  options: SpellguardOptions<E, M>,
): SpellguardInstance<E, M> {
  let resolvedModel: M | undefined;
  let initPromise: Promise<void> | null = null;
  let initStartedAt = 0;

  // Per-instance attestation state: each createSpellguard() call gets
  // its own channel / config / discoveryConfig bucket, so multiple
  // instances hosted in the same worker (e.g. the the demo fleet) don't
  // overwrite each other on init or during outbound sends.  The
  // middleware wraps each request in this state via ALS.
  const instanceState: AttestationState = createAttestationState();

  const INIT_STALE_MS = 30_000;

  const SKIP_INIT_PATHS = new Set([
    '/_spellguard/health',
    '/.well-known/agent.json',
  ]);

  function getModel(): M {
    if (options.model && resolvedModel === undefined) {
      throw new Error(
        '[Spellguard] Model not initialized. Ensure middleware() has handled at least one non-skip request.',
      );
    }
    return resolvedModel as M;
  }

  async function initialize(env: E): Promise<void> {
    const cfg = resolveConfig(options.config, env);

    // Resolve the active profile (original | slim). Under the original
    // profile the existing attestation / channel / send code paths
    // remain authoritative; this call just surfaces the active profile
    // in startup logs and gives slim-profile follow-up commits a hook
    // to subscribe to. Pulls SPELLGUARD_* keys defensively from env
    // since the Worker env shape is generic.
    const envRecord = env as Record<string, unknown>;
    const profileBundle = loadProfile({
      SPELLGUARD_PROFILE: stringEnv(envRecord.SPELLGUARD_PROFILE),
      SPELLGUARD_TRANSPORT: stringEnv(envRecord.SPELLGUARD_TRANSPORT),
      SPELLGUARD_DIRECTORY: stringEnv(envRecord.SPELLGUARD_DIRECTORY),
      SPELLGUARD_IDENTITY: stringEnv(envRecord.SPELLGUARD_IDENTITY),
      SPELLGUARD_SLIM_GATEWAY_URL: stringEnv(
        envRecord.SPELLGUARD_SLIM_GATEWAY_URL,
      ),
      SPELLGUARD_DIR_URL: stringEnv(envRecord.SPELLGUARD_DIR_URL),
      SPELLGUARD_IDENTITY_ISSUER_URL: stringEnv(
        envRecord.SPELLGUARD_IDENTITY_ISSUER_URL,
      ),
    });
    console.log(
      `[Spellguard] Profile: ${profileBundle.profile} (transport=${profileBundle.transport.name}, directory=${profileBundle.directory.name}, identity=${profileBundle.identity.name})`,
    );

    // Auto-fill agentCard.url from config.selfUrl when empty
    const agentCard: AgentCard = options.agentCard.url
      ? options.agentCard
      : { ...options.agentCard, url: cfg.selfUrl };

    if (cfg.type === 'managed') {
      await discoverAndConfigure({
        agentId: cfg.agentId,
        agentSecret: cfg.agentSecret,
        // The signing key has to flow through here, not just live on
        // the ManagedConfig — discoverAndConfigure → configure() is
        // the only path that populates the channel's signingPrivateKey,
        // which createChannel() then uses to sign registration
        // evidence.  Dropping it here makes the channel fall back to
        // codeHash-as-seed, and the Verifier rejects with "Invalid
        // evidence signature" whenever it has the agent's real
        // public_key (i.e. every managed deployment).
        signingPrivateKey: cfg.signingPrivateKey,
        managementUrl: cfg.managementUrl,
        selfUrl: cfg.selfUrl,
        codeHash: cfg.codeHash,
        agentCard,
        platformAttestation: cfg.platformAttestation,
      });
    } else {
      configure({
        agentId: cfg.agentId,
        verifierUrl: cfg.verifierUrl,
        selfUrl: cfg.selfUrl,
        codeHash: cfg.codeHash,
        expectedVerifierImageHash: cfg.expectedVerifierImageHash,
        agentSecret: cfg.agentSecret,
        agentCard,
      });
      // Eagerly register with Verifier so this agent is discoverable
      // by other agents (matches the managed path behavior).
      const PRE_REG_TIMEOUT_MS = 15_000;
      try {
        await Promise.race([
          getOrCreateChannel(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('pre-registration timed out')),
              PRE_REG_TIMEOUT_MS,
            ),
          ),
        ]);
        console.log('[Spellguard] Pre-registered with Verifier for discovery');
      } catch (error) {
        console.warn(
          `[Spellguard] Direct-config pre-registration failed (will retry on first send): ${error}`,
        );
      }
    }

    // Resolve the main model
    if (options.model) {
      resolvedModel = resolveModel(options.model, env);
    }

    // Set intent detection model if provided
    const rawIntentModel = options.intentDetectionModel;
    if (rawIntentModel) {
      const resolved = resolveIntentModel(rawIntentModel, env);
      if (typeof resolved === 'function') {
        setIntentDetectFn(resolved as (prompt: string) => Promise<string[]>);
      } else {
        setIntentDetectionModel(resolved as LanguageModel);
      }
    }

    if (options.onInitialized) {
      await options.onInitialized(env);
    }

    // No agent-side SLIM awareness: the agent only knows about its
    // Verifier URL (which points at the gateway in slim mode). The
    // gateway-backed verifier owns the slimName ↔ callbackUrl mapping
    // — it derives the agent's slimName from the CTLS registration
    // that already happened above and pushes a registry-update SLIM
    // control message to the gateway. Nothing here for the agent to do.

    console.log('[Spellguard] Initialization complete');
  }

  function middleware(): Hono<{ Bindings: E }> {
    const app = new Hono<{ Bindings: E }>();

    // Lazy init middleware, wrapped in this instance's AttestationState
    // so configure()/getOrCreateChannel() called from onMessage or
    // nested generateText calls always see THIS agent's channel and
    // config — not whichever createSpellguard instance initialized
    // most recently in the same worker.
    app.use('*', async (c, next) => {
      if (SKIP_INIT_PATHS.has(c.req.path)) {
        return next();
      }

      await runWithAttestationState(instanceState, async () => {
        if (initPromise && Date.now() - initStartedAt > INIT_STALE_MS) {
          console.warn('[Spellguard] Clearing stale init promise, retrying');
          initPromise = null;
        }

        if (!initPromise) {
          initStartedAt = Date.now();
          initPromise = initialize(c.env).catch((err) => {
            initPromise = null;
            throw err;
          });
        }

        await initPromise;
        await next();
      });
    });

    // Verifier callback endpoint
    app.post('/_spellguard/receive', async (c) => {
      const channelToken = c.req.header('X-Spellguard-Channel-Token');
      if (!channelToken) {
        return c.json({ error: 'Missing channel token' }, 401);
      }

      let body: {
        message?: unknown;
        encryptedMessage?: string;
        senderId: string;
        messageId: string;
        timestamp: number;
      };

      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      const { senderId, messageId } = body;
      // Gateway-opaque delivery (option a): when the Verifier encrypted to this
      // agent's registered key, decrypt it with our private key. A legacy
      // delivery carries a plaintext `message` instead — use it as-is.
      const wasEncrypted = typeof body.encryptedMessage === 'string';
      let message: unknown;
      if (wasEncrypted) {
        const keyPair = getClientKeyPair();
        if (!keyPair) {
          console.error(
            '[Spellguard] Received an encrypted message but have no agent keypair to decrypt with',
          );
          return c.json({ error: 'Failed to decrypt message' }, 400);
        }
        try {
          message = JSON.parse(
            decryptFromVerifier(
              body.encryptedMessage as string,
              keyPair.privateKeyHex,
            ),
          );
        } catch (err) {
          console.error(
            `[Spellguard] Failed to decrypt delivered message: ${err}`,
          );
          return c.json({ error: 'Failed to decrypt message' }, 400);
        }
      } else {
        message = body.message;
      }
      if (!message || !senderId) {
        return c.json({ error: 'Missing required fields' }, 400);
      }

      console.log(
        `[Spellguard] Received message ${messageId} from ${senderId}`,
      );

      try {
        // Extract hops + correlation id stamped by the Verifier so
        // that any outbound sendToAgent call within this async
        // context carries them forward.  Both fields are stamped on
        // the inbound payload by the Verifier router (see
        // packages/verifier/src/proxy/router.ts) — hops to enforce
        // MAX_MESSAGE_HOPS, correlation id to keep audit_logs rows
        // for one logical conversation grouped under a single
        // session.
        const hops =
          typeof message === 'object' && message !== null
            ? Number((message as Record<string, unknown>)._spellguardHops) || 0
            : 0;
        const correlationId =
          typeof message === 'object' && message !== null
            ? typeof (message as Record<string, unknown>)
                ._spellguardCorrelationId === 'string'
              ? ((message as Record<string, unknown>)
                  ._spellguardCorrelationId as string)
              : undefined
            : undefined;

        const response = await runWithHops(
          hops,
          () =>
            options.onMessage({
              message,
              senderId,
              model: getModel(),
              env: c.env,
            }),
          correlationId,
          // Carry the immediate sender into the trace context so any nested
          // routing this handler triggers excludes back-routing to the
          // sender (2-node cycle prevention — keeps the graph a DAG).
          senderId,
        );
        // Return leg: if the inbound was encrypted (so the Verifier supports it
        // and registered its X25519 key with us), encrypt our reply back TO the
        // Verifier. Otherwise reply in plaintext (legacy).
        const verifierPubkey = getVerifierPublicKey();
        if (wasEncrypted && verifierPubkey) {
          return c.json({
            success: true,
            encryptedResponse: encryptForVerifier(
              JSON.stringify(response),
              verifierPubkey,
            ),
          });
        }
        return c.json({ success: true, response });
      } catch (error) {
        console.error(`[Spellguard] Error handling message: ${error}`);
        return c.json(
          {
            error: 'Failed to process message',
            details: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    });

    // A2A Agent Card discovery
    app.get('/.well-known/agent.json', (c) => {
      const globalConfig = getConfig();
      const baseCard =
        !options.agentCard.url && globalConfig?.agentCard
          ? globalConfig.agentCard
          : options.agentCard;

      const card: AgentCard = {
        ...baseCard,
        ...(baseCard.url
          ? {}
          : { url: resolveConfig(options.config, c.env).selfUrl }),
        authentication: { schemes: ['spellguard-verifier'] },
      };
      return c.json(card);
    });

    // Health check
    app.get('/_spellguard/health', (c) => {
      const globalConfig = getConfig();
      return c.json({
        status: 'ok',
        agentId:
          globalConfig?.agentId ?? resolveConfig(options.config, c.env).agentId,
      });
    });

    return app;
  }

  return { middleware, getModel };
}

// ─── Helpers ───────────────────────────────────────────────────────

function resolveConfig<E extends object>(
  config: SpellguardConfigMode | ((env: E) => SpellguardConfigMode),
  env: E,
): SpellguardConfigMode {
  return typeof config === 'function' ? config(env) : config;
}

function stringEnv(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveModel<E extends object, M>(
  modelOrFactory: ((env: E) => M) | { model: M },
  env: E,
): M {
  return typeof modelOrFactory === 'function'
    ? modelOrFactory(env)
    : modelOrFactory.model;
}

function resolveIntentModel<E extends object>(
  modelOrFactory: IntentDetectionModelOrFactory<E>,
  env: E,
): unknown {
  return typeof modelOrFactory === 'function'
    ? modelOrFactory(env)
    : modelOrFactory.model;
}

// ─── Public types ──────────────────────────────────────────────────

export interface SpellguardInstance<E extends object, M> {
  /** Hono sub-app with lazy init, Verifier callback, agent card, and health. */
  middleware(): Hono<{ Bindings: E }>;
  /** Get the initialized model. Throws if init hasn't completed yet. */
  getModel(): M;
}

/**
 * Verify that a request came from the Verifier.
 * In a full implementation, this would verify cryptographic signatures.
 */
export function verifyVerifierRequest(channelToken: string): boolean {
  return !!channelToken && channelToken.length > 0;
}
