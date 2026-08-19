import type { DevLogRecord, DevLogReplayGap } from '../../../agent-bundle/src/dev/dev-log-service.ts';

export interface LogsViewOptions {
  readonly context: string | undefined;
  readonly gap: DevLogReplayGap | undefined;
  readonly kind: string | undefined;
  readonly level: string | undefined;
  readonly producer: string | undefined;
  readonly records: readonly DevLogRecord[];
}

export interface LogsView {
  readonly contexts: readonly string[];
  readonly gap: DevLogReplayGap | undefined;
  readonly kinds: readonly string[];
  readonly levels: readonly string[];
  readonly producers: readonly string[];
  readonly records: readonly DevLogRecord[];
  readonly summary: string;
  readonly total: number;
}

export const maximumLogViewRecords = 2_048;

const sorted = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));

export interface DevLogRecordMerge {
  readonly conflictSequence?: number;
  readonly discardedThroughSequence?: number;
  readonly records: readonly DevLogRecord[];
}

const jsonEquivalent = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => jsonEquivalent(entry, right[index]));
  }
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && jsonEquivalent(value, rightEntries[index]?.[1]));
};

const recordsEquivalent = (left: DevLogRecord, right: DevLogRecord): boolean =>
  left.sequence === right.sequence && left.producer === right.producer && left.level === right.level &&
  left.kind === right.kind && left.occurredAt === right.occurredAt && left.summary === right.summary &&
  jsonEquivalent(left.context, right.context) && jsonEquivalent(left.details, right.details);

/** Replay and stream records share a global sequence; live duplicates are ignored by sequence. */
export const mergeDevLogRecords = (
  existing: readonly DevLogRecord[],
  incoming: readonly DevLogRecord[],
): DevLogRecordMerge => {
  const records: DevLogRecord[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  let conflictSequence: number | undefined;
  while (existingIndex < existing.length || incomingIndex < incoming.length) {
    const previous = existing[existingIndex];
    const next = incoming[incomingIndex];
    if (next === undefined || (previous !== undefined && previous.sequence < next.sequence)) {
      records.push(previous);
      existingIndex += 1;
    } else if (previous === undefined || next.sequence < previous.sequence) {
      records.push(next);
      incomingIndex += 1;
    } else {
      records.push(previous);
      if (!recordsEquivalent(previous, next)) conflictSequence ??= previous.sequence;
      existingIndex += 1;
      incomingIndex += 1;
    }
  }
  const discardedThroughSequence = records.length > maximumLogViewRecords ? records.at(-(maximumLogViewRecords + 1))?.sequence : undefined;
  return Object.freeze({
    ...(conflictSequence === undefined ? {} : { conflictSequence }),
    ...(discardedThroughSequence === undefined ? {} : { discardedThroughSequence }),
    records: Object.freeze(records.slice(-maximumLogViewRecords)),
  });
};

/** Derives the complete logs page from production records only; no playground session is involved. */
export const logsViewFor = (options: LogsViewOptions): LogsView => {
  const records = options.records.filter((record) =>
    (options.producer === undefined || record.producer === options.producer) &&
    (options.level === undefined || record.level === options.level) &&
    (options.kind === undefined || record.kind === options.kind) &&
    (options.context === undefined || Object.values(record.context).some((value) => value === options.context)),
  );
  const total = options.records.length;
  return Object.freeze({
    contexts: sorted(options.records.flatMap((record) => Object.values(record.context))),
    gap: options.gap,
    kinds: sorted(options.records.map((record) => record.kind)),
    levels: sorted(options.records.map((record) => record.level)),
    producers: sorted(options.records.map((record) => record.producer)),
    records: Object.freeze([...records].sort((left, right) => right.sequence - left.sequence)),
    summary: `Showing ${String(records.length)} of ${String(total)} production log records.`,
    total,
  });
};
