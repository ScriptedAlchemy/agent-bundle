/**
 * Browser-consumable contract surface for Playground sessions, operation
 * requests, and native host catalogs. Type-only: the playground services
 * behind these shapes touch Node builtins.
 */
export type { PlaygroundOperationRequest, PlaygroundRun } from '../dev/playground-contract.ts';
export type { NativePlaygroundCatalog, NativePlaygroundHost } from '../dev/native-playground-service.ts';
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
} from '../services/playground-service.ts';
