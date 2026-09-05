import type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceMeta,
  McpSessionTraceReplayGap,
} from '../../../agent-bundle/src/contracts/mcp-session.ts';
import type { DevRuntimeMcpAppRunBinding, RuntimeVector } from '../../../agent-bundle/src/contracts/runtime.ts';
import { isRecord } from '../client-helpers.ts';
import { deepFreeze } from '../freeze.ts';


export type McpBrowserSessionBinding =
  | McpSessionBinding
  | Readonly<{ readonly kind: 'runtime'; readonly binding: DevRuntimeMcpAppRunBinding }>;

export type McpBrowserSessionPhase =
  | 'idle'
  | 'opening'
  | 'ready'
  | 'restarting'
  | 'closing'
  | 'closed'
  | 'error';

export interface McpBrowserSessionConnection {
  readonly protocolVersion?: string;
  readonly serverCapabilities?: unknown;
  readonly serverInfo?: unknown;
}

export interface McpBrowserSessionCatalogs {
  readonly prompts: readonly unknown[];
  readonly resourceTemplates: readonly unknown[];
  readonly resources: readonly unknown[];
  readonly tools: readonly unknown[];
}

export interface McpBrowserSessionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'info' | 'warning';
}

export interface McpBrowserSessionTiming {
  readonly completedAt: number;
  readonly durationMs: number;
  readonly startedAt: number;
}

export interface McpBrowserSessionInvocation {
  readonly binding?: McpBrowserSessionBinding;
  readonly error?: unknown;
  readonly id: string;
  readonly operation: McpSessionOperation;
  readonly replayOf?: string;
  readonly request: unknown;
  readonly result?: unknown;
  readonly timing: McpBrowserSessionTiming;
  readonly vector?: RuntimeVector;
}

export interface McpBrowserSessionActiveRequest {
  readonly binding?: McpBrowserSessionBinding;
  readonly id: string;
  readonly operation: McpSessionOperation;
  readonly replayOf?: string;
  readonly request: unknown;
  readonly startedAt: number;
}

export interface McpBrowserSessionInvocationTimelineEntry {
  readonly invocation: McpBrowserSessionInvocation;
  readonly type: 'invocation';
}

/** A raw JSON-RPC frame with the keys the server lifts beside it: `id`, `method`, and the known `_meta` correlation keys. */
export type McpBrowserSessionFrameEntry = Extract<McpSessionTraceEntry, { readonly kind: 'frame' }>;

/** The `_meta` keys the server lifts onto a frame, in display order. */
export const mcpFrameMetaKeys: readonly (keyof McpSessionTraceMeta)[] = Object.freeze(['correlationId', 'conversationId', 'requestId', 'sessionId']);

/** Narrows a timeline value the Protocol page renders; the controller's strict decoder is the only producer of frames. */
export const isMcpFrameEntry = (entry: unknown): entry is McpBrowserSessionFrameEntry =>
  isRecord(entry) && entry.kind === 'frame' && (entry.direction === 'client' || entry.direction === 'server') &&
  typeof entry.sequence === 'number';

export type McpBrowserSessionTimelineEntry =
  | McpSessionTraceEntry
  | McpSessionTraceReplayGap
  | McpBrowserSessionInvocationTimelineEntry;

export interface McpBrowserSessionTimeline {
  readonly droppedThroughSequence: number;
  readonly entries: readonly McpBrowserSessionTimelineEntry[];
  readonly lastSequence: number;
}

export interface McpBrowserSessionModel {
  readonly activeRequests: Readonly<Record<string, McpBrowserSessionActiveRequest>>;
  readonly binding?: McpBrowserSessionBinding;
  readonly catalogs: McpBrowserSessionCatalogs;
  readonly conciseTrace: readonly McpBrowserSessionTimelineEntry[];
  readonly config?: McpSessionInspectorConfig;
  readonly connection?: McpBrowserSessionConnection;
  readonly diagnostics: readonly McpBrowserSessionDiagnostic[];
  readonly logs: readonly Extract<McpSessionTraceEntry, { readonly kind: 'logging' }> [];
  readonly phase: McpBrowserSessionPhase;
  readonly progress: readonly Extract<McpSessionTraceEntry, { readonly kind: 'progress' }> [];
  readonly sessionId: string;
  readonly timeline: McpBrowserSessionTimeline;
}

