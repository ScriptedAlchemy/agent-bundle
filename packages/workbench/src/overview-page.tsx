import React, { useState } from 'react';

import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';

import { overviewFor } from './overview-model.ts';
import type { ProjectClient } from './project-client.ts';
import { Navigation, Topbar, type WorkbenchPage } from './workbench-screen.tsx';

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

const dateTime = (value: string | undefined): string => value === undefined
  ? 'Not available'
  : dateTimeFormat.format(new Date(value));

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

/** A navigation-only guide to the bundle lifecycle; authoritative state remains below. */
export const BundleWorkflow = ({ onNavigate }: { readonly onNavigate: (page: WorkbenchPage) => void }) => <section aria-labelledby="bundle-dashboard-heading" className="section">
  <div className="page-heading">
    <h1 id="bundle-dashboard-heading">Bundle dashboard</h1>
    <p>Author once, exercise host-ready behavior, and evaluate durable evidence.</p>
  </div>
  <ol className="bundle-workflow">
    <li>
      <h2>1. Author</h2>
      <p>Define Skills, Hooks, scripts, and MCP capabilities from one source bundle.</p>
      <button onClick={() => onNavigate('skills')} type="button">Skills</button>
      <button onClick={() => onNavigate('hooks')} type="button">Hooks</button>
    </li>
    <li>
      <h2>2. Build</h2>
      <p>Build an immutable artifact epoch for the hosts you selected.</p>
      <button onClick={() => onNavigate('artifacts')} type="button">Artifacts</button>
    </li>
    <li>
      <h2>3. Exercise</h2>
      <p>Exercise emitted Skills, Hooks, Playground, and MCP behavior.</p>
      <button onClick={() => onNavigate('skills')} type="button">Skills</button>
      <button onClick={() => onNavigate('hooks')} type="button">Hooks</button>
      <button onClick={() => onNavigate('playground')} type="button">Playground</button>
      <button onClick={() => onNavigate('mcp')} type="button">MCP</button>
    </li>
    <li>
      <h2>4. Evaluate</h2>
      <p>Evaluate host-ready behavior, compare results, and inspect durable evidence.</p>
      <button onClick={() => onNavigate('evals')} type="button">Evals</button>
      <button onClick={() => onNavigate('comparisons')} type="button">Comparisons</button>
    </li>
  </ol>
</section>;

export const Overview = ({ changedFiles, client, connectionError, onNavigate, status, onStatus }: {
  readonly changedFiles: readonly string[];
  readonly client: ProjectClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly status: ProjectStatus;
}) => {
  const overview = overviewFor(status, changedFiles);
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
      <Navigation onNavigate={onNavigate} page="overview" />
      <main className="canvas" id="overview">
        <Topbar connectionError={connectionError} />
        <div className="page-content">
          <BundleWorkflow onNavigate={onNavigate} />

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

          <section aria-labelledby="changed-files-heading" className="section">
            <h2 id="changed-files-heading">Latest changed files ({overview.changedFiles.length})</h2>
            {overview.changedFiles.length === 0 ? <p className="empty-row">No source changes have been reported in this browser session.</p> : (
              <ul className="changed-file-list">
                {overview.changedFiles.map((path) => <li className="identifier" key={path}>{path}</li>)}
              </ul>
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
