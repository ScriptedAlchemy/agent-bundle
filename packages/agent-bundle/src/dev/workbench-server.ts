import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import type { InstallHost } from '../install/install.ts';
import { HookService } from '../services/hook-service.ts';
import { AgentApi } from './agent-api.ts';
import { ArtifactInspectionService } from './artifacts/artifact-inspection-service.ts';
import { DevCoordinator } from './coordinator.ts';
import { DevPackageBuildService } from './package-build-service.ts';
import { runDevEpochContracts } from './dev-contract-runner.ts';
import { EpochAdoptionPolicy } from './epoch-adoption-policy.ts';
import { devStateRoot } from './state-paths.ts';
import { DevLogService } from './logs/dev-log-service.ts';
import { attachProjectEventLogs, createMcpDevLogTraceSink, createProjectDevLogger } from './logs/dev-log-producers.ts';
import { EpochStore, EpochStoreError } from './epoch-store.ts';
import { EvalService } from './eval/eval-service.ts';
import { ProjectEventHub } from './events.ts';
import { attachHookReceipts } from './hooks/hook-receipt-endpoint.ts';
import { createInspectorLauncher } from './inspector-launcher.ts';
import { HookPlaygroundService } from './playground/hook-playground-service.ts';
import { DevHostInstallManager } from './host-install-manager.ts';
import { HostSessionService } from './sessions/host-session-service.ts';
import {
  HostDiscoveryService,
  type HostDiscoveryServiceOptions,
} from './playground/host-discovery-service.ts';
import { HostMcpRoutes } from './host-mcp-routes.ts';
import { LifecycleReplayService } from './playground/lifecycle-replay-service.ts';
import {
  McpProbeService,
  type McpProbeServiceOptions,
} from './playground/mcp-probe-service.ts';
import {
  startForegroundServer,
  type ForegroundCoordinator,
  type ForegroundServerOptions,
  type WorkbenchAssetSource,
} from './foreground-server.ts';
import { McpAppBindingService, type McpAppToolDefinition } from './mcp-apps/mcp-app-binding-service.ts';
import type { McpAppRoutePreviewService } from './mcp-apps/mcp-app-routes.ts';
import { McpAppPreviewService } from './mcp-apps/mcp-app-preview-service.ts';
import { mcpAppPreviewHost, mcpAppPreviewHostInfo, openInBrowser, type OpenBrowser } from './mcp-apps/mcp-app-preview-host.ts';
import { McpAppRuntimeBindingService } from './mcp-app-runtime-binding-service.ts';
import { McpAppRuntimePreviewService } from './mcp-app-runtime-preview-service.ts';
import {
  createMcpAppSandboxProxy,
  type CreateMcpAppSandboxProxyOptions,
  type McpAppSandboxProxy,
} from './mcp-apps/mcp-app-sandbox.ts';
import { McpSessionService } from './mcp-session/mcp-session-service.ts';
import { NativePlaygroundService } from './playground/native-playground-service.ts';
import { PlaygroundOrchestrationService } from './playground/playground-orchestration-service.ts';
import { PlaygroundStore as PlaygroundService } from './playground/playground-store.ts';
import { createDevPlatformRuntime } from './platform-run.ts';
import type { DevPlatformRuntime } from './platform-runtime.ts';
import { ProjectService, type PreparedProject } from './project-service.ts';
import { emptyCompiledRouteGraph } from '../routes/graph.ts';
import { testManifestFromRouteGraph } from '../test/manifest.ts';
import type { RouteInvocationEventHost } from './routes/route-invocation.ts';
import {
  ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE,
  ROUTE_INVOCATION_STALE_REVISION_CODE,
  ROUTE_INVOCATION_STALE_REVISION_MESSAGE,
  RouteInvocationRequestError,
  RouteInvocationService,
} from './routes/route-invocation-service.ts';
import { routeManifestFor } from './routes/route-manifest.ts';
import type { RouteManifestRouteService } from './routes/route-manifest-routes.ts';
import { DevRuntimeController } from './runtime-controller.ts';
import {
  RuntimeClientSurfaceProxy,
  strictRuntimeClientSurfaceContentPolicy,
  type RuntimeClientSurfaceContentPolicy,
} from './runtime-client-surface-proxy.ts';
import { resolveDevRuntimeProvider } from './runtime-provider-loader.ts';
import {
  isDevRuntimeUnavailableError,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeClientSurfaceProxyBinding,
  type DevRuntimeEventInput,
} from './runtime-provider.ts';
import { ScriptPlaygroundService } from './playground/script-playground-service.ts';
import { SkillDocumentService } from './skill-document-service.ts';
import { TraceHub } from './trace/trace-hub.ts';
import { attachProjectEventTrace } from './trace/trace-project-events.ts';
import { createWorkbenchAssetSource } from './workbench-assets.ts';
import type { Invalidation, ProjectStatus } from './types.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface DevServerSession {
  close(): Promise<void>;
  openRuntimeClientSurface(surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  status(): ProjectStatus;
  readonly url: string;
}

export type { OpenBrowser } from './mcp-apps/mcp-app-preview-host.ts';

interface Closeable {
  close(): Promise<void>;
}

export interface DevServerLifecycleCloseFailure {
  readonly error: unknown;
  readonly resource: 'coordinator' | 'epoch-adoption' | 'host-installs' | 'inspector' | 'logs' | 'mcp-apps' | 'mcp-sessions' | 'playground' | 'runtime' | 'runtime-client-surfaces';
}

/** Reports session and coordinator cleanup failures without hiding either resource. */
export class DevServerLifecycleCloseError extends Error {
  readonly failures: readonly DevServerLifecycleCloseFailure[];

