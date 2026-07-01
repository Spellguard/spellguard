// SPDX-License-Identifier: Apache-2.0
//
// Gateway SLIM worker thread — plain JavaScript so we can spawn it with
// vanilla `node` (no tsx). @agntcy/slim-bindings transitively imports
// uniffi-bindgen-react-native whose package main is a .ts file in
// node_modules, which Node 24 refuses to strip and tsx can't intercept
// reliably. Compiling our worker isn't enough — the dep chain has to be
// .js-only. So this file is hand-written .mjs.
//
// All TypeScript types for the protocol live in slim-worker-host.ts;
// this worker stays close to the type-doc'd contract.
//
// See slim-worker.ts (now unused as a Worker entry point — kept for
// editor type hints) for the documented type signatures.

import { parentPort, workerData } from 'node:worker_threads';
import { publishWithSessionRetry } from './publish-retry.mjs';
import { createLaneDispatcher } from './slim-lane-dispatcher.mjs';
import { createWedgeDetector } from './wedge-detector.mjs';

if (!parentPort) throw new Error('slim-worker must run as a worker thread');
const port = parentPort;
if (!workerData) throw new Error('slim-worker requires workerData');
const init = workerData;

/** @type {Map<string, { resolve: (b: Uint8Array) => void, timer: NodeJS.Timeout }>} */
const pendingReplies = new Map();
let stopRequested = false;
let nextTag = 1;

let bindings = null;
let app = null;
let connId = null;
// Wedge detection — see wedge-detector.mjs for the (hard-won) design.
// The detector deliberately does NOT immediate-exit on the upstream
// panic strings ('failed to add participant to session', 'message send
// retries exhausted'): those are indistinguishable from the benign
// "verifier route not subscribed yet" case (gateway cold start, verifier
// ECS restart), so exiting on them would crash-loop the gateway against
// a not-yet-ready verifier. All failures flow through soft counters
// (consecutive + window-with-decay) instead. When the detector decides
// the plane is wedged, we ask the host to exit so ECS recycles the task.
const wedge = createWedgeDetector();

// Have we ever completed a round-trip to the verifier on this worker?
// Until we have, createSession/send failures mean "verifier not ready
// yet" (it's recovering / not subscribed during our boot window), NOT a
// wedged gateway — so they must NOT count toward a wedge-recycle, or a
// fresh gateway booting into the verifier's recovery window would
// recycle-loop (observed live on 2026-05-29). The prewarm retry loop
// owns the boot-budget escalation while unpaired; once paired, the wedge
// detector behaves normally (a previously-working gateway that starts
// failing IS likely wedged). everPaired resets only via a fresh process.
let everPaired = false;
// How long a freshly-booted worker keeps patiently retrying to pair with
// the verifier before giving up and asking for a recycle. Comfortably
// covers a co-located slim+verifier task replacement (~50-60s).
const PREWARM_BUDGET_MS = 90_000;

function requestProcessExit(reason) {
  port.postMessage({ type: 'request-process-exit', reason });
}

