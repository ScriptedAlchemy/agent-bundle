/**
 * The workspace body every invocable leaf shares (#600): input editor → Run →
 * rendered Agent Document by default, secondary result tabs, and the inspector
 * drawer. `useRouteInvocation` owns the one invocation per mounted leaf and
 * drives it through the selected `InvocationBackend`; the event workspace
 * composes this body with a host selector and codec tabs.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import type {
  RouteInvocationRequest,
  RouteInvocationSummary,
  RouteInvocationSurface,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import { errorMessage, isAbortError, isRecord } from '../client-helpers.ts';
import type { WorkbenchLocation } from '../shell/workbench-location.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';
import {
  idleInvocationState,
  readLastInput,
  reduceInvocationState,
  selectBackend,
  statusLabel,
  writeLastInput,
  type InvocationState,
} from './invocation-model.ts';
import { OutcomeBadge, ResultTabs, type ResultTabDefinition } from './result-tabs.tsx';
import {
  defaultRouteInputValue,
  RouteInputEditor,
  routeInputJson,
  routeInputSubmission,
  routeInputValueFromJson,
  type RouteInputValue,
} from './route-input-editor.tsx';
import { RouteInspector } from './route-inspector.tsx';
import {
  invocationOf,
  type RouteInputFixture,
  type RouteInvocationController,
  type RouteInvocationDraft,
  type WorkspaceInspectorTab,
  type WorkspaceResultTab,
} from './workspace-contracts.ts';
import './workspace.css';

const resultTabs: readonly WorkspaceResultTab[] = Object.freeze(['canonical', 'cli', 'mapping', 'mcp', 'native', 'raw', 'rendered', 'replay', 'structured', 'trace']);

/** The `?tab=` value as a result tab, falling back to `rendered`. */
export const resultTabFor = (value: string | undefined): WorkspaceResultTab =>
  value !== undefined && (resultTabs as readonly string[]).includes(value) ? value as WorkspaceResultTab : 'rendered';

const failureOf = (reason: unknown): { readonly code: string; readonly message: string } => {
  const code = isRecord(reason) && typeof reason.code === 'string' && reason.code.length > 0 ? reason.code : 'AB8230';
  return Object.freeze({ code, message: errorMessage(reason, 'The invocation request failed.') });
};

