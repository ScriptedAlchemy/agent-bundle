/**
 * Browser-consumable contract surface for the Workbench unified trace
 * (`GET /api/trace`, `GET /api/trace/stream`). The source vocabulary is
 * dependency-free runtime code; the entry shapes are type-only.
 */
export { isTraceReplayGap, isTraceSource, traceSources } from '../dev/trace/trace-entry.ts';
export type {
  TraceCorrelation,
  TraceEntry,
  TraceEntryInput,
  TraceMessage,
  TraceReplay,
  TraceReplayGap,
  TraceSource,
  TraceStatus,
} from '../dev/trace/trace-entry.ts';
