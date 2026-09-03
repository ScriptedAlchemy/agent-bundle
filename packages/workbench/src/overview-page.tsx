import React, { useState } from 'react';

import type { Diagnostic } from '../../agent-bundle/src/contracts/diagnostics.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';

import { bundleSummaryFor, overviewFor, type OverviewHostAdoption } from './overview-model.ts';
import type { ProjectClient } from './project-client.ts';
import type { WorkbenchCapabilities } from './workbench-capabilities.ts';
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

const actionFor: Readonly<Partial<Record<WorkbenchPage, Readonly<{ label: string; summary: string }>>>> = Object.freeze({
  artifacts: { label: 'Inspect generated output', summary: 'Browse target files and provenance.' },
  evals: { label: 'Run evaluations', summary: 'Record durable evidence for this build.' },
  hooks: { label: 'Simulate Hooks', summary: 'Exercise an emitted Hook with a canonical event.' },
  mcp: { label: 'Open MCP playground', summary: 'Connect to an emitted MCP server.' },
  playground: { label: 'Run the Playground', summary: 'Execute a supported Hook or script operation.' },
  skills: { label: 'Review authored Skills', summary: 'Inspect authored instructions and generated host output.' },
});

/**
 * What live host connections and development installs currently serve. A failed
 * contract gate must be visible beside the published build, never silently applied.
 */
export const HostAdoptionSection = ({ hostAdoption, publishedEpochId }: {
  readonly hostAdoption: OverviewHostAdoption | undefined;
  readonly publishedEpochId: string | undefined;
}) => {
  if (hostAdoption === undefined) return undefined;
  return <section aria-labelledby="host-adoption-heading" className="section host-adoption" data-state={hostAdoption.state}>
    <h2 id="host-adoption-heading">Host adoption</h2>
    <div className="build-health-state">
      <StateMark state={hostAdoption.state === 'passed' || hostAdoption.state === 'direct' ? 'active' : hostAdoption.state} />
      <div>
        <strong>{hostAdoption.summary}</strong>
        <p>
          {hostAdoption.mode === 'gated'
            ? 'Live host connections and development installs adopt a build only after the development contract matrix passes.'
            : 'Declare dev.contracts to gate host adoption on the development contract matrix.'}
        </p>
      </div>
    </div>
    <dl className="definition-row">
      <div><dt>Host-facing build</dt><dd className="identifier">{hostAdoption.adoptedEpochId ?? 'None adopted'}</dd></div>
      <div><dt>Published build</dt><dd className="identifier">{publishedEpochId ?? 'None published'}</dd></div>
      {hostAdoption.gateSummary === undefined ? undefined : <div><dt>Contract matrix</dt><dd>{hostAdoption.gateSummary}</dd></div>}
    </dl>
    {hostAdoption.failures.length === 0 ? undefined : (
      <div className="table-wrap"><table aria-label="Contract violations">
        <thead><tr><th>Route</th><th>Failed checks</th></tr></thead>
        <tbody>{hostAdoption.failures.map((failure) => <tr key={failure.routeId}>
          <td className="identifier">{failure.routeId}</td>
          <td className="identifier">{failure.checks.join(', ')}</td>
        </tr>)}</tbody>
      </table></div>
    )}
  </section>;
};

/** A capability-aware entry point; authoritative build state remains below. */
export const BundleWorkflow = ({ capabilities, onNavigate }: {
  readonly capabilities?: Pick<WorkbenchCapabilities, 'counts' | 'pages'>;
  readonly onNavigate: (page: WorkbenchPage) => void;
}) => {
  const summary = capabilities === undefined
    ? { capabilityLabels: ['No published capabilities yet', '0 generated targets'], nextPages: ['artifacts'] as const }
    : bundleSummaryFor(capabilities);
  return <section aria-labelledby="bundle-dashboard-heading" className="bundle-dashboard">
    <div className="page-heading">
      <h1 id="bundle-dashboard-heading">Bundle dashboard</h1>
      <p>See what this bundle publishes, try supported workflows, and rebuild after source changes.</p>
    </div>
    <div aria-label="Bundle capabilities" className="capability-summary">
      {summary.capabilityLabels.map((label) => <span className="capability-card" key={label}>{label}</span>)}
    </div>
    <div aria-label="Recommended next actions" className="dashboard-actions">
      {summary.nextPages.map((page) => {
        const action = actionFor[page];
        return action === undefined ? undefined : <a
          className="action-link"
          href={`#${page}`}
          key={page}
          onClick={(event) => { event.preventDefault(); onNavigate(page); }}
        >
          <strong>{action.label}</strong>
          <span>{action.summary}</span>
        </a>;
      })}
    </div>
  </section>;
};

