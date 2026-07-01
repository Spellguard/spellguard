// SPDX-License-Identifier: Apache-2.0
//
// Verifier SLIM listener worker — plain JavaScript so we can spawn it
// with vanilla `node` (no tsx).  See packages/gateway/src/slim-worker.mjs
// for the rationale: @agntcy/slim-bindings transitively imports
// uniffi-bindgen-react-native whose package main is a .ts file in
// node_modules, which Node 24 refuses to strip.
//
// Listen-only variant of the gateway worker. Protocol identical to the
// gateway worker except no `send` support.

import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort) throw new Error('worker-listener must run as a worker thread');
const port = parentPort;
if (!workerData) throw new Error('worker-listener requires workerData');
const init = workerData;

const pendingReplies = new Map();
let stopRequested = false;
let nextTag = 1;

// Init-failure handling. The bottom-of-file port.on('message') listener
// keeps this worker thread alive even after main() returns, so a bare
// `return` on an init failure would leave a SLIM-dead-but-alive worker
// the supervisor never notices (no 'exit' event fires, and /health stays
// 200 because it's served locally). Exit the thread instead, so the
// endpoint supervisor's worker.on('exit') respawns us — and escalates to
// a full process recycle (ECS replaces the task) if respawns thrash.
//
// NB: we deliberately do NOT count generic listen/getMessage transport
// errors toward a "wedge" exit. This worker is listen-only, and the
// @agntcy/slim-bindings handle gRPC reconnect internally (commit 0b48e177
// — "that's the layer we should trust"), so a non-timeout blip during a
// reconnect window is not a wedge and must not self-kill the verifier.
// Wedge counting lives in the gateway worker, which owns the outbound
// send path; a genuinely stuck-but-alive listener here is culled
// externally by the verifier's /ready probe.
function fatalInit(stage, err) {
  postError(stage, err);
  // process.exit() inside a worker_thread terminates THIS thread (not the
  // whole verifier process) and fires the parent's 'exit' event.
  process.exit(1);
}

