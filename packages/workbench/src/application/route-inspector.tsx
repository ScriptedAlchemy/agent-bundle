/**
 * The right inspector drawer of a route workspace (#600): closed by default,
 * opened for the evidence around an invocation — where the route lives, its
 * static schema, the request context and providers it ran with, execution
 * timings, the host projections, and the raw request/response pair.
 *
 * `InspectorDrawer` is the generic drawer (toggle, tab strip, one panel); the
 * skill workspace reuses it with its own tabs.
 */
import React from 'react';

import type { RouteInvocation, RouteInvocationRequest } from '../../../agent-bundle/src/contracts/invocations.ts';
import type { RequestContextProvenance, RequestProvenanceAxis } from '../../../agent-bundle/src/contracts/request-provenance.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackendKind } from './invocation-backend.ts';
import { displayAgentDocumentValue } from './rendered-document.tsx';
import type { WorkspaceInspectorTab } from './workspace-contracts.ts';
import './workspace.css';

export interface InspectorTabDefinition<Tab extends string> {
  readonly id: Tab;
  readonly label: string;
  readonly render: () => React.ReactNode;
}

export interface InspectorDrawerProps<Tab extends string> {
  readonly label: string;
  readonly onTabChange: (tab: Tab) => void;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly tab: Tab;
  readonly tabs: readonly InspectorTabDefinition<Tab>[];
}

/** The drawer shell: a toggle that is always visible and a tabbed panel only when open. */
export const InspectorDrawer = <Tab extends string>({ label, onTabChange, onToggle, open, tab, tabs }: InspectorDrawerProps<Tab>): React.ReactNode => {
  const active = tabs.find((definition) => definition.id === tab) ?? tabs[0];
  return <aside aria-label={label} className={open ? 'inspector inspector--open' : 'inspector'}>
    <button
      aria-expanded={open}
      className="inspector-toggle"
      data-testid="inspector-toggle"
      onClick={onToggle}
      title={open ? 'Close inspector' : 'Open inspector'}
      type="button"
    >{open ? 'Inspector ›' : '‹ Inspector'}</button>
    {!open || active === undefined ? undefined : <div className="inspector-body">
      <div aria-label={`${label} tabs`} className="inspector-tablist" role="tablist">
        {tabs.map((definition) => <button
          aria-selected={active.id === definition.id}
          className={active.id === definition.id ? 'inspector-tab inspector-tab--active' : 'inspector-tab'}
          data-testid={`inspector-tab-${definition.id}`}
          key={definition.id}
          onClick={() => onTabChange(definition.id)}
          role="tab"
          tabIndex={active.id === definition.id ? 0 : -1}
          type="button"
        >{definition.label}</button>)}
      </div>
      <div aria-label={active.label} className="inspector-panel" role="tabpanel">
        {active.render()}
      </div>
    </div>}
  </aside>;
};

export interface RouteInspectorProps {
  readonly backendKind?: InvocationBackendKind;
  readonly invocation?: RouteInvocation;
  readonly leaf: ApplicationLeaf;
  readonly onTabChange: (tab: WorkspaceInspectorTab) => void;
  readonly onToggle: () => void;
  readonly open: boolean;
  /** The last request the workspace sent; the Raw protocol tab shows it beside the response. */
  readonly request?: RouteInvocationRequest;
  readonly tab: WorkspaceInspectorTab;
}

export interface InspectorRow {
  readonly label: string;
  readonly value: string;
}

const row = (label: string, value: string): InspectorRow => Object.freeze({ label, value });

const axisRow = <Value,>(label: string, axis: RequestProvenanceAxis<Value>, display: (value: Value) => string): InspectorRow => row(
  label,
  axis.state === 'available' ? `${display(axis.value)} · ${axis.source}` : `Unavailable · ${axis.reason}`,
);

