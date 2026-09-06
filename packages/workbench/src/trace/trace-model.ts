/**
 * Pure model behind the Trace page (#600 PR 2): the ordered entry list, the
 * correlated groups it folds into, and the selection rules the URL drives. No
 * transport, no React; the page calls these with whatever the feed has
 * delivered so far.
 */
import type {
  TraceCorrelation,
  TraceEntry,
  TraceSource,
  TraceStatus,
} from '../../../agent-bundle/src/contracts/trace.ts';

/** Matches `TraceHub`'s default retention so the page never holds more than the server does. */
export const maximumTraceEntries = 4_096;

/**
 * The correlation keys entries join on, in the priority order that names a
 * group. `epochId`, `host`, and `routeId` are facets, not joins: every entry
 * of an epoch would otherwise become one group.
 */
export const traceJoinKeys = Object.freeze([
  'conversationId',
  'sessionId',
  'mcpSessionId',
  'invocationId',
  'executionId',
  'runId',
  'mcpRequestId',
  'correlationId',
] as const);

export type TraceJoinKey = (typeof traceJoinKeys)[number];

export type TraceGroupKeyKind = TraceJoinKey | 'entry';

export interface TraceRow {
  /** 0 for an invocation-level row, 1 for a row nested under its invocation. */
  readonly depth: 0 | 1;
  readonly entry: TraceEntry;
}

export interface TraceGroup {
  readonly endedAt: string;
  readonly firstSequence: number;
  /** The entry that names the group in the timeline header. */
  readonly headline: TraceEntry;
  /** Stable identity: the highest-priority join key the group shares, else the lone entry id. */
  readonly key: string;
  readonly keyKind: TraceGroupKeyKind;
  readonly lastSequence: number;
  readonly rows: readonly TraceRow[];
  /** First to last `occurredAt` in milliseconds; a lone entry reports its own `durationMs`. */
  readonly spanMs: number;
  readonly startedAt: string;
  readonly status: TraceStatus;
}

const millis = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * Replay and live entries share one server sequence: the result is ordered by
 * `sequence`, a sequence seen twice keeps the first copy, and the oldest
 * entries beyond {@link maximumTraceEntries} fall off the front.
 */
export const mergeTraceEntries = (
  existing: readonly TraceEntry[],
  incoming: readonly TraceEntry[],
): readonly TraceEntry[] => {
  const merged: TraceEntry[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  while (existingIndex < existing.length || incomingIndex < incoming.length) {
    const previous = existing[existingIndex];
    const next = incoming[incomingIndex];
    if (next === undefined || (previous !== undefined && previous.sequence < next.sequence)) {
      merged.push(previous!);
      existingIndex += 1;
    } else if (previous === undefined || next.sequence < previous.sequence) {
      merged.push(next);
      incomingIndex += 1;
    } else {
      merged.push(previous);
      existingIndex += 1;
      incomingIndex += 1;
    }
  }
  return Object.freeze(merged.slice(-maximumTraceEntries));
};

/** `mcpRequestId` is only meaningful within its session; session ids join across publishers. */
const joinValue = (correlation: TraceCorrelation, key: TraceJoinKey): string | undefined => {
  const value = correlation[key];
  if (value === undefined) return undefined;
  if (key !== 'mcpRequestId') return value;
  return correlation.mcpSessionId === undefined ? undefined : `${correlation.mcpSessionId}/${value}`;
};

const joinToken = (correlation: TraceCorrelation, key: TraceJoinKey): string | undefined => {
  const value = joinValue(correlation, key);
  return value === undefined ? undefined : `correlation:${value}`;
};

const headlinePriority: Readonly<Record<TraceSource, number>> = Object.freeze({
  hook: 0,
  invocation: 1,
  runtime: 2,
  mcp: 3,
  kernel: 4,
  diagnostic: 5,
  log: 6,
});

const isInvocationLevel = (entry: TraceEntry): boolean => {
  switch (entry.source) {
    case 'hook':
    case 'invocation':
    case 'runtime':
      return true;
    case 'kernel':
    case 'mcp':
    case 'log':
    case 'diagnostic':
      return false;
    default: {
      const exhaustive: never = entry.source;
      return exhaustive;
    }
  }
};

const groupStatus = (entries: readonly TraceEntry[]): TraceStatus => {
  if (entries.some((entry) => entry.status === 'error')) return 'error';
  return entries.at(-1)?.status === 'running' ? 'running' : 'ok';
};

const groupFor = (entries: readonly TraceEntry[]): TraceGroup => {
  const first = entries[0]!;
  const last = entries.at(-1)!;
  let key = `entry:${first.id}`;
  let keyKind: TraceGroupKeyKind = 'entry';
  search: for (const joinKey of traceJoinKeys) {
    for (const entry of entries) {
      const value = joinValue(entry.correlation, joinKey);
      if (value === undefined) continue;
      key = `${joinKey}:${value}`;
      keyKind = joinKey;
      break search;
    }
  }
  const headline = entries.reduce((best, entry) =>
    headlinePriority[entry.source] < headlinePriority[best.source] ? entry : best, first);
  const rows = entries.map((entry): TraceRow => Object.freeze({
    depth: isInvocationLevel(entry) || entries.length === 1 ? 0 : 1,
    entry,
  }));
  return Object.freeze({
    endedAt: last.occurredAt,
    firstSequence: first.sequence,
    headline,
    key,
    keyKind,
    lastSequence: last.sequence,
    rows: Object.freeze(rows),
    spanMs: entries.length === 1 ? first.durationMs ?? 0 : Math.max(0, millis(last.occurredAt) - millis(first.occurredAt)),
    startedAt: first.occurredAt,
    status: groupStatus(entries),
  });
};

/**
 * Folds entries into correlated groups: two entries share a group when they
 * share any join key, transitively, so a kernel event that knows only its
 * `executionId` still lands beside the invocation that also carries the
 * `conversationId`. Groups are ordered by their first entry; rows within a
 * group by sequence. Entries with no join key are groups of one.
 */
export const groupTraceEntries = (entries: readonly TraceEntry[]): readonly TraceGroup[] => {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = node;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const entryNode = (entry: TraceEntry): string => `entry:${entry.id}`;
  for (const entry of entries) {
    const node = entryNode(entry);
    parent.set(node, node);
    for (const joinKey of traceJoinKeys) {
      const token = joinToken(entry.correlation, joinKey);
      if (token === undefined) continue;
      if (!parent.has(token)) parent.set(token, token);
      union(node, token);
    }
  }
  const members = new Map<string, TraceEntry[]>();
  for (const entry of entries) {
    const root = find(entryNode(entry));
    const list = members.get(root);
    if (list === undefined) members.set(root, [entry]);
    else list.push(entry);
  }
  return Object.freeze([...members.values()].map((list) => groupFor(Object.freeze(list))));
};

/** Every correlation value on an entry, plus its own id: what `?correlation=` may name. */
export const traceEntryCorrelationValues = (entry: TraceEntry): readonly string[] => Object.freeze([
  entry.id,
  ...Object.values(entry.correlation).filter((value): value is string => typeof value === 'string'),
]);

/** The group holding any entry that carries `id` as one of its correlation values (or as its own id). */
export const selectTraceGroup = (groups: readonly TraceGroup[], id: string): TraceGroup | undefined =>
  groups.find((group) => group.rows.some((row) => traceEntryCorrelationValues(row.entry).includes(id)));

/**
 * `/trace/<id>`: the entry with that id. A PR 1 deep link named an invocation
 * id, so an `inv_…` id still resolves — to the latest entry of that invocation.
 */
export const selectTraceEntry = (entries: readonly TraceEntry[], id: string): TraceEntry | undefined =>
  entries.find((entry) => entry.id === id) ??
  entries.findLast((entry) => entry.correlation.invocationId === id || entry.correlation.runId === id);

const timeFormats = new Map<string | undefined, Intl.DateTimeFormat>();

/** `HH:MM:SS.mmm`; local time unless a zone is given (tests pass `UTC`). */
export const formatTraceTime = (value: string, timeZone?: string): string => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  let format = timeFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-GB', {
      fractionalSecondDigits: 3,
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
      ...(timeZone === undefined ? {} : { timeZone }),
    });
    timeFormats.set(timeZone, format);
  }
  return format.format(new Date(parsed));
};