function postError(stage, err) {
  port.postMessage({
    type: 'error',
    stage,
    message: err?.message || String(err),
  });
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// A process running >1 SLIM app must give each worker its own Service —
// getGlobalService() rejects a 2nd connectAsync with "CALL_ERROR but no
// errorClass specified". The Verifier co-locates this endpoint listener with
// the send-to-agent and push-registry workers, so all three set
// `ownService: true`. See slim-worker.mjs for the full rationale.
function resolveSlimService(bindings) {
  if (!init.ownService) return bindings.getGlobalService();
  return new bindings.Service(
    `sg-${init.identity.namespace}-${init.identity.agent}`,
  );
}

async function main() {
  let bindings;
  try {
    bindings = await import('@agntcy/slim-bindings');
    if (bindings.default) bindings = bindings.default;
    bindings.initializeWithDefaults();
  } catch (err) {
    fatalInit('init-bindings', err);
    return;
  }
  let service;
  let connId;
  try {
    service = resolveSlimService(bindings);
    const cfg = bindings.newInsecureClientConfig(init.controlPlaneUrl);
    const raw = await service.connectAsync(cfg);
    connId = BigInt(raw);
  } catch (err) {
    fatalInit('init-connect', err);
    return;
  }
  const selfName = new bindings.Name(
    init.identity.org,
    init.identity.namespace,
    init.identity.agent,
  );
  let app;
  try {
    app = service.createAppWithSecret(selfName, init.sharedSecret);
  } catch (err) {
    fatalInit('init-app', err);
    return;
  }
  // Use the 3-arg Name constructor — matches the AGNTCY Node example.
  // The data plane's subscription table stores connections per
  // 3-component name in both `self.ids[app_id]` and `self.connections`;
  // wildcard senders match against `self.connections`, so this
  // registers us correctly. (Tried `Name.newWithId(c0,c1,c2,
  // 0xffffffffffffffffn)` explicitly — bindings reject it with an
  // empty-message Error during subscribe.)
  try {
    for (const nameStr of init.listenNames) {
      const parts = nameStr.split('/');
      if (parts.length !== 3) {
        postError('subscribe', new Error(`invalid name ${nameStr}`));
        continue;
      }
      const name = new bindings.Name(parts[0], parts[1], parts[2]);
      app.subscribe(name, connId);
    }
  } catch (err) {
    fatalInit('subscribe', err);
    return;
  }
  port.postMessage({ type: 'ready' });

  // The bindings handle gRPC reconnect internally — we deliberately
  // do NOT re-call connectAsync at the application layer. Calling
  // connectAsync a second time on the same global service throws
  // "CALL_ERROR but no errorClass specified" and bricks the worker.
  // The slim_datapath logs "connection lost ... attempting to
  // reconnect" / "connection re-established successfully" on its own.
  while (!stopRequested) {
    let session;
    try {
      // Async variant — sync listenForSession blocks the worker's
      // entire JS thread for the timeout duration, head-of-line
      // blocking every concurrent inbound session's reply handling.
      // Awaiting yields the event loop so port.on('message') reply
      // handlers fire freely between polls. Poll interval bumped to
      // 5s since blocking is no longer a concern.
      session = await app.listenForSessionAsync(5000);
    } catch (err) {
      // Async timeouts surface as "listen_for_session timed out" or
      // the generic UniFFI fallback "CALL_ERROR but no errorClass
      // specified" that listenForSessionAsync emits when no session
      // arrived within the poll window. Treat both as benign.
      if (
        /timed out|timeout|CALL_ERROR but no errorClass/i.test(
          err.message || '',
        )
      ) {
        continue;
      }
      // Non-timeout error. The bindings reconnect at the gRPC layer on
      // their own (commit 0b48e177), so we just log + back off and retry
      // the listen on the next loop — NOT a wedge, and not counted toward
      // any self-exit (that would re-introduce the reverted app-level
      // reconnect-reaction and could kill a verifier mid-reconnect).
      postError('listen-for-session', err);
      await sleep(500);
      continue;
    }
    port.postMessage({
      type: 'error',
      stage: 'got-session',
      message: `sessionId=${session.sessionId()}`,
    });
    void runSession(app, session);
  }
}

// Reap a session after this many ms with no inbound message. Without this the
// per-tick churned sessions (the gateway opens fresh sessions as agents
// re-register every tick) accumulate forever — each keeps a getMessageAsync
// poll loop AND its native session state (now incl. MLS group state) alive,
// which is the @agntcy/slim native-RSS leak that OOM-kills the verifier. The
// gateway recreates a session on demand if it ever needs one we reaped (its
// dead-session eviction path), so reaping genuinely-idle sessions is safe.
const SESSION_IDLE_MS =
  Number(process.env.SPELLGUARD_VERIFIER_SLIM_SESSION_IDLE_MS) || 120_000;

// Wrapper: tears the native session down when polling ends (idle reap, peer
// close, or shutdown). The listener previously abandoned sessions here with no
// teardown, so sessions — and, with MLS on, their group state — piled up in
// the bindings as native RSS until the kernel OOM-killed the verifier. The
// best-effort delete mirrors the gateway's `deleteSessionAndWait` guard.
async function runSession(app, session) {
  try {
    await pollSession(session);
  } finally {
    try {
      await app.deleteSessionAndWait(session);
    } catch {
      /* already torn down — the peer may have closed it first */
    }
  }
}

async function pollSession(session) {
  let idleMs = 0;
  while (!stopRequested) {
    let received;
    try {
      received = await session.getMessageAsync(5000);
    } catch (err) {
      const msg = err.message || '';
      // SLIM's timeout-shaped error variants:
      //   • listen_for_session → "listen_for_session timed out"
      //   • session.get_message → "receive timeout waiting for message"
      //   • async fallback     → "CALL_ERROR but no errorClass specified"
      // (See agntcy/slim issue #1647 — should all be SlimError::Timeout
      //  but are SessionError/ReceiveError with these specific strings,
      //  and the async variants surface as the generic UniFFI fallback.)
      if (/timed out|timeout|CALL_ERROR but no errorClass/i.test(msg)) {
        idleMs += 5000;
        if (idleMs >= SESSION_IDLE_MS) {
          // Idle past the threshold → the peer has moved on. Stop polling so
          // runSession's `finally` reaps the session (frees its native state).
          port.postMessage({
            type: 'error',
            stage: 'session-reaped-idle',
            message: `sessionId=${session.sessionId()} idleMs=${idleMs}`,
          });
          return;
        }
        continue;
      }
      // Non-timeout getMessage error ends this session; the outer loop
      // goes back to listenForSession. Bindings handle reconnect, so this
      // is not counted toward any self-exit (see the listen-loop note).
      port.postMessage({
        type: 'error',
        stage: 'session-getmessage',
        message: `name=${err.name} msg=${msg}`,
      });
      return;
    }
    idleMs = 0;
    port.postMessage({
      type: 'error',
      stage: 'got-message',
      message: `payloadBytes=${received.payload.byteLength} payloadType=${received.context.payloadType}`,
    });
    const tag = `t${nextTag++}`;
    const source = received.context.sourceName.components().join('/');
    const destParts = received.context.destinationName
      ? received.context.destinationName.components()
      : undefined;
    const destination = destParts ? destParts.join('/') : '';
    const replyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(tag);
        reject(
          new Error(`parent reply timed out after ${init.replyTimeoutMs}ms`),
        );
      }, init.replyTimeoutMs);
      pendingReplies.set(tag, { resolve, timer });
    });
    port.postMessage({
      type: 'inbound',
      tag,
      source,
      destination,
      payloadType: received.context.payloadType,
      payload: new Uint8Array(received.payload),
    });
    let reply;
    try {
      reply = await replyPromise;
    } catch (err) {
      postError('await-reply', err);
      continue;
    }
    port.postMessage({
      type: 'error',
      stage: 'got-parent-reply',
      message: `tag=${tag} replyBytes=${reply.byteLength}`,
    });
    try {
      session.publishTo(
        received.context,
        toArrayBuffer(reply),
        received.context.payloadType,
        undefined,
      );
      port.postMessage({
        type: 'error',
        stage: 'published-reply',
        message: `tag=${tag}`,
      });
    } catch (err) {
      // publishTo can throw 'session closed' when the gateway already
      // tore down the session (e.g. its own send timed out first). That's
      // a benign, recoverable teardown — the next listenForSession yields
      // a fresh session — so we just log and move on, never self-exit.
      postError('publish-reply', err);
    }
  }
}

port.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'reply' && typeof m.tag === 'string' && m.payload) {
    const pending = pendingReplies.get(m.tag);
    if (pending) {
      clearTimeout(pending.timer);
      pendingReplies.delete(m.tag);
      pending.resolve(m.payload);
    }
  } else if (m.type === 'shutdown') {
    stopRequested = true;
    for (const { timer } of pendingReplies.values()) clearTimeout(timer);
    pendingReplies.clear();
  }
});

main().catch((err) => postError('main', err));
