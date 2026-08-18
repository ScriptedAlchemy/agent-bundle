import type {
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonValue,
  PlaygroundSession,
  PlaygroundTraceEvent,
  PlaygroundTraceSource,
} from '../../../agent-bundle/src/services/playground-service.ts';

export type PlaygroundState = 'finalized' | 'no-epoch' | 'no-session' | 'open';

export interface PlaygroundDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface PlaygroundTraceRow {
  readonly epochDigest: string;
  readonly epochId: string;
  readonly key: string;
  readonly kind: string;
  readonly raw: PlaygroundJsonValue;
  readonly rawEventRef: string;
  readonly sequence: number;
  readonly source: PlaygroundTraceSource;
  readonly summary: string;
  readonly timestamp: string;
}

export interface PlaygroundViewOptions {
  readonly epoch: PlaygroundEpochIdentity | undefined;
  readonly events: readonly PlaygroundTraceEvent[];
  readonly exported: PlaygroundExport | undefined;
  readonly selectedRefs: readonly string[];
  readonly session: PlaygroundSession | undefined;
}

export interface PlaygroundView {
  readonly canPromote: boolean;
  readonly cursor: number;
  readonly exported: PlaygroundExport | undefined;
  readonly identity: readonly PlaygroundDetailRow[];
  readonly outcome: readonly PlaygroundDetailRow[];
  readonly promotionBlocker: string | undefined;
  /** References are accepted only when they were observed in the persisted server trace. */
  readonly rawEventRefs: readonly string[];
  readonly rows: readonly PlaygroundTraceRow[];
  readonly selectedRefs: readonly string[];
  readonly state: PlaygroundState;
  readonly summary: string;
  readonly workspace: PlaygroundJsonValue | undefined;
}

export interface PlaygroundLogsViewOptions {
  readonly epoch: PlaygroundEpochIdentity | undefined;
  readonly events: readonly PlaygroundTraceEvent[];
  readonly kind: string | undefined;
  readonly session: PlaygroundSession | undefined;
  readonly source: string | undefined;
}

export interface PlaygroundLogsView {
  readonly kinds: readonly string[];
  readonly rows: readonly PlaygroundTraceRow[];
  readonly sources: readonly string[];
  readonly state: PlaygroundState;
  readonly summary: string;
  readonly total: number;
}

/** A stream/replay collision means the server trace cannot be trusted as one ordered history. */
export class PlaygroundTraceConflictError extends Error {
  readonly code = 'AB8043';

  constructor() {
    super('Conflicting playground trace event received.');
  }
}

const noRows: readonly PlaygroundDetailRow[] = Object.freeze([]);

const noTraceRows: readonly PlaygroundTraceRow[] = Object.freeze([]);

const noStrings: readonly string[] = Object.freeze([]);

const row = (label: string, value: string): PlaygroundDetailRow => Object.freeze({ label, value });

const bySequence = (left: PlaygroundTraceEvent, right: PlaygroundTraceEvent): number => left.sequence - right.sequence;

const sameJson = (left: PlaygroundJsonValue, right: PlaygroundJsonValue): boolean => {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => sameJson(entry, right[index]!));
  }
  const leftRecord = left as Readonly<Record<string, PlaygroundJsonValue>>;
  const rightRecord = right as Readonly<Record<string, PlaygroundJsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key]!, rightRecord[key]!));
};

const sameTraceEvent = (left: PlaygroundTraceEvent, right: PlaygroundTraceEvent): boolean =>
  left.kind === right.kind && left.rawEventRef === right.rawEventRef && left.sequence === right.sequence &&
  left.source === right.source && left.summary === right.summary && left.timestamp === right.timestamp && sameJson(left.raw, right.raw);

export const formatPlaygroundJson = (value: PlaygroundJsonValue): string => JSON.stringify(value, undefined, 2);

/** Replay and stream frames overlap by design, so the ordered trace is keyed on the durable sequence. */
export const mergePlaygroundEvents = (
  existing: readonly PlaygroundTraceEvent[],
  incoming: readonly PlaygroundTraceEvent[],
): readonly PlaygroundTraceEvent[] => {
  const byRawEventRef = new Map<string, PlaygroundTraceEvent>();
  const bySequenceIndex = new Map<number, PlaygroundTraceEvent>();
  for (const event of [...existing, ...incoming]) {
    const sequenceMatch = bySequenceIndex.get(event.sequence);
    const referenceMatch = byRawEventRef.get(event.rawEventRef);
    if ((sequenceMatch !== undefined && !sameTraceEvent(sequenceMatch, event)) ||
      (referenceMatch !== undefined && !sameTraceEvent(referenceMatch, event))) {
      throw new PlaygroundTraceConflictError();
    }
    bySequenceIndex.set(event.sequence, event);
    byRawEventRef.set(event.rawEventRef, event);
  }
  return Object.freeze([...bySequenceIndex.values()].sort(bySequence));
};

export const playgroundTraceRowsFor = (
  epoch: PlaygroundEpochIdentity,
  events: readonly PlaygroundTraceEvent[],
): readonly PlaygroundTraceRow[] => Object.freeze(
  [...events].sort(bySequence).map((event): PlaygroundTraceRow => Object.freeze({
    epochDigest: epoch.digest,
    epochId: epoch.id,
    key: event.rawEventRef,
    kind: event.kind,
    raw: event.raw,
    rawEventRef: event.rawEventRef,
    sequence: event.sequence,
    source: event.source,
    summary: event.summary,
    timestamp: event.timestamp,
  })),
);