export const Overview = ({ capabilities, changedFiles, client, connectionError, onNavigate, pages, status, onStatus }: {
  readonly capabilities?: WorkbenchCapabilities;
  readonly changedFiles: readonly string[];
  readonly client: ProjectClient;
  readonly connectionError?: string;
  readonly onNavigate: (page: WorkbenchPage) => void;
  readonly onStatus: (status: ProjectStatus) => void;
  readonly pages: ReadonlySet<WorkbenchPage>;
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
      <Navigation onNavigate={onNavigate} page="overview" pages={pages} />
      <main className="canvas" id="overview">
        <Topbar connectionError={connectionError} />
        <div className="page-content">
          <BundleWorkflow capabilities={capabilities} onNavigate={onNavigate} />

          <section aria-labelledby="build-health-heading" className="build-health section">
            <div>
              <h2 id="build-health-heading">Build health</h2>
              <div className="build-health-state">
                <StateMark state={overview.epoch.state} />
                <div><strong>{overview.epoch.summary}</strong><p>{overview.nextAction.summary}</p></div>
              </div>
            </div>
            <button disabled={rebuilding} onClick={() => void rebuild()} type="button">
              {rebuilding ? 'Rebuilding…' : overview.nextAction.label}
            </button>
          </section>
          {error === undefined ? undefined : <p className="request-error" role="alert">{error}</p>}

          <HostAdoptionSection hostAdoption={overview.hostAdoption} publishedEpochId={overview.epoch.id} />

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

          <details className="build-details">
            <summary>Inspect build details</summary>
            <section aria-labelledby="normalization-heading" className="section">
              <h2 id="normalization-heading">Source and build state</h2>
              <dl className="definition-row">
                <div><dt>Source state</dt><dd><StateMark state={overview.normalization.state} />{overview.normalization.label}</dd></div>
                <div><dt>Source revision</dt><dd className="identifier">{overview.normalization.revision ?? 'Not available'}</dd></div>
                <div><dt>Build state</dt><dd className="status-text">{stateLabel(status.build.state)}</dd></div>
              </dl>
            </section>

            <section aria-labelledby="published-build-heading" className="section">
              <h2 id="published-build-heading">Published build</h2>
              <div className={`epoch-row epoch-row--${overview.epoch.state}`}>
                <div className="epoch-state"><StateMark state={overview.epoch.state} /><strong>{stateLabel(overview.epoch.state)}</strong></div>
                <div><span>State</span><strong>{overview.epoch.summary}</strong></div>
                <div><span>Build ID</span><strong className="identifier">{overview.epoch.id ?? 'None published'}</strong></div>
                <div><span>Published</span><strong>{dateTime(overview.epoch.createdAt)}</strong></div>
              </div>
            </section>

            <section aria-labelledby="targets-heading" className="section">
              <h2 id="targets-heading">Generated targets</h2>
              {overview.targets.length === 0 ? <p className="empty-row">No generated targets are available for this project state.</p> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Target</th><th>Build state</th><th>Digest</th></tr></thead>
                  <tbody>{overview.targets.map((target) => <tr key={target.name}>
                    <td><strong>{target.name}</strong></td>
                    <td><StateMark state={target.state} />{stateLabel(target.state)}</td>
                    <td className="identifier">{target.digest}</td>
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
          </details>
        </div>
      </main>
    </div>
  );
};
