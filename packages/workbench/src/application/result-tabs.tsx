/**
 * The result pane of an executable route workspace (#600): the rendered Agent
 * Document by default, with the structured result, the raw document and
 * render-event stream, the MCP and CLI lowered forms (when the invocation
 * produced them), and this leaf's trace as secondary tabs. Event workspaces
 * append their codec panes through `extraTabs`.
 */
import React, { useEffect, useState } from 'react';

import type {
  RouteInvocation,
  RouteInvocationOutcome,
  RouteInvocationStatus,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import {
  isTraceReplayGap,
  type TraceEntry,
} from '../../../agent-bundle/src/contracts/trace.ts';
import { ShellLink } from '../shell/shell-link.tsx';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { TraceClient } from '../trace/trace-client.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { outcomeLabel, statusLabel } from './invocation-model.ts';
import { agentRenderEventLabel, displayAgentDocumentValue, RenderedAgentDocument } from './rendered-document.tsx';
import { invocationOf, type RouteInvocationController, type WorkspaceResultTab } from './workspace-contracts.ts';
import './workspace.css';

type Navigate = (location: WorkbenchLocation) => void;

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
  readonly onNavigate?: Navigate;
  readonly onTabChange: (tab: WorkspaceResultTab) => void;
  readonly tab: WorkspaceResultTab;
  readonly trace?: TraceClient;
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

/** Whether the execution boundary completed — never the run's verdict, which {@link OutcomeBadge} carries. */
export const StatusBadge = ({ status }: { readonly status: RouteInvocationStatus }): React.ReactNode =>
  <span className={`result-trace-status result-trace-status--${status}`}>{statusLabel(status)}</span>;

/** The application outcome of a completed run, shown beside — never merged into — its status. */
export const OutcomeBadge = ({ outcome }: { readonly outcome: RouteInvocationOutcome }): React.ReactNode =>
  <span className={`route-outcome route-outcome--${outcome.kind}`} data-testid="route-outcome">{outcomeLabel(outcome)}</span>;

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
      {invocation.evictedEvents === undefined
        ? undefined
        : <p className="result-note">The {String(invocation.evictedEvents)} oldest events were evicted from retained history.</p>}
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

const traceMatches = (
  entry: TraceEntry,
  invocationId: string,
  correlationId: string | undefined,
): boolean => entry.correlation.invocationId === invocationId ||
  (correlationId !== undefined && entry.correlation.correlationId === correlationId);

const orderedTraceEntries = (
  entries: readonly TraceEntry[],
  invocationId: string,
  correlationId: string | undefined,
): readonly TraceEntry[] => entries
  .filter((entry) => traceMatches(entry, invocationId, correlationId))
  .sort((left, right) => left.sequence - right.sequence);

const TraceRow = ({ entry, onNavigate }: { readonly entry: TraceEntry; readonly onNavigate?: Navigate }): React.ReactNode => <li className={`result-trace-row${entry.status === 'error' ? ' result-trace-row--error' : ''}`}>
  <ShellLink location={{ area: 'trace', invocationId: entry.id }} onNavigate={onNavigate}>
    <time className="result-trace-time" dateTime={entry.occurredAt}>{formatTime(entry.occurredAt)}</time>
    <span className="result-trace-kind">{entry.kind.replaceAll('.', ' · ')}</span>
    <span className="result-trace-summary">{entry.summary}</span>
    <span className="result-trace-duration">{entry.durationMs === undefined ? '—' : `${String(entry.durationMs)} ms`}</span>
  </ShellLink>
</li>;

export const TraceTimeline = ({ correlationId, entries, invocationId, onNavigate }: {
  readonly correlationId?: string;
  readonly entries: readonly TraceEntry[];
  readonly invocationId: string;
  readonly onNavigate?: Navigate;
}): React.ReactNode => {
  const matching = orderedTraceEntries(entries, invocationId, correlationId);
  if (matching.length === 0) {
    return <p className="result-empty" role="status">No correlated trace entries have arrived for this invocation.</p>;
  }
  const kernel = matching.filter((entry) => entry.source === 'kernel');
  const outer = matching.filter((entry) => entry.source !== 'kernel');
  return <ol aria-label="Correlated invocation trace" className="result-trace">
    {outer.map((entry, index) => <React.Fragment key={entry.id}>
      <TraceRow entry={entry} onNavigate={onNavigate} />
      {index === 0 && kernel.length > 0
        ? <li className="result-trace-kernel">
          <ol aria-label="Kernel phases">{kernel.map((phase) => <TraceRow entry={phase} key={phase.id} onNavigate={onNavigate} />)}</ol>
        </li>
        : undefined}
    </React.Fragment>)}
    {outer.length === 0 ? kernel.map((entry) => <TraceRow entry={entry} key={entry.id} onNavigate={onNavigate} />) : undefined}
  </ol>;
};

type TraceLoadState =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly entries: readonly TraceEntry[]; readonly state: 'ready' }>;

