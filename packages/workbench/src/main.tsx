/**
 * The Workbench entry (#600): builds the foreground clients, keeps the project
 * connection and capability catalog current, derives the one application tree,
 * and renders the shell with the area the URL names. Pages, hash routing, and
 * page-availability selectors are gone; the tree and the route workspace are
 * the product.
 */
import { RegistryProvider } from '@effect/atom-react';
import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { MCP_APP_PROFILE_DESCRIPTORS } from '../../agent-bundle/src/contracts/mcp-apps.ts';
import type { ProjectStatus } from '../../agent-bundle/src/contracts/project.ts';

import { AdvancedPage } from './advanced/advanced-page.tsx';
import { applicationTreeFor, findApplicationLeaf, type ApplicationTree } from './application/application-tree-model.ts';
import { ApplicationTreeView } from './application/application-tree.tsx';
import { createDevServerBackend } from './application/dev-server-backend.ts';
import type { InvocationBackend } from './application/invocation-backend.ts';
import { InvocationClient } from './application/invocation-client.ts';
import { RouteWorkspace } from './application/route-workspace.tsx';
import { createRuntimeBackend } from './application/runtime-backend.ts';
import type { WorkspaceClients } from './application/workspace-contracts.ts';
import { ArtifactClient } from './artifacts/artifact-client.ts';
import { errorMessage as messageFrom } from './client-helpers.ts';
import { DiscoveryClient } from './discovery/discovery-client.ts';
import { ComparisonClient } from './evals/comparison-client.ts';
import { EvalClient } from './evals/eval-client.ts';
import { HookClient } from './hooks/hook-client.ts';
import { LifecycleClient } from './lifecycles/lifecycle-client.ts';
import { LogClient } from './logs/log-client.ts';
import { McpAppClient } from './mcp/mcp-app-client.ts';
import { createMcpInspectorLaunchController } from './mcp/mcp-inspector-launch-controller.ts';
import { ForegroundRouteClient, McpRouteClient } from './mcp/mcp-route-client.ts';
import { createMcpSessionController } from './mcp/mcp-session-controller.ts';
import { ProblemsPage } from './problems/problems-page.tsx';
import { projectFailureText, ProjectClient, type ProjectConnectionState } from './project-client.ts';
import { RouteManifestClient } from './routes/route-manifest-client.ts';
import { RuntimeClient, type RuntimeBootstrap } from './runtime-client.ts';
import { HostSessionClient } from './sessions/host-session-client.ts';
import { SessionsPage } from './sessions/sessions-page.tsx';
import type { RuntimeProfileOption } from './runtime-model.ts';
import {
  createRuntimeEventBuffer,
  createRuntimePlaygroundController,
  runtimeBootstrapRetryPlan,
  type RuntimePlaygroundController,
} from './runtime-controller.ts';
import { activeEpochFor, problemsFor, type Problem } from './shell/build-status-model.ts';
import { ConnectionGate } from './shell/shell-status.tsx';
import { applicationNodePath, type WorkbenchLocation } from './shell/workbench-location.ts';
import { createWorkbenchRouter, type WorkbenchRouter } from './shell/workbench-router.ts';
import { ApplicationArea, SelectRouteState, UnknownRouteState, WorkbenchShell } from './shell/workbench-shell.tsx';
import { SkillClient } from './skill-client.ts';
import { ForegroundTraceClient, type TraceClient } from './trace/trace-client.ts';
import { TracePage } from './trace/trace-page.tsx';
import {
  applicationTreeSourcesFor,
  loadWorkbenchCapabilities,
  type WorkbenchCapabilities,
} from './workbench-capabilities.ts';
import './styles.css';

const errorMessage = (reason: unknown): string =>
  messageFrom(reason, 'Foreground project state could not be refreshed.');

const connectionFailure = (reason: unknown): string =>
  projectFailureText(reason, 'Foreground project state could not be refreshed.');

const runtimeProfiles = Object.values(MCP_APP_PROFILE_DESCRIPTORS) satisfies readonly RuntimeProfileOption[];

/** The Workbench, rather than an individual MCP transport, owns this shared foreground credential. */
class WorkbenchMcpRouteClient extends McpRouteClient {
  override forgetAuthentication(): void {}
}

const createMcpController = (routes: WorkbenchMcpRouteClient) => createMcpSessionController({ routes });

type WorkbenchMcpController = ReturnType<typeof createMcpController>;

