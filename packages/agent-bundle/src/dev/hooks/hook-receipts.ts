import { isHostSessionId } from '../../contracts/host-sessions.ts';
import type { RequestLineageProvenance, RequestProvenanceAxis } from '../../contracts/request-provenance.ts';
import { hasOnlyOwnKeys, isRecord, type JsonObject, type JsonValue } from '../../core/strict-json.ts';
import {
  EVENT_TRACE_RECEIPT_VERSION,
  type EventTraceReceipt,
  type EventTraceReceiptEvent,
  type EventTraceReceiptIdentity,
} from '../../events/trace-receipt.ts';
import {
  eventTraceEventKinds,
  eventTracePhases,
  type EventTraceErrorSummary,
  type EventTracePhase,
} from '../../events/trace.ts';
import { canonicalAgentEvents } from '../../routes/events.ts';
import { applicationNodePath } from '../routes/application-node.ts';
import type { TraceCorrelation, TraceEntryInput } from '../trace/trace-entry.ts';

export const HOOK_RECEIPT_UNAUTHORIZED_CODE = 'AB8247';
export const HOOK_RECEIPT_MALFORMED_CODE = 'AB8248';
export const HOOK_RECEIPT_TOO_LARGE_CODE = 'AB8249';
export const HOOK_RECEIPT_SESSION_CODE = 'AB8266';

const hookReceiptMaxEvents = 32;
const MAX_ID_LENGTH = 256;
const MAX_ERROR_MESSAGE_LENGTH = 512;

export class HookReceiptDecodeError extends TypeError {
  constructor(readonly path: string) {
    super(`Hook receipt field ${path} is not valid.`);
    this.name = 'HookReceiptDecodeError';
  }
}

export class HookReceiptSessionError extends TypeError {
  readonly code = HOOK_RECEIPT_SESSION_CODE;

  constructor(readonly path = 'devSession') {
    super('AGENT_BUNDLE_DEV_SESSION must be a host-session id (hs_ + 16 lowercase characters).');
    this.name = 'HookReceiptSessionError';
  }
}

const fail: (path: string) => never = (path) => {
  throw new HookReceiptDecodeError(path);
};

const record = (value: unknown, path: string): Readonly<Record<string, unknown>> =>
  isRecord(value) ? value : fail(path);

const onlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[], path: string): void => {
  if (!hasOnlyOwnKeys(value, keys)) fail(path);
};

const boundedString = (value: unknown, path: string, maxLength = MAX_ID_LENGTH): string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= maxLength && !value.includes('\0')
    ? value
    : fail(path);

const optionalString = (value: unknown, path: string, maxLength = MAX_ID_LENGTH): string | undefined =>
  value === undefined ? undefined : boundedString(value, path, maxLength);

const finiteNumber = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail(path);

const optionalDuration = (value: unknown, path: string): number | undefined =>
  value === undefined ? undefined : finiteNumber(value, path);

const nonNegativeInteger = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail(path);

const oneOf = <Value extends string>(value: unknown, values: readonly Value[], path: string): Value =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as Value) : fail(path);

const isoInstant = (value: unknown, path: string): string => {
  const text = boundedString(value, path, 64);
  return Number.isNaN(Date.parse(text)) ? fail(path) : text;
};

const provenanceSources = ['native', 'receipt', 'derived'] as const;
const unavailableReasons = [
  'not-provided',
  'unsupported-surface',
  'host-omitted',
  'unauthenticated',
  'no-subagent-events',
  'id-not-resolvable',
  'cloud-agent-no-user-hooks',
  'no-shared-runtime',
] as const;
const lineageResolutions = ['native', 'registry', 'confirmed', 'transcript', 'inferred'] as const;

