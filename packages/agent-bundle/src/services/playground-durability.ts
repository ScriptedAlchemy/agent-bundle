import { testModeGlobalValue } from '../core/durability-test-hook.ts';

/**
 * The playground store's durability test seam: the phase vocabulary its
 * durability-injection tests target and the symbol-keyed hook readers. The
 * `Symbol.for` key strings are part of the test contract
 * (tests/support/durability.ts installs hooks under them) and must not change.
 */

export type DirectorySyncReason =
  | 'final-index-publication'
  | 'layout-index-entry'
  | 'layout-object-entry'
  | 'layout-pending-index-entry'
  | 'layout-project-entry'
  | 'layout-storage-entry'
  | 'new-file'
  | 'object-created'
  | 'owner-lock-create'
  | 'owner-lock-create-recovery'
  | 'owner-lock-recovery'
  | 'owner-lock-release'
  | 'pending-index-publication'
  | 'session-metadata-rename';
export type DurableFilePhase = 'event' | 'owner' | 'pending-index' | 'session-metadata';
export type OwnerMutationReason = 'create-recovery' | 'recovery' | 'release';
export type DurabilityTestPhase =
  | 'after-final-index-link'
  | 'before-owner-lock-recovery'
  | 'before-final-index-link'
  | `before-directory-fsync:${DirectorySyncReason}`
  | `before-directory-open:${DirectorySyncReason}`
  | `before-directory-sync:${DirectorySyncReason}`
  | `before-file-fsync:${DurableFilePhase}`
  | `before-file-write:${DurableFilePhase}`
  | `before-owner-lock-unlink:${OwnerMutationReason}`;
export type DurabilityTestHook = (phase: DurabilityTestPhase, path: string) => Promise<void> | void;

/** Non-API test seam, unavailable unless the process explicitly runs in test mode. */
const durabilityTestHookKey = Symbol.for('agent-bundle.playground-service.durability-test-hook');
const durabilityTestPlatformKey = Symbol.for('agent-bundle.playground-service.durability-test-platform');

export const runDurabilityTestHook = (phase: DurabilityTestPhase, path: string): void => {
  void testModeGlobalValue<DurabilityTestHook>(durabilityTestHookKey)?.(phase, path);
};

export const runAsyncDurabilityTestHook = async (phase: DurabilityTestPhase, path: string): Promise<void> => {
  await testModeGlobalValue<DurabilityTestHook>(durabilityTestHookKey)?.(phase, path);
};

export const durabilityPlatform = (): NodeJS.Platform =>
  testModeGlobalValue<NodeJS.Platform>(durabilityTestPlatformKey) ?? process.platform;
