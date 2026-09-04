/**
 * Browser-consumable contract surface for the Dev Log stream. The shared
 * vocabulary (kinds, levels, producers) is dependency-free runtime code;
 * the record shapes are type-only because the log service touches Node.
 */
export { devLogKinds, devLogLevels, devLogProducers, hasControlOrSeparators, safeContextKeys } from '../dev/logs/dev-log-kinds.ts';
export type { DevLogMessage, DevLogRecord, DevLogReplay, DevLogReplayGap } from '../dev/logs/dev-log-service.ts';