  constructor(failures: readonly DevServerLifecycleCloseFailure[]) {
    super('Development workbench could not close every lifecycle resource.');
    this.name = 'DevServerLifecycleCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

export interface StartDevServerOptions {
  /** Enables the optional agent-facing MCP endpoint for this foreground session. */
  readonly agentApi?: boolean;
  /** @internal Trusted test seam for the fixed Agent API bearer secret. */
  readonly agentApiToken?: string;
  /** Supplied by integration tests; published callers use the packaged assets. */
  readonly assets?: WorkbenchAssetSource;
  /** Hosts whose installed development variant follows successful artifact epochs. */
  readonly installHosts?: readonly InstallHost[];
  /** Launch the foreground URL after it has started. Defaults to false. */
  readonly open?: boolean;
  /** Injectable browser launcher for embedding and deterministic tests. */
  readonly openBrowser?: OpenBrowser;
  readonly port?: number;
  /** Advanced adapter registry shared by all development project and runtime services. */
  readonly registry?: TargetRegistry;
  readonly root: string;
  /** Test-only listener and sandbox factories; production always uses the built-in loopback services. */
  readonly testing?: DevServerTesting;
  /** Contributor HMR only: loopback origins of a Workbench Rsbuild dev server that proxies `/api` to this foreground server; never set by default. */
  readonly workbenchDevOrigins?: readonly string[];
}

interface DevServerForeground {
  close(): Promise<void>;
  readonly url: string;
}

interface DevServerTesting {
  readonly createSandboxProxy?: (options: CreateMcpAppSandboxProxyOptions) => Promise<McpAppSandboxProxy>;
  /** Overrides only Doctor execution and time; prepared build identity always comes from this dev server. */
  readonly hostDiscoveryOptions?: Pick<HostDiscoveryServiceOptions, 'doctor' | 'doctorOptions' | 'now'>;
  readonly mcpProbeOptions?: Pick<
    McpProbeServiceOptions,
    | 'clock'
    | 'createClient'
    | 'createPluginData'
    | 'createStdioTransport'
    | 'createStreamableHttpTransport'
    | 'now'
    | 'registry'
    | 'timeoutMs'
  >;
  readonly openRuntimeClientSurface?: (
    endpoint: DevRuntimeClientSurfaceEndpoint,
    listener: Parameters<typeof RuntimeClientSurfaceProxy.open>[1],
    hostOrigin: string,
  ) => Promise<DevRuntimeClientSurfaceProxyBinding>;
  readonly startForegroundServer?: (options: ForegroundServerOptions) => Promise<DevServerForeground>;
}

export interface DevServerStartFailure {
  readonly error: unknown;
  readonly resource: 'cleanup' | 'start';
}

/** Preserves a failed post-listener startup and every release failure needed to unwind it. */
export class DevServerStartError extends Error {
  readonly failures: readonly DevServerStartFailure[];

  constructor(failures: readonly DevServerStartFailure[]) {
    super('Development workbench could not start cleanly.');
    this.name = 'DevServerStartError';
    this.failures = Object.freeze([...failures]);
  }
}

interface McpAppLifecycleCloseFailure {
  readonly error: unknown;
  readonly resource: 'previews' | 'runtime-previews' | 'sandbox';
}

class McpAppLifecycleCloseError extends Error {
  readonly failures: readonly McpAppLifecycleCloseFailure[];

  constructor(failures: readonly McpAppLifecycleCloseFailure[]) {
    super('MCP Apps could not close every lifecycle resource.');
    this.name = 'McpAppLifecycleCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

class McpAppLifecycle implements Closeable {
  readonly #sandbox: McpAppSandboxProxy;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #prepareClosePromise: Promise<void> | undefined;
  #previews: McpAppPreviewService | undefined;
  #runtimePreviews: McpAppRuntimePreviewService | undefined;

  constructor(sandbox: McpAppSandboxProxy) {
    this.#sandbox = sandbox;
  }

  attach(previews: McpAppPreviewService, runtimePreviews?: McpAppRuntimePreviewService): void {
    if (this.#previews !== undefined) throw new Error('MCP App previews are already attached.');
    if (this.#closing) throw new Error('MCP App previews are closing.');
    this.#previews = previews;
    this.#runtimePreviews = runtimePreviews;
  }

  /** The runtime App lane can arrive after its initial model becomes valid. */
  attachRuntime(runtimePreviews: McpAppRuntimePreviewService): boolean {
    if (this.#previews === undefined) throw new Error('MCP App previews are not attached.');
    if (this.#closing || this.#runtimePreviews !== undefined) return false;
    this.#runtimePreviews = runtimePreviews;
    return true;
  }

  get acceptsRuntimePreviews(): boolean { return !this.#closing && this.#previews !== undefined && this.#runtimePreviews === undefined; }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  prepareClose(): Promise<void> {
    this.#closing = true;
    this.#prepareClosePromise ??= this.#runtimePreviews?.prepareClose() ?? Promise.resolve();
    return this.#prepareClosePromise;
  }

  async #close(): Promise<void> {
    await this.prepareClose();
    const preview = this.#previews === undefined
      ? undefined
      : await Promise.allSettled([this.#previews.closeAll()]);
    const runtimePreview = this.#runtimePreviews === undefined
      ? undefined
      : await Promise.allSettled([this.#runtimePreviews.closeAll()]);
    const sandbox = await Promise.allSettled([this.#sandbox.close()]);
    const failures: McpAppLifecycleCloseFailure[] = [
      ...(preview?.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'previews' as const })]
        : []) ?? []),
      ...(runtimePreview?.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'runtime-previews' as const })]
        : []) ?? []),
      ...sandbox.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'sandbox' as const })]
        : []),
    ];
    if (failures.length > 0) throw new McpAppLifecycleCloseError(failures);
  }
}

/** Connects foreground-owned App routes after the listener reveals its loopback origin. */
class DeferredMcpAppPreviewService implements McpAppRoutePreviewService {
  #closing = false;
  #service: McpAppRoutePreviewService | undefined;
  #runtime: McpAppRuntimePreviewService | undefined;
  #prepareClose: (() => Promise<void>) | undefined;

