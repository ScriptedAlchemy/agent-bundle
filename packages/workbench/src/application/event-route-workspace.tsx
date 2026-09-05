/**
 * The event route workspace (#600): the shared executable body with a host
 * selector in front of it. `Canonical` submits the canonical event payload the
 * route's schema describes; `Claude | Codex | Cursor` submit that host's
 * native hook payload — seeded from the served lifecycle fixture — as
 * `event: { host, fixtureId }` so the service canonicalizes it exactly as the
 * emitted wrapper would. The plugin-visible decision (the rendered document)
 * stays the default result; the codec panes the old Hooks page led with are
 * secondary tabs: canonical → host mapping, native in / out, canonical
 * result, and Replay (an observed receipt pasted and run as that host).
 */
import React, { useEffect, useMemo, useState } from 'react';

import type { RouteInvocation, RouteInvocationEventHost } from '../../../agent-bundle/src/contracts/invocations.ts';
import type { JsonObject } from '../../../agent-bundle/src/contracts/strict-json.ts';
import { errorMessage } from '../client-helpers.ts';
import type { Lifecycle, LifecycleClient, LifecycleTarget } from '../lifecycles/lifecycle-client.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import { ExecutableRouteWorkspace } from './executable-route-workspace.tsx';
import { outcomeLabel, statusLabel } from './invocation-model.ts';
import { displayAgentDocumentValue } from './rendered-document.tsx';
import { OutcomeBadge, StatusBadge, type ResultTabDefinition } from './result-tabs.tsx';
import { requestContextRows } from './route-inspector.tsx';
import {
  invocationOf,
  type RouteInputFixture,
  type RouteInvocationController,
  type RouteInvocationDraft,
  type WorkspaceClients,
} from './workspace-contracts.ts';
import './workspace.css';

export type EventHostSelection = 'canonical' | RouteInvocationEventHost;

export const eventHosts: readonly RouteInvocationEventHost[] = Object.freeze(['claude', 'codex', 'cursor']);

const hostLabels: Readonly<Record<EventHostSelection, string>> = Object.freeze({
  canonical: 'Canonical',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
});

const isEventHost = (value: string): value is RouteInvocationEventHost => (eventHosts as readonly string[]).includes(value);

type LifecycleState =
  | Readonly<{ readonly state: 'loading' }>
  | Readonly<{ readonly lifecycle?: Lifecycle; readonly state: 'ready' }>
  | Readonly<{ readonly message: string; readonly state: 'unavailable' }>;

/** The served lifecycle entry for this leaf's compiled route, when the catalog lists one. */
export const lifecycleForLeaf = (lifecycles: readonly Lifecycle[], leaf: ApplicationLeaf): Lifecycle | undefined =>
  lifecycles.find((lifecycle) => lifecycle.routeId === leaf.routeId) ??
  lifecycles.find((lifecycle) => lifecycle.event === leaf.event);

export const eventHostTarget = (lifecycle: Lifecycle | undefined, host: RouteInvocationEventHost): LifecycleTarget | undefined =>
  lifecycle?.targets.find((target) => target.target === host);

/** One native payload fixture per host the lifecycle catalog serves for this route. */
export const eventFixturesFor = (lifecycle: Lifecycle | undefined): readonly RouteInputFixture[] => Object.freeze(
  (lifecycle?.targets ?? [])
    .filter((target) => isEventHost(target.target) && target.fixture !== undefined)
    .map((target) => Object.freeze({
      host: target.target as RouteInvocationEventHost,
      id: `${target.target}:${target.fixture!.label}`,
      input: target.fixture!.native as JsonObject,
      label: `${target.fixture!.label} · ${hostLabels[target.target as RouteInvocationEventHost]}`,
    })),
);

export const eventRequestFor = (
  host: EventHostSelection,
  draft: RouteInvocationDraft,
): RouteInvocationDraft => {
  if (host === 'canonical') return draft;
  return Object.freeze({ ...draft, event: Object.freeze({ host }) });
};

const Rows = ({ rows }: { readonly rows: readonly { readonly label: string; readonly value: string }[] }): React.ReactNode => <dl className="inspector-rows">
  {rows.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}
</dl>;

const Empty = ({ children }: { readonly children: React.ReactNode }): React.ReactNode => <p className="result-empty" role="status">{children}</p>;

