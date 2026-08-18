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

const sorted = (values: readonly string[]): readonly string[] => Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));

/** Replay and stream records share a global sequence; live duplicates are ignored by sequence. */
export const mergeDevLogRecords = (
  existing: readonly DevLogRecord[],
  incoming: readonly DevLogRecord[],
): readonly DevLogRecord[] => {
  const records = new Map<number, DevLogRecord>();
  for (const record of [...existing, ...incoming]) {
    const prior = records.get(record.sequence);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record)) {
      throw new Error('Conflicting Dev Log record received.');
    }
    records.set(record.sequence, record);
  }
  return Object.freeze([...records.values()].sort((left, right) => left.sequence - right.sequence));
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
