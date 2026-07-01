// SPDX-License-Identifier: Apache-2.0

export { runSessionStart } from './hooks/session-start';
export {
  runPreToolUse,
  runPreToolUseHook,
  runPreToolUseObservation,
  emitPreToolUseObservation,
  detectGitOperation,
} from './hooks/pre-tool-use-observation';
export { runMonitorTick } from './monitors/credential-monitor';
export { runSpellguardSetup } from './skills/spellguard-setup';
export { observeGitOperation } from './lib/observation-pipeline';
// Re-export observation-emitter surface
export {
  buildObservationEvent,
  emitOrQueue,
  flushQueue,
  ObservationQueue,
  WHITELIST_FIELDS,
  WHITELIST_TARGET_FIELDS,
} from './lib/observation-emitter';
export { isInEffectiveScope, loadUserAllowlist } from './lib/observation-scope';
export { canonicalizeGitRemote } from './lib/git-remote-canonicalizer';
// Re-export common types for consumers
export type { PluginConfig } from './lib/config-store';
export type { RepoTuple } from './lib/observation-scope';
export { syncFrameworkIdentity } from './lib/plugin-sync';
