/**
 * The result pane of an executable route workspace (#600): the rendered Agent
 * Document by default, with the structured result, the raw document and
 * render-event stream, the MCP and CLI lowered forms (when the invocation
 * produced them), and this leaf's trace as secondary tabs. Event workspaces
 * append their codec panes through `extraTabs`.
 */
import React from 'react';

import type { RouteInvocation, RouteInvocationSummary } from '../../../agent-bundle/src/contracts/invocations.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { agentRenderEventLabel, displayAgentDocumentValue, RenderedAgentDocument } from './rendered-document.tsx';
import { invocationOf, type RouteInvocationController, type WorkspaceResultTab } from './workspace-contracts.ts';
import './workspace.css';

export interface ResultTabDefinition {
  readonly id: WorkspaceResultTab;
  readonly label: string;
  readonly render: () => React.ReactNode;
}

export interface ResultTabsProps {
  readonly controller: RouteInvocationController;
  /** Codec panes appended after the core tabs (event workspaces). */
  readonly extraTabs?: readonly ResultTabDefinition[];
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly onTabChange: (tab: WorkspaceResultTab) => void;
  readonly tab: WorkspaceResultTab;
}

const coreTabLabels: Readonly<Record<'cli' | 'mcp' | 'raw' | 'rendered' | 'structured' | 'trace', string>> = Object.freeze({
  cli: 'CLI projection',
  mcp: 'MCP projection',
  raw: 'Raw AgentDocument',
  rendered: 'Rendered',
  structured: 'Structured result',
  trace: 'Trace',
});

const tabId = (leafKey: string, tab: string): string => `result-tab-${tab}-${leafKey}`.replace(/[^a-zA-Z0-9_-]/gu, '-');

const panelId = (leafKey: string): string => `result-panel-${leafKey}`.replace(/[^a-zA-Z0-9_-]/gu, '-');

const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
};