const newCorrelationId = (): string => {
  const random = globalThis.crypto;
  return random !== undefined && typeof random.randomUUID === 'function'
    ? random.randomUUID()
    : `inv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export interface UseRouteInvocationOptions {
  readonly backends: readonly InvocationBackend[];
  /** A deep-linked snapshot to load; re-loaded whenever it changes. */
  readonly invocationId?: string;
  readonly leaf: ApplicationLeaf;
}

/**
 * One invocation per mounted leaf: picks the backend, runs requests with the
 * leaf's route id and a browser-minted correlation id, keeps this leaf's
 * history current from the backend's subscription, and loads snapshots by id.
 */
export const useRouteInvocation = ({ backends, invocationId, leaf }: UseRouteInvocationOptions): RouteInvocationController => {
  const backend = useMemo(() => selectBackend(backends, leaf), [backends, leaf]);
  const [state, dispatch] = useReducer(reduceInvocationState, idleInvocationState);
  const [request, setRequest] = useState<RouteInvocationRequest>();
  const [history, setHistory] = useState<readonly RouteInvocationSummary[]>(Object.freeze([]));
  const inFlight = useRef<AbortController | undefined>(undefined);
  const routeId = leaf.routeId;

  useEffect(() => {
    if (backend === undefined || routeId === undefined) return;
    const controller = new AbortController();
    void backend.history(leaf, controller.signal).then(
      (entries) => { if (!controller.signal.aborted) setHistory(entries); },
      () => undefined,
    );
    const unsubscribe = backend.subscribe((summary) => {
      if (summary.routeId !== routeId) return;
      setHistory((previous) => Object.freeze([summary, ...previous.filter((entry) => entry.id !== summary.id)]));
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [backend, leaf, routeId]);

  const load = useCallback((id: string): void => {
    if (backend === undefined) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    void backend.read(id, controller.signal).then(
      (invocation) => { if (!controller.signal.aborted) dispatch({ invocation, type: 'load' }); },
      (reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        dispatch({ completedAt: Date.now(), failure: failureOf(reason), type: 'fail' });
      },
    );
  }, [backend]);

  useEffect(() => {
    if (invocationId !== undefined) load(invocationId);
  }, [invocationId, load]);

  useEffect(() => () => { inFlight.current?.abort(); }, []);

  const run = useCallback((draft: RouteInvocationDraft): void => {
    if (backend === undefined || routeId === undefined) {
      dispatch({ completedAt: Date.now(), failure: { code: 'AB8230', message: 'No backend can run this route.' }, type: 'fail' });
      return;
    }
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    const correlationId = newCorrelationId();
    const next: RouteInvocationRequest = Object.freeze({ ...draft, correlationId, routeId });
    setRequest(next);
    dispatch({ correlationId, startedAt: Date.now(), type: 'start' });
    void backend.invoke(leaf, next, controller.signal).then(
      (invocation) => { if (!controller.signal.aborted) dispatch({ completedAt: Date.now(), invocation, type: 'settle' }); },
      (reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        dispatch({ completedAt: Date.now(), failure: failureOf(reason), type: 'fail' });
      },
    );
  }, [backend, leaf, routeId]);

  return useMemo(() => Object.freeze({
    ...(backend === undefined ? {} : { backendKind: backend.kind }),
    history,
    load,
    ...(request === undefined ? {} : { request }),
    run,
    state,
  }), [backend, history, load, request, run, state]);
};

const stateSummary = (state: InvocationState): string => {
  switch (state.phase) {
    case 'idle':
      return 'Not run yet';
    case 'running':
      return 'Running…';
    case 'succeeded':
      return `${statusLabel('succeeded')}${state.durationMs === undefined ? '' : ` in ${String(state.durationMs)} ms`}`;
    case 'failed':
      return `${statusLabel('failed')}${state.durationMs === undefined ? '' : ` after ${String(state.durationMs)} ms`}`;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const InvocationStatusLine = ({ backendKind, state }: { readonly backendKind?: string; readonly state: InvocationState }): React.ReactNode => {
  const invocation = invocationOf(state);
  return <p aria-live="polite" className={`route-status route-status--${state.phase}`} data-testid="route-status" role="status">
    <span className="route-status-phase">{stateSummary(state)}</span>
    {invocation?.outcome === undefined ? undefined : <OutcomeBadge outcome={invocation.outcome} />}
    {backendKind === undefined ? undefined : <span className="route-status-backend">via {backendKind}</span>}
    {invocation === undefined ? undefined : <span className="route-status-id">{invocation.id}</span>}
    {invocation?.correlationId === undefined ? undefined : <span className="route-status-correlation">correlation {invocation.correlationId}</span>}
  </p>;
};

const InvocationDiagnostics = ({ diagnostics, failure, onNavigate }: {
  readonly diagnostics: readonly Diagnostic[];
  readonly failure?: { readonly code: string; readonly message: string };
  readonly onNavigate: (location: WorkbenchLocation) => void;
}): React.ReactNode => <section aria-label="Invocation diagnostics" className="route-diagnostics">
  {failure === undefined ? undefined : <p className="route-diagnostic">
    <strong>{failure.code}</strong> {failure.message}
    <button className="route-diagnostic-link" onClick={() => onNavigate({ area: 'problems' })} type="button">Open in Problems</button>
  </p>}
  {diagnostics.map((diagnostic, index) => <p className={`route-diagnostic route-diagnostic--${diagnostic.severity}`} key={`${diagnostic.code}-${String(index)}`}>
    <strong>{diagnostic.code}</strong> {diagnostic.message}
    {diagnostic.recovery === undefined ? undefined : <span className="route-diagnostic-recovery">{diagnostic.recovery}</span>}
    <button className="route-diagnostic-link" onClick={() => onNavigate({ area: 'problems' })} type="button">Open in Problems</button>
  </p>)}
</section>;

export interface ExecutableRouteWorkspaceProps {
  readonly controller: RouteInvocationController;
  /** Result tabs appended after the core set (the event route's codec panes). */
  readonly extraTabs?: readonly ResultTabDefinition[];
  readonly fixtures?: readonly RouteInputFixture[];
  /** The leaf the editor builds its form from; event workspaces pass a schema-less view for native payloads. */
  readonly inputLeaf?: ApplicationLeaf;
  /** Where the last input persists; defaults to the leaf key. */
  readonly inputKey?: string;
  readonly leaf: ApplicationLeaf;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  /** Adds request options (an event host, a fixture id) to what the editor produced. */
  readonly requestFor?: (draft: RouteInvocationDraft, fixtureId?: string) => RouteInvocationDraft;
  readonly tab?: string;
  /** Rendered between the header and the editor (the event host selector). */
  readonly toolbar?: React.ReactNode;
}

const leafKindLabel = (leaf: ApplicationLeaf): string => {
  switch (leaf.ref.kind) {
    case 'tool':
      return 'MCP tool';
    case 'resource':
      return 'MCP resource';
    case 'prompt':
      return 'MCP prompt';
    case 'app':
      return 'MCP App';
    case 'event':
      return 'Event route';
    case 'cli':
      return 'CLI command';
    case 'script':
      return 'Script';
    case 'skill':
      return 'Skill';
    case 'command':
      return 'Command';
    case 'rule':
      return 'Rule';
    default: {
      const exhaustive: never = leaf.ref;
      return exhaustive;
    }
  }
};

/** Title, kind, route id, and description — the header every workspace body shares. */
export const WorkspaceHeader = ({ leaf, surface }: { readonly leaf: ApplicationLeaf; readonly surface?: string }): React.ReactNode => <header className="route-workspace-heading">
  <p className="route-workspace-eyebrow">{leafKindLabel(leaf)}{leaf.routeId === undefined ? '' : ` · ${leaf.routeId}`}{surface === undefined ? '' : ` · ${surface}`}</p>
  <h1>{leaf.label}</h1>
  {leaf.description === undefined ? undefined : <p className="route-workspace-description">{leaf.description}</p>}
</header>;

/** Input → Run → result tabs + inspector for one invocable leaf. */
export const ExecutableRouteWorkspace = ({
  controller,
  extraTabs,
  fixtures,
  inputKey,
  inputLeaf,
  leaf,
  onNavigate,
  requestFor,
  tab,
  toolbar,
}: ExecutableRouteWorkspaceProps): React.ReactNode => {
  const editorLeaf = inputLeaf ?? leaf;
  const projectedTool = leaf.ref.kind === 'tool' && leaf.command?.projection !== undefined;
  const [selectedSurface, setSelectedSurface] = useState<RouteInvocationSurface['kind']>(() => {
    switch (leaf.ref.kind) {
      case 'cli':
        return 'cli';
      case 'event':
        return 'event';
      case 'script':
        return 'script';
      case 'tool':
      case 'resource':
      case 'prompt':
        return 'mcp';
      case 'app':
      case 'skill':
      case 'command':
      case 'rule':
        return 'unit-render';
      default: {
        const exhaustive: never = leaf.ref;
        return exhaustive;
      }
    }
  });
  const cliSurface = selectedSurface === 'cli';
  const storageKey = inputKey ?? leaf.key;
  const [input, setInput] = useState<RouteInputValue>(() => {
    const last = readLastInput(storageKey);
    if (last !== undefined) return routeInputValueFromJson(editorLeaf, last);
    const fixture = fixtures?.[0];
    return fixture === undefined ? defaultRouteInputValue(editorLeaf) : routeInputValueFromJson(editorLeaf, fixture.input, fixture.id);
  });
  const [resultTab, setResultTab] = useState<WorkspaceResultTab>(() => resultTabFor(tab));
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<WorkspaceInspectorTab>('source');
  const invocation = invocationOf(controller.state);
  const seededFrom = useRef<string | undefined>(undefined);

  useEffect(() => { setResultTab(resultTabFor(tab)); }, [tab]);
  useEffect(() => {
    if (
      projectedTool
      && invocation !== undefined
      && (invocation.surface.kind === 'mcp' || invocation.surface.kind === 'cli' || invocation.surface.kind === 'unit-render')
    ) {
      setSelectedSurface(invocation.surface.kind);
    }
  }, [invocation, projectedTool]);

  // A snapshot loaded by id (deep link, trace entry) replaces the editor's
  // input with what that invocation actually rendered, once per snapshot.
  useEffect(() => {
    if (invocation === undefined || controller.request?.correlationId === invocation.correlationId || seededFrom.current === invocation.id) return;
    seededFrom.current = invocation.id;
    setInput(routeInputValueFromJson(editorLeaf, invocation.input));
  }, [controller.request, editorLeaf, invocation]);

  const changeTab = (next: WorkspaceResultTab): void => {
    setResultTab(next);
    onNavigate({ area: 'application', ...(invocation === undefined ? {} : { invocationId: invocation.id }), node: leaf.ref, tab: next });
  };

  const run = (): void => {
    const submission = routeInputSubmission(editorLeaf, input, cliSurface);
    if (submission.draft === undefined) {
      setInput(Object.freeze({ ...input, attempted: true }));
      return;
    }
    const json = routeInputJson(editorLeaf, input, cliSurface);
    if (json !== undefined) writeLastInput(storageKey, json);
    const surfaced = submission.draft.surface !== undefined
      ? submission.draft
      : Object.freeze({
          ...submission.draft,
          surface: Object.freeze({ kind: selectedSurface }) as RouteInvocationSurface,
        });
    controller.run(requestFor === undefined ? surfaced : requestFor(surfaced, input.fixtureId));
  };

  const failed = controller.state.phase === 'failed' ? controller.state : undefined;

  return <div className={inspectorOpen ? 'route-workspace route-workspace--inspecting' : 'route-workspace'} data-testid="route-workspace">
    <div className="route-workspace-main">
      <WorkspaceHeader
        leaf={leaf}
        surface={selectedSurface === 'cli' ? `CLI ${leaf.command?.path.join(' ') ?? ''}`.trim() : selectedSurface === 'mcp' ? 'MCP' : selectedSurface}
      />
      {projectedTool ? <div aria-label="Invocation surface" className="route-surface-selector" role="group">
        <button aria-pressed={selectedSurface === 'mcp'} onClick={() => setSelectedSurface('mcp')} type="button">MCP</button>
        <button aria-pressed={selectedSurface === 'cli'} onClick={() => setSelectedSurface('cli')} type="button">CLI <code>{leaf.command!.path.join(' ')}</code></button>
        <button aria-pressed={selectedSurface === 'unit-render'} onClick={() => setSelectedSurface('unit-render')} type="button">Unit render</button>
      </div> : undefined}
      {toolbar}
      <RouteInputEditor
        cliSurface={cliSurface}
        disabled={controller.backendKind === undefined}
        fixtures={fixtures}
        leaf={editorLeaf}
        onChange={setInput}
        onRun={run}
        running={controller.state.phase === 'running'}
        value={input}
      />
      <InvocationStatusLine backendKind={controller.backendKind} state={controller.state} />
      {failed === undefined || (failed.diagnostics.length === 0 && failed.failure === undefined)
        ? undefined
        : <InvocationDiagnostics diagnostics={failed.diagnostics} failure={failed.failure} onNavigate={onNavigate} />}
      <ResultTabs controller={controller} extraTabs={extraTabs} leaf={leaf} onNavigate={onNavigate} onTabChange={changeTab} tab={resultTab} />
    </div>
    <RouteInspector
      backendKind={controller.backendKind}
      invocation={invocation}
      leaf={leaf}
      onTabChange={setInspectorTab}
      onToggle={() => setInspectorOpen((open) => !open)}
      open={inspectorOpen}
      request={controller.request}
      tab={inspectorTab}
    />
  </div>;
};