const MappingTab = ({ invocation, leaf, lifecycle }: { readonly invocation?: RouteInvocation; readonly leaf: ApplicationLeaf; readonly lifecycle?: Lifecycle }): React.ReactNode => {
  const host = invocation?.event?.host;
  const target = host === undefined ? undefined : eventHostTarget(lifecycle, host);
  return <div className="event-mapping">
    <Rows rows={[
      { label: 'Canonical event', value: leaf.event ?? invocation?.event?.event ?? '—' },
      { label: 'Route', value: leaf.source ?? lifecycle?.routePath ?? '—' },
      { label: 'Host', value: host === undefined ? 'Canonical submission (no host codec applied)' : hostLabels[host] },
      ...(target === undefined ? [] : [
        { label: 'Native event', value: target.nativeEvent },
        { label: 'Host contract revision', value: target.hostContractRevision },
      ]),
      ...(lifecycle === undefined ? [] : [{ label: 'Hosts with wrappers', value: lifecycle.targets.map((entry) => entry.target).join(', ') || 'none' }]),
    ]} />
    {invocation === undefined ? <Empty>Run the route as a host to see how its native payload maps onto the canonical event.</Empty> : <>
      <h3>Canonical payload the route received</h3>
      <pre className="result-json"><code>{displayAgentDocumentValue(invocation.event?.canonical ?? invocation.input)}</code></pre>
      <h3>Request context</h3>
      <Rows rows={requestContextRows(invocation.context)} />
    </>}
  </div>;
};