export type McpBrowserSessionEvent =
  | Readonly<{ readonly binding: McpBrowserSessionBinding; readonly type: 'open' }>
  | Readonly<{ readonly binding: McpBrowserSessionBinding; readonly type: 'binding' }>
  | Readonly<{ readonly connection: McpBrowserSessionConnection; readonly type: 'connection' }>
  | Readonly<{ readonly catalogs: McpBrowserSessionCatalogs; readonly type: 'catalogs' }>
  | Readonly<{ readonly config: McpSessionInspectorConfig; readonly type: 'config' }>
  | Readonly<{ readonly entry: McpSessionTraceEntry | McpSessionTraceReplayGap; readonly type: 'trace' }>
  | Readonly<{ readonly request: McpBrowserSessionActiveRequest; readonly type: 'request.start' }>
  | Readonly<{
    readonly completedAt: number;
    readonly error?: unknown;
    readonly id: string;
    readonly result?: unknown;
    readonly type: 'request.settled';
    readonly vector?: RuntimeVector;
  }>
  | Readonly<{ readonly diagnostic: McpBrowserSessionDiagnostic; readonly type: 'failed' }>
  | Readonly<{ readonly type: 'ready' | 'restart' | 'close' | 'closed' }>;

type McpBrowserSessionEventType = McpBrowserSessionEvent['type'];

const emptyCatalogs = deepFreeze({
  prompts: [],
  resourceTemplates: [],
  resources: [],
  tools: [],
});

const emptyActiveRequests: Readonly<Record<string, McpBrowserSessionActiveRequest>> = Object.freeze(Object.create(null));

const secretName = /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/iu;

const snapshot = <Value>(
  value: Value,
  seen = new Map<object, unknown>(),
  visiting = new Set<object>(),
): Value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('MCP session model snapshots must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new TypeError('MCP session model snapshots must contain JSON values.');
  if (visiting.has(value)) throw new TypeError('MCP session model snapshots must not contain cycles.');
  const known = seen.get(value);
  if (known !== undefined) return known as Value;
  visiting.add(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    try {
      for (const item of value) copy.push(snapshot(item, seen, visiting));
      return Object.freeze(copy) as Value;
    } finally {
      visiting.delete(value);
    }
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('MCP session model snapshots must be plain objects.');
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  try {
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: snapshot(item, seen, visiting),
        writable: true,
      });
    }
    return Object.freeze(copy) as Value;
  } finally {
    visiting.delete(value);
  }
};

const isReplayGap = (entry: McpSessionTraceEntry | McpSessionTraceReplayGap): entry is McpSessionTraceReplayGap =>
  'type' in entry && entry.type === 'replay.gap';

const isLoggingEntry = (entry: McpBrowserSessionTimelineEntry): entry is Extract<McpSessionTraceEntry, { readonly kind: 'logging' }> =>
  'kind' in entry && entry.kind === 'logging';

const isProgressEntry = (entry: McpBrowserSessionTimelineEntry): entry is Extract<McpSessionTraceEntry, { readonly kind: 'progress' }> =>
  'kind' in entry && entry.kind === 'progress';

const isInvocationEntry = (entry: McpBrowserSessionTimelineEntry): entry is McpBrowserSessionInvocationTimelineEntry =>
  'type' in entry && entry.type === 'invocation';

/**
 * Derived trace views, cached on the timeline they came from. Every event type
 * funnels through `withViews`, but the timeline is replaced only when a trace
 * entry arrives, so phase and request updates reuse the previous scan instead
 * of re-filtering the whole timeline.
 */
const derivedViews = new WeakMap<object, Pick<McpBrowserSessionModel, 'logs' | 'progress'>>();

const viewsFor = (
  entries: readonly McpBrowserSessionTimelineEntry[],
): Pick<McpBrowserSessionModel, 'logs' | 'progress'> => {
  const cached = derivedViews.get(entries);
  if (cached !== undefined) return cached;
  const views = deepFreeze({
    logs: entries.filter(isLoggingEntry),
    progress: entries.filter(isProgressEntry),
  });
  derivedViews.set(entries, views);
  return views;
};

const withViews = (model: Omit<McpBrowserSessionModel, 'conciseTrace' | 'logs' | 'progress'>): McpBrowserSessionModel => {
  const entries = model.timeline.entries;
  // `entries` is already frozen, so the concise trace can alias it directly.
  return Object.freeze({ ...model, conciseTrace: entries, ...viewsFor(entries) });
};

const update = (
  model: McpBrowserSessionModel,
  change: Partial<Omit<McpBrowserSessionModel, 'conciseTrace' | 'logs' | 'progress'>>,
): McpBrowserSessionModel => withViews({ ...model, ...change });

const allowedEventsByPhase: Readonly<Record<McpBrowserSessionPhase, readonly McpBrowserSessionEventType[]>> = {
  closed: [],
  closing: ['closed'],
  error: ['close'],
  idle: ['open', 'close', 'failed'],
  opening: ['binding', 'connection', 'catalogs', 'config', 'trace', 'request.start', 'request.settled', 'ready', 'close', 'failed'],
  ready: ['binding', 'connection', 'catalogs', 'config', 'trace', 'request.start', 'request.settled', 'restart', 'close', 'failed'],
  restarting: ['binding', 'connection', 'catalogs', 'config', 'trace', 'request.start', 'request.settled', 'ready', 'close', 'failed'],
};

