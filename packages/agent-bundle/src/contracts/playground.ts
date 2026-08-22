/**
 * Browser-consumable contract surface for Playground sessions, operation
 * requests, and native host catalogs. Type-only: the playground services
 * behind these shapes touch Node builtins.
 */
export type { PlaygroundOperationRequest, PlaygroundRun } from '../dev/playground/playground-contract.ts';
export type { NativePlaygroundCatalog, NativePlaygroundHost } from '../dev/playground/native-playground-service.ts';
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
