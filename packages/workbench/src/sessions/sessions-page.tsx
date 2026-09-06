import React, { useCallback, useEffect, useReducer, useRef } from 'react';

import { errorMessage, isAbortError } from '../client-helpers.ts';
import { ShellLink } from '../shell/shell-link.tsx';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { HostSession, HostSessionHost, HostSessionSize } from '../../../agent-bundle/src/contracts/host-sessions.ts';
import type { HostSessionClient } from './host-session-client.ts';
import {
  availabilityFor,
  defaultHostSessionSize,
  hostLabel,
  hosts,
  initialHostSessionsState,
  reduceHostSessions,
  sessionStateLabel,
} from './host-session-model.ts';
import { SessionTerminal } from './terminal.tsx';
import './sessions-page.css';

export interface SessionsPageProps {
  readonly client: HostSessionClient;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** `?session=<id>`: the session whose terminal fills the pane. */
  readonly session?: string;
}

const time = (millis: number): string => new Date(millis).toLocaleTimeString('en-GB', { hour12: false });

const stateSummary = (session: HostSession): string => {
  const detail = session.state === 'running'
    ? session.pid === undefined ? undefined : `pid ${String(session.pid)}`
    : session.signal ?? (session.exitCode === undefined ? undefined : `exit ${String(session.exitCode)}`);
  return detail === undefined ? sessionStateLabel(session.state) : `${sessionStateLabel(session.state)} · ${detail}`;
};