const activeRequestsWith = (
  requests: Readonly<Record<string, McpBrowserSessionActiveRequest>>,
  active: McpBrowserSessionActiveRequest,
): Readonly<Record<string, McpBrowserSessionActiveRequest>> => {
  const copy = Object.create(null) as Record<string, McpBrowserSessionActiveRequest>;
  for (const [id, request] of Object.entries(requests)) Object.defineProperty(copy, id, { enumerable: true, value: request });
  Object.defineProperty(copy, active.id, { enumerable: true, value: active });
  return Object.freeze(copy);
};

const activeRequestsWithout = (
  requests: Readonly<Record<string, McpBrowserSessionActiveRequest>>,
  id: string,
): Readonly<Record<string, McpBrowserSessionActiveRequest>> => {
  const copy = Object.create(null) as Record<string, McpBrowserSessionActiveRequest>;
  for (const [currentId, request] of Object.entries(requests)) {
    if (currentId !== id) Object.defineProperty(copy, currentId, { enumerable: true, value: request });
  }
  return Object.freeze(copy);
};

const diagnosticKey = (diagnostic: McpBrowserSessionDiagnostic): string =>
  `${diagnostic.severity}\u0000${diagnostic.code}\u0000${diagnostic.message}`;

const withDiagnostic = (
  model: McpBrowserSessionModel,
  diagnostic: McpBrowserSessionDiagnostic,
): McpBrowserSessionModel => {
  const frozen = snapshot(diagnostic);
  if (model.diagnostics.some((current) => diagnosticKey(current) === diagnosticKey(frozen))) return model;
  return update(model, { diagnostics: Object.freeze([...model.diagnostics, frozen]) });
};

const invalidTransition = (model: McpBrowserSessionModel, type: McpBrowserSessionEventType): McpBrowserSessionModel =>
  withDiagnostic(model, {
    code: 'mcp.lifecycle.invalid-transition',
    message: `Ignored ${type} while session phase is ${model.phase}.`,
    severity: 'warning',
  });

const sanitizeConfig = (config: McpSessionInspectorConfig): McpSessionInspectorConfig => {
  if (config.launch.kind !== 'stdio') {
    const url = new URL(config.launch.url);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return snapshot({ launch: { kind: config.launch.kind, url: url.toString() }, origin: 'artifact' });
  }
  const env = Object.fromEntries(Object.entries(config.launch.env).map(([name, value]) => [
    name,
    secretName.test(name) ? '[redacted]' : value,
  ]));
  return snapshot({
    launch: {
      args: [...config.launch.args],
      command: config.launch.command,
      ...(config.launch.cwd === undefined ? {} : { cwd: config.launch.cwd }),
      env,
      kind: 'stdio' as const,
    },
    origin: 'artifact' as const,
  });
};

const settledInvocation = (
  active: McpBrowserSessionActiveRequest,
  event: Extract<McpBrowserSessionEvent, { readonly type: 'request.settled' }>,
): McpBrowserSessionInvocation => snapshot({
  ...(active.binding === undefined ? {} : { binding: active.binding }),
  ...(event.error === undefined ? {} : { error: event.error }),
  id: active.id,
  operation: active.operation,
  ...(active.replayOf === undefined ? {} : { replayOf: active.replayOf }),
  request: active.request,
  ...(event.result === undefined ? {} : { result: event.result }),
  timing: {
    completedAt: event.completedAt,
    durationMs: Math.max(0, event.completedAt - active.startedAt),
    startedAt: active.startedAt,
  },
  ...(event.vector === undefined ? {} : { vector: event.vector }),
});

export const createMcpBrowserSessionModel = (sessionId: string): McpBrowserSessionModel => withViews({
  activeRequests: emptyActiveRequests,
  catalogs: emptyCatalogs,
  diagnostics: Object.freeze([]),
  phase: 'idle',
  sessionId,
  timeline: deepFreeze({ droppedThroughSequence: 0, entries: [], lastSequence: 0 }),
});

