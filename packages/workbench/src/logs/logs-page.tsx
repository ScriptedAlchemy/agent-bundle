import React, { useEffect, useState } from 'react';

import type { DevLogRecord, DevLogReplayGap } from '../../../agent-bundle/src/dev/dev-log-service.ts';
import { LogClient } from './log-client.ts';
import { logsViewFor, mergeDevLogRecords, type LogsView as LogsViewModel } from './logs-model.ts';
import './logs-page.css';

export interface LogsPageProps {
  readonly client: Pick<LogClient, 'replay' | 'stream'>;
  /** A supplied snapshot keeps server/static rendering deterministic. */
  readonly records?: readonly DevLogRecord[];
}

const all = 'all';
const filter = (value: string): string | undefined => value === all ? undefined : value;
const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : 'Production logs could not be read.';

export const LogsView = ({ view }: { readonly view: LogsViewModel }) => <div className="logs-trace">
  {view.gap === undefined ? undefined : <p className="logs-gap" role="status">Earlier records are no longer retained.</p>}
  <p className="logs-summary" role="status">{view.summary}</p>
  {view.records.length === 0 ? <p className="empty-row">No production log record matches this filter.</p> : <ol className="logs-entries">
    {view.records.map((record) => <li key={record.sequence}>
      <div className="logs-entry-head">
        <span className="logs-entry-sequence">#{record.sequence}</span>
        <time className="logs-entry-timestamp">{record.occurredAt}</time>
        <span className="logs-entry-source">{record.producer}</span>
        <span className="logs-entry-kind">{record.kind}</span>
      </div>
      <p className="logs-entry-summary">{record.summary}</p>
      <p className="logs-entry-binding">{Object.entries(record.context).map(([key, value]) => <span className="identifier" key={key}>{key} {value}</span>)}</p>
      <span className="logs-details-label">Details available</span>
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
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let stream: ReturnType<LogClient['stream']> | undefined;
    const connect = async (): Promise<void> => {
      try {
        const replay = await client.replay(latestSequence);
        if (!current) return;
        latestSequence = replay.cursor.afterSequence;
        setGap(replay.gap);
        setRecords((existing) => mergeDevLogRecords(existing, replay.records));
        stream = client.stream({
          afterSequence: latestSequence,
          onMessage: (message) => {
            if (!current) return;
            if ('type' in message) setGap(message);
            else {
              latestSequence = Math.max(latestSequence, message.sequence);
              setRecords((existing) => mergeDevLogRecords(existing, [message]));
            }
          },
        });
        void stream.done.then(
          () => { if (current) reconnect = setTimeout(() => { void connect(); }, 250); },
          (reason: unknown) => {
            if (!current) return;
            setError(errorMessage(reason));
            reconnect = setTimeout(() => { void connect(); }, 250);
          },
        );
      } catch (reason) {
        if (!current) return;
        setError(errorMessage(reason));
        reconnect = setTimeout(() => { void connect(); }, 250);
      }
    };
    void connect();
    return () => { current = false; if (reconnect !== undefined) clearTimeout(reconnect); stream?.close(); };
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
