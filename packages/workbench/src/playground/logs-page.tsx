import React, { useEffect, useState } from 'react';

import type {
  PlaygroundEpochIdentity,
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';

import type { PlaygroundClient } from './playground-client.ts';
import {
  formatPlaygroundJson,
  mergePlaygroundEvents,
  playgroundLogsViewFor,
  type PlaygroundLogsView,
} from './playground-model.ts';
import './logs-page.css';

export interface LogsTraceViewProps {
  readonly view: PlaygroundLogsView;
}

export interface LogsPageProps {
  readonly client: PlaygroundClient;
  readonly epoch: PlaygroundEpochIdentity | undefined;
  /** The Playground page owns the session; the Logs page only reads its durable trace. */
  readonly sessionId: string | undefined;
}

const allFilter = 'all';

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The playground log could not be read.';

const filterValue = (value: string): string | undefined => value === allFilter ? undefined : value;

export const loadPlaygroundLogTrace = async (
  client: PlaygroundClient,
  sessionId: string,
  afterSequence?: number,
): Promise<PlaygroundReplay> => client.replay(sessionId, afterSequence);

/** The same ordered trace, most recent first, with every raw payload inspectable in place. */
export const LogsTraceView = ({ view }: LogsTraceViewProps) => <div className="logs-trace">
  <p className="logs-summary" role="status">{view.summary}</p>
  {view.rows.length === 0
    ? <p className="empty-row">No trace entry matches this filter.</p>
    : <ol className="logs-entries">
      {view.rows.map((entry) => <li key={entry.key}>
        <div className="logs-entry-head">
          <span className="logs-entry-sequence">#{entry.sequence}</span>
          <span className="logs-entry-timestamp">{entry.timestamp}</span>
          <span className="logs-entry-source">{entry.source}</span>
          <span className="logs-entry-kind">{entry.kind}</span>
        </div>
        <p className="logs-entry-summary">{entry.summary}</p>
        <p className="logs-entry-binding">
          <span className="identifier" title={entry.epochDigest}>epoch {entry.epochId}</span>
          <span className="identifier">raw {entry.rawEventRef}</span>
        </p>
        <details>
          <summary>Raw payload</summary>
          <pre className="logs-json"><code>{formatPlaygroundJson(entry.raw)}</code></pre>
        </details>
      </li>)}
    </ol>}
</div>;

/** Reads one playground session's durable trace through the playground client and nothing else. */
export const LogsPage = ({ client, epoch, sessionId }: LogsPageProps) => {
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<readonly PlaygroundTraceEvent[]>([]);
  const [kind, setKind] = useState(allFilter);
  const [session, setSession] = useState<PlaygroundSession>();
  const [source, setSource] = useState(allFilter);
  const view = playgroundLogsViewFor({
    epoch,
    events,
    kind: filterValue(kind),
    session,
    source: filterValue(source),
  });

  useEffect(() => {
    setError(undefined);
    setEvents([]);
    setSession(undefined);
    if (sessionId === undefined) return;
    let current = true;
    void loadPlaygroundLogTrace(client, sessionId).then(
      (replay) => {
        if (!current) return;
        setEvents((previous) => mergePlaygroundEvents(previous, replay.events));
        setSession(replay.session);
      },
      (reason: unknown) => {
        if (current) setError(errorMessage(reason));
      },
    );
    const stream = client.stream(sessionId, {
      onEvent: (event) => {
        if (current) setEvents((previous) => mergePlaygroundEvents(previous, [event]));
      },
    });
    stream.done.catch((reason: unknown) => {
      if (current) setError(errorMessage(reason));
    });
    return () => {
      current = false;
      stream.close();
    };
  }, [client, sessionId]);

  return <div className="logs-content">
    <div className="page-heading logs-page-heading">
      <div>
        <h1>Logs</h1>
        <p>Every recorded trace event of the active playground session, newest first, with its raw payload.</p>
      </div>
    </div>
    {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
    {sessionId === undefined
      ? <p className="empty-row" role="status">No playground session is open, so no trace has been recorded.</p>
      : <>
        <section aria-label="Log filters" className="logs-controls">
          <label htmlFor="logs-source">Source</label>
          <select id="logs-source" onChange={(event) => setSource(event.currentTarget.value)} value={source}>
            <option value={allFilter}>All sources</option>
            {view.sources.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
          <label htmlFor="logs-kind">Kind</label>
          <select id="logs-kind" onChange={(event) => setKind(event.currentTarget.value)} value={kind}>
            <option value={allFilter}>All kinds</option>
            {view.kinds.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </section>
        <LogsTraceView view={view} />
      </>}
  </div>;
};