  attach(service: McpAppRoutePreviewService, runtime?: McpAppRuntimePreviewService, lifecycle?: McpAppLifecycle): void {
    if (this.#service !== undefined) throw new Error('MCP App preview route service is already attached.');
    if (this.#closing) throw new Error('MCP App preview route service is closing.');
    this.#service = service;
    this.#runtime = runtime;
    this.#prepareClose = lifecycle === undefined ? undefined : () => lifecycle.prepareClose();
  }

  /** Publishes one lifecycle-owned runtime lane only after it is fully registered. */
  attachRuntime(runtime: McpAppRuntimePreviewService): boolean {
    if (this.#service === undefined) throw new Error('MCP App preview route service is not ready.');
    if (this.#closing || this.#runtime !== undefined) return false;
    this.#runtime = runtime;
    return true;
  }

  get runtime(): McpAppRuntimePreviewService | undefined { return this.#runtime; }

  prepareClose(): Promise<void> {
    // The route facade must fail closed synchronously, before the foreground
    // begins draining the runtime preview lane it no longer exposes.
    this.#closing = true;
    this.#runtime = undefined;
    return this.#prepareClose?.() ?? Promise.resolve();
  }

  get(bindingId: string) {
    return this.#service?.get(bindingId);
  }

  create(options: Parameters<McpAppRoutePreviewService['create']>[0]) {
    return this.#active().create(options);
  }

  forceClose(bindingId: string) {
    return this.#active().forceClose(bindingId);
  }

  receive(bindingId: string, action: unknown) {
    return this.#active().receive(bindingId, action);
  }

  takeOutbound(bindingId: string) {
    return this.#active().takeOutbound(bindingId);
  }

  close(bindingId: string, options: Parameters<McpAppRoutePreviewService['close']>[1]) {
    return this.#active().close(bindingId, options);
  }

  consentChallenges(bindingId: string) {
    return this.#active().consentChallenges?.(bindingId);
  }

  decideConsent(bindingId: string, challengeId: string, approved: boolean) {
    return this.#active().decideConsent?.(bindingId, challengeId, approved) ?? false;
  }

  #active(): McpAppRoutePreviewService {
    if (this.#service === undefined) throw new Error('MCP App preview service is not ready.');
    return this.#service;
  }
}

/** Owns every fixed loopback proxy binding for the life of a Workbench session. */
export class RuntimeClientSurfaceBindings implements Closeable {
  readonly #openProxy: typeof RuntimeClientSurfaceProxy.open;
  readonly #runtime: DevRuntimeController | undefined;
  readonly #bindings = new Set<DevRuntimeClientSurfaceProxyBinding>();
  readonly #lateCloseFailures: unknown[] = [];
  readonly #pending = new Set<Promise<DevRuntimeClientSurfaceProxyBinding | undefined>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #hostOrigin: string | undefined;

  constructor(
    runtime: DevRuntimeController | undefined,
    openProxy: typeof RuntimeClientSurfaceProxy.open = RuntimeClientSurfaceProxy.open,
  ) {
    this.#runtime = runtime;
    this.#openProxy = openProxy;
  }

  /** The foreground listener is the only authority allowed to embed a surface. */
  bindHostOrigin(hostOrigin: string): void {
    let parsed: URL;
    try {
      parsed = new URL(hostOrigin);
    } catch {
      throw new TypeError('Runtime client surfaces require a canonical foreground origin.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== hostOrigin ||
      parsed.username.length > 0 || parsed.password.length > 0 || parsed.pathname !== '/' ||
      parsed.search.length > 0 || parsed.hash.length > 0 || this.#hostOrigin !== undefined
    ) throw new TypeError('Runtime client surfaces require one canonical foreground origin binding.');
    this.#hostOrigin = parsed.origin;
  }

  async open(
    surfaceId: string,
    policy: RuntimeClientSurfaceContentPolicy = strictRuntimeClientSurfaceContentPolicy,
  ): Promise<DevRuntimeClientSurfaceProxyBinding | undefined> {
    if (this.#closing) throw new Error('Development runtime client surfaces are closed.');
    if (this.#hostOrigin === undefined) throw new Error('Development runtime client surfaces are not bound to a foreground origin.');
    let endpoint;
    try {
      endpoint = this.#runtime?.clientSurface(surfaceId);
    } catch (error) {
      if (isDevRuntimeUnavailableError(error)) return undefined;
      throw error;
    }
    if (endpoint === undefined) return undefined;
    const opening = this.#openProxy(endpoint, (event) => {
      this.#runtime?.emit(Object.freeze({
        details: Object.freeze({ connectionCount: event.connectionCount, surfaceId: event.surfaceId }),
        type: event.type === 'connected' ? 'runtime.hmr.client-connected' : 'runtime.hmr.client-disconnected',
      } satisfies DevRuntimeEventInput));
    }, this.#hostOrigin, policy).then(async (binding) => {
      if (this.#closing) {
        try {
          await binding.close();
        } catch (error) {
          this.#lateCloseFailures.push(error);
        }
        throw new Error('Development runtime client surfaces are closed.');
      }
      const wrapped: DevRuntimeClientSurfaceProxyBinding = Object.freeze({
        ...binding,
        close: async (): Promise<void> => {
          try {
            await binding.close();
          } finally {
            this.#bindings.delete(wrapped);
          }
        },
      });
      this.#bindings.add(wrapped);
      return wrapped;
    });
    this.#pending.add(opening);
    void opening.then(
      () => this.#pending.delete(opening),
      () => this.#pending.delete(opening),
    );
    return opening;
  }

  /** Fences new proxy acquisition before the App lanes begin their ordered drain. */
  beginClose(): void { this.#closing = true; }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#pending]);
    const results = await Promise.allSettled([...this.#bindings].map((binding) => binding.close()));
    const failures = [
      ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...this.#lateCloseFailures,
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime client surfaces could not close.');
  }
}

export interface DevServerRuntimeLifecycleResources {
  readonly clientSurfaces?: Closeable;
  readonly runtime?: Closeable;
}

export interface DevServerLifecycleOptions {
  readonly coordinator: Closeable;
  readonly detachProjectLogs?: () => void;
  readonly detachProjectTrace?: () => void;
  readonly epochAdoption?: Closeable;
  readonly hostInstalls?: Closeable;
  readonly logs?: DevLogService;
  readonly mcpApps?: Closeable;
  readonly inspector?: Closeable;
  readonly mcpSessions: Closeable;
  readonly playground?: Closeable;
  readonly runtimeResources?: DevServerRuntimeLifecycleResources;
  readonly trace?: TraceHub;
}

/** Closes persistent MCP state alongside the coordinator, preserving all cleanup failures. */
export const closeDevServerLifecycle = async ({
  coordinator,
  detachProjectLogs,
  detachProjectTrace,
  epochAdoption,
  hostInstalls,
  inspector,
  logs,
  mcpApps,
  mcpSessions,
  playground,
  runtimeResources,
  trace,
}: DevServerLifecycleOptions): Promise<void> => {
  // ForegroundServer owns the Agent API admission gate. This lifecycle owns
  // only the shared services that are released after foreground routing ends.
  logs?.log({
    kind: 'dev.shutdown.started',
    level: 'info',
    producer: 'project',
    summary: 'Development workbench shutdown started.',
  });
  // Producers close strictly in this order, each awaited before the next;
  // the ordering is load-bearing for the sessions the coordinator drains.
  const producers: readonly (readonly [DevServerLifecycleCloseFailure['resource'], Closeable | undefined])[] = [
    ['playground', playground],
    ['inspector', inspector],
    ['mcp-apps', mcpApps],
    ['runtime-client-surfaces', runtimeResources?.clientSurfaces],
    ['runtime', runtimeResources?.runtime],
    ['epoch-adoption', epochAdoption],
    ['mcp-sessions', mcpSessions],
    ['host-installs', hostInstalls],
    ['coordinator', coordinator],
  ];
  const failures: DevServerLifecycleCloseFailure[] = [];
  const closeResource = async (resource: DevServerLifecycleCloseFailure['resource'], closeable: Closeable): Promise<void> => {
    const [result] = await Promise.allSettled([closeable.close()]);
    if (result?.status === 'rejected') failures.push(Object.freeze({ error: result.reason, resource }));
  };
  for (const [resource, closeable] of producers) {
    if (closeable !== undefined) await closeResource(resource, closeable);
  }
  try { detachProjectLogs?.(); }
  catch { /* The subscription is observability-only and cannot hold shutdown. */ }
  try { detachProjectTrace?.(); }
  catch { /* The subscription is observability-only and cannot hold shutdown. */ }
  logs?.log({
    details: { failures: failures.length },
    kind: 'dev.shutdown.completed',
    level: failures.length === 0 ? 'info' : 'warning',
    producer: 'project',
    summary: failures.length === 0 ? 'Development workbench shutdown completed.' : 'Development workbench shutdown completed with failures.',
  });
  if (logs !== undefined) await closeResource('logs', logs);
  trace?.close();
  if (failures.length > 0) throw new DevServerLifecycleCloseError(failures);
};

const withMcpSessionLifecycle = (
  coordinator: DevCoordinator,
  mcpSessions: McpSessionService,
  mcpApps: () => Closeable | undefined,
  runtime: DevRuntimeController | undefined,
  clientSurfaces: RuntimeClientSurfaceBindings,
  status: () => ProjectStatus,
  playground: Closeable,
  logs: DevLogService,
  detachProjectLogs: () => void,
  trace: TraceHub,
  detachProjectTrace: () => void,
  inspector: Closeable,
  epochAdoption: EpochAdoptionPolicy,
  hookReceipts: ReturnType<typeof attachHookReceipts>,
  publishHookReceiptUrl: (url: string) => void,
  hostInstalls?: DevHostInstallManager,
): ForegroundCoordinator => Object.freeze({
  close: () => {
    clientSurfaces.beginClose();
    return closeDevServerLifecycle({
      coordinator,
      detachProjectLogs,
      detachProjectTrace,
      epochAdoption,
      hostInstalls,
      inspector,
      logs,
      mcpApps: mcpApps(),
      mcpSessions,
      playground,
      runtimeResources: { clientSurfaces, runtime },
      trace,
    });
  },
  publishServerUrl: async (url: string) => {
    await coordinator.publishServerUrl(url);
    publishHookReceiptUrl(url);
    await hookReceipts.publishEndpoint(url);
  },
  rebuild: (invalidation: Invalidation) => coordinator.rebuild(invalidation),
  start: async () => {
    hostInstalls?.start();
    await coordinator.start();
    // A failing initial build publishes no artifact.available; hosts must still
    // serve the last-good epoch the store restored, so seed it through the gate.
    const artifact = coordinator.status().artifact;
    if (artifact.state === 'active' || artifact.state === 'stale') epochAdoption.seed(artifact.activeEpoch.id);
    await epochAdoption.settled();
    await hostInstalls?.settled();
    await runtime?.start();
  },
  status,
});

/** Starts one loopback foreground session over the current project services. */
export const startDevServer = async (options: StartDevServerOptions): Promise<DevServerSession> => {
  // One platform runtime per dev-server session, created here rather than at
  // module top level: `effect` is a CLI cold-start cost (#530), and the
  // runtime's Scope is disposed from the returned session's `close`.
  const platformRuntime = createDevPlatformRuntime();
  let session: DevServerSession;
  try {
    session = await startDevServerSession(options, platformRuntime);
  } catch (error) {
    const [cleanup] = await Promise.allSettled([platformRuntime.close()]);
    if (cleanup?.status === 'rejected') {
      throw new DevServerStartError([
        Object.freeze({ error, resource: 'start' }),
        Object.freeze({ error: cleanup.reason, resource: 'cleanup' }),
      ]);
    }
    throw error;
  }
  return Object.freeze({
    close: async (): Promise<void> => {
      // Every service that ran on the runtime closes first; only then is its
      // Scope released. A session close failure is the report that matters, so
      // it is rethrown as-is even when the disposal also fails; the disposal
      // failure surfaces on its own only after a clean session close.
      try {
        await session.close();
      } catch (error) {
        await Promise.allSettled([platformRuntime.close()]);
        throw error;
      }
      await platformRuntime.close();
    },
    openRuntimeClientSurface: (surfaceId: string) => session.openRuntimeClientSurface(surfaceId),
    status: () => session.status(),
    url: session.url,
  });
};

const startDevServerSession = async (options: StartDevServerOptions, platformRuntime: DevPlatformRuntime): Promise<DevServerSession> => {
  const root = resolve(options.root);
  const registry = options.registry ?? createDefaultRegistry();
  const openBrowser = options.openBrowser ?? openInBrowser;
  const eventHub = new ProjectEventHub();
  const epochStore = new EpochStore({ projectRoot: root });
  const traceHub = new TraceHub({ projectRoot: root });
  const hookReceipts = attachHookReceipts({ projectRoot: root, trace: traceHub });
  let hookReceiptUrl: string | undefined;
  const logs = new DevLogService({ projectRoot: root, trace: traceHub });
  const detachProjectLogs = attachProjectEventLogs(logs, eventHub);
  const detachProjectTrace = attachProjectEventTrace(traceHub, eventHub);
  const projectService = new ProjectService({
    includeDevRuntime: true,
    logger: createProjectDevLogger(logs),
    mode: 'development',
    outputRoots: ['dist', '.agent-bundle/runtime', '.agent-bundle/playground'],
    registry,
    root,
    platformRuntime,
  });
  const initialPreparedProject = await projectService.prepare('dev');
  const agentApiEnabled = options.agentApi ?? initialPreparedProject.devAgentApiEnabled ?? false;
  let latestValidPreparedProject = initialPreparedProject.source.state === 'ready' && initialPreparedProject.model !== undefined
    ? initialPreparedProject
    : undefined;
  let latestPublishedPreparedProject: PreparedProject | undefined;
  const topologyProviderSessionId = randomUUID();
  let runtimeTopologyChanged = false;
  let status: () => ProjectStatus = () => deepFreeze({
    artifact: { state: 'missing' },
    build: { state: 'idle' },
    source: { diagnostics: Object.freeze([]), state: 'unknown' },
  });
  // A provider can start in `compiling`; event delivery retries the no-op
  // placeholder only after the Workbench has installed its App lifecycle.
  let ensureRuntimeAppPreviews: () => void = () => undefined;
  let runtime: DevRuntimeController | undefined;
  if (initialPreparedProject.devRuntime !== undefined || initialPreparedProject.devRuntimeDiagnostic !== undefined) {
    const preparedRuntime = initialPreparedProject.devRuntime ?? Object.freeze({
      apps: Object.freeze([]),
      provider: '',
      servers: Object.freeze([]),
      sourceRevision: initialPreparedProject.source.revision ?? 'unknown',
    });
    let provider;
    let providerLoadError: unknown;
    if (initialPreparedProject.devRuntime !== undefined) {
      try {
        provider = await resolveDevRuntimeProvider(root, initialPreparedProject.devRuntime, undefined, platformRuntime);
      } catch (error) {
        providerLoadError = error;
      }
    } else {
      providerLoadError = initialPreparedProject.devRuntimeDiagnostic;
    }
    runtime = new DevRuntimeController({
      artifactStatus: () => status().artifact,
      emit: (event) => {
        const artifact = status().artifact;
        eventHub.publish({
          ...((artifact.state === 'active' || artifact.state === 'stale') ? { epochId: artifact.activeEpoch.id } : {}),
          payload: event,
          type: 'runtime.event',
        });
        if (event.type === 'runtime.generation.activated' || event.type === 'runtime.generation.failed' || event.type === 'runtime.status') {
          ensureRuntimeAppPreviews();
        }
      },
      environment: process.env,
      preparedRuntime,
      projectRoot: root,
      provider,
      providerLoadError,
      storageRoot: join(root, '.agent-bundle', 'runtime'),
    });
  }
  const appPreviews = new DeferredMcpAppPreviewService();
  const clientSurfaces = new RuntimeClientSurfaceBindings(runtime, options.testing?.openRuntimeClientSurface);
  const runtimeTopology = runtime === undefined
    ? undefined
    : Object.freeze({ state: 'configured' as const });
  let foregroundClosing = false;
  let installingRuntimePreviews = false;
  let mcpApps: McpAppLifecycle | undefined;
  let mcpAppSandboxOrigin: string | undefined;
  let previews: McpAppPreviewService | undefined;
  /**
   * Runtime topology is fixed at startup, but a valid model can arrive later
   * than the controller.  Register the service with its lifecycle before the
   * foreground facade publishes it, so close/reconcile races remain closed.
   */
  ensureRuntimeAppPreviews = (): void => {
    const lifecycle = mcpApps;
    const prepared = latestValidPreparedProject;
    if (
      foregroundClosing || runtime === undefined || prepared === undefined || previews === undefined ||
      lifecycle === undefined || !lifecycle.acceptsRuntimePreviews || installingRuntimePreviews
    ) return;
    const runtimeStatus = runtime.status();
    if (runtimeStatus.state !== 'active' && runtimeStatus.state !== 'degraded') return;
    installingRuntimePreviews = true;
    try {
      // Reading this getter proves that the provider has exposed the stable
      // broker surface; a merely constructed controller is not enough.
      const registry = runtime.mcpRegistry;
      if (typeof registry.session !== 'function' || typeof registry.subscribe !== 'function') return;
      const runtimePreviews = new McpAppRuntimePreviewService({
        bindingAuthority: new McpAppRuntimeBindingService(),
        configExtensions: () => {
          const current = latestValidPreparedProject;
          if (current === undefined || current.source.state !== 'ready' || current.source.revision === undefined || current.model === undefined) {
            throw new Error('No valid prepared project is available for Runtime MCP App inspection.');
          }
          return Object.freeze({
            descriptors: current.registry.configExtensions(),
            extensions: current.model.extensions,
            projectRoot: current.root,
            sourceRevision: current.source.revision,
          });
        },
        emit: (details) => runtime.emit(Object.freeze({
          details: Object.freeze({ ...details }),
          mcpSessionId: details.sessionId,
          mcpSessionRevision: details.sessionRevision,
          type: 'runtime.app.updated',
        })),
        openRuntimeClientSurface: (surfaceId) => clientSurfaces.open(surfaceId),
        runtime,
      });
      if (!lifecycle.attachRuntime(runtimePreviews)) {
        void runtimePreviews.closeAll().catch(() => undefined);
        return;
      }
      // `attachRuntime` is synchronous and immediately follows lifecycle
      // registration, so a foreground close cannot expose a half-owned lane.
      if (!appPreviews.attachRuntime(runtimePreviews)) void runtimePreviews.prepareClose().catch(() => undefined);
    } catch (error) {
      if (!isDevRuntimeUnavailableError(error)) throw error;
    } finally {
      installingRuntimePreviews = false;
    }
  };
  const coordinator = new DevCoordinator({
    epochStore,
    eventHub,
    initialPreparedProject,
    onPreparedProject: async (prepared) => {
      const validPreparedProject = prepared.source.state === 'ready' && prepared.model !== undefined;
      if (foregroundClosing || !validPreparedProject) return;
      latestValidPreparedProject = prepared;
      if (runtime !== undefined) {
        await runtime.reconcileDeclaration(prepared.devRuntime, prepared.devRuntimeDiagnostic);
        ensureRuntimeAppPreviews();
        return;
      }
      if (!runtimeTopologyChanged && (prepared.devRuntime !== undefined || prepared.devRuntimeDiagnostic !== undefined)) {
        runtimeTopologyChanged = true;
        eventHub.publish({
          payload: Object.freeze({
            details: Object.freeze({ restartRequired: true, state: 'failed' }),
            providerSessionId: topologyProviderSessionId,
            type: 'runtime.status',
          }),
          type: 'runtime.event',
        });
      }
    },
    onPublishedProject: (prepared) => {
      latestPublishedPreparedProject = prepared;
    },
    outputPaths: [
      'dist',
      initialPreparedProject.artifactDistPath,
      '.agent-bundle/runtime',
      '.agent-bundle/playground',
    ],
    packageBuildService: new DevPackageBuildService({ platformRuntime }),
    prepareCommand: 'dev',
    projectService,
    root,
  });
  const mcpSessions = new McpSessionService({
    epochStore,
    projectRoot: root,
    registry,
    platformRuntime,
    trace: traceHub,
    traceSink: createMcpDevLogTraceSink(logs),
  });
  const epochAdoption = new EpochAdoptionPolicy({
    contracts: () => latestValidPreparedProject?.devContracts,
    eventHub,
    lease: (epochId) => epochStore.acquireEpochReference(epochId),
    run: (epochId, contracts) => {
      const prepared = latestValidPreparedProject;
      if (prepared === undefined || prepared.devContracts !== contracts) {
        throw new Error('Development contract preparation was superseded before its epoch run started.');
      }
      return runDevEpochContracts({ contracts, epochId, mcpSessions, prepared });
    },
  });
  status = () => Object.freeze({
    ...coordinator.status(),
    hostAdoption: epochAdoption.status(),
    ...(runtimeTopology === undefined ? {} : { runtime: runtimeTopology }),
  });
  const hostInstalls = options.installHosts === undefined || options.installHosts.length === 0
    ? undefined
    : new DevHostInstallManager({
        adoption: epochAdoption,
        epochStore,
        eventHub,
        hosts: options.installHosts,
        projectRoot: root,
        platformRuntime,
      });
  const hostSessions = new HostSessionService({
    attached: (host) => hostInstalls?.attached(host),
    currentEpochId: () => epochAdoption.currentEpochId,
    environment: () => ({
      ...process.env,
      ...(hookReceiptUrl === undefined ? {} : hookReceipts.environment(hookReceiptUrl)),
    }),
    projectRoot: root,
    trace: traceHub,
  });
  const hostMcp = new HostMcpRoutes({ adoption: epochAdoption, epochStore, eventHub, mcpSessions });
  const hookPlayground = new HookPlaygroundService({
    epochStore,
    hookService: new HookService({
      environment: () => hookReceiptUrl === undefined ? {} : hookReceipts.environment(hookReceiptUrl),
      registry,
    }),
    logger: logs,
    registry,
    platformRuntime,
  });
  const preparedBundle = () => {
    const prepared = latestValidPreparedProject;
    if (prepared?.model === undefined) return undefined;
    return Object.freeze({
      bundleSource: join(root, prepared.artifactDistPath),
      ...(prepared.source.revision === undefined
        ? {}
        : { manifestDigest: prepared.source.revision }),
    });
  };
  const hostDiscovery = new HostDiscoveryService({
    platformRuntime,
    ...options.testing?.hostDiscoveryOptions,
    prepared: preparedBundle,
    registry,
  });
  const mcpProbe = new McpProbeService({
    prepared: preparedBundle,
    projectRoot: root,
    registry,
    platformRuntime,
    ...options.testing?.mcpProbeOptions,
  });
  const lifecycleReplay = new LifecycleReplayService({
    logger: logs,
    prepared: () => {
      const prepared = latestValidPreparedProject;
      if (prepared?.model === undefined) {
        throw new Error('No valid prepared project is available for lifecycle replay.');
      }
      return Object.freeze({
        graph: prepared.routeGraph ?? emptyCompiledRouteGraph,
        ...(prepared.source.revision === undefined ? {} : { sourceRevision: prepared.source.revision }),
        targets: Object.freeze(prepared.model.targets.map((target) => target.name)),
      });
    },
    registry,
  });
  const skillDocuments = new SkillDocumentService({ epochStore, projectService, root, platformRuntime });
  const artifacts = new ArtifactInspectionService(epochStore, registry);
  const evals = new EvalService({ logger: logs, projectRoot: root, registry, platformRuntime });
  // The resolved root is the project's stable identity: a store copied elsewhere must not reopen.
  const playgroundTrace = new PlaygroundService({
    logger: logs,
    projectId: root,
    projectRoot: root,
    storageRoot: join(root, '.agent-bundle', 'playground'),
  });
  const scriptPlayground = new ScriptPlaygroundService({ epochStore, registry, platformRuntime });
  const playground = new PlaygroundOrchestrationService({
    coordinator,
    epochStore,
    hookPlayground,
    mcpSessions,
    native: new NativePlaygroundService({ projectRoot: root, platformRuntime }),
    scripts: scriptPlayground,
    skillDocuments,
    trace: playgroundTrace,
  });
  const inspector = createInspectorLauncher({ projectRoot: root });
  // The manifest is a projection of the prepared project's own compiler pass;
  // route discovery never runs a second time for the browser.
  const routeManifest: RouteManifestRouteService = {
    manifest: () => {
      const prepared = latestPublishedPreparedProject;
      if (
        prepared === undefined ||
        prepared.model === undefined ||
        prepared.source.revision === undefined
      ) {
        throw new Error('No valid prepared project is available for the route manifest.');
      }
      return routeManifestFor(
        prepared.routeGraph ?? emptyCompiledRouteGraph,
        status().source.revision ?? prepared.source.revision,
        prepared.model.state,
        prepared.model.notices,
      );
    },
  };
  const routeInvocations = new RouteInvocationService({
    manifest: routeManifest,
    prepared: async () => {
      const prepared = latestPublishedPreparedProject;
      if (prepared === undefined || prepared.model === undefined) {
        throw new Error('No valid prepared project is available for route invocation.');
      }
      const artifact = status().artifact;
      if (
        artifact.state !== 'active' ||
        prepared.source.revision === undefined ||
        artifact.activeEpoch.projectRevision !== prepared.source.revision
      ) {
        throw new RouteInvocationRequestError(
          ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE,
          'The source is newer than the published build. Rebuild before invoking routes.',
          409,
        );
      }
      const targets = prepared.model.targets
        .map((target) => target.name)
        .filter((target): target is RouteInvocationEventHost =>
          target === 'claude' || target === 'codex' || target === 'cursor');
      // Emitted scripts live once at the composite root; any selected target
      // whose layout has a scripts directory reads the same file.
      const scriptTarget = prepared.model.targets
        .map((target) => target.name)
        .find((target) => registry.artifactLayout(target).scripts !== undefined);
      const epochId = artifact.activeEpoch.id;
      const project = Object.freeze({
        ...(scriptTarget === undefined ? {} : { artifact: { epochId, target: scriptTarget } }),
        manifest: testManifestFromRouteGraph({
          apps: prepared.model.mcpApps,
          configPath: prepared.configPath,
          diagnostics: prepared.diagnostics,
          graph: prepared.routeGraph ?? emptyCompiledRouteGraph,
          plugin: {
            name: prepared.model.metadata.name,
            ...(prepared.model.metadata.packageName === undefined
              ? {}
              : { packageName: prepared.model.metadata.packageName }),
            ...(prepared.model.metadata.packageVersion === undefined
              ? {}
              : { packageVersion: prepared.model.metadata.packageVersion }),
            version: prepared.model.metadata.version,
          },
          projectRoot: prepared.root,
          scripts: prepared.model.scripts,
          ...(prepared.model.state === undefined ? {} : { state: prepared.model.state }),
          targets,
        }),
        stateRoot: devStateRoot(root),
        targets,
      });
      let reference;
      try {
        reference = await epochStore.acquireEpochReference(epochId);
      } catch (error) {
        if (error instanceof EpochStoreError && error.code === 'EPOCH_NOT_FOUND') {
          throw new RouteInvocationRequestError(
            ROUTE_INVOCATION_STALE_REVISION_CODE,
            ROUTE_INVOCATION_STALE_REVISION_MESSAGE,
            409,
          );
        }
        throw error;
      }
      return {
        project,
        release: () => reference.close(),
      };
    },
    registry,
    scripts: scriptPlayground,
    trace: traceHub,
  });
  const agentApi = agentApiEnabled
    ? new AgentApi({
      artifacts,
      coordinator: { status },
      diagnostics: {
        list: async () => {
          const current = status();
          return Object.freeze({ build: current.build, source: current.source });
        },
      },
      epochs: epochStore,
      evals,
      hooks: hookPlayground,
      mcpSessions,
      skills: skillDocuments,
      ...(options.agentApiToken === undefined ? {} : { token: options.agentApiToken }),
    })
    : undefined;
  const foreground = await (options.testing?.startForegroundServer ?? startForegroundServer)({
    ...(agentApi === undefined ? {} : { agentApi }),
    artifacts,
    assets: options.assets ?? createWorkbenchAssetSource({ platformRuntime }),
    coordinator: withMcpSessionLifecycle(
      coordinator,
      mcpSessions,
      () => mcpApps,
      runtime,
      clientSurfaces,
      status,
      playground,
      logs,
      detachProjectLogs,
      traceHub,
      detachProjectTrace,
      inspector,
      epochAdoption,
      hookReceipts,
      (url) => { hookReceiptUrl = url; },
      hostInstalls,
    ),
    evals,
    evalLifecycle: evals,
    epochs: epochStore,
    eventHub,
    hookPlayground,
    hookReceipts: hookReceipts.routes,
    hostDiscovery,
    hostMcp,
    hostSessions,
    inspector,
    lifecycleReplay,
    logs,
    mcpAppPreviews: appPreviews,
    mcpAppSandboxOrigin: () => mcpAppSandboxOrigin,
    mcpProbe,
    mcpSessions,
    playground,
    port: options.port,
    routeManifest,
    routeInvocations,
    ...(runtime === undefined ? {} : { runtime }),
    skillDocuments,
    trace: traceHub,
    webHostLaunch: { projectRoot: root, registry },
    ...(options.workbenchDevOrigins === undefined || options.workbenchDevOrigins.length === 0
      ? {}
      : { workbenchDevOrigins: options.workbenchDevOrigins }),
  });
  if (latestPublishedPreparedProject === undefined) {
    const artifact = status().artifact;
    if (
      (artifact.state === 'active' || artifact.state === 'stale') &&
      initialPreparedProject.source.revision === artifact.activeEpoch.projectRevision
    ) {
      latestPublishedPreparedProject = initialPreparedProject;
    }
  }
  clientSurfaces.bindHostOrigin(foreground.url);
  // Linearize Workbench-owned runtime proxy acquisition before Foreground
  // begins its asynchronous App/SSE drain. The coordinator repeats this fence
  // defensively during lifecycle close, but that happens too late for a proxy
  // open already pending when callers request server.close().
  const closeForeground = async (): Promise<void> => {
    foregroundClosing = true;
    // Fence authenticated runtime routes before the foreground begins closing;
    // the lifecycle retains the service for its ordered preview cleanup.
    void appPreviews.prepareClose().catch(() => undefined);
    void mcpApps?.prepareClose().catch(() => undefined);
    clientSurfaces.beginClose();
    try {
      try {
        await hookReceipts.close();
      } finally {
        await foreground.close();
      }
    } finally {
      // Probe transports whose teardown outlived their response boundary own
      // their plugin-data removal; joining them here (bounded by the probe's
      // teardown cap) keeps shutdown from leaving those directories behind.
      await mcpProbe.settle();
    }
  };
  try {
    const sandbox = await (options.testing?.createSandboxProxy ?? createMcpAppSandboxProxy)({ hostOrigin: foreground.url });
    mcpAppSandboxOrigin = sandbox.origin;
    mcpApps = new McpAppLifecycle(sandbox);
    const bindings = new McpAppBindingService({ sessionAuthority: mcpSessions });
    previews = new McpAppPreviewService({
      bindingAuthority: bindings,
      host: mcpAppPreviewHost(openBrowser),
      hostInfo: mcpAppPreviewHostInfo,
      hostOrigin: foreground.url,
      sandboxProxy: sandbox,
      toolAuthority: {
        resolveTool: async (sessionId, toolName): Promise<McpAppToolDefinition> => {
          const session = mcpSessions.get(sessionId);
          if (session === undefined) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
          const tools = await session.listTools();
          const tool = tools.find((candidate) => candidate.name === toolName);
          if (tool === undefined) throw new Error(`Unknown MCP App tool ${JSON.stringify(toolName)}.`);
          const metadata = tool._meta as Readonly<Record<string, unknown>> | undefined;
          const ui = metadata?.ui as Readonly<Record<string, unknown>> | undefined;
          const resourceUri = ui?.resourceUri;
          if (typeof resourceUri !== 'string') {
            throw new Error(`MCP App tool ${JSON.stringify(toolName)} lacks a standard _meta.ui.resourceUri.`);
          }
          return Object.freeze({
            _meta: Object.freeze({ ui: Object.freeze({ resourceUri }) }),
            name: tool.name,
          });
        },
      },
    });
    mcpApps.attach(previews);
    appPreviews.attach(previews, undefined, mcpApps);
    ensureRuntimeAppPreviews();
    if (options.open === true) await openBrowser(foreground.url);
  } catch (error) {
    const [cleanup] = await Promise.allSettled([closeForeground()]);
    if (cleanup?.status === 'rejected') {
      throw new DevServerStartError([
        Object.freeze({ error, resource: 'start' }),
        Object.freeze({ error: cleanup.reason, resource: 'cleanup' }),
      ]);
    }
    throw error;
  }
  return Object.freeze({
    close: closeForeground,
    openRuntimeClientSurface: (surfaceId: string) => clientSurfaces.open(surfaceId),
    status,
    url: foreground.url,
  });
};
