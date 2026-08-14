import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';

import { overviewFor } from './overview-model.ts';
import { ProjectClient } from './project-client.ts';
import './styles.css';

const dateTime = (value: string | undefined): string => value === undefined
  ? 'Not available'
  : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value));

const stateLabel = (state: string): string => state.replaceAll('-', ' ');

const sourceFor = (diagnostic: Diagnostic): string =>
  diagnostic.sourcePath ?? diagnostic.generatedPath ?? diagnostic.target ?? 'Project';

const StateMark = ({ state }: { readonly state: string }) => (
  <span aria-hidden="true" className={`state-mark state-mark--${state}`}>{
    state === 'active' || state === 'ready' || state === 'built' ? '✓'
      : state === 'stale' || state === 'invalid' || state === 'failed' ? '!'
        : '–'
  }</span>
);

const Overview = ({ client, status, onStatus }: {
  readonly client: ProjectClient;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly status: ProjectStatus;
}) => {
  const overview = overviewFor(status);
  const [error, setError] = useState<string>();
  const [rebuilding, setRebuilding] = useState(false);

  const rebuild = async (): Promise<void> => {
    setError(undefined);
    setRebuilding(true);
    try {
      onStatus(await client.rebuild());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Rebuild request could not be completed.');
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="workbench-shell">
      <aside className="rail" aria-label="Workbench navigation">
        <div className="brand">Agent Bundle</div>
        <a aria-current="page" className="nav-item" href="#overview">
          <span aria-hidden="true" className="nav-glyph">⊞</span>
          Overview
        </a>
      </aside>
      <main className="canvas" id="overview">
        <header className="topbar">
          <span className="menu-glyph" aria-hidden="true">☰</span>
          <span className="topbar-title">Project workbench</span>
          <span className="connection"><span aria-hidden="true" />Foreground server connected</span>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <p className="eyebrow">Overview</p>
            <h1>Project overview</h1>
          </div>

          <section aria-labelledby="normalization-heading" className="section">
            <h2 id="normalization-heading">Normalization summary</h2>
            <dl className="definition-row">
              <div><dt>Source state</dt><dd><StateMark state={overview.normalization.state} />{overview.normalization.label}</dd></div>
              <div><dt>Source revision</dt><dd className="identifier">{overview.normalization.revision ?? 'Not available'}</dd></div>
              <div><dt>Build state</dt><dd className="status-text">{stateLabel(status.build.state)}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="epoch-heading" className="section">
            <h2 id="epoch-heading">Artifact epoch</h2>
            <div className={`epoch-row epoch-row--${overview.epoch.state}`}>
              <div className="epoch-state"><StateMark state={overview.epoch.state} /><strong>{stateLabel(overview.epoch.state)}</strong></div>
              <div><span>State</span><strong>{overview.epoch.summary}</strong></div>
              <div><span>Epoch ID</span><strong className="identifier">{overview.epoch.id ?? 'None published'}</strong></div>
              <div><span>Published</span><strong>{dateTime(overview.epoch.createdAt)}</strong></div>
            </div>
          </section>

          <section aria-labelledby="targets-heading" className="section">
            <h2 id="targets-heading">Generated targets</h2>
            {overview.targets.length === 0 ? <p className="empty-row">No generated targets are available for this project state.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Target</th><th>Artifact state</th><th>Digest</th></tr></thead>
                <tbody>{overview.targets.map((target) => <tr key={target.name}>
                  <td><strong>{target.name}</strong></td>
                  <td><StateMark state={target.state} />{stateLabel(target.state)}</td>
                  <td className="identifier">{target.digest}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>

          <section aria-labelledby="diagnostics-heading" className="section">
            <h2 id="diagnostics-heading">Diagnostics ({overview.diagnostics.length})</h2>
            {overview.diagnostics.length === 0 ? <p className="empty-row">No source or latest-build diagnostics.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>Source</th></tr></thead>
                <tbody>{overview.diagnostics.map((diagnostic, index) => <tr key={`${diagnostic.code}-${index}`}>
                  <td><span className={`severity severity--${diagnostic.severity}`}>{diagnostic.severity}</span></td>
                  <td className="identifier">{diagnostic.code}</td>
                  <td>{diagnostic.message}</td>
                  <td className="identifier">{sourceFor(diagnostic)}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>

          <section aria-labelledby="action-heading" className="next-action">
            <div><h2 id="action-heading">Next action</h2><p>{overview.nextAction.summary}</p></div>
            <button disabled={rebuilding} onClick={() => void rebuild()} type="button">
              {rebuilding ? 'Rebuilding…' : overview.nextAction.label}
            </button>
          </section>
          {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}
        </div>
      </main>
    </div>
  );
};

const Workbench = () => {
  const client = useRef<ProjectClient>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<ProjectStatus>();

  useEffect(() => {
    const next = new ProjectClient();
    client.current = next;
    void next.connect(setStatus).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Project status could not be loaded.');
    });
    return () => next.close();
  }, []);

  if (status !== undefined && client.current !== undefined) return <Overview client={client.current} onStatus={setStatus} status={status} />;
  return <main className="loading-state" aria-live="polite"><strong>Loading project state…</strong>{error === undefined ? undefined : <p role="alert">{error}</p>}</main>;
};

createRoot(document.getElementById('root')!).render(<Workbench />);