const decodeSubagent = (value: unknown, path: string): NonNullable<RequestLineageProvenance['subagent']> => {
  const input = record(value, path);
  onlyKeys(input, ['id', 'isParallelWorker', 'toolCallId', 'type'], path);
  const isParallelWorker = input.isParallelWorker === undefined || typeof input.isParallelWorker === 'boolean'
    ? input.isParallelWorker
    : fail(`${path}.isParallelWorker`);
  const toolCallId = optionalString(input.toolCallId, `${path}.toolCallId`);
  const type = optionalString(input.type, `${path}.type`);
  return Object.freeze({
    id: boundedString(input.id, `${path}.id`),
    ...(isParallelWorker === undefined ? {} : { isParallelWorker }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(type === undefined ? {} : { type }),
  });
};

const decodeLineage = (value: unknown): RequestProvenanceAxis<RequestLineageProvenance> => {
  const axis = record(value, 'lineage');
  if (axis.state === 'unavailable') {
    onlyKeys(axis, ['reason', 'state'], 'lineage');
    return Object.freeze({ reason: oneOf(axis.reason, unavailableReasons, 'lineage.reason'), state: 'unavailable' });
  }
  if (axis.state !== 'available') fail('lineage.state');
  onlyKeys(axis, ['source', 'state', 'value'], 'lineage');
  const input = record(axis.value, 'lineage.value');
  onlyKeys(input, ['conversation', 'depth', 'generation', 'parent', 'resolution', 'root', 'subagent'], 'lineage.value');
  const generation = optionalString(input.generation, 'lineage.value.generation');
  const parent = optionalString(input.parent, 'lineage.value.parent');
  return Object.freeze({
    source: oneOf(axis.source, provenanceSources, 'lineage.source'),
    state: 'available',
    value: Object.freeze({
      conversation: boundedString(input.conversation, 'lineage.value.conversation'),
      depth: nonNegativeInteger(input.depth, 'lineage.value.depth'),
      ...(generation === undefined ? {} : { generation }),
      ...(parent === undefined ? {} : { parent }),
      resolution: oneOf(input.resolution, lineageResolutions, 'lineage.value.resolution'),
      root: boundedString(input.root, 'lineage.value.root'),
      ...(input.subagent === undefined ? {} : { subagent: decodeSubagent(input.subagent, 'lineage.value.subagent') }),
    }),
  });
};

const decodeDevSession = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!isHostSessionId(value)) throw new HookReceiptSessionError();
  return value;
};