const NativeTab = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode => {
  if (invocation === undefined) return <Empty>Run the route as a host to see the native payload in and the native response out.</Empty>;
  const host = invocation.event?.host;
  const projections = invocation.projection.hosts ?? [];
  return <div className="event-native">
    <section>
      <h3>Native in{host === undefined ? '' : ` · ${hostLabels[host]}`}</h3>
      {invocation.event?.native === undefined
        ? <Empty>This invocation was a canonical submission; no native payload was received.</Empty>
        : <pre className="result-json"><code>{displayAgentDocumentValue(invocation.event.native)}</code></pre>}
    </section>
    <section>
      <h3>Native out</h3>
      {projections.length === 0
        ? <Empty>No host projection was produced.</Empty>
        : projections.map((projection) => <div key={projection.host}>
          <h4>{hostLabels[projection.host]}</h4>
          {projection.diagnostics.length === 0 ? undefined : <ul className="inspector-diagnostics">{projection.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${String(index)}`}><strong>{diagnostic.code}</strong> {diagnostic.message}</li>)}</ul>}
          {projection.native === undefined ? <Empty>The projection failed.</Empty> : <pre className="result-json"><code>{displayAgentDocumentValue(projection.native)}</code></pre>}
        </div>)}
    </section>
  </div>;
};

const CanonicalResultTab = ({ invocation }: { readonly invocation?: RouteInvocation }): React.ReactNode => {
  if (invocation === undefined) return <Empty>Run the route to see the canonical result its document lowers to.</Empty>;
  const value = invocation.result ?? invocation.document?.value;
  return <div className="event-canonical">
    <Rows rows={[
      { label: 'Document status', value: invocation.document?.status ?? 'no document' },
      { label: 'Execution', value: statusLabel(invocation.status) },
      { label: 'Outcome', value: invocation.outcome === undefined ? 'none (the boundary did not complete)' : outcomeLabel(invocation.outcome) },
    ]} />
    {value === undefined
      ? <Empty>The document carries no value; the decision is expressed by its nodes (see Rendered).</Empty>
      : <pre className="result-json"><code>{displayAgentDocumentValue(value)}</code></pre>}
  </div>;
};

const ReplayTab = ({ controller, defaultHost, lifecycle }: {
  readonly controller: RouteInvocationController;
  readonly defaultHost: RouteInvocationEventHost;
  readonly lifecycle?: Lifecycle;
}): React.ReactNode => {
  const [host, setHost] = useState<RouteInvocationEventHost>(defaultHost);
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState<string>();
  const observed = controller.history.filter((summary) => summary.event?.host !== undefined);
  const replay = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(receipt);
    } catch {
      setError('Paste the native hook payload as a JSON object.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('The receipt must be a JSON object.');
      return;
    }
    setError(undefined);
    controller.run(Object.freeze({ event: Object.freeze({ host }), input: parsed as JsonObject }));
  };
  return <div className="event-replay">
    <p className="result-note">Replay a receipt a real host produced: paste its native payload and run it through this route exactly as the emitted wrapper would.</p>
    <label className="event-replay-host">
      <span>Host</span>
      <select onChange={(event) => { if (isEventHost(event.currentTarget.value)) setHost(event.currentTarget.value); }} value={host}>
        {eventHosts.map((candidate) => <option disabled={lifecycle !== undefined && eventHostTarget(lifecycle, candidate) === undefined} key={candidate} value={candidate}>{hostLabels[candidate]}</option>)}
      </select>
    </label>
    <label className="event-replay-receipt">
      <span>Native receipt (JSON)</span>
      <textarea aria-invalid={error === undefined ? undefined : true} onChange={(event) => setReceipt(event.currentTarget.value)} rows={8} spellCheck={false} value={receipt} />
    </label>
    {error === undefined ? undefined : <p className="route-input-error" role="alert">{error}</p>}
    <button className="route-run" disabled={controller.state.phase === 'running' || receipt.trim().length === 0} onClick={replay} type="button">Replay receipt</button>
    <h3>Observed host runs of this route</h3>
    {observed.length === 0
      ? <Empty>No host-submitted invocations of this route have been recorded in this dev session.</Empty>
      : <ol className="result-trace">{observed.map((summary) => <li className="result-trace-entry" key={summary.id}>
        <button onClick={() => controller.load(summary.id)} type="button">
          <StatusBadge status={summary.status} />
          {summary.outcome === undefined ? undefined : <OutcomeBadge outcome={summary.outcome} />}
          <span className="result-trace-host">{summary.event?.host}</span>
          <span className="result-trace-time">{summary.startedAt}</span>
          <span className="result-trace-id">{summary.id}</span>
        </button>
      </li>)}</ol>}
  </div>;
};

export interface EventRouteWorkspaceProps {
  readonly clients: Pick<WorkspaceClients, 'lifecycleClient'>;
  readonly controller: RouteInvocationController;
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly tab?: string;
}

const useLifecycle = (client: LifecycleClient, leaf: ApplicationLeaf): LifecycleState => {
  const [state, setState] = useState<LifecycleState>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: 'loading' });
    void client.list(controller.signal).then(
      (list) => { if (!controller.signal.aborted) setState(Object.freeze({ lifecycle: lifecycleForLeaf(list.lifecycles, leaf), state: 'ready' })); },
      (reason: unknown) => { if (!controller.signal.aborted) setState(Object.freeze({ message: errorMessage(reason, 'Host fixtures could not be loaded.'), state: 'unavailable' })); },
    );
    return () => controller.abort();
  }, [client, leaf]);
  return state;
};

/** Host selector → executable body with the event codec tabs. */
export const EventRouteWorkspace = ({ clients, controller, leaf, onNavigate, tab }: EventRouteWorkspaceProps): React.ReactNode => {
  const lifecycleState = useLifecycle(clients.lifecycleClient, leaf);
  const lifecycle = lifecycleState.state === 'ready' ? lifecycleState.lifecycle : undefined;
  const fixtures = useMemo(() => eventFixturesFor(lifecycle), [lifecycle]);
  const invocation = invocationOf(controller.state);
  const [host, setHost] = useState<EventHostSelection>('canonical');

  // A loaded host invocation switches the selector to its host so the editor
  // shows the native payload it was actually run with.
  useEffect(() => {
    if (invocation?.event?.host !== undefined) setHost(invocation.event.host);
  }, [invocation]);

  const nativeLeaf = useMemo<ApplicationLeaf>(() => {
    const { inputSchema: _schema, ...rest } = leaf;
    return Object.freeze(rest);
  }, [leaf]);
  const hostFixtures = host === 'canonical' ? [] : fixtures.filter((fixture) => fixture.host === host);

  const toolbar = <div aria-label="Event host" className="event-host-selector" role="group">
    {(['canonical', ...eventHosts] as readonly EventHostSelection[]).map((candidate) => {
      const target = candidate === 'canonical' ? undefined : eventHostTarget(lifecycle, candidate);
      const missing = candidate !== 'canonical' && lifecycleState.state === 'ready' && target === undefined;
      return <button
        aria-pressed={host === candidate}
        data-testid={`event-host-${candidate}`}
        disabled={missing || (candidate !== 'canonical' && lifecycleState.state === 'loading')}
        key={candidate}
        onClick={() => setHost(candidate)}
        title={missing ? `No ${hostLabels[candidate]} wrapper is generated for this event.` : target === undefined ? undefined : `${target.nativeEvent} · ${target.hostContractRevision}`}
        type="button"
      >{hostLabels[candidate]}</button>;
    })}
    <span className="event-host-note">
      {lifecycleState.state === 'loading'
        ? 'Loading host fixtures…'
        : lifecycleState.state === 'unavailable'
          ? lifecycleState.message
          : host === 'canonical'
            ? 'Submits the canonical event payload directly.'
            : `Submits ${hostLabels[host]}\u2019s native payload; the service canonicalizes it as the emitted wrapper would.`}
    </span>
  </div>;

  const extraTabs: readonly ResultTabDefinition[] = [
    { id: 'mapping', label: 'Canonical → host mapping', render: () => <MappingTab invocation={invocation} leaf={leaf} lifecycle={lifecycle} /> },
    { id: 'native', label: 'Native in / out', render: () => <NativeTab invocation={invocation} /> },
    { id: 'canonical', label: 'Canonical result', render: () => <CanonicalResultTab invocation={invocation} /> },
    { id: 'replay', label: 'Replay', render: () => <ReplayTab controller={controller} defaultHost={host === 'canonical' ? 'claude' : host} lifecycle={lifecycle} /> },
  ];

  return <ExecutableRouteWorkspace
    controller={controller}
    extraTabs={extraTabs}
    fixtures={hostFixtures}
    inputKey={host === 'canonical' ? leaf.key : `${leaf.key}#${host}`}
    inputLeaf={host === 'canonical' ? leaf : nativeLeaf}
    key={host}
    leaf={leaf}
    onNavigate={onNavigate}
    requestFor={(draft) => eventRequestFor(host, draft)}
    tab={tab}
    toolbar={toolbar}
  />;
};
