/**
 * Browser-consumable contract surface for Playground sessions, operation
 * requests, and native host catalogs. The host vocabulary is the only
 * runtime export; everything else is type-only because the playground
 * services behind these shapes touch Node builtins.
 */
export { NATIVE_HOSTS, NATIVE_HOST_LABELS } from '../host-contracts/native-hosts.ts';
export type { PlaygroundOperationRequest, PlaygroundRun } from '../dev/playground/playground-contract.ts';
export type { NativePlaygroundCatalog } from '../dev/playground/native-playground-service.ts';
export type { NativePlaygroundHost } from '../dev/playground/native-playground-types.ts';
export type {
  DraftEvalCase,
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonObject,
  PlaygroundJsonValue,
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTarget,
  PlaygroundTraceEvent,
  PlaygroundTraceSource,
} from '../dev/playground/playground-store.ts';
