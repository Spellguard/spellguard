// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { createManagementClient } from '@spellguard/agent-control';

export const WHITELIST_FIELDS = [
  'event_uuid',
  'agent_id',
  'scoped_token_id',
  'operation_type',
  'target',
  'timestamp',
  'client_session_id',
] as const;

export const WHITELIST_TARGET_FIELDS = [
  'owner',
  'repo',
  'branch',
  'head_sha',
  'pr_number',
  'commits_count',
  'commit_message',
] as const;

export type OperationType = 'push' | 'branch_create' | 'pr_open' | 'commit';

export interface ObservationTarget {
  owner: string;
  repo: string;
  branch?: string;
  head_sha?: string;
  pr_number?: number;
  commits_count?: number;
  commit_message?: string;
}

export interface ObservationEvent {
  event_uuid: string;
  agent_id: string;
  scoped_token_id: string;
  operation_type: OperationType;
  target: ObservationTarget;
  timestamp: string;
  client_session_id: string;
}

export interface BuildObservationInput {
  agentId: string;
  scopedTokenId: string;
  operationType: OperationType;
  target: ObservationTarget & Record<string, unknown>;
  clientSessionId: string;
  eventUuid?: string;
  timestamp?: string;
}

export function buildObservationEvent(
  input: BuildObservationInput,
): ObservationEvent {
  // Fail fast on empty/non-string owner/repo so a programming error
  // surfaces at the call site instead of as a server-side 400 (or worse, as
  // an accepted observation row with empty `target.owner`).
  if (
    typeof input.target.owner !== 'string' ||
    input.target.owner.length === 0
  ) {
    throw new Error(
      'buildObservationEvent: target.owner must be a non-empty string',
    );
  }
  if (typeof input.target.repo !== 'string' || input.target.repo.length === 0) {
    throw new Error(
      'buildObservationEvent: target.repo must be a non-empty string',
    );
  }
  const target: ObservationTarget = {
    owner: input.target.owner.toLowerCase(),
    repo: input.target.repo.toLowerCase(),
  };
  for (const key of WHITELIST_TARGET_FIELDS) {
    const v = (input.target as Record<string, unknown>)[key];
    if (v !== undefined && key !== 'owner' && key !== 'repo') {
      (target as unknown as Record<string, unknown>)[key] = v;
    }
  }
  return {
    event_uuid: input.eventUuid ?? randomUUID(),
    agent_id: input.agentId,
    scoped_token_id: input.scopedTokenId,
    operation_type: input.operationType,
    target,
    timestamp: input.timestamp ?? new Date().toISOString(),
    client_session_id: input.clientSessionId,
  };
}

export interface QueueOptions {
  capacity: number;
}

export class ObservationQueue {
  private buf: ObservationEvent[] = [];
  constructor(private opts: QueueOptions) {}
  enqueue(event: ObservationEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.opts.capacity) {
      this.buf.splice(0, this.buf.length - this.opts.capacity);
    }
  }
  size(): number {
    return this.buf.length;
  }
  drain(): ObservationEvent[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }
  peek(): ObservationEvent[] {
    return [...this.buf];
  }
  prepend(events: ObservationEvent[]): void {
    // Used for re-queue on transient HTTP failure; preserve queue cap.
    this.buf = [...events, ...this.buf];
    if (this.buf.length > this.opts.capacity) {
      this.buf.splice(0, this.buf.length - this.opts.capacity);
    }
  }
}

export interface EmitOptions {
  endpoint: string; // e.g., https://spellguard/v1/observations
  agentId: string;
  agentSecret: string;
  fetchImpl?: typeof fetch;
}

// The typed management client takes a baseUrl WITHOUT the `/v1` prefix (it
// appends `/v1` itself) and a path of `/observations`. `EmitOptions.endpoint`
// is the legacy full URL ending in `/v1/observations`, so strip that suffix to
// recover the origin the client expects.
function managementClientFor(opts: EmitOptions) {
  const baseUrl = opts.endpoint.replace(/\/v1\/observations\/?$/, '');
  return createManagementClient({
    baseUrl,
    agentId: opts.agentId,
    agentSecret: opts.agentSecret,
    fetchImpl: opts.fetchImpl,
  });
}

export async function emitOrQueue(
  event: ObservationEvent,
  queue: ObservationQueue,
  opts: EmitOptions,
): Promise<{ delivered: boolean; status?: number }> {
  const api = managementClientFor(opts);
  try {
    const { error, response } = await api.POST('/observations', {
      body: event,
    });
    if (!error) return { delivered: true, status: response.status };
    queue.enqueue(event);
    return { delivered: false, status: response.status };
  } catch {
    queue.enqueue(event);
    return { delivered: false };
  }
}

/**
 * Serial flush with head-of-queue bailout.
 *
 * The previous implementation drained the full queue up-front and attempted
 * every event in the snapshot — a network hiccup mid-drain would leave the
 * queue with the remainder of the snapshot re-prepended, but ordering was
 * subtly wrong when a retry succeeded after an earlier failure (the failed
 * event would move to the tail).
 *
 * This implementation removes an event only on a 2xx response; on the first
 * failure it breaks out of the loop, leaving the offender at the head of
 * the queue so the next flush retries it first. Order is preserved end-to-end.
 */
export async function flushQueue(
  queue: ObservationQueue,
  opts: EmitOptions,
): Promise<{ flushed: number; remaining: number }> {
  const api = managementClientFor(opts);
  let flushed = 0;
  // Peek + conditional-shift via the existing drain/prepend primitives. We
  // drain once to get a stable snapshot, then on first failure re-prepend
  // the remainder (including the offender) and break.
  const snapshot = queue.drain();
  for (let i = 0; i < snapshot.length; i++) {
    const event = snapshot[i];
    let ok = false;
    try {
      const { error } = await api.POST('/observations', { body: event });
      ok = !error;
    } catch {
      ok = false;
    }
    if (!ok) {
      // Leave this event + everything after it in queue order, at the head.
      queue.prepend(snapshot.slice(i));
      return { flushed, remaining: queue.size() };
    }
    flushed++;
  }
  return { flushed, remaining: queue.size() };
}
