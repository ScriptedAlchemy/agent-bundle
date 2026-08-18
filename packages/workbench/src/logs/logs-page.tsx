import React, { useEffect, useState } from 'react';

import type { DevLogRecord, DevLogReplayGap } from '../../../agent-bundle/src/dev/dev-log-service.ts';
import { LogClient, LogClientError } from './log-client.ts';
import { logsViewFor, mergeDevLogRecords, type LogsView as LogsViewModel } from './logs-model.ts';
import './logs-page.css';

export interface LogsPageProps {
  readonly client: Pick<LogClient, 'replay' | 'stream'>;
  /** A supplied snapshot keeps server/static rendering deterministic. */
  readonly records?: readonly DevLogRecord[];
}

const all = '';
const filter = (value: string): string | undefined => value === all ? undefined : value;
const errorMessage = (reason: unknown): string => {
  try { return reason instanceof Error && typeof reason.message === 'string' ? reason.message : 'Production logs could not be read.'; }
  catch { return 'Production logs could not be read.'; }
};
const isCursorAhead = (reason: unknown): boolean => {
  try { return reason instanceof LogClientError && reason.code === 'AB8092'; }
  catch { return false; }
};

export const LogsView = ({ view }: { readonly view: LogsViewModel }) => <div className="logs-trace">
  {view.gap === undefined ? undefined : <p className="logs-gap" role="status">Earlier records are no longer retained.</p>}
  <p className="logs-summary" role="status">{view.summary}</p>
  {view.records.length === 0 ? <p className="empty-row">No production log record matches this filter.</p> : <ol className="logs-entries">
    {view.records.map((record) => <li key={record.sequence}>
      <div className="logs-entry-head">
        <span className="logs-entry-sequence">#{record.sequence}</span>
        <time className="logs-entry-timestamp">{record.occurredAt}</time>
        <span className="logs-entry-source">{record.producer}</span>
        <span className={`logs-entry-level logs-entry-level--${record.level}`}>{record.level}</span>
        <span className="logs-entry-kind">{record.kind}</span>
      </div>
      <p className="logs-entry-summary">{record.summary}</p>
      <p className="logs-entry-binding">{Object.entries(record.context).map(([key, value]) => <span className="identifier" key={key}>{key} {value}</span>)}</p>
      <details className="logs-details"><summary>Details</summary><pre>{JSON.stringify({ context: record.context, details: record.details }, null, 2)}</pre></details>
    </li>)}
  </ol>}
</div>;

/** App-owned producer-wide log page, independent from durable playground sessions. */
export const LogsPage = ({ client, records: suppliedRecords }: LogsPageProps) => {
  const [error, setError] = useState<string>();
  const [gap, setGap] = useState<DevLogReplayGap>();
  const [kind, setKind] = useState(all);
  const [level, setLevel] = useState(all);
  const [producer, setProducer] = useState(all);
  const [context, setContext] = useState(all);
  const [records, setRecords] = useState<readonly DevLogRecord[]>(suppliedRecords ?? []);
  const view = logsViewFor({ context: filter(context), gap, kind: filter(kind), level: filter(level), producer: filter(producer), records });

  useEffect(() => {
    if (suppliedRecords !== undefined) return;
    let current = true;
    let latestSequence = 0;
    let observedRecords: readonly DevLogRecord[] = [];
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let stream: ReturnType<LogClient['stream']> | undefined;
    let generationController: AbortController | undefined;
    let generation = 0;
    const resetCursor = (): void => {
      latestSequence = 0;
      observedRecords = [];
      setRecords([]);
      setGap(undefined);
    };
    const recordLocalGap = (discardedThroughSequence: number): void => {
      setGap((previous) => {
        if (previous === undefined) return Object.freeze({
          earliestAvailableSequence: discardedThroughSequence + 1,
          latestDroppedSequence: discardedThroughSequence,
          requestedAfterSequence: 0,
          type: 'replay.gap' as const,
        });
        if (previous.latestDroppedSequence >= discardedThroughSequence) return previous;
        return Object.freeze({
          earliestAvailableSequence: discardedThroughSequence + 1,
          latestDroppedSequence: discardedThroughSequence,
          requestedAfterSequence: previous.requestedAfterSequence,
          type: 'replay.gap' as const,
        });
      });
    };
    const observe = (incoming: readonly DevLogRecord[]): boolean => {
      const merged = mergeDevLogRecords(observedRecords, incoming);
      if (merged.conflictSequence !== undefined) {
        setError('Production logs could not be read.');
        return false;
      }
      observedRecords = merged.records;
      setRecords(merged.records);
      if (merged.discardedThroughSequence !== undefined) recordLocalGap(merged.discardedThroughSequence);
      return true;
    };
    const reconnectLater = (): void => {
      if (!current) return;
      if (reconnect !== undefined) clearTimeout(reconnect);
      reconnect = setTimeout(() => { void connect(); }, 250);
    };
    const connect = async (): Promise<void> => {
      const attempt = generation + 1;
      generation = attempt;
      stream?.close();
      generationController?.abort();
      generationController = new AbortController();
      try {
        const replay = await client.replay(latestSequence, generationController.signal);
        if (!current || attempt !== generation) return;
        latestSequence = replay.cursor.afterSequence;
        setError(undefined);
        if (replay.gap !== undefined) setGap(replay.gap);
        if (!observe(replay.records)) return;
        stream = client.stream({
          afterSequence: latestSequence,
          signal: generationController.signal,
          onMessage: (message) => {
            if (!current || attempt !== generation) return;
            if ('type' in message) setGap(message);
            else {
              latestSequence = Math.max(latestSequence, message.sequence);
              observe([message]);
            }
          },
        });
        void stream.done.then(
          () => { if (attempt === generation) reconnectLater(); },
          (reason: unknown) => {
            if (!current || attempt !== generation) return;
            if (isCursorAhead(reason)) {
              resetCursor();
              void connect();
              return;
            }
            setError(errorMessage(reason));
            reconnectLater();
          },
        );
      } catch (reason) {
        if (!current || attempt !== generation) return;
        if (isCursorAhead(reason)) {
          resetCursor();
          void connect();
          return;
        }
        setError(errorMessage(reason));
        reconnectLater();
      }
    };
    void connect();
    return () => {
      current = false;
      generation += 1;
      if (reconnect !== undefined) clearTimeout(reconnect);
      generationController?.abort();
      stream?.close();
    };
  }, [client, suppliedRecords]);

  return <div className="logs-content">
    <div className="page-heading logs-page-heading"><div><h1>Logs</h1><p>Redacted production diagnostics from every Workbench producer.</p></div></div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    <section aria-label="Log filters" className="logs-controls">
      <label htmlFor="logs-producer">Producer</label><select id="logs-producer" onChange={(event) => setProducer(event.currentTarget.value)} value={producer}><option value={all}>All producers</option>{view.producers.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <label htmlFor="logs-level">Level</label><select id="logs-level" onChange={(event) => setLevel(event.currentTarget.value)} value={level}><option value={all}>All levels</option>{view.levels.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <label htmlFor="logs-kind">Kind</label><select id="logs-kind" onChange={(event) => setKind(event.currentTarget.value)} value={kind}><option value={all}>All kinds</option>{view.kinds.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <label htmlFor="logs-context">Context</label><select id="logs-context" onChange={(event) => setContext(event.currentTarget.value)} value={context}><option value={all}>All contexts</option>{view.contexts.map((value) => <option key={value} value={value}>{value}</option>)}</select>
    </section>
    <LogsView view={view} />
  </div>;
};