function recordFailure(stage, err) {
  if (!everPaired) {
    // Boot / pre-pairing window — see everPaired above. Don't recycle;
    // the caller already logged, and prewarmWithRetry handles escalation.
    return;
  }
  const verdict = wedge.recordFailure(stage, err?.message || String(err));
  if (verdict.exit) requestProcessExit(verdict.reason);
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

async function bootstrap() {
  try {
    bindings = await import('@agntcy/slim-bindings');
    if (bindings.default) bindings = bindings.default;
    bindings.initializeWithDefaults();
  } catch (err) {
    postError('init-bindings', err);
    // A boot-time init failure leaves the worker alive but useless (the
    // port.on('message') listener keeps the thread from exiting), so
    // `await host.ready` would hang forever. Ask the host to recycle the
    // process — a fresh boot may succeed once bindings/SLIM are healthy.
    requestProcessExit(`init-bindings failed: ${err?.message || String(err)}`);
    return;
  }
  try {
    // getGlobalService() is a PROCESS-GLOBAL singleton: a 2nd connectAsync on
    // it from a co-located worker throws "CALL_ERROR but no errorClass
    // specified" and bricks that worker. A process that runs MORE THAN ONE
    // SLIM app (the Verifier: endpoint listener + send-to-agent +
    // push-registry) must therefore give each worker its OWN Service via
    // `ownService: true` in workerData. The gateway runs a single worker, so
    // it keeps the global service. See worker-listener.mjs for the mirror.
    const service = init.ownService
      ? new bindings.Service(
          `sg-${init.identity.namespace}-${init.identity.agent}`,
        )
      : bindings.getGlobalService();
    const cfg = bindings.newInsecureClientConfig(init.controlPlaneUrl);
    const raw = await service.connectAsync(cfg);
    connId = BigInt(raw);
    const selfName = new bindings.Name(
      init.identity.org,
      init.identity.namespace,
      init.identity.agent,
    );
    app = service.createAppWithSecret(selfName, init.sharedSecret);
    // Subscribe to our own canonical name first. The AGNTCY Node
    // example does this as part of createAndConnectApp ("Forward
    // subscription to next node") — it's what makes reply paths
    // work. Without this, the gateway's createSession would get the
    // verifier's DiscoveryReply rejected with "match not found for
    // name spellguard/gateway/edge/<id>", and createSessionAndWait
    // times out on "message send retries exhausted."
    app.subscribe(selfName, connId);
    for (const nameStr of init.listenNames) {
      doSubscribe(nameStr);
    }
  } catch (err) {
    postError('init-app', err);
    // connectAsync / createApp / subscribe failed (e.g. the SLIM data
    // plane isn't accepting connections yet). Same rationale as
    // init-bindings: recycle rather than hang every forward on a worker
    // that will never post 'ready'.
    requestProcessExit(`init-app failed: ${err?.message || String(err)}`);
    return;
  }
  // 'ready' means the worker BOOTED (bindings + connection + subscribe),
  // NOT that it has paired with the verifier. The host's `ready` resolves
  // here so HTTP serves immediately; actual pairing is reflected by the
  // /ready probe and by `everPaired`.
  port.postMessage({ type: 'ready' });

  // Pair with the verifier in the BACKGROUND, retrying through its
  // recovery window. Establishing one shared outbound session up front
  // means the first burst of agent registrations reuses it (per the
  // per-destination cache) instead of each racing a cold
  // createSessionAndWait — the concurrency that trips the upstream
  // session_moderator panic (session_moderator.rs:671/:748, commit
  // c52ce29d). Critically, at boot the verifier may still be recovering
  // (its co-located task just recycled), so a single attempt isn't
  // enough; we retry with backoff until paired or the boot budget
  // expires. While unpaired, send failures don't wedge-recycle us (see
  // everPaired), so we don't recycle-loop into the recovery window.
  prewarmWithRetry().catch((err) => postError('prewarm-loop', err));

  runListenLoop().catch((err) => postError('listen-loop', err));
}

async function prewarmWithRetry() {
  if (!init.prewarmDestination) return;
  const dest = init.prewarmDestination;
  const deadlineAt = Date.now() + PREWARM_BUDGET_MS;
  let attempt = 0;
  while (!stopRequested && !everPaired && Date.now() < deadlineAt) {
    try {
      // The 'ctl' lane establishes pairing — REQUIRED. Prewarming it means
      // the first control-plane burst reuses a warm session instead of each
      // racing a cold createSessionAndWait (the session_moderator race).
      await getOrCreateOutboundSessionAsync({ destination: dest }, 'ctl');
      everPaired = true;
      port.postMessage({
        type: 'error',
        stage: 'prewarm',
        message: `paired (ctl) with ${destinationKey(dest)} after ${attempt + 1} attempt(s)`,
      });
      // Warm ONE 'msg' pool session — a SECOND concurrent session to the
      // verifier — best-effort: it proves the 2-concurrent-session capability
      // and spares the first /messages/send a cold create. If the bindings
      // reject a 2nd session, that must NOT block pairing or recycle-loop the
      // gateway; the pool (re)creates on first use, and a genuine 2-session
      // limit then surfaces as message-send 502s on a LIVE, diagnosable
      // gateway rather than a boot recycle-loop.
      try {
        const warm = await createMsgSession(dest);
        msgPool.push({
          session: warm,
          dest: destinationKey(dest),
          inUse: false,
        });
        port.postMessage({
          type: 'error',
          stage: 'prewarm',
          message: `msg pool warmed (2nd concurrent session to ${destinationKey(dest)} ok)`,
        });
      } catch (msgErr) {
        logSuspectedTransport('prewarm-msg-pool', msgErr);
      }
      return;
    } catch (err) {
      attempt++;
      logSuspectedTransport(`prewarm-attempt-${attempt}`, err);
      // Drop the half-built session so the next attempt rebuilds cleanly
      // (fire-and-forget; the delete queues on the lifecycle lock ahead of
      // the next attempt's create).
      void dropOutboundSession({ destination: dest }, 'ctl');
      // Linear backoff capped at 5s. A handleSend that pairs first will
      // flip everPaired and end this loop on the next check.
      await sleep(Math.min(5_000, 1_000 * attempt));
    }
  }
  if (!everPaired && !stopRequested) {
    // Couldn't reach the verifier for the entire boot budget — likely a
    // durably-down verifier/data-plane, not a transient recovery window.
    // Recycle so ECS gives us a fresh task (and the deploy circuit breaker
    // rolls back a bad image).
    requestProcessExit(
      `could not pair with verifier within ${PREWARM_BUDGET_MS}ms of boot`,
    );
  }
}

// NOTE: we deliberately do NOT re-call connectAsync at the
// application layer. The @agntcy/slim-bindings already have an
// internal gRPC reconnect (slim_datapath::message_processing logs
// "connection lost ... attempting to reconnect" and "connection
// re-established successfully" on its own). Calling connectAsync a
// second time on the same global service throws
// "CALL_ERROR but no errorClass specified" and bricks the worker.
//
// All we do here is surface a diagnostic log on a suspected
// transport blip so we can correlate with the bindings' internal
// reconnect events. The caller still gets the original error;
// next attempts use the same app/connId, and the bindings' inner
// machinery handles the reconnect transparently.
function logSuspectedTransport(reason, err) {
  postError(
    'suspected-transport-blip',
    new Error(
      `${reason}: ${err?.message || String(err)} (bindings auto-reconnect)`,
    ),
  );
}

function doSubscribe(nameStr) {
  if (!bindings || !app || connId === null) return;
  const parts = nameStr.split('/');
  if (parts.length !== 3) {
    postError('subscribe', new Error(`invalid name ${nameStr}`));
    return;
  }
  const name = new bindings.Name(parts[0], parts[1], parts[2]);
  app.subscribe(name, connId);
  port.postMessage({ type: 'subscribed', name: nameStr });
}

async function runListenLoop() {
  while (!stopRequested) {
    if (!app) {
      await sleep(50);
      continue;
    }
    let session;
    try {
      // Async variant — the sync listenForSession blocks the worker's
      // entire JS thread for the timeout duration, which serialises
      // every concurrent inbound session (each runInboundSession's
      // getMessage call also blocks). Awaiting the async variant
      // yields the event loop so reply handlers and other inbound
      // sessions can interleave freely. Poll interval bumped to 5s
      // since head-of-line blocking is no longer a concern.
      session = await app.listenForSessionAsync(5000);
    } catch (err) {
      const msg = err.message || '';
      // SLIM has two timeout strings: "listen_for_session timed out" from
      // listenForSession and "receive timeout waiting for message" from
      // get_message (see agntcy/slim #1647). Match both.
      // Async timeouts surface as one of: "listen_for_session timed
      // out", "receive timeout waiting for message" (see agntcy/slim
      // #1647), or the generic UniFFI fallback "CALL_ERROR but no
      // errorClass specified" that listenForSessionAsync/getMessageAsync
      // emit when no message arrived within the poll window. Treat
      // all three as benign timeouts — anything else falls through
      // to the real-error path below.
      if (/timed out|timeout|CALL_ERROR but no errorClass/i.test(msg)) {
        continue;
      }
      postError('listen-for-session', err);
      // The bindings auto-reconnect at the gRPC layer; we just log
      // here. No application-level reconnect — see logSuspectedTransport.
      logSuspectedTransport('listen-for-session', err);
      await sleep(500);
      continue;
    }
    void runInboundSession(session);
  }
}

async function runInboundSession(session) {
  while (!stopRequested) {
    let received;
    try {
      received = await session.getMessageAsync(5000);
    } catch (err) {
      if (
        /timed out|timeout|CALL_ERROR but no errorClass/i.test(
          err.message || '',
        )
      ) {
        continue;
      }
      return;
    }

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

    try {
      session.publishTo(
        received.context,
        toArrayBuffer(reply),
        received.context.payloadType,
        undefined,
      );
    } catch (err) {
      postError('publish-reply', err);
    }
  }
}

// Outbound sessions are cached per (destination, LANE) and reused across
// requests. Two lanes go to the verifier:
//   - 'ctl': fast control-plane (attestation/register/resolve/tools-check)
//   - 'msg': LLM-bearing /messages/send that can park ~110s for the reply
// Splitting the lanes is the issue-#8 fix: a parked 'msg' send no longer
// head-of-line-blocks a 'ctl' send. Before this, ONE shared session + a SYNC
// getMessage parked the whole worker thread for the reply budget, so while a
// 120s /messages/send was in flight every other agent's control-plane call
// 502'd at the gateway before reaching the verifier — which timed out the
// data-custodian demo turns (their in-turn checkToolPolicy could never get
// through). The slim Session has no request-id correlation — getMessage
// returns the NEXT message — so a single session can't multiplex concurrent
// requests; the two lanes solve this differently:
//   - 'ctl' (fast leaf control-plane): ONE cached session, serialized by
//     ctlDispatcher. These never nest into another outbound send, so a shared
//     FIFO session is correct and cheap. (This Map holds it.)
//   - 'msg' (LLM /messages/send, can NEST): a BOUNDED POOL of reusable
//     sessions (see msgPool below) — each in-flight send checks out its own
//     session (correct correlation) from a fixed, REUSED set (no churn).
//
// session_moderator.rs panics at :671 (discovery_complete) / :748
// (join_complete) when createSessionAndWait handshakes overlap (a late reply
// lands after current_task was cleared). The global withSessionCreateLock
// guarantees only ONE create/delete is ever in flight, so no two handshakes
// overlap. Per-request msg sessions (create+delete each send) instead CHURNED
// the verifier's event loop until it recycled — the pool fixes that by reusing
// a bounded set of long-lived sessions.
//
// The cached ctl session is keyed "org/namespace/agent#ctl". Cleared on a
// transport failure so the next ctl send rebuilds.
const outboundSessions = new Map();

function destinationKey(d) {
  return `${d.org}/${d.namespace}/${d.agent}`;
}

function sessionKey(d, lane) {
  return `${destinationKey(d)}#${lane}`;
}

// Serialize ALL session lifecycle ops — the cached 'ctl' create and every
// pooled 'msg' create AND delete. createSessionAndWait drives the
// discovery+join handshake that trips the upstream session_moderator race
// when handshakes overlap, so we allow at most one lifecycle op in flight at
// a time. The long getMessageAsync reply waits run OUTSIDE this lock, so
// concurrent (incl. nested) sends still interleave freely.
let sessionCreateLock = Promise.resolve();
function withSessionCreateLock(fn) {
  const run = sessionCreateLock.then(fn, fn);
  // Keep the lock chain alive regardless of outcome (errors are handled by
  // the caller); swallow here so we don't emit unhandledRejection.
  sessionCreateLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

// SLIM session options shared by every outbound session this worker opens.
// MLS (AGNTCY's per-session end-to-end encryption between the two SLIM
// endpoints) is enabled by the PRESENCE of `mlsSettings` — slim-bindings 2.0
// replaced the 1.4.x `enableMls` boolean with this object (absence = MLS off).
// This worker only runs under SPELLGUARD_PROFILE=agntcy (the gateway is
// agntcy-only; the verifier's SLIM endpoint + senders are gated on the agntcy
// profile in verifier server.ts), so enabling MLS unconditionally here is
// exactly "MLS whenever the deployment is on the agntcy profile" — no separate
// flag. headerIntegrityValidationPercent=100 verifies header integrity on every
// message after decrypt (full validation).
const MLS_SETTINGS = { headerIntegrityValidationPercent: 100 };
function pointToPointSessionConfig() {
  return {
    sessionType: 'pointToPoint',
    mlsSettings: MLS_SETTINGS,
    metadata: new Map(),
  };
}

async function getOrCreateOutboundSessionAsync(input, lane) {
  const key = sessionKey(input.destination, lane);
  const cached = outboundSessions.get(key);
  if (cached) return { session: cached, fresh: false };
  return withSessionCreateLock(async () => {
    // Re-check inside the lock — a concurrent waiter may have built it.
    const again = outboundSessions.get(key);
    if (again) return { session: again, fresh: false };
    const destination = new bindings.Name(
      input.destination.org,
      input.destination.namespace,
      input.destination.agent,
    );
    // SetRoute tells the local App "to reach this destination name,
    // forward via this connection." Idempotent so we re-set it each time
    // we (re)build a session. ffi-rs requires the connection id as a JS
    // Number, not a BigInt — passing BigInt throws an empty-message Error.
    app.setRoute(destination, Number(connId));
    const session = await app.createSessionAndWaitAsync(
      pointToPointSessionConfig(),
      destination,
    );
    outboundSessions.set(key, session);
    return { session, fresh: true };
  });
}

function dropOutboundSession(input, lane) {
  const key = sessionKey(input.destination, lane);
  const cached = outboundSessions.get(key);
  if (!cached) return Promise.resolve();
  // Uncache synchronously so no concurrent send can grab the dead session;
  // the delete itself goes through the lifecycle lock like every other
  // create/delete (the upstream session_moderator race applies to ALL
  // lifecycle ops). Never rejects, so callers may fire-and-forget.
  outboundSessions.delete(key);
  return withSessionCreateLock(async () => {
    try {
      app.deleteSessionAndWait(cached);
    } catch {
      // best-effort — the underlying session may already be torn down
    }
  });
}

// Route a send to its lane by reply budget: slim-forward.ts tiers the
// timeout (~25s control / 120s LLM message routes), so anything that can
// park a long time (>= 60s) is the 'msg' lane; everything else is 'ctl'.
function laneFor(input) {
  return (input.replyTimeoutMs ?? 0) >= 60_000 ? 'msg' : 'ctl';
}

function postSendOk(requestId, payload) {
  port.postMessage({
    type: 'send-result',
    requestId,
    ok: true,
    payload: new Uint8Array(payload),
  });
}

function postSendErr(requestId, errorCode, error) {
  port.postMessage({
    type: 'send-result',
    requestId,
    ok: false,
    errorCode,
    error,
  });
}

// 'ctl' lane: ONE cached, SERIALIZED session for fast leaf control-plane
// calls. publishAndWait stays SYNC (local ack ~ms); only the reply wait goes
// async (getMessageAsync) so the worker thread is freed — the issue-#8 fix.
// UniFFI Duration is MILLISECONDS; pass ms directly.
async function handleCtlSendAsync(input) {
  if (!bindings || !app) {
    postSendErr(input.requestId, 'not-ready', 'worker not initialised');
    return;
  }
  let session;
  try {
    ({ session } = await getOrCreateOutboundSessionAsync(input, 'ctl'));
  } catch (err) {
    postSendErr(input.requestId, 'session-failed', err.message);
    logSuspectedTransport('create-ctl-session', err);
    recordFailure('create-session', err);
    return;
  }
  // PUBLISH phase, guarded separately from the reply wait: a publishAndWait
  // throw means the message provably never left — the dead-cached-session
  // case after a verifier recycle ("Session already closed or dropped") —
  // so replace the session and retry the publish exactly ONCE. A recovered
  // first failure never reaches this catch, so it can't advance the wedge
  // counters (see publish-retry.mjs for the policy + accounting rationale).
  try {
    ({ session } = await publishWithSessionRetry({
      session,
      publish: (s) =>
        s.publishAndWait(
          toArrayBuffer(input.payload),
          input.payloadType,
          undefined,
        ),
      replaceSession: async () => {
        await dropOutboundSession(input, 'ctl');
        const { session: fresh } = await getOrCreateOutboundSessionAsync(
          input,
          'ctl',
        );
        return fresh;
      },
      onRecovered: (firstErr) =>
        postError(
          'publish-retry',
          new Error(
            `replaced dead SLIM session on publish retry (lane=ctl): ${firstErr?.message || String(firstErr)}`,
          ),
        ),
    }));
  } catch (err) {
    postSendErr(input.requestId, 'transport-failed', err.message);
    logSuspectedTransport('ctl-publish', err);
    void dropOutboundSession(input, 'ctl');
    recordFailure('publish', err);
    return;
  }
  // REPLY phase — getMessageAsync failures keep the pre-retry behavior: NO
  // retry (the publish succeeded, so the message may have been delivered;
  // re-publishing could double-deliver).
  try {
    const received = await session.getMessageAsync(
      input.replyTimeoutMs || 30_000,
    );
    postSendOk(input.requestId, received.payload);
    everPaired = true;
    wedge.noteSuccess();
  } catch (err) {
    postSendErr(input.requestId, 'transport-failed', err.message);
    logSuspectedTransport('ctl-publish-or-getmessage', err);
    void dropOutboundSession(input, 'ctl');
    recordFailure('publish-or-getmessage', err);
  }
}

// 'msg' lane: a BOUNDED POOL of REUSABLE sessions for LLM /messages/send.
// LLM routes can NEST (a recipient's turn may route on to another agent —
// e.g. compliance-auditor -> fraud-watch), so msg sends must run CONCURRENTLY:
// a single serialized session deadlocks a nested send behind its own parked
// ancestor. But PER-REQUEST sessions (create+delete each send) churned the
// verifier's event loop until it recycled. The pool reconciles both: each
// in-flight send checks out its OWN session (correct reply correlation) from a
// fixed set that is REUSED (no churn), so the verifier sees only
// MSG_POOL_SIZE stable sessions. Concurrency (incl. nesting depth) is bounded
// by the pool size — sized above the demo's nesting depth so a descendant
// send never waits on an ancestor's slot (which would deadlock). Tunable per
// env (worker threads inherit process.env); default 4. Clamped to a positive
// integer like the verifier's concurrency gate: a negative/fractional override
// (operator typo in the .env.slim file) would otherwise make the growth guard
// `msgPool.length < MSG_POOL_SIZE` never fire, deadlocking every msg send on an
// unfillable waiter.
const MSG_POOL_SIZE = Math.max(
  1,
  Math.floor(Number(process.env.SPELLGUARD_GATEWAY_MSG_POOL_SIZE)) || 4,
);
const msgPool = []; // entries: { session: Session|null, dest: string|null, inUse: boolean }
const msgWaiters = []; // FIFO resolve fns awaiting a free entry

async function createMsgSession(dest) {
  // The msg pool used to assume a SINGLE outbound destination (the verifier,
  // via prewarmDestination). It now serves ARBITRARY destinations so the
  // Verifier can deliver to recipient agents' slimNames over SLIM (Task 27).
  // `dest` defaults to the prewarm destination, so the gateway→verifier path
  // — whose sole destination IS the prewarm — is byte-for-byte unchanged.
  const d = dest ?? init.prewarmDestination;
  return withSessionCreateLock(async () => {
    const name = new bindings.Name(d.org, d.namespace, d.agent);
    app.setRoute(name, Number(connId));
    return app.createSessionAndWaitAsync(pointToPointSessionConfig(), name);
  });
}

// Acquire an exclusive pool entry: reuse a free one, else grow to the cap,
// else wait (FIFO) for a checkin. Guarantees a live session on return.
async function acquireMsgEntry(dest) {
  const wantKey = destinationKey(dest ?? init.prewarmDestination);
  // Prefer a free entry already holding a live session to THIS destination
  // (zero rebuild — the steady state for a single-destination sender like the
  // gateway, whose every send targets the verifier). Else take any free entry
  // and (re)point it at `dest`.
  let entry = msgPool.find((e) => !e.inUse && e.session && e.dest === wantKey);
  if (!entry) entry = msgPool.find((e) => !e.inUse);
  if (!entry && msgPool.length < MSG_POOL_SIZE) {
    entry = { session: null, dest: null, inUse: false };
    msgPool.push(entry);
  }
  if (!entry) entry = await new Promise((resolve) => msgWaiters.push(resolve));
  entry.inUse = true;
  if (!entry.session || entry.dest !== wantKey) {
    // New slot, a slot whose session was dropped on a prior failure, or a slot
    // currently pointed at a DIFFERENT destination — (re)build for `dest`. Tear
    // down any stale cross-destination session first so we don't leak it. When
    // there is only ever one destination (the gateway), this branch runs once
    // per slot and the steady state matches the old single-destination pool.
    await teardownMsgEntrySession(entry);
    try {
      entry.session = await createMsgSession(dest);
      entry.dest = wantKey;
    } catch (err) {
      entry.dest = null;
      releaseMsgEntry(entry);
      throw err;
    }
  }
  return entry;
}

// Return an entry to the pool — hand it straight to the next FIFO waiter if
// any (it stays checked out; that waiter ensures the session), else free it.
function releaseMsgEntry(entry) {
  const waiter = msgWaiters.shift();
  if (waiter) {
    waiter(entry);
    return;
  }
  entry.inUse = false;
}

// Tear down a checked-out msg-pool entry's session (dead, failed, or holding
// a stale unread reply that would mis-correlate the next send) so the slot
// rebuilds on next use. Delete goes through the lifecycle lock; does NOT
// release the entry — callers own the single releaseMsgEntry per checkout.
async function teardownMsgEntrySession(entry) {
  const bad = entry.session;
  entry.session = null;
  entry.dest = null;
  if (!bad) return;
  try {
    await withSessionCreateLock(async () => {
      app.deleteSessionAndWait(bad);
    });
  } catch {
    // best-effort — may already be torn down
  }
}

async function handleMsgSendAsync(input) {
  if (!bindings || !app) {
    postSendErr(input.requestId, 'not-ready', 'worker not initialised');
    return;
  }
  let entry;
  try {
    entry = await acquireMsgEntry(input.destination);
  } catch (err) {
    postSendErr(input.requestId, 'session-failed', err.message);
    logSuspectedTransport('create-msg-session', err);
    recordFailure('create-session', err);
    return;
  }
  // PUBLISH phase, guarded separately from the reply wait — same retry-once
  // policy as the ctl lane (see publish-retry.mjs). The entry stays checked
  // out across the retry (the slot's session is rebuilt in place), so the
  // FIFO-waiter handoff semantics are untouched: exactly one releaseMsgEntry
  // per checkout, on every path.
  try {
    await publishWithSessionRetry({
      session: entry.session,
      publish: (s) =>
        s.publishAndWait(
          toArrayBuffer(input.payload),
          input.payloadType,
          undefined,
        ),
      replaceSession: async () => {
        await teardownMsgEntrySession(entry);
        entry.session = await createMsgSession(input.destination);
        entry.dest = destinationKey(
          input.destination ?? init.prewarmDestination,
        );
        return entry.session;
      },
      onRecovered: (firstErr) =>
        postError(
          'publish-retry',
          new Error(
            `replaced dead SLIM session on publish retry (lane=msg): ${firstErr?.message || String(firstErr)}`,
          ),
        ),
    });
  } catch (err) {
    postSendErr(input.requestId, 'transport-failed', err.message);
    logSuspectedTransport('msg-publish', err);
    recordFailure('publish', err);
    await teardownMsgEntrySession(entry);
    releaseMsgEntry(entry);
    return;
  }
  // REPLY phase — getMessageAsync failures keep the pre-retry behavior: NO
  // retry (the publish succeeded, so the message may have been delivered;
  // re-publishing could double-deliver).
  try {
    const received = await entry.session.getMessageAsync(
      input.replyTimeoutMs || 120_000,
    );
    postSendOk(input.requestId, received.payload);
    everPaired = true;
    wedge.noteSuccess();
    releaseMsgEntry(entry); // reuse the session — no churn
  } catch (err) {
    postSendErr(input.requestId, 'transport-failed', err.message);
    logSuspectedTransport('msg-publish-or-getmessage', err);
    recordFailure('publish-or-getmessage', err);
    // The session is likely bad and may hold a stale unread reply that would
    // mis-correlate the next send — drop it so the slot rebuilds on reuse.
    await teardownMsgEntrySession(entry);
    releaseMsgEntry(entry);
  }
}

// 'ctl' goes through the FIFO dispatcher (serialized, one cached session);
// 'msg' fires CONCURRENTLY against the reusable pool (nesting-safe).
const ctlDispatcher = createLaneDispatcher({
  laneFor: () => 'ctl',
  handle: (input) => handleCtlSendAsync(input),
});

function dispatchSend(input) {
  if (laneFor(input) === 'msg') {
    // Fire-and-forget concurrent — pooled session, nesting-safe.
    void handleMsgSendAsync(input);
  } else {
    ctlDispatcher.dispatch(input);
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
  } else if (m.type === 'subscribe' && typeof m.name === 'string') {
    try {
      doSubscribe(m.name);
    } catch (err) {
      postError('subscribe', err);
    }
  } else if (
    m.type === 'send' &&
    typeof m.requestId === 'string' &&
    m.destination &&
    m.payload
  ) {
    // Returns immediately so port.on('message') is never blocked: ctl via the
    // FIFO dispatcher, msg fired concurrently against the pool — both post the
    // send-result back and never throw (they catch internally).
    dispatchSend(m);
  } else if (m.type === 'shutdown') {
    stopRequested = true;
    for (const { timer } of pendingReplies.values()) clearTimeout(timer);
    pendingReplies.clear();
  }
});

bootstrap().catch((err) => postError('bootstrap', err));