export const reduceMcpBrowserSession = (
  model: McpBrowserSessionModel,
  event: McpBrowserSessionEvent,
): McpBrowserSessionModel => {
  if (!allowedEventsByPhase[model.phase].includes(event.type)) return invalidTransition(model, event.type);
  switch (event.type) {
    case 'open':
      return update(model, { binding: snapshot(event.binding), phase: 'opening' });
    case 'binding':
      return update(model, { binding: snapshot(event.binding) });
    case 'connection':
      return update(model, { connection: snapshot(event.connection) });
    case 'catalogs':
      return update(model, { catalogs: snapshot(event.catalogs) });
    case 'config':
      return update(model, { config: sanitizeConfig(event.config) });
    case 'ready':
      return update(model, { phase: 'ready' });
    case 'restart':
      return update(model, { phase: 'restarting' });
    case 'close':
      return update(model, { phase: 'closing' });
    case 'closed':
      return update(model, { activeRequests: emptyActiveRequests, phase: 'closed' });
    case 'failed':
      return update(withDiagnostic(model, event.diagnostic), { phase: 'error' });
    case 'trace': {
      if (isReplayGap(event.entry)) {
        const gap = snapshot(event.entry);
        const rangeIsValid =
          Number.isSafeInteger(gap.requestedAfterSequence)
          && Number.isSafeInteger(gap.latestDroppedSequence)
          && Number.isSafeInteger(gap.earliestAvailableSequence)
          && gap.requestedAfterSequence === model.timeline.lastSequence
          && gap.latestDroppedSequence > gap.requestedAfterSequence
          && gap.earliestAvailableSequence === gap.latestDroppedSequence + 1;
        if (!rangeIsValid) {
          return withDiagnostic(model, {
            code: 'mcp.trace.invalid-replay-gap',
            message: `Ignored replay gap after ${gap.requestedAfterSequence} because its retained range is invalid.`,
            severity: 'warning',
          });
        }
        return update(model, {
          timeline: Object.freeze({
            droppedThroughSequence: gap.latestDroppedSequence,
            entries: Object.freeze([...model.timeline.entries, gap]),
            lastSequence: gap.latestDroppedSequence,
          }),
        });
      }
      const entry = snapshot(event.entry);
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= 0) {
        return withDiagnostic(model, {
          code: 'mcp.trace.non-monotonic',
          message: `Ignored trace sequence ${entry.sequence} because the current cursor is ${model.timeline.lastSequence}.`,
          severity: 'warning',
        });
      }
      if (model.timeline.droppedThroughSequence > 0 && entry.sequence <= model.timeline.droppedThroughSequence) {
        return withDiagnostic(model, {
          code: 'mcp.trace.dropped',
          message: `Ignored trace sequence ${entry.sequence} because it was dropped through ${model.timeline.droppedThroughSequence}.`,
          severity: 'warning',
        });
      }
      if (entry.sequence <= model.timeline.lastSequence) {
        return withDiagnostic(model, {
          code: 'mcp.trace.non-monotonic',
          message: `Ignored trace sequence ${entry.sequence} because the current cursor is ${model.timeline.lastSequence}.`,
          severity: 'warning',
        });
      }
      const expectedSequence = model.timeline.lastSequence + 1;
      if (entry.sequence !== expectedSequence) {
        return withDiagnostic(model, {
          code: 'mcp.trace.gap-required',
          message: `Expected trace sequence ${expectedSequence} but received ${entry.sequence}; an explicit replay gap is required.`,
          severity: 'warning',
        });
      }
      return update(model, {
        timeline: Object.freeze({
          droppedThroughSequence: model.timeline.droppedThroughSequence,
          entries: Object.freeze([...model.timeline.entries, entry]),
          lastSequence: entry.sequence,
        }),
      });
    }
    case 'request.start': {
      if (Object.hasOwn(model.activeRequests, event.request.id)) {
        return withDiagnostic(model, {
          code: 'mcp.request.duplicate',
          message: `Ignored duplicate active request ${event.request.id}.`,
          severity: 'warning',
        });
      }
      const binding = event.request.binding ?? model.binding;
      const active = snapshot({
        ...(binding === undefined ? {} : { binding }),
        id: event.request.id,
        operation: event.request.operation,
        ...(event.request.replayOf === undefined ? {} : { replayOf: event.request.replayOf }),
        request: event.request.request,
        startedAt: event.request.startedAt,
      });
      return update(model, {
        activeRequests: activeRequestsWith(model.activeRequests, active),
      });
    }
    case 'request.settled': {
      if (!Object.hasOwn(model.activeRequests, event.id)) {
        return withDiagnostic(model, {
          code: 'mcp.request.unknown',
          message: `Ignored settlement for unknown request ${event.id}.`,
          severity: 'warning',
        });
      }
      const active = model.activeRequests[event.id];
      const invocation: McpBrowserSessionInvocationTimelineEntry = snapshot({
        invocation: settledInvocation(active, event),
        type: 'invocation' as const,
      });
      return update(model, {
        activeRequests: activeRequestsWithout(model.activeRequests, event.id),
        timeline: Object.freeze({
          droppedThroughSequence: model.timeline.droppedThroughSequence,
          entries: Object.freeze([...model.timeline.entries, invocation]),
          lastSequence: model.timeline.lastSequence,
        }),
      });
    }
  }
};

export const invocationHistoryFor = (model: McpBrowserSessionModel): readonly McpBrowserSessionInvocation[] =>
  Object.freeze(model.timeline.entries.filter(isInvocationEntry).map((entry) => entry.invocation));
