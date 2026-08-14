import type {
  McpSessionBinding,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceReplayGap,
} from '../../../agent-bundle/src/dev/mcp-session-protocol.ts';

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
  readonly binding?: McpSessionBinding;
  readonly error?: unknown;
  readonly id: string;
  readonly operation: McpSessionOperation;
  readonly replayOf?: string;
  readonly request: unknown;
  readonly result?: unknown;
  readonly timing: McpBrowserSessionTiming;
}

export interface McpBrowserSessionActiveRequest {
  readonly binding?: McpSessionBinding;
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

export type McpBrowserSessionTimelineEntry =
  | McpSessionTraceEntry
  | McpSessionTraceReplayGap
  | McpBrowserSessionInvocationTimelineEntry;

export interface McpBrowserSessionTimeline {
  readonly entries: readonly McpBrowserSessionTimelineEntry[];
  readonly lastSequence: number;
}

export interface McpBrowserSessionModel {
  readonly activeRequests: Readonly<Record<string, McpBrowserSessionActiveRequest>>;
  readonly binding?: McpSessionBinding;
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
  | Readonly<{ readonly binding: McpSessionBinding; readonly type: 'open' }>
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
  }>
  | Readonly<{ readonly diagnostic: McpBrowserSessionDiagnostic; readonly type: 'failed' }>
  | Readonly<{ readonly type: 'ready' | 'restart' | 'close' | 'closed' }>;

const emptyCatalogs = Object.freeze({
  prompts: Object.freeze([]),
  resourceTemplates: Object.freeze([]),
  resources: Object.freeze([]),
  tools: Object.freeze([]),
});

const secretName = /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/iu;

const snapshot = <Value>(value: Value, seen = new Map<object, unknown>()): Value => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') {
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('MCP session model snapshots must be JSON-like values.');
  const known = seen.get(value);
  if (known !== undefined) return known as Value;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(snapshot(item, seen));
    return Object.freeze(copy) as Value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('MCP session model snapshots must be plain objects.');
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: snapshot(item, seen),
      writable: true,
    });
  }
  return Object.freeze(copy) as Value;
};

const isReplayGap = (entry: McpSessionTraceEntry | McpSessionTraceReplayGap): entry is McpSessionTraceReplayGap =>
  'type' in entry && entry.type === 'replay.gap';

const isLoggingEntry = (entry: McpBrowserSessionTimelineEntry): entry is Extract<McpSessionTraceEntry, { readonly kind: 'logging' }> =>
  'kind' in entry && entry.kind === 'logging';

const isProgressEntry = (entry: McpBrowserSessionTimelineEntry): entry is Extract<McpSessionTraceEntry, { readonly kind: 'progress' }> =>
  'kind' in entry && entry.kind === 'progress';

const isInvocationEntry = (entry: McpBrowserSessionTimelineEntry): entry is McpBrowserSessionInvocationTimelineEntry =>
  'type' in entry && entry.type === 'invocation';

const withViews = (model: Omit<McpBrowserSessionModel, 'conciseTrace' | 'logs' | 'progress'>): McpBrowserSessionModel => {
  const entries = model.timeline.entries;
  return Object.freeze({
    ...model,
    conciseTrace: Object.freeze([...entries]),
    logs: Object.freeze(entries.filter(isLoggingEntry)),
    progress: Object.freeze(entries.filter(isProgressEntry)),
  });
};

const update = (
  model: McpBrowserSessionModel,
  change: Partial<Omit<McpBrowserSessionModel, 'conciseTrace' | 'logs' | 'progress'>>,
): McpBrowserSessionModel => withViews({ ...model, ...change });

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
});

export const createMcpBrowserSessionModel = (sessionId: string): McpBrowserSessionModel => withViews({
  activeRequests: Object.freeze({}),
  catalogs: emptyCatalogs,
  diagnostics: Object.freeze([]),
  phase: 'idle',
  sessionId,
  timeline: Object.freeze({ entries: Object.freeze([]), lastSequence: 0 }),
});

export const reduceMcpBrowserSession = (
  model: McpBrowserSessionModel,
  event: McpBrowserSessionEvent,
): McpBrowserSessionModel => {
  switch (event.type) {
    case 'open':
      return update(model, { binding: snapshot(event.binding), phase: 'opening' });
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
      return update(model, { activeRequests: Object.freeze({}), phase: 'closed' });
    case 'failed':
      return update(withDiagnostic(model, event.diagnostic), { phase: 'error' });
    case 'trace': {
      if (isReplayGap(event.entry)) {
        return update(model, {
          timeline: Object.freeze({
            entries: Object.freeze([...model.timeline.entries, snapshot(event.entry)]),
            lastSequence: model.timeline.lastSequence,
          }),
        });
      }
      if (!Number.isSafeInteger(event.entry.sequence) || event.entry.sequence <= model.timeline.lastSequence) {
        return withDiagnostic(model, {
          code: 'mcp.trace.non-monotonic',
          message: `Ignored trace sequence ${event.entry.sequence} because the current cursor is ${model.timeline.lastSequence}.`,
          severity: 'warning',
        });
      }
      return update(model, {
        timeline: Object.freeze({
          entries: Object.freeze([...model.timeline.entries, snapshot(event.entry)]),
          lastSequence: event.entry.sequence,
        }),
      });
    }
    case 'request.start': {
      if (model.activeRequests[event.request.id] !== undefined) {
        return withDiagnostic(model, {
          code: 'mcp.request.duplicate',
          message: `Ignored duplicate active request ${event.request.id}.`,
          severity: 'warning',
        });
      }
      const active = snapshot({
        ...event.request,
        ...(event.request.binding === undefined && model.binding !== undefined ? { binding: model.binding } : {}),
      });
      return update(model, {
        activeRequests: Object.freeze({ ...model.activeRequests, [active.id]: active }),
      });
    }
    case 'request.settled': {
      const active = model.activeRequests[event.id];
      if (active === undefined) {
        return withDiagnostic(model, {
          code: 'mcp.request.unknown',
          message: `Ignored settlement for unknown request ${event.id}.`,
          severity: 'warning',
        });
      }
      const { [event.id]: _settled, ...remaining } = model.activeRequests;
      const invocation: McpBrowserSessionInvocationTimelineEntry = snapshot({
        invocation: settledInvocation(active, event),
        type: 'invocation' as const,
      });
      return update(model, {
        activeRequests: Object.freeze(remaining),
        timeline: Object.freeze({
          entries: Object.freeze([...model.timeline.entries, invocation]),
          lastSequence: model.timeline.lastSequence,
        }),
      });
    }
  }
};

export const invocationHistoryFor = (model: McpBrowserSessionModel): readonly McpBrowserSessionInvocation[] =>
  Object.freeze(model.timeline.entries.filter(isInvocationEntry).map((entry) => entry.invocation));