const useTraceEntries = (trace: TraceClient | undefined): TraceLoadState => {
  const [state, setState] = useState<TraceLoadState>({ state: 'loading' });
  useEffect(() => {
    if (trace === undefined) return;
    const controller = new AbortController();
    void trace.replay().then((replay) => {
      if (controller.signal.aborted) return;
      setState({ entries: replay.entries, state: 'ready' });
      return trace.stream(replay.latestSequence, (message) => {
        if (isTraceReplayGap(message)) return;
        setState((current) => {
          const entries = current.state === 'ready' ? current.entries : [];
          return {
            entries: Object.freeze([...entries.filter((entry) => entry.id !== message.id), message]),
            state: 'ready',
          };
        });
      }, controller.signal);
    }).catch(() => {
      if (!controller.signal.aborted) setState({ entries: Object.freeze([]), state: 'ready' });
    });
    return () => controller.abort();
  }, [trace]);
  return state;
};

/** The tabbed result pane; `rendered` is the default and always present. */
export const ResultTabs = ({ controller, extraTabs = [], leaf, onNavigate, onTabChange, tab, trace }: ResultTabsProps): React.ReactNode => {
  const invocation = invocationOf(controller.state);
  const running = controller.state.phase === 'running';
  const events = running ? controller.state.retained?.events ?? [] : invocation?.events ?? [];
  const traceState = useTraceEntries(trace);
  const definitions: readonly ResultTabDefinition[] = [
    { id: 'rendered', label: coreTabLabels.rendered, render: () => <RenderedAgentDocument
      emptyLabel={controller.backendKind === undefined ? 'No backend can run this route.' : undefined}
      events={events}
      streaming={running}
    /> },
    { id: 'structured', label: coreTabLabels.structured, render: () => <StructuredResult invocation={invocation} /> },
    { id: 'raw', label: coreTabLabels.raw, render: () => <RawDocument invocation={invocation} /> },
    ...(invocation?.projection.mcp === undefined ? [] : [{ id: 'mcp' as const, label: coreTabLabels.mcp, render: () => <McpProjection invocation={invocation} /> }]),
    ...(invocation?.projection.cli === undefined ? [] : [{ id: 'cli' as const, label: coreTabLabels.cli, render: () => <CliProjection invocation={invocation} /> }]),
    ...extraTabs,
    { id: 'trace', label: coreTabLabels.trace, render: () => invocation === undefined
      ? <p className="result-empty" role="status">Run the route to see its correlated trace.</p>
      : <>
        <div className="result-trace-verdict">
          <StatusBadge status={invocation.status} />
          {invocation.outcome === undefined ? undefined : <OutcomeBadge outcome={invocation.outcome} />}
        </div>
        {traceState.state === 'loading'
          ? <p className="result-empty" role="status">Loading correlated trace…</p>
          : <TraceTimeline correlationId={invocation.correlationId} entries={traceState.entries} invocationId={invocation.id} onNavigate={onNavigate} />}
      </> },
  ];
  const active = definitions.find((definition) => definition.id === tab) ?? definitions[0]!;
  const panel = panelId(leaf.key);

  return <section aria-label="Result" className="result-tabs">
    {invocation?.correlationId === undefined ? undefined : <div className="result-actions">
      <ShellLink location={{ area: 'trace', correlation: invocation.correlationId }} onNavigate={onNavigate}>Open in Trace</ShellLink>
    </div>}
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
