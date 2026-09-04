import React from 'react';

import { bundleSummaryFor, type OverviewHostAdoption } from './overview-model.ts';
import type { WorkbenchCapabilities } from './workbench-capabilities.ts';
import type { WorkbenchPage } from './workbench-screen.tsx';

export const StateMark = ({ state }: { readonly state: string }) => (
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