export const formatTraceDuration = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1) return '<1 ms';
  if (value < 1000) return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ms`;
  return `${(value / 1000).toFixed(2)} s`;
};

/** The glyph the timeline puts in front of a row, one per source. */
export const traceSourceGlyph = (source: TraceSource): string => {
  switch (source) {
    case 'invocation':
      return '▶';
    case 'kernel':
      return '⚙';
    case 'mcp':
      return '⇄';
    case 'runtime':
      return '◈';
    case 'hook':
      return '⚑';
    case 'log':
      return '≡';
    case 'diagnostic':
      return '⚠';
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};

const kindLabels: ReadonlyMap<string, string> = new Map([
  ['invocation.started', 'invocation started'],
  ['invocation.completed', 'invocation completed'],
  ['invocation.failed', 'invocation failed'],
  ['kernel.preflight.start', 'preflight'],
  ['kernel.preflight.outcome', 'preflight outcome'],
  ['kernel.execute.start', 'execute'],
  ['kernel.providers.start', 'providers'],
  ['kernel.providers.finish', 'providers finished'],
  ['kernel.render.start', 'render'],
  ['kernel.render.finish', 'render finished'],
  ['kernel.failure', 'kernel failure'],
  ['mcp.request', 'MCP request'],
  ['mcp.response', 'MCP response'],
  ['mcp.notification', 'MCP notification'],
  ['mcp.progress', 'MCP progress'],
  ['mcp.logging', 'MCP log'],
  ['mcp.session.started', 'MCP session started'],
  ['mcp.session.closed', 'MCP session closed'],
  ['mcp.stderr', 'MCP stderr'],
  ['runtime.run.started', 'run started'],
  ['runtime.run.completed', 'run completed'],
  ['runtime.run.failed', 'run failed'],
  ['runtime.generation.published', 'generation published'],
  ['runtime.app.updated', 'app updated'],
  ['hook.received', 'hook received'],
  ['hook.completed', 'hook completed'],
  ['hook.failed', 'hook failed'],
  ['session.started', 'session started'],
  ['session.ended', 'session ended'],
  ['diagnostic.build.failed', 'build failed'],
  ['diagnostic.contract.failed', 'contract failed'],
  ['diagnostic.host.sync', 'host sync'],
]);

/**
 * The short label for a row's `kind`: the vocabulary in the PR 2 brief maps to
 * a phrase; `log.<producer>.<kind>` shows `<producer> <kind>`; anything else
 * shows its dotted tail with the source prefix removed.
 */
export const traceKindLabel = (entry: TraceEntry): string => {
  const known = kindLabels.get(entry.kind);
  if (known !== undefined) return known;
  const prefix = `${entry.source}.`;
  const tail = entry.kind.startsWith(prefix) ? entry.kind.slice(prefix.length) : entry.kind;
  return tail.split('.').join(' ');
};