type CapabilityState =
  | Readonly<{ readonly state: 'empty' }>
  | Readonly<{ readonly buildId: string; readonly previous?: WorkbenchCapabilities; readonly state: 'loading' }>
  | Readonly<{ readonly buildId: string; readonly message: string; readonly previous?: WorkbenchCapabilities; readonly state: 'error' }>
  | Readonly<{ readonly state: 'ready'; readonly value: WorkbenchCapabilities }>;

/** The last loaded catalog, retained so an epoch flip revalidates without unmounting live content. */
const staleCapabilities = (state: CapabilityState): WorkbenchCapabilities | undefined => {
  switch (state.state) {
    case 'ready':
      return state.value;
    case 'loading':
    case 'error':
      return state.previous;
    case 'empty':
      return undefined;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const noProblems: readonly Problem[] = Object.freeze([]);

/** One shared foreground client set; constructed once for the page's lifetime. */
const createClients = () => {
  const foreground = new ForegroundRouteClient();
  const mcpRoutes = new WorkbenchMcpRouteClient({ foreground });
  return Object.freeze({
    artifactClient: new ArtifactClient({ foreground }),
    comparisonClient: new ComparisonClient({ foreground }),
    discoveryClient: new DiscoveryClient({ foreground }),
    evalClient: new EvalClient({ foreground }),
    foreground,
    hookClient: new HookClient({ foreground }),
    hostSessionClient: new HostSessionClient({ foreground }),
    inspectorLaunch: createMcpInspectorLaunchController({ routes: mcpRoutes }),
    invocationClient: new InvocationClient({ foreground }),
    lifecycleClient: new LifecycleClient({ foreground }),
    logClient: new LogClient({ foreground }),
    mcpRoutes,
    routeManifestClient: new RouteManifestClient({ foreground }),
    runtimeClient: new RuntimeClient(foreground),
    skillClient: new SkillClient(),
    traceClient: new ForegroundTraceClient({ foreground }),
  });
};

type WorkbenchClients = ReturnType<typeof createClients>;

const ApplicationExplorer = ({ backends, clients, location, onNavigate, status, trace, tree }: {
  readonly backends: readonly InvocationBackend[];
  readonly clients: WorkspaceClients;
  readonly location: Extract<WorkbenchLocation, { readonly area: 'application' }>;
  readonly onNavigate: (location: WorkbenchLocation) => void;
  readonly status: ProjectStatus;
  readonly trace: TraceClient;
  readonly tree: ApplicationTree | undefined;
}) => {
  const [query, setQuery] = useState('');
  const leaf = tree === undefined || location.node === undefined ? undefined : findApplicationLeaf(tree, location.node);
  const workspace = location.node === undefined
    ? <SelectRouteState tree={tree} />
    : leaf === undefined || tree === undefined
      ? <UnknownRouteState onNavigate={onNavigate} path={applicationNodePath(location.node)} />
      : <RouteWorkspace
          backends={backends}
          clients={clients}
          invocationId={location.invocationId}
          leaf={leaf}
          onNavigate={onNavigate}
          status={status}
          tab={location.tab}
          trace={trace}
          tree={tree}
        />;
  return <ApplicationArea tree={tree === undefined
    ? <p aria-live="polite" className="empty-row">Loading the application graph…</p>
    : <ApplicationTreeView
        onQueryChange={setQuery}
        onSelect={(ref) => onNavigate({ area: 'application', node: ref })}
        query={query}
        selected={location.node}
        tree={tree}
      />}>
    {workspace}
  </ApplicationArea>;
};

const Workbench = () => {
  const clientsRef = useRef<WorkbenchClients>(undefined);
  const clients = (clientsRef.current ??= createClients());
  const routerRef = useRef<WorkbenchRouter>(undefined);
  const router = (routerRef.current ??= createWorkbenchRouter(window));
  const location = useSyncExternalStore(router.subscribe, router.current, router.current);
  const navigate = useCallback((next: WorkbenchLocation): void => { router.navigate(next); }, [router]);

  const project = useRef<ProjectClient>(undefined);
  const mcpAppClient = useRef<McpAppClient>(undefined);
  const mcpControllerRef = useRef<WorkbenchMcpController>(undefined);
  const runtimeController = useRef<RuntimePlaygroundController>(undefined);
  const resetRuntimeInstance = useRef<() => void>(() => undefined);

  const [mcpController, setMcpController] = useState(() => createMcpController(clients.mcpRoutes));
  const [connectionError, setConnectionError] = useState<string>();
  const [connection, setConnection] = useState<ProjectConnectionState>({ state: 'connecting' });
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [capabilityState, setCapabilityState] = useState<CapabilityState>({ state: 'empty' });
  const [runtimeControllerState, setRuntimeControllerState] = useState<RuntimePlaygroundController>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [status, setStatus] = useState<ProjectStatus>();

  const replaceMcpController = useCallback((): void => {
    const replacement = createMcpController(clients.mcpRoutes);
    mcpControllerRef.current = replacement;
    setMcpController(replacement);
  }, [clients]);

  const projectClient = (project.current ??= new ProjectClient({
    beforeInstanceChange: async () => {
      try {
        await mcpControllerRef.current?.close();
      } catch (reason) {
        setConnectionError(connectionFailure(reason));
      }
      mcpAppClient.current?.resetRuntimeForForegroundReplacement();
      resetRuntimeInstance.current();
      runtimeController.current?.close();
      runtimeController.current = undefined;
      setRuntimeControllerState(undefined);
      setCapabilityState({ state: 'empty' });
      replaceMcpController();
    },
    foreground: clients.foreground,
  }));
  const appClient = (mcpAppClient.current ??= new McpAppClient({ foreground: clients.foreground, projectClient }));
  if (mcpControllerRef.current !== mcpController) mcpControllerRef.current = mcpController;

  const buildId = status === undefined ? undefined : activeEpochFor(status)?.id;
  const epochSourceRevision = status === undefined ? undefined : activeEpochFor(status)?.projectRevision;
  const runtimeConfigured = status?.runtime?.state === 'configured';
  // Serve the last loaded catalog while a new epoch's catalog loads: a build
  // flip must not unmount live content just to re-create it from the same
  // evidence.
  const capabilities = staleCapabilities(capabilityState);

  useEffect(() => {
    const next = projectClient;
    const runtimeClient = clients.runtimeClient;
    let runtimeEvents = createRuntimeEventBuffer();
    let mounted = true;
    let runtimeInstanceVersion = 0;
    let runtimeTopologyPresent = false;
    let runtimeBootstrapStarted = false;
    let runtimeRetry: ReturnType<typeof setTimeout> | undefined;
    let runtimeRetryCount = 0;
    const resetRuntimeBootstrap = (): void => {
      runtimeInstanceVersion += 1;
      runtimeTopologyPresent = false;
      runtimeBootstrapStarted = false;
      runtimeRetryCount = 0;
      if (runtimeRetry !== undefined) clearTimeout(runtimeRetry);
      runtimeRetry = undefined;
      runtimeEvents.close();
      runtimeEvents = createRuntimeEventBuffer();
    };
    resetRuntimeInstance.current = resetRuntimeBootstrap;
    const unsubscribeConnection = next.onConnection((nextConnection) => {
      if (!mounted) return;
      setConnection(nextConnection);
      if (nextConnection.state === 'connected') setConnectionError(undefined);
    });
    const runtimeUnavailable = (): void => {
      runtimeEvents.close();
      runtimeRetryCount = 0;
      setRuntimeError(undefined);
    };
    const resolveRuntimeCapability = (bootstrap: RuntimeBootstrap): void => {
      if (!mounted) return;
      if (bootstrap.kind === 'unavailable') {
        runtimeUnavailable();
        return;
      }
      const controller = runtimeController.current;
      if (controller === undefined) {
        const nextController = createRuntimePlaygroundController({
          bootstrap,
          client: runtimeClient,
          defaultProfileId: 'portable',
          profiles: runtimeProfiles,
        });
        runtimeController.current = nextController;
        runtimeEvents.install(nextController);
        setRuntimeControllerState(nextController);
      } else {
        controller.dispatch({ bootstrap, type: 'bootstrap.received' });
      }
      setRuntimeError(undefined);
      if (bootstrap.status.activeVector === undefined && bootstrap.status.state !== 'failed' && bootstrap.status.state !== 'closed') {
        scheduleRuntimeBootstrap();
      } else {
        runtimeRetryCount = 0;
      }
    };
    const scheduleRuntimeBootstrap = (): void => {
      if (!mounted || runtimeRetry !== undefined) return;
      const retry = runtimeBootstrapRetryPlan(runtimeRetryCount, runtimeController.current !== undefined);
      runtimeRetryCount = retry.retryCount;
      if (retry.closePreControllerIngress) runtimeEvents.close();
      if (retry.delay === undefined) return;
      runtimeRetry = setTimeout(() => {
        runtimeRetry = undefined;
        bootstrapRuntime();
      }, retry.delay);
    };
    const bootstrapRuntime = (): void => {
      if (!mounted || !runtimeTopologyPresent) return;
      const instanceVersion = runtimeInstanceVersion;
      runtimeBootstrapStarted = true;
      void runtimeClient.bootstrap().then((bootstrap) => {
        if (instanceVersion === runtimeInstanceVersion) resolveRuntimeCapability(bootstrap);
      }).catch((reason: unknown) => {
        if (!mounted || instanceVersion !== runtimeInstanceVersion) return;
        setRuntimeError(errorMessage(reason));
        scheduleRuntimeBootstrap();
      });
    };
    void next.connect(
      (nextStatus) => {
        if (!mounted) return;
        setConnectionError(undefined);
        setStatus(nextStatus);
        if (nextStatus.runtime?.state === 'configured') {
          runtimeTopologyPresent = true;
          if (!runtimeBootstrapStarted) bootstrapRuntime();
          return;
        }
        runtimeUnavailable();
      },
      (reason) => {
        if (mounted) setConnectionError(connectionFailure(reason));
      },
      (event) => { runtimeEvents.receive(event); },
    ).catch((reason: unknown) => {
      if (mounted) setConnectionError(connectionFailure(reason));
    });
    return () => {
      mounted = false;
      if (resetRuntimeInstance.current === resetRuntimeBootstrap) resetRuntimeInstance.current = () => undefined;
      if (runtimeRetry !== undefined) clearTimeout(runtimeRetry);
      runtimeEvents.close();
      unsubscribeConnection();
      void (async () => {
        try {
          await mcpControllerRef.current?.close();
        } catch {
          // Draining errors are surfaced by the owning controller while active.
        }
        mcpAppClient.current?.disposeRuntime();
        next.close();
      })();
      runtimeController.current?.close();
      runtimeController.current = undefined;
    };
  }, [clients, projectClient]);

  useEffect(() => {
    const request = new AbortController();
    if (buildId === undefined) {
      setCapabilityState({ state: 'empty' });
      return () => request.abort();
    }
    setCapabilityState((current) => {
      if (current.state === 'ready' && current.value.buildId === buildId) return current;
      const previous = staleCapabilities(current);
      return { buildId, ...(previous === undefined ? {} : { previous }), state: 'loading' };
    });
    void loadWorkbenchCapabilities({
      artifactClient: clients.artifactClient,
      buildId,
      ...(epochSourceRevision === undefined ? {} : { epochSourceRevision }),
      evalClient: clients.evalClient,
      routeManifestClient: clients.routeManifestClient,
      runtime: runtimeConfigured,
      signal: request.signal,
      skillClient: clients.skillClient,
    }).then(
      (value) => { if (!request.signal.aborted) setCapabilityState({ state: 'ready', value }); },
      (reason: unknown) => {
        if (request.signal.aborted) return;
        setCapabilityState((current) => {
          const previous = staleCapabilities(current);
          return { buildId, message: errorMessage(reason), ...(previous === undefined ? {} : { previous }), state: 'error' };
        });
      },
    );
    return () => request.abort();
  }, [buildId, capabilityRetry, clients, epochSourceRevision, runtimeConfigured]);

  useEffect(() => () => {
    // Root shutdown owns the active controller's close; this cleanup owns only a superseded controller after reset.
    if (mcpControllerRef.current !== mcpController) void mcpController.close().catch(() => undefined);
  }, [mcpController]);
  useEffect(() => () => { router.dispose(); }, [router]);

  const tree = useMemo(() => capabilities === undefined ? undefined : applicationTreeFor(applicationTreeSourcesFor(capabilities)), [capabilities]);
  const problems = useMemo(() => status === undefined ? noProblems : problemsFor({
    ...(capabilities === undefined ? {} : {
      catalog: {
        diagnostics: capabilities.routes.manifest?.diagnostics ?? [],
        ...(capabilities.routes.message === undefined ? {} : { message: capabilities.routes.message }),
        state: capabilities.routes.state,
      },
    }),
    ...(runtimeError === undefined ? {} : { runtimeDiagnostic: runtimeError }),
    status,
    ...(tree === undefined ? {} : { tree }),
  }), [capabilities, runtimeError, status, tree]);

  const devServerBackend = useMemo(() => createDevServerBackend({
    client: clients.invocationClient,
    events: { subscribe: (listener) => projectClient.subscribeEvents(listener) },
  }), [clients, projectClient]);
  const runtimeBackend = useMemo(() => capabilities?.features.runtime === true && runtimeControllerState !== undefined
    ? createRuntimeBackend({ controller: runtimeControllerState, runtimeClient: clients.runtimeClient })
    : undefined, [capabilities?.features.runtime, clients, runtimeControllerState]);
  const backends = useMemo<readonly InvocationBackend[]>(() => Object.freeze(
    runtimeBackend === undefined ? [devServerBackend] : [runtimeBackend, devServerBackend],
  ), [devServerBackend, runtimeBackend]);

  const workspaceClients = useMemo<WorkspaceClients>(() => Object.freeze({
    appClient,
    evalClient: clients.evalClient,
    foreground: clients.foreground,
    hookClient: clients.hookClient,
    hostSessionClient: clients.hostSessionClient,
    lifecycleClient: clients.lifecycleClient,
    mcpRoutes: clients.mcpRoutes,
    skillClient: clients.skillClient,
  }), [appClient, clients]);

  const repair = useCallback(async (): Promise<void> => {
    setStatus(await projectClient.rebuild());
  }, [projectClient]);

  const connectionGate = connection.state === 'connected' ? undefined : <ConnectionGate error={connectionError} state={connection.state} />;
  if (connection.generation === undefined && connectionGate !== undefined) return connectionGate;
  if (status === undefined) {
    if (connectionGate !== undefined) return connectionGate;
    return <main aria-live="polite" className="loading-state" data-testid="workbench-loading">
      <strong>Loading project state…</strong>
      {runtimeError === undefined ? undefined : <p className="runtime-capability-error">Runtime capability issue: {runtimeError}</p>}
    </main>;
  }
  if (buildId !== undefined && capabilities === undefined) {
    const content = capabilityState.state === 'error' && capabilityState.buildId === buildId
      ? <main aria-live="polite" className="loading-state" data-testid="workbench-loading">
          <h1>Bundle capabilities unavailable</h1>
          <p role="alert">{capabilityState.message}</p>
          <button onClick={() => setCapabilityRetry((current) => current + 1)} type="button">Retry</button>
        </main>
      : <main aria-live="polite" className="loading-state" data-testid="workbench-loading"><strong>Loading bundle capabilities…</strong></main>;
    return <>
      <div className="connection-content" inert={connectionGate === undefined ? undefined : true} key={connection.generation}>{content}</div>
      {connectionGate}
    </>;
  }

  const area = ((): ReactNode => {
    switch (location.area) {
      case 'application':
        return <ApplicationExplorer backends={backends} clients={workspaceClients} location={location} onNavigate={navigate} status={status} trace={clients.traceClient} tree={tree} />;
      case 'trace':
        return <TracePage client={clients.traceClient} correlation={location.correlation} entryId={location.invocationId} onNavigate={navigate} />;
      case 'problems':
        return <ProblemsPage onNavigate={navigate} onRepair={repair} problems={problems} status={status} />;
      case 'sessions':
        return <SessionsPage client={clients.hostSessionClient} onNavigate={navigate} session={location.session} />;
      case 'advanced':
        return <AdvancedPage
          clients={{
            appClient,
            artifactClient: clients.artifactClient,
            comparisonClient: clients.comparisonClient,
            discoveryClient: clients.discoveryClient,
            evalClient: clients.evalClient,
            logClient: clients.logClient,
          }}
          manifestSourceRevision={capabilities?.routes.manifest?.sourceRevision}
          onNavigate={navigate}
          protocol={{ controller: mcpController, inspectorLaunch: clients.inspectorLaunch, onResetSession: replaceMcpController }}
          section={location.section}
          status={status}
        />;
      default: {
        const exhaustive: never = location;
        return exhaustive;
      }
    }
  })();

  const runtimeNotice = runtimeError === undefined
    ? undefined
    : <p className="runtime-capability-error" role="status">Runtime capability issue: {runtimeError}</p>;

  return <>
    <div className="connection-content" inert={connectionGate === undefined ? undefined : true} key={connection.generation}>
      <WorkbenchShell
        connection={connection}
        connectionError={connectionError}
        header={runtimeNotice}
        location={location}
        onNavigate={navigate}
        problems={problems}
        status={status}
        tree={tree}
      >
        {area}
      </WorkbenchShell>
    </div>
    {connectionGate}
  </>;
};

const root = document.getElementById('root');
if (root === null) throw new Error('Workbench root element is missing.');
createRoot(root).render(<RegistryProvider><Workbench /></RegistryProvider>);
