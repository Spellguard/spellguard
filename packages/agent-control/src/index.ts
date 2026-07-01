// SPDX-License-Identifier: Apache-2.0

/**
 * `@spellguard/agent-control` — the neutral, framework-agnostic
 * agent-control credential-socket client.
 *
 * This package owns the single TypeScript copy of the agent-to-backend
 * credential-channel protocol client. It is consumed by the Spellguard agent
 * plugins (Claude Code, Codex, OpenClaw), so no plugin depends on another
 * plugin merely to reuse this client.
 *
 * Public surface:
 *   - `client`     — `AgentControlClient` (PartySocket transport) + options.
 *   - `protocol`   — the wire frames, descriptors, and close codes.
 *   - `claim-flow` — the managed-provisioning first-boot bootstrap orchestrator.
 *
 * Framework-specific credential *handlers* (which mutate a particular agent's
 * on-disk config / git credential helper) intentionally live in each plugin,
 * not here — they are not shareable.
 *
 * PROTOCOL PARITY: `protocol.ts` must stay structurally in sync with the
 * server-side wire contract and the Python mirror used by the Hermes plugin,
 * neither of which can import this TypeScript package. Drift is pinned by the
 * protocol-shape test. Any change to the wire shape here MUST update those
 * copies together.
 */

export * from './client';
export * from './protocol';
export * from './claim-flow';
export * from './management-client';
export * from './plugin-contract';