/** The request context an invocation ran with, one row per axis, unavailable axes saying why. */
export const requestContextRows = (context: RequestContextProvenance): readonly InspectorRow[] => Object.freeze([
  row('Invocation kind', context.invocation.kind),
  row('Operation ID', context.invocation.operationId ?? 'Unavailable · not-provided'),
  row('Surface', context.invocation.surface ?? 'Unavailable · not-provided'),
  row('Host contract revision', context.invocation.hostContractRevision ?? 'Unavailable · not-provided'),
  axisRow('Host', context.host, ({ name }) => name),
  axisRow('Session', context.session, ({ sessionId }) => sessionId),
  axisRow('Actor', context.actor, ({ id }) => id),
  axisRow('Workspace', context.workspace, ({ root }) => root),
  axisRow('Lineage', context.lineage, ({ conversation, depth, resolution }) => `${conversation} · depth ${String(depth)} · ${resolution}`),
]);

const Rows = ({ rows }: { readonly rows: readonly InspectorRow[] }): React.ReactNode => <dl className="inspector-rows">
  {rows.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}
</dl>;

const Empty = ({ children }: { readonly children: React.ReactNode }): React.ReactNode => <p className="inspector-empty" role="status">{children}</p>;

const SourceTab = ({ backendKind, invocation, leaf }: Pick<RouteInspectorProps, 'backendKind' | 'invocation' | 'leaf'>): React.ReactNode => <>
  <Rows rows={[
    ...(leaf.source === undefined ? [row('Source', 'Not a route module (declared in configuration)')] : [row('Source', leaf.source)]),
    ...(leaf.routeId === undefined ? [] : [row('Route ID', leaf.routeId)]),
    row('Execution', backendKind === undefined ? 'No backend accepts this leaf' : backendKind === 'dev-server' ? 'Dev server (production runtime in a child process)' : 'Runtime provider'),
    ...(invocation === undefined ? [] : [
      row('Rendered from', invocation.source),
      row('Source revision', invocation.sourceRevision),
      row('Manifest digest', invocation.manifestDigest),
    ]),
  ]} />
  {leaf.source === undefined ? undefined : <button
    className="inspector-copy"
    onClick={() => { void globalThis.navigator?.clipboard?.writeText(leaf.source ?? ''); }}
    type="button"
  >Copy source path</button>}
  {leaf.config.length === 0 ? <Empty>No static <code>config</code> export.</Empty> : <>
    <h3>Static config</h3>
    <Rows rows={leaf.config.map((entry) => row(entry.key, entry.kind === 'string' ? entry.value : `${entry.value} (${entry.kind})`))} />
  </>}
</>;

const SchemaTab = ({ invocation, leaf }: Pick<RouteInspectorProps, 'invocation' | 'leaf'>): React.ReactNode => <>
  <h3>Input schema</h3>
  {leaf.inputSchema === undefined
    ? <Empty>The input schema is richer than the statically projectable grammar; the editor accepts raw JSON and the route validates during execution.</Empty>
    : <pre className="inspector-json"><code>{displayAgentDocumentValue(leaf.inputSchema)}</code></pre>}
  <h3>Result schema</h3>
  {invocation?.result === undefined
    ? <Empty>The result schema is not projected statically. A route that exports <code>resultSchema</code> shows its parsed value under Structured result after a run.</Empty>
    : <Empty>This route exports a <code>resultSchema</code>; its parsed value is under Structured result.</Empty>}
</>;

const ProvidersTab = ({ invocation }: Pick<RouteInspectorProps, 'invocation'>): React.ReactNode => {
  if (invocation === undefined) return <Empty>Run the route to see which context providers mounted.</Empty>;
  if (invocation.providers.length === 0) return <Empty>This invocation mounted no context providers.</Empty>;
  return <table className="inspector-table">
    <thead><tr><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Duration</th></tr></thead>
    <tbody>{invocation.providers.map((provider) => <tr key={provider.id}>
      <th scope="row"><span className="inspector-name">{provider.name}</span><span className="inspector-id">{provider.id}</span></th>
      <td><span className={`inspector-status inspector-status--${provider.status}`}>{provider.status}</span>{provider.message === undefined ? undefined : <span className="inspector-message">{provider.message}</span>}</td>
      <td>{provider.durationMs === undefined ? '—' : `${String(provider.durationMs)} ms`}</td>
    </tr>)}</tbody>
  </table>;
};

