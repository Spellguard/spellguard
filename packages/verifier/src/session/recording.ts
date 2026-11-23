// SPDX-License-Identifier: Apache-2.0

/**
 * Appending a leg's parts to a session, best effort
 * (internal design notes).
 *
 * A leg appends after its verdict, and an append that fails never changes
 * that verdict: the leg records what happened on its audit event instead.
 */

import { SessionCapacityError, type SessionHandle } from './session-store';
import type { SessionPart, SessionPartInput } from './types';

/**
 * What the audit event says about the session on this leg:
 *   recorded     every part was appended
 *   full         the session refused a part (its caps); earlier ones stayed
 *   unavailable  the store failed
 */
export type SessionRecordStatus = 'recorded' | 'full' | 'unavailable';

export async function recordParts(
  session: SessionHandle,
  parts: readonly SessionPartInput[],
): Promise<SessionRecordStatus> {
  return (await appendParts(session, parts)).status;
}

/** `recordParts`, also returning the parts stored, in order. */
export async function appendParts(
  session: SessionHandle,
  parts: readonly SessionPartInput[],
): Promise<{ status: SessionRecordStatus; stored: SessionPart[] }> {
  const stored: SessionPart[] = [];
  try {
    for (const part of parts) stored.push(await session.append(part));
    return { status: 'recorded', stored };
  } catch (err) {
    if (err instanceof SessionCapacityError) return { status: 'full', stored };
    console.warn(
      `[Verifier] Session append failed for ${session.key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: 'unavailable', stored };
  }
}

/** A label marking a part whose leg was denied. */
export function deniedLabel(label: string | undefined): string {
  return `${label ?? ''}:denied`;
}