export const SessionsPage = ({ client, onNavigate, session: selectedId }: SessionsPageProps): React.ReactNode => {
  const [state, dispatch] = useReducer(reduceHostSessions, initialHostSessionsState);
  const size = useRef<HostSessionSize>(defaultHostSessionSize);
  const fail = useCallback((reason: unknown): void => {
    if (!isAbortError(reason)) dispatch({ message: errorMessage(reason, 'The host session request failed.'), type: 'error' });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    client.list(controller.signal).then(
      (list) => { if (!controller.signal.aborted) dispatch({ ...list, type: 'list' }); },
      (reason: unknown) => { if (!controller.signal.aborted) fail(reason); },
    );
    return () => controller.abort();
  }, [client, fail]);

  const select = useCallback((session: HostSession): void => {
    dispatch({ session, type: 'session' });
    onNavigate({ area: 'sessions', session: session.id });
  }, [onNavigate]);
  const launch = (host: HostSessionHost): void => { client.launch({ host, ...size.current }).then(select, fail); };
  const terminate = (id: string): void => { client.terminate(id).then((session) => dispatch({ session, type: 'session' }), fail); };
  const restart = (session: HostSession): void => {
    client.restart(session.id, { cols: session.cols, rows: session.rows }).then(select, fail);
  };
  const forget = (id: string): void => {
    client.forget(id).then(() => {
      dispatch({ id, type: 'forget' });
      onNavigate({ area: 'sessions' });
    }, fail);
  };
  const onSession = useCallback((session: HostSession): void => { dispatch({ session, type: 'session' }); }, []);
  const onSize = useCallback((next: HostSessionSize): void => { size.current = next; }, []);
  const onError = useCallback((message: string): void => { dispatch({ message, type: 'error' }); }, []);

  const selected = selectedId === undefined ? undefined : state.sessions.find((session) => session.id === selectedId);

  return <main className="shell-page sessions-page">
    <aside aria-label="Host sessions" className="sessions-side">
      <div className="shell-page-heading sessions-heading">
        <div>
          <h1>Host sessions</h1>
          <p>Claude Code and Codex in this project, attached to the dev plugin.</p>
        </div>
      </div>
      <div aria-label="Launch a host" className="sessions-launch" role="group">
        {hosts.map((host) => {
          const availability = availabilityFor(state.hosts, host);
          const reason = !state.loaded ? 'Checking host availability…' : availability?.launchable === true ? undefined : availability?.reason ?? `${hostLabel(host)} is not available in this project.`;
          return <div className="sessions-launch-host" key={host}>
            <button
              className="route-run"
              data-testid={`sessions-launch-${host}`}
              disabled={reason !== undefined}
              onClick={() => launch(host)}
              title={availability?.executable}
              type="button"
            >Launch {hostLabel(host)}</button>
            {reason === undefined ? undefined : <span className="sessions-launch-reason" role="status">{reason}</span>}
          </div>;
        })}
      </div>
      {state.error === undefined ? undefined : <p className="request-error" role="alert">{state.error}</p>}
      {state.sessions.length === 0
        ? <p className="empty-row" data-testid="sessions-empty">{state.loaded ? 'No host session yet. Launch one above, or open a route in a host from its workspace.' : 'Loading host sessions…'}</p>
        : <ol className="sessions-list" data-testid="sessions-list">
          {state.sessions.map((session) => <li key={session.id}>
            <ShellLink
              aria-current={session.id === selectedId ? 'page' : undefined}
              className={`sessions-item sessions-item--${session.state}`}
              data-session-id={session.id}
              data-testid="sessions-item"
              location={{ area: 'sessions', session: session.id }}
              onNavigate={onNavigate}
            >
              <span className="sessions-item-host">{hostLabel(session.host)}</span>
              <span className={`sessions-state sessions-state--${session.state}`}>{sessionStateLabel(session.state)}</span>
              <span className="sessions-item-meta">{time(session.startedAt)} · <span className="identifier">{session.id}</span></span>
              {session.prompt === undefined ? undefined : <span className="sessions-item-prompt">{session.prompt}</span>}
            </ShellLink>
          </li>)}
        </ol>}
    </aside>
    <section aria-label="Session terminal" className="sessions-main">
      {selected === undefined
        ? <div className="sessions-placeholder" data-testid="sessions-placeholder">
          {selectedId === undefined
            ? <p>Select a session, or launch a host.</p>
            : <p>{state.loaded ? `No host session is ${selectedId} in this dev server.` : 'Loading host sessions…'}</p>}
        </div>
        : <>
          <div className="sessions-toolbar">
            <h2>{hostLabel(selected.host)} <span className="identifier">{selected.id}</span></h2>
            <span className="sessions-toolbar-actions">
              <ShellLink className="sessions-trace-link" data-testid="sessions-trace" location={{ area: 'trace', correlation: selected.traceSessionId ?? selected.id }} onNavigate={onNavigate}>Trace</ShellLink>
              <button className="route-cancel" data-testid="sessions-terminate" disabled={selected.state !== 'running'} onClick={() => terminate(selected.id)} type="button">Terminate</button>
              <button className="sessions-action" data-testid="sessions-restart" onClick={() => restart(selected)} type="button">Restart</button>
              <button className="sessions-action" data-testid="sessions-forget" disabled={selected.state === 'running'} onClick={() => forget(selected.id)} type="button">Forget</button>
            </span>
          </div>
          <SessionTerminal
            client={client}
            key={selected.id}
            live={selected.state === 'running'}
            onError={onError}
            onSession={onSession}
            onSize={onSize}
            sessionId={selected.id}
          />
          <dl className="sessions-authority" data-testid="sessions-authority">
            <div><dt>Runs in</dt><dd className="identifier">{selected.authority.projectRoot}</dd></div>
            <div><dt>Epoch</dt><dd className="identifier">{selected.authority.epochId}</dd></div>
            <div><dt>Install</dt><dd className="identifier">{selected.authority.install}</dd></div>
            <div><dt>State</dt><dd className={`sessions-state sessions-state--${selected.state}`} data-testid="sessions-state">{stateSummary(selected)}</dd></div>
            {selected.restartOf === undefined ? undefined : <div><dt>Restart of</dt><dd><ShellLink className="identifier" location={{ area: 'sessions', session: selected.restartOf }} onNavigate={onNavigate}>{selected.restartOf}</ShellLink></dd></div>}
            {selected.traceSessionId === undefined ? undefined : <div><dt>Host session</dt><dd className="identifier">{selected.traceSessionId}</dd></div>}
          </dl>
        </>}
    </section>
  </main>;
};