const durationOf = (summary: Pick<RouteInvocationSummary, 'completedAt' | 'startedAt'>): string => {
  const ms = new Date(summary.completedAt).getTime() - new Date(summary.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? `${String(ms)} ms` : '—';
};

const StructuredResult = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode => {
  if (invocation === undefined) return <p className="result-empty" role="status">Run the route to see its structured result.</p>;
  if (invocation.result !== undefined) return <pre className="result-json"><code>{displayAgentDocumentValue(invocation.result)}</code></pre>;
  if (invocation.document?.value !== undefined) {
    return <>
      <p className="result-note">This route exports no <code>resultSchema</code>; showing the document value instead.</p>
      <pre className="result-json"><code>{displayAgentDocumentValue(invocation.document.value)}</code></pre>
    </>;
  }
  return <p className="result-empty" role="status">This invocation produced no structured value.</p>;
};

const RawDocument = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode => {
  if (invocation === undefined) return <p className="result-empty" role="status">Run the route to see its Agent Document and render events.</p>;
  return <div className="result-raw">
    <details className="result-raw-document" open>
      <summary>Agent Document{invocation.document === undefined ? ' (none produced)' : ` · ${invocation.document.status}`}</summary>
      {invocation.document === undefined
        ? <p className="result-note">Rendering failed before a document existed; see the diagnostics above.</p>
        : <pre className="result-json"><code>{displayAgentDocumentValue(invocation.document)}</code></pre>}
    </details>
    <section aria-label="Render events" className="result-raw-events">
      <h3>Render events ({String(invocation.events.length)})</h3>
      {invocation.events.length === 0
        ? <p className="result-note">The stream carried no events.</p>
        : <ol>{invocation.events.map((event) => <li key={`${event.type}-${String(event.sequence)}`}>
          <details>
            <summary>{agentRenderEventLabel(event)}</summary>
            <pre className="result-json"><code>{displayAgentDocumentValue(event)}</code></pre>
          </details>
        </li>)}</ol>}
    </section>
  </div>;
};

const McpProjection = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode =>
  invocation?.projection.mcp === undefined
    ? <p className="result-empty" role="status">This invocation has no MCP projection.</p>
    : <pre className="result-json"><code>{displayAgentDocumentValue(invocation.projection.mcp)}</code></pre>;

const CliProjection = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode => {
  const cli = invocation?.projection.cli;
  if (cli === undefined) return <p className="result-empty" role="status">This invocation has no CLI projection.</p>;
  return <div className="result-cli">
    <p className="result-cli-exit">Exit code <code>{String(cli.exitCode)}</code></p>
    <h3>Text output</h3>
    <pre className="result-cli-text"><code>{cli.text}</code></pre>
    {cli.json === undefined ? undefined : <>
      <h3>JSON output (<code>--json</code>)</h3>
      <pre className="result-json"><code>{displayAgentDocumentValue(cli.json)}</code></pre>
    </>}
  </div>;
};

const TraceList = ({ current, history, leaf, onNavigate, onSelect }: {
  readonly current?: string;
  readonly history: readonly RouteInvocationSummary[];
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly onSelect: (invocationId: string) => void;
}): React.ReactNode => history.length === 0
  ? <p className="result-empty" role="status">No invocations of this route have been recorded in this dev session.</p>
  : <ol aria-label="Invocations of this route" className="result-trace">
    {history.map((summary) => <li className={summary.id === current ? 'result-trace-entry result-trace-entry--current' : 'result-trace-entry'} key={summary.id}>
      <button
        aria-current={summary.id === current ? 'true' : undefined}
        onClick={() => {
          onSelect(summary.id);
          onNavigate({ area: 'application', invocationId: summary.id, node: leaf.ref, tab: 'rendered' });
        }}
        type="button"
      >
        <span className={`result-trace-status result-trace-status--${summary.status}`}>{summary.status}</span>
        <span className="result-trace-time">{formatTime(summary.startedAt)}</span>
        <span className="result-trace-duration">{durationOf(summary)}</span>
        {summary.event?.host === undefined ? undefined : <span className="result-trace-host">{summary.event.host}</span>}
        <span className="result-trace-id">{summary.id}</span>
      </button>
    </li>)}
  </ol>;

/** The tabbed result pane; `rendered` is the default and always present. */
export const ResultTabs = ({ controller, extraTabs = [], leaf, onNavigate, onTabChange, tab }: ResultTabsProps): React.ReactNode => {
  const invocation = invocationOf(controller.state);
  const running = controller.state.phase === 'running';
  const definitions: readonly ResultTabDefinition[] = [
    { id: 'rendered', label: coreTabLabels.rendered, render: () => <RenderedAgentDocument
      emptyLabel={controller.backendKind === undefined ? 'No backend can run this route.' : undefined}
      events={invocation?.events ?? []}
      streaming={running}
    /> },
    { id: 'structured', label: coreTabLabels.structured, render: () => <StructuredResult invocation={invocation} /> },
    { id: 'raw', label: coreTabLabels.raw, render: () => <RawDocument invocation={invocation} /> },
    ...(invocation?.projection.mcp === undefined ? [] : [{ id: 'mcp' as const, label: coreTabLabels.mcp, render: () => <McpProjection invocation={invocation} /> }]),
    ...(invocation?.projection.cli === undefined ? [] : [{ id: 'cli' as const, label: coreTabLabels.cli, render: () => <CliProjection invocation={invocation} /> }]),
    ...extraTabs,
    { id: 'trace', label: coreTabLabels.trace, render: () => <TraceList
      current={invocation?.id}
      history={controller.history}
      leaf={leaf}
      onNavigate={onNavigate}
      onSelect={controller.load}
    /> },
  ];
  const active = definitions.find((definition) => definition.id === tab) ?? definitions[0]!;
  const panel = panelId(leaf.key);

  return <section aria-label="Result" className="result-tabs">
    <div aria-label="Result views" className="result-tablist" role="tablist">
      {definitions.map((definition) => <button
        aria-controls={panel}
        aria-selected={active.id === definition.id}
        className={active.id === definition.id ? 'result-tab result-tab--active' : 'result-tab'}
        data-testid={`result-tab-${definition.id}`}
        id={tabId(leaf.key, definition.id)}
        key={definition.id}
        onClick={() => onTabChange(definition.id)}
        role="tab"
        tabIndex={active.id === definition.id ? 0 : -1}
        type="button"
      >{definition.label}</button>)}
    </div>
    <div aria-labelledby={tabId(leaf.key, active.id)} className="result-panel" id={panel} role="tabpanel">
      {active.render()}
    </div>
  </section>;
};