const persistedRefsFor = (
  rows: readonly PlaygroundTraceRow[],
  selectedRefs: readonly string[],
): readonly string[] => {
  const selected = new Set(selectedRefs);
  return Object.freeze(rows.filter((entry) => selected.has(entry.rawEventRef)).map((entry) => entry.rawEventRef));
};

const identityRowsFor = (session: PlaygroundSession): readonly PlaygroundDetailRow[] => Object.freeze([
  row('Session', session.id),
  row('Session state', session.state),
  row('Epoch', session.identity.epoch.id),
  row('Epoch digest', session.identity.epoch.digest),
  row('Fixture', session.identity.fixture.id),
  row('Fixture digest', session.identity.fixture.digest),
  row('Target', session.identity.target.name),
  ...(session.identity.target.digest === undefined ? [] : [row('Target digest', session.identity.target.digest)]),
  row('Task', session.identity.task.id),
  row('Invocation kind', session.identity.invocation.kind),
]);

const outcomeRowsFor = (session: PlaygroundSession): readonly PlaygroundDetailRow[] => {
  const outcome = session.outcome;
  if (outcome === undefined) return noRows;
  return Object.freeze([
    row('Status', outcome.status),
    ...(outcome.response === undefined ? [] : [row('Response', outcome.response)]),
  ]);
};

const stateFor = (
  epoch: PlaygroundEpochIdentity | undefined,
  session: PlaygroundSession | undefined,
): PlaygroundState => {
  if (epoch === undefined && session === undefined) return 'no-epoch';
  if (session === undefined) return 'no-session';
  return session.state === 'finalized' ? 'finalized' : 'open';
};

const summaryFor = (
  state: PlaygroundState,
  epoch: PlaygroundEpochIdentity | undefined,
  session: PlaygroundSession | undefined,
  count: number,
): string => {
  if (state === 'no-epoch') return 'No artifact epoch is active, so no playground session can be bound to one.';
  if (state === 'no-session' || session === undefined) {
    return `Start a server-owned playground run against epoch ${epoch?.id ?? 'unknown'} to record an ordered trace.`;
  }
  const suffix = `epoch ${session.identity.epoch.id} with ${String(count)} recorded ${count === 1 ? 'event' : 'events'}.`;
  if (state === 'finalized') {
    return `Session ${session.id} is finalized on ${suffix}`;
  }
  return `Session ${session.id} is ${session.state} on ${suffix}`;
};

const promotionBlockerFor = (
  state: PlaygroundState,
  rawEventRefs: readonly string[],
): string | undefined => {
  if (state !== 'finalized') {
    return 'Wait for the server-owned run to reach a durable terminal state before promoting this trace.';
  }
  if (rawEventRefs.length === 0) return 'Select at least one persisted trace event for the draft eval case.';
  return undefined;
};

/** Derives the whole Playground page from the active epoch, the session, and the ordered trace. */
export const playgroundViewFor = (options: PlaygroundViewOptions): PlaygroundView => {
  const session = options.session;
  const state = stateFor(options.epoch, session);
  const boundEpoch = session?.identity.epoch ?? options.epoch;
  const rows = boundEpoch === undefined ? noTraceRows : playgroundTraceRowsFor(boundEpoch, options.events);
  const rawEventRefs = session === undefined ? noStrings : persistedRefsFor(rows, options.selectedRefs);
  const promotionBlocker = promotionBlockerFor(state, rawEventRefs);
  return Object.freeze({
    canPromote: promotionBlocker === undefined,
    cursor: rows.reduce((highest, entry) => Math.max(highest, entry.sequence), 0),
    exported: options.exported,
    identity: session === undefined ? noRows : identityRowsFor(session),
    outcome: session === undefined ? noRows : outcomeRowsFor(session),
    promotionBlocker,
    rawEventRefs,
    rows,
    selectedRefs: rawEventRefs,
    state,
    summary: summaryFor(state, options.epoch, session, rows.length),
    workspace: session?.outcome?.workspace,
  });
};

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));

/** The Logs page reads the same ordered trace, newest first, narrowed to one source and kind. */
export const playgroundLogsViewFor = (options: PlaygroundLogsViewOptions): PlaygroundLogsView => {
  const session = options.session;
  const state = stateFor(options.epoch, session);
  const boundEpoch = session?.identity.epoch ?? options.epoch;
  const rows = boundEpoch === undefined || session === undefined
    ? noTraceRows
    : playgroundTraceRowsFor(boundEpoch, options.events);
  const filtered = rows.filter((entry) =>
    (options.source === undefined || entry.source === options.source) &&
    (options.kind === undefined || entry.kind === options.kind));
  const summary = session === undefined
    ? summaryFor(state, options.epoch, session, 0)
    : `Showing ${String(filtered.length)} of ${String(rows.length)} trace events for session ${session.id} on epoch ${session.identity.epoch.id}.`;
  return Object.freeze({
    kinds: rows.length === 0 ? noStrings : uniqueSorted(rows.map((entry) => entry.kind)),
    rows: Object.freeze([...filtered].reverse()),
    sources: rows.length === 0 ? noStrings : uniqueSorted(rows.map((entry) => entry.source)),
    state,
    summary,
    total: rows.length,
  });
};