const decodeIdentity = (value: unknown): EventTraceReceiptIdentity => {
  const input = record(value, 'identity');
  onlyKeys(input, ['conversationId', 'requestId', 'sessionId'], 'identity');
  const conversationId = optionalString(input.conversationId, 'identity.conversationId');
  const requestId = optionalString(input.requestId, 'identity.requestId');
  const sessionId = optionalString(input.sessionId, 'identity.sessionId');
  return Object.freeze({
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
};

const decodeError = (value: unknown, path: string): EventTraceErrorSummary => {
  const input = record(value, path);
  onlyKeys(input, ['code', 'message', 'name'], path);
  const code = optionalString(input.code, `${path}.code`);
  return Object.freeze({
    ...(code === undefined ? {} : { code }),
    message: boundedString(input.message, `${path}.message`, MAX_ERROR_MESSAGE_LENGTH),
    name: boundedString(input.name, `${path}.name`, 128),
  });
};

const decodeEvent = (value: unknown, index: number): EventTraceReceiptEvent => {
  const path = `events[${index}]`;
  const input = record(value, path);
  const kind = oneOf(input.kind, eventTraceEventKinds, `${path}.kind`);
  const phase = oneOf(input.phase, eventTracePhases, `${path}.phase`);
  const base = {
    at: finiteNumber(input.at, `${path}.at`),
    sequence: nonNegativeInteger(input.sequence, `${path}.sequence`),
  };
  const durationMs = optionalDuration(input.durationMs, `${path}.durationMs`);
  const withDuration = durationMs === undefined ? {} : { durationMs };
  const expectPhase = (expected: EventTracePhase): void => {
    if (phase !== expected) fail(`${path}.phase`);
  };
  switch (kind) {
    case 'preflight.start':
      expectPhase('preflight');
      onlyKeys(input, ['at', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({ ...base, kind, phase: 'preflight' });
    case 'preflight.outcome':
      expectPhase('preflight');
      onlyKeys(input, ['at', 'durationMs', 'kind', 'outcome', 'phase', 'sequence'], path);
      return Object.freeze({
        ...base,
        ...withDuration,
        kind,
        outcome: oneOf(input.outcome, ['execute', 'continue', 'deny'] as const, `${path}.outcome`),
        phase: 'preflight',
      });
    case 'execute.start':
      expectPhase('execute');
      onlyKeys(input, ['at', 'kind', 'phase', 'runtime', 'sequence'], path);
      return Object.freeze({
        ...base,
        kind,
        phase: 'execute',
        runtime: oneOf(input.runtime, ['shared', 'standalone'] as const, `${path}.runtime`),
      });
    case 'providers.start':
      expectPhase('providers');
      onlyKeys(input, ['at', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({ ...base, kind, phase: 'providers' });
    case 'providers.finish':
      expectPhase('providers');
      onlyKeys(input, ['at', 'count', 'durationMs', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({
        ...base,
        count: nonNegativeInteger(input.count, `${path}.count`),
        ...withDuration,
        kind,
        phase: 'providers',
      });
    case 'render.start':
      expectPhase('render');
      onlyKeys(input, ['at', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({ ...base, kind, phase: 'render' });
    case 'render.finish':
      expectPhase('render');
      onlyKeys(input, ['at', 'durationMs', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({ ...base, ...withDuration, kind, phase: 'render' });
    case 'failure':
      onlyKeys(input, ['at', 'durationMs', 'error', 'kind', 'phase', 'sequence'], path);
      return Object.freeze({ ...base, ...withDuration, error: decodeError(input.error, `${path}.error`), kind, phase });
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

/**
 * Strictly decodes a posted receipt. Every field is bounded, every object
 * closed to unknown keys, every enum checked against the kernel's own lists;
 * anything else throws {@link HookReceiptDecodeError} naming the field.
 */
export const decodeHookReceipt = (value: unknown): EventTraceReceipt => {
  const input = record(value, 'receipt');
  onlyKeys(input, ['devSession', 'events', 'execution', 'identity', 'lineage', 'startedAt', 'version'], 'receipt');
  if (input.version !== EVENT_TRACE_RECEIPT_VERSION) fail('version');
  const execution = record(input.execution, 'execution');
  onlyKeys(execution, ['event', 'executionId', 'host', 'nativeEvent'], 'execution');
  const rawEvents: unknown = input.events;
  if (!Array.isArray(rawEvents) || rawEvents.length > hookReceiptMaxEvents) fail('events');
  const events = rawEvents.map(decodeEvent);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) fail(`events[${index}].sequence`);
  }
  const devSession = decodeDevSession(input.devSession);
  return Object.freeze({
    ...(devSession === undefined ? {} : { devSession }),
    events: Object.freeze(events),
    execution: Object.freeze({
      event: oneOf(execution.event, canonicalAgentEvents, 'execution.event'),
      executionId: boundedString(execution.executionId, 'execution.executionId', 128),
      host: boundedString(execution.host, 'execution.host', 64),
      nativeEvent: boundedString(execution.nativeEvent, 'execution.nativeEvent', 128),
    }),
    identity: decodeIdentity(input.identity),
    lineage: decodeLineage(input.lineage),
    startedAt: isoInstant(input.startedAt, 'startedAt'),
    version: EVENT_TRACE_RECEIPT_VERSION,
  });
};

type HookReceiptOutcome =
  | Readonly<{ readonly kind: 'completed'; readonly gate?: 'continue' | 'deny' }>
  | Readonly<{ readonly error: EventTraceErrorSummary; readonly kind: 'failed'; readonly phase: EventTracePhase }>;

const hookReceiptOutcome = (receipt: EventTraceReceipt): HookReceiptOutcome => {
  let gate: 'continue' | 'deny' | undefined;
  for (const event of receipt.events) {
    if (event.kind === 'failure') return Object.freeze({ error: event.error, kind: 'failed', phase: event.phase });
    if (event.kind === 'preflight.outcome' && event.outcome !== 'execute') gate = event.outcome;
  }
  return Object.freeze({ kind: 'completed', ...(gate === undefined ? {} : { gate }) });
};

const hookRuntime = (receipt: EventTraceReceipt): 'shared' | 'standalone' | undefined => {
  let runtime: 'shared' | 'standalone' | undefined;
  for (const event of receipt.events) if (event.kind === 'execute.start') runtime = event.runtime;
  return runtime;
};

const correlationOf = (receipt: EventTraceReceipt): TraceCorrelation => {
  const conversationId = receipt.identity.conversationId
    ?? (receipt.lineage.state === 'available' ? receipt.lineage.value.conversation : undefined);
  return Object.freeze({
    ...(conversationId === undefined ? {} : { conversationId }),
    executionId: receipt.execution.executionId,
    host: receipt.execution.host,
    ...(receipt.identity.requestId === undefined ? {} : { requestId: receipt.identity.requestId }),
    routeId: `event:${receipt.execution.event}`,
    ...(receipt.identity.sessionId === undefined ? {} : { sessionId: receipt.identity.sessionId }),
  });
};

const eventsDetail = (receipt: EventTraceReceipt): readonly JsonObject[] => {
  const origin = receipt.events[0]?.at ?? 0;
  return receipt.events.map((event) => ({
    atMs: Math.max(0, Math.round((event.at - origin) * 1000) / 1000),
    kind: event.kind,
    phase: event.phase,
    ...('durationMs' in event && event.durationMs !== undefined ? { durationMs: Math.round(event.durationMs * 1000) / 1000 } : {}),
    ...(event.kind === 'preflight.outcome' ? { outcome: event.outcome } : {}),
    ...(event.kind === 'execute.start' ? { runtime: event.runtime } : {}),
    ...(event.kind === 'providers.finish' ? { count: event.count } : {}),
  }));
};

const lineageDetail = (lineage: EventTraceReceipt['lineage']): JsonValue => {
  if (lineage.state === 'unavailable') return { reason: lineage.reason, state: 'unavailable' };
  const { subagent, ...rest } = lineage.value;
  return {
    source: lineage.source,
    state: 'available',
    value: { ...rest, ...(subagent === undefined ? {} : { subagent: { ...subagent } }) },
  };
};

const instantAfter = (startedAt: string, receipt: EventTraceReceipt, at: number | undefined): string => {
  const origin = receipt.events[0]?.at;
  if (at === undefined || origin === undefined) return startedAt;
  const started = Date.parse(startedAt);
  return Number.isNaN(started) ? startedAt : new Date(started + Math.max(0, at - origin)).toISOString();
};

const describe = (receipt: EventTraceReceipt): string =>
  `${receipt.execution.host} ${receipt.execution.nativeEvent} → ${receipt.execution.event}`;

/**
 * Lowers one decoded receipt into the entries a `TracePublisher` receives, in
 * publish order. Pure: the same receipt always yields the same entries.
 */
export const lowerHookReceipt = (receipt: EventTraceReceipt): readonly TraceEntryInput[] => {
  const correlation = correlationOf(receipt);
  const href = applicationNodePath({ event: receipt.execution.event, kind: 'event' });
  const outcome = hookReceiptOutcome(receipt);
  const runtime = hookRuntime(receipt);
  const first = receipt.events[0];
  const last = receipt.events.at(-1);
  const durationMs = first === undefined || last === undefined
    ? undefined
    : Math.max(0, Math.round((last.at - first.at) * 1000) / 1000);
  const completedAt = instantAfter(receipt.startedAt, receipt, last?.at);
  const label = describe(receipt);
  const entries: TraceEntryInput[] = [{
    correlation,
    details: { execution: { ...receipt.execution }, identity: { ...receipt.identity } },
    href,
    kind: 'hook.received',
    occurredAt: receipt.startedAt,
    source: 'hook',
    status: 'ok',
    summary: `${label} received`,
  }];
  if (receipt.execution.event === 'session/start') {
    entries.push({
      correlation,
      href,
      kind: 'session.started',
      occurredAt: receipt.startedAt,
      source: 'hook',
      status: 'ok',
      summary: `${receipt.execution.host} session started${correlation.sessionId === undefined ? '' : ` (${correlation.sessionId})`}`,
    });
  }
  const details: JsonObject = {
    events: eventsDetail(receipt),
    execution: { ...receipt.execution },
    identity: { ...receipt.identity },
    lineage: lineageDetail(receipt.lineage),
    ...(runtime === undefined ? {} : { runtime }),
  };
  switch (outcome.kind) {
    case 'completed':
      entries.push({
        correlation,
        details: { ...details, ...(outcome.gate === undefined ? {} : { gate: outcome.gate }) },
        ...(durationMs === undefined ? {} : { durationMs }),
        href,
        kind: 'hook.completed',
        occurredAt: completedAt,
        source: 'hook',
        status: 'ok',
        summary: outcome.gate === undefined
          ? `${label} completed`
          : `${label} ${outcome.gate === 'deny' ? 'denied' : 'continued'} by preflight`,
      });
      break;
    case 'failed':
      entries.push({
        correlation,
        details: { ...details, error: { ...outcome.error }, failedPhase: outcome.phase },
        ...(durationMs === undefined ? {} : { durationMs }),
        href,
        kind: 'hook.failed',
        occurredAt: completedAt,
        source: 'hook',
        status: 'error',
        summary: `${label} failed in ${outcome.phase}: ${outcome.error.name}: ${outcome.error.message}`,
      });
      break;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
  if (receipt.execution.event === 'session/end') {
    entries.push({
      correlation,
      href,
      kind: 'session.ended',
      occurredAt: completedAt,
      source: 'hook',
      status: outcome.kind === 'failed' ? 'error' : 'ok',
      summary: `${receipt.execution.host} session ended${correlation.sessionId === undefined ? '' : ` (${correlation.sessionId})`}`,
    });
  }
  return Object.freeze(entries);
};
