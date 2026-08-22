import type {
  PlaygroundEpochIdentity,
  PlaygroundExport,
  PlaygroundJsonValue,
  PlaygroundSession,
  PlaygroundTarget,
  PlaygroundTraceEvent,
  PlaygroundTraceSource,
} from '../../../agent-bundle/src/contracts/playground.ts';
import type { PlaygroundOperationRequest } from '../../../agent-bundle/src/contracts/playground.ts';
import type { NativePlaygroundCatalog, NativePlaygroundHost } from '../../../agent-bundle/src/contracts/playground.ts';

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

/** Browser state for opaque native catalog identities; it never contains an executable or model value. */
export interface NativePlaygroundSelection {
  readonly caseId: string;
  readonly epochId: string;
  readonly fixtureId: string;
  readonly host: '' | NativePlaygroundHost;
  readonly modelPinId: string;
}

export interface NativePlaygroundRequestOptions {
  readonly catalog: NativePlaygroundCatalog | undefined;
  readonly prompt: string;
  readonly selection: NativePlaygroundSelection;
  readonly target: string;
  readonly targets: readonly PlaygroundTarget[];
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

const emptyNativeSelection = (epochId = ''): NativePlaygroundSelection => Object.freeze({
  caseId: '', epochId, fixtureId: '', host: '', modelPinId: '',
});

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

const nativeSelectionExists = (
  catalog: NativePlaygroundCatalog,
  selection: Pick<NativePlaygroundSelection, 'caseId' | 'fixtureId' | 'host' | 'modelPinId'>,
): boolean => selection.host !== '' && catalog.selections.some((candidate) =>
  candidate.caseId === selection.caseId && candidate.fixtureId === selection.fixtureId &&
  candidate.host === selection.host && candidate.modelPinId === selection.modelPinId,
);

/**
 * Retains only IDs that still compose an advertised selection in the current
 * immutable catalog. Callers can render this immediately while synchronizing
 * their form state after a rebuild or a parent picker changes.
 */
export const nativeSelectionFor = (
  catalog: NativePlaygroundCatalog | undefined,
  selection: NativePlaygroundSelection,
): NativePlaygroundSelection => {
  if (catalog === undefined || selection.epochId !== catalog.epochId) return emptyNativeSelection(catalog?.epochId ?? '');
  const caseId = catalog.cases.some((entry) => entry.id === selection.caseId) ? selection.caseId : '';
  const host = (selection.host === 'claude' || selection.host === 'codex') &&
    catalog.selections.some((entry) => entry.caseId === caseId && entry.host === selection.host)
    ? selection.host
    : '';
  const fixtureId = catalog.fixtures.some((entry) => entry.id === selection.fixtureId) &&
    catalog.selections.some((entry) => entry.caseId === caseId && entry.fixtureId === selection.fixtureId && entry.host === host)
    ? selection.fixtureId
    : '';
  const modelPinId = catalog.modelPins.some((entry) => entry.id === selection.modelPinId && entry.host === host) &&
    nativeSelectionExists(catalog, { caseId, fixtureId, host, modelPinId: selection.modelPinId })
    ? selection.modelPinId
    : '';
  return Object.freeze({ caseId, epochId: catalog.epochId, fixtureId, host, modelPinId });
};

/** Builds the only native browser request after every selectable identity proves membership in the current catalog. */
export const nativePlaygroundRequestFor = (options: NativePlaygroundRequestOptions): Extract<PlaygroundOperationRequest, { readonly operation: 'native.prompt' }> | undefined => {
  const catalog = options.catalog;
  const selection = nativeSelectionFor(catalog, options.selection);
  if (catalog === undefined || options.prompt.trim().length === 0 || !options.targets.some((entry) => entry.name === options.target) ||
    selection.host === '' || !nativeSelectionExists(catalog, selection)) return undefined;
  return Object.freeze({
    caseId: selection.caseId,
    epochId: catalog.epochId,
    fixtureId: selection.fixtureId,
    host: selection.host,
    modelPinId: selection.modelPinId,
    operation: 'native.prompt' as const,
    prompt: options.prompt,
    target: options.target,
  });
};

const nativeInvocationRowsFor = (session: PlaygroundSession): readonly PlaygroundDetailRow[] => {
  if (session.identity.invocation.kind !== 'native.prompt') return noRows;
  const intent = session.identity.invocation.intent;
  const value = (key: string): string | undefined => typeof intent[key] === 'string' ? intent[key] : undefined;
  const host = value('host');
  const caseId = value('caseId');
  const fixtureId = value('fixtureId');
  const modelPinId = value('modelPinId');
  return Object.freeze([
    ...(host === undefined ? [] : [row('Native host', host)]),
    ...(caseId === undefined ? [] : [row('Native case', caseId)]),
    ...(fixtureId === undefined ? [] : [row('Requested fixture', fixtureId)]),
    ...(modelPinId === undefined ? [] : [row('Authored model pin', modelPinId)]),
  ]);
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
  ...nativeInvocationRowsFor(session),
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
