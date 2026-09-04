import {
  agent,
  type AgentLineage,
  type AgentStateHandle,
  type JsonObject,
  type JsonValue,
  type Observed,
} from '@agent-bundle/runtime';
import { z } from 'zod';

import type { CaptureRecord } from './capture.js';
import { readLog, resolveLog, type ResolvedLog } from './log.js';
import type { CaptureEvents, CapturesState } from './state.js';

export const dumpInputSchema = z.object({
  /** Match any identity field (conversation_id, session_id, subagent_id, ...) exactly. */
  conversation: z.string().min(1).max(1024).optional(),
  /** Include the complete raw records instead of the compact summary. */
  full: z.boolean().optional(),
  kinds: z.array(z.enum(['event', 'mcp', 'cli'])).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
}).strict();

export type DumpInput = z.output<typeof dumpInputSchema>;

const stateSummarySchema = z.object({
  reason: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  state: z.enum(['available', 'unavailable']),
  summarized: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
}).strict();

export const dumpResultSchema = z.object({
  filter: dumpInputSchema,
  log: z.object({
    malformed: z.number().int().nonnegative(),
    path: z.string(),
    source: z.string(),
  }).strict(),
  matched: z.number().int().nonnegative(),
  records: z.array(z.record(z.string(), z.unknown())),
  state: stateSummarySchema,
  total: z.number().int().nonnegative(),
}).strict();

export type DumpResult = z.output<typeof dumpResultSchema>;

const asCaptures = (records: readonly Record<string, JsonValue>[]): CaptureRecord[] => records
  .filter((record) => typeof record['kind'] === 'string' && typeof record['recordedAt'] === 'string')
  .map((record) => record as unknown as CaptureRecord);

/**
 * A record belongs to a conversation when the host named it in an id field,
 * as the session, or anywhere on the request's *own* lineage chain. The
 * `tree` the lineage carries lists other live conversations (#457) and is
 * deliberately not searched: a sibling's records are not this conversation's.
 */
const matchesConversation = (record: CaptureRecord, conversation: string): boolean => {
  if (Object.values(record.ids).some((value) => value === conversation)) return true;
  const session = (record.request as { session?: { value?: { sessionId?: string } } }).session;
  if (session?.value?.sessionId === conversation) return true;
  const lineage = (record.request as { lineage?: Observed<AgentLineage> | { readonly state?: undefined } }).lineage;
  if (lineage?.state !== 'available') return false;
  const { conversation: own, parent, root, subagent } = lineage.value;
  return own === conversation || parent === conversation || root === conversation || subagent?.id === conversation;
};

/** The compact shape a human or an agent scans first; `full` returns the whole line. */
export const summarizeRecord = (record: CaptureRecord, index: number): JsonObject => {
  const request = record.request as {
    readonly lineage?: JsonValue;
    readonly session?: JsonValue;
    readonly invocation?: { readonly id?: string; readonly kind?: string };
  };
  const observedTool = (record.observed as { readonly tool?: unknown } | undefined)?.tool;
  return {
    ...(record.event === undefined
      ? typeof observedTool === 'string' ? { event: `mcp:${observedTool}` } : {}
      : { event: (record.event.canonical as { event: string }).event }),
    host: record.host,
    ids: record.ids,
    index,
    invocation: request.invocation?.id ?? null,
    kind: record.kind,
    ...(request.lineage === undefined ? {} : { lineage: request.lineage }),
    ...(record.event === undefined
      ? {}
      : { nativeEvent: (record.event.canonical as { provenance: { nativeEvent: string } }).provenance.nativeEvent }),
    ...(record.observed === undefined ? {} : { observed: record.observed }),
    pid: record.process.pid,
    recordedAt: record.recordedAt,
    runtime: record.runtime,
    sequence: record.sequence,
  };
};

export const dumpCaptures = async (
  input: DumpInput,
  log: ResolvedLog = resolveLog(),
): Promise<DumpResult> => {
  const { malformed, records } = await readLog(log);
  const captures = asCaptures(records);
  const indexed = captures.map((record, position) => ({ index: position + 1, record }));
  const filtered = indexed
    .filter(({ record }) => input.kinds === undefined || input.kinds.includes(record.kind))
    .filter(({ record }) => input.conversation === undefined || matchesConversation(record, input.conversation));
  const limited = input.limit === undefined ? filtered : filtered.slice(Math.max(0, filtered.length - input.limit));

  let state: DumpResult['state'];
  const context = await agent();
  const handle = context.state as AgentStateHandle<CapturesState, CaptureEvents> | undefined;
  if (handle === undefined) {
    state = { reason: 'no state handle mounted on this request', state: 'unavailable' };
  } else {
    try {
      const snapshot = await handle.read({ signal: context.signal });
      state = {
        revision: snapshot.revision,
        state: 'available',
        summarized: snapshot.state.captures.length,
        total: snapshot.state.total,
      };
    } catch (error) {
      state = { reason: error instanceof Error ? error.message : String(error), state: 'unavailable' };
    }
  }

  return {
    filter: input,
    log: { malformed, path: log.path, source: log.source },
    matched: filtered.length,
    records: input.full === true
      ? limited.map(({ index, record }): Record<string, unknown> => ({ index, ...record }))
      : limited.map(({ index, record }) => summarizeRecord(record, index)),
    state,
    total: captures.length,
  };
};

export const renderDumpMarkdown = (result: DumpResult): string => {
  const lines = [
    '# host-test captures',
    '',
    `- Log: \`${result.log.path}\` (${result.log.source}, ${String(result.total)} records, ${String(result.log.malformed)} malformed)`,
    `- Durable state: ${result.state.state === 'available'
      ? `revision ${String(result.state.revision)}, ${String(result.state.total)} total, ${String(result.state.summarized)} summarized`
      : `unavailable (${result.state.reason ?? 'unknown'})`}`,
    `- Matched: ${String(result.matched)}${result.filter.conversation === undefined ? '' : ` for ${result.filter.conversation}`}`,
    '',
    '| # | kind | event | host | runtime | lineage | ids |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const record of result.records) {
    const summary = record as Partial<ReturnType<typeof summarizeRecord>> & { readonly ids?: JsonObject };
    const ids = Object.entries(summary.ids ?? {})
      .filter(([key]) => key !== 'cwd' && key !== 'hook_event_name' && key !== 'transcript_path' && key !== 'agent_transcript_path')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    lines.push(`| ${String(summary.index ?? '')} | ${String(summary.kind ?? '')} | ${String(summary.event ?? summary.nativeEvent ?? '')} | ${String(summary.host ?? '')} | ${String(summary.runtime ?? '')} | ${renderLineage(summary.lineage)} | ${ids} |`);
  }
  return lines.join('\n');
};

/** One cell: `depth N · <conversation> ← <parent> (resolution)` or the typed unavailable reason. */
export const renderLineage = (lineage: JsonValue | undefined): string => {
  if (lineage === undefined || lineage === null || typeof lineage !== 'object' || Array.isArray(lineage)) return 'not recorded';
  // The serialized `Observed<AgentLineage>` the capture wrote from `request.lineage`.
  const observed = lineage as unknown as Observed<AgentLineage> | { readonly state?: undefined };
  if (observed.state !== 'available') {
    return `unavailable · ${observed.state === 'unavailable' ? observed.reason : 'unknown'}`;
  }
  const { conversation, depth, parent, resolution } = observed.value;
  return `depth ${String(depth)} · ${conversation}${parent === undefined ? '' : ` ← ${parent}`} (${resolution})`;
};
