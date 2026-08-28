/**
 * Browser-consumable contract surface for project status, sources, builds,
 * and the project event stream consumed by the workbench. Type-only: the
 * dev server modules behind it touch Node builtins.
 */
export type { SourceProvenance } from '../core/types.ts';
export { freezeJsonValue } from '../dev/types.ts';
export type {
  ArtifactEpoch,
  ArtifactState,
  ArtifactStatus,
  BuildAttempt,
  BuildStatus,
  Invalidation,
  JsonObject,
  JsonValue,
  ProjectEventMessage,
  ProjectEvent,
  ProjectEventOf,
  ProjectReplayGap,
  ProjectStatus,
  SourceState,
  SourceStatus,
} from '../dev/types.ts';