const TimingsTab = ({ invocation }: Pick<RouteInspectorProps, 'invocation'>): React.ReactNode => {
  if (invocation === undefined) return <Empty>Run the route to see its execution timings.</Empty>;
  if (invocation.timings.length === 0) return <Empty>This invocation recorded no timings.</Empty>;
  const total = Math.max(1, ...invocation.timings.map((timing) => timing.durationMs));
  const wall = new Date(invocation.completedAt).getTime() - new Date(invocation.startedAt).getTime();
  return <>
    <p className="inspector-note">Wall clock {Number.isFinite(wall) ? `${String(Math.max(0, wall))} ms` : '—'} · started {invocation.startedAt}</p>
    <ol className="inspector-timings">
      {invocation.timings.map((timing) => <li key={`${timing.phase}-${timing.startedAt}`}>
        <span className="inspector-timing-phase">{timing.phase}</span>
        <span className="inspector-timing-bar"><span style={{ width: `${String(Math.round((timing.durationMs / total) * 100))}%` }} /></span>
        <span className="inspector-timing-duration">{String(timing.durationMs)} ms</span>
      </li>)}
    </ol>
  </>;
};

const ProjectionTab = ({ invocation }: Pick<RouteInspectorProps, 'invocation'>): React.ReactNode => {
  if (invocation === undefined) return <Empty>Run the route to see how its document lowers per host.</Empty>;
  const { cli, hosts, mcp } = invocation.projection;
  if (cli === undefined && hosts === undefined && mcp === undefined) return <Empty>This invocation produced no host projection.</Empty>;
  return <>
    {mcp === undefined ? undefined : <><h3>MCP</h3><pre className="inspector-json"><code>{displayAgentDocumentValue(mcp)}</code></pre></>}
    {cli === undefined ? undefined : <><h3>CLI</h3><Rows rows={[row('Exit code', String(cli.exitCode)), row('JSON output', cli.json === undefined ? 'none' : 'present')]} /><pre className="inspector-json"><code>{cli.text}</code></pre></>}
    {hosts === undefined ? undefined : hosts.map((host) => <section key={host.host}>
      <h3>{host.host}</h3>
      {host.diagnostics.length === 0 ? undefined : <ul className="inspector-diagnostics">{host.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${String(index)}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</li>)}</ul>}
      {host.native === undefined ? <Empty>The projection failed; no native response.</Empty> : <pre className="inspector-json"><code>{displayAgentDocumentValue(host.native)}</code></pre>}
    </section>)}
  </>;
};

const RawProtocolTab = ({ invocation, request }: Pick<RouteInspectorProps, 'invocation' | 'request'>): React.ReactNode => <>
  <h3>Request body</h3>
  {request === undefined
    ? <Empty>No request has been sent from this workspace yet.</Empty>
    : <pre className="inspector-json"><code>{displayAgentDocumentValue(request)}</code></pre>}
  <h3>Response</h3>
  {invocation === undefined
    ? <Empty>No response yet.</Empty>
    : <pre className="inspector-json"><code>{displayAgentDocumentValue({ invocation })}</code></pre>}
</>;

/** The route inspector: Source · Schema · Context · Providers · Timings · Projection · Raw protocol. */
export const RouteInspector = ({ backendKind, invocation, leaf, onTabChange, onToggle, open, request, tab }: RouteInspectorProps): React.ReactNode => {
  const tabs: readonly InspectorTabDefinition<WorkspaceInspectorTab>[] = [
    { id: 'source', label: 'Source', render: () => <SourceTab backendKind={backendKind} invocation={invocation} leaf={leaf} /> },
    { id: 'schema', label: 'Schema', render: () => <SchemaTab invocation={invocation} leaf={leaf} /> },
    { id: 'context', label: 'Context', render: () => invocation === undefined
      ? <Empty>Run the route to see the request context it rendered with.</Empty>
      : <Rows rows={requestContextRows(invocation.context)} /> },
    { id: 'providers', label: 'Providers', render: () => <ProvidersTab invocation={invocation} /> },
    { id: 'timings', label: 'Timings', render: () => <TimingsTab invocation={invocation} /> },
    { id: 'projection', label: 'Projection', render: () => <ProjectionTab invocation={invocation} /> },
    { id: 'raw-protocol', label: 'Raw protocol', render: () => <RawProtocolTab invocation={invocation} request={request} /> },
  ];
  return <InspectorDrawer label="Route inspector" onTabChange={onTabChange} onToggle={onToggle} open={open} tab={tab} tabs={tabs} />;
};
