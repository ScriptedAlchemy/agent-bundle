import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { ArtifactInspectionService } from './artifact-inspection-service.ts';
import { DevCoordinator } from './coordinator.ts';
import { EpochStore } from './epoch-store.ts';
import { EvalService } from './eval-service.ts';
import { ProjectEventHub } from './events.ts';
import { HookPlaygroundService } from './hook-playground-service.ts';
import {
  startForegroundServer,
  type ForegroundCoordinator,
  type ForegroundServerOptions,
  type WorkbenchAssetSource,
} from './foreground-server.ts';
import { McpAppBindingService, type McpAppToolDefinition } from './mcp-app-binding-service.ts';
import type { McpAppRoutePreviewService } from './mcp-app-routes.ts';
import { McpAppPreviewService } from './mcp-app-preview-service.ts';
import { McpAppRuntimeBindingService } from './mcp-app-runtime-binding-service.ts';
import { McpAppRuntimePreviewService } from './mcp-app-runtime-preview-service.ts';
import {
  createMcpAppSandboxProxy,
  type CreateMcpAppSandboxProxyOptions,
  type McpAppSandboxProxy,
} from './mcp-app-sandbox.ts';
import { McpSessionService } from './mcp-session-service.ts';
import { PlaygroundOrchestrationService } from './playground-orchestration-service.ts';
import { PlaygroundService } from '../services/playground-service.ts';
import { ProjectService } from './project-service.ts';
import { DevRuntimeController } from './runtime-controller.ts';
import {
  RuntimeClientSurfaceProxy,
  strictRuntimeClientSurfaceContentPolicy,
  type RuntimeClientSurfaceContentPolicy,
} from './runtime-client-surface-proxy.ts';
import { resolveDevRuntimeProvider } from './runtime-provider-loader.ts';
import {
  DevRuntimeUnavailableError,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeClientSurfaceProxyBinding,
  type DevRuntimeEventInput,
} from './runtime-provider.ts';
import { ScriptPlaygroundService } from './script-playground-service.ts';
import { SkillDocumentService } from './skill-document-service.ts';
import { createWorkbenchAssetSource } from './workbench-assets.ts';
import type { Invalidation, ProjectStatus } from './types.ts';

export interface DevServerSession {
  close(): Promise<void>;
  openRuntimeClientSurface(surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
  status(): ProjectStatus;
  readonly url: string;
}

export type OpenBrowser = (url: string) => Promise<void> | void;

interface Closeable {
  close(): Promise<void>;
}

export interface DevServerLifecycleCloseFailure {
  readonly error: unknown;
  readonly resource: 'coordinator' | 'mcp-apps' | 'mcp-sessions' | 'playground' | 'runtime' | 'runtime-client-surfaces';
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
  /** Supplied by integration tests; published callers use the packaged assets. */
  readonly assets?: WorkbenchAssetSource;
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
}

interface DevServerForeground {
  close(): Promise<void>;
  readonly url: string;
}

interface DevServerTesting {
  readonly createSandboxProxy?: (options: CreateMcpAppSandboxProxyOptions) => Promise<McpAppSandboxProxy>;
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
      if (error instanceof DevRuntimeUnavailableError) return undefined;
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
  readonly mcpApps?: Closeable;
  readonly mcpSessions: Closeable;
  readonly playground?: Closeable;
  readonly runtimeResources?: DevServerRuntimeLifecycleResources;
}

/** Closes persistent MCP state alongside the coordinator, preserving all cleanup failures. */
export const closeDevServerLifecycle = async ({
  coordinator,
  mcpApps,
  mcpSessions,
  playground,
  runtimeResources,
}: DevServerLifecycleOptions): Promise<void> => {
  // Orchestration owns in-flight subprocess and MCP operations. Fence and
  // drain them before closing the shared services they depend on.
  const playgroundResults = playground === undefined ? [] : await Promise.allSettled([playground.close()]);
  const appResults = mcpApps === undefined ? [] : await Promise.allSettled([mcpApps.close()]);
  const clientSurfaceResults = runtimeResources?.clientSurfaces === undefined
    ? []
    : await Promise.allSettled([runtimeResources.clientSurfaces.close()]);
  const runtimeResults = runtimeResources?.runtime === undefined
    ? []
    : await Promise.allSettled([runtimeResources.runtime.close()]);
  const sessionResults = await Promise.allSettled([mcpSessions.close()]);
  const coordinatorResults = await Promise.allSettled([coordinator.close()]);
  const failures = [
    ...playgroundResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'playground' as const })]
        : [],
    ),
    ...appResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'mcp-apps' as const })]
        : [],
    ),
    ...clientSurfaceResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'runtime-client-surfaces' as const })]
        : [],
    ),
    ...runtimeResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'runtime' as const })]
        : [],
    ),
    ...sessionResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'mcp-sessions' as const })]
        : [],
    ),
    ...coordinatorResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
    result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: 'coordinator' as const })]
      : [],
    ),
  ];
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
): ForegroundCoordinator => Object.freeze({
  close: () => {
    clientSurfaces.beginClose();
    return closeDevServerLifecycle({
      coordinator,
      mcpApps: mcpApps(),
      mcpSessions,
      playground,
      runtimeResources: { clientSurfaces, runtime },
    });
  },
  rebuild: (invalidation: Invalidation) => coordinator.rebuild(invalidation),
  start: async () => {
    await coordinator.start();
    await runtime?.start();
  },
  status,
});

const openInBrowser: OpenBrowser = (url) => new Promise((resolvePromise, rejectPromise) => {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', rejectPromise);
  child.once('spawn', () => {
    child.unref();
    resolvePromise();
  });
});

/** Starts one loopback foreground session over the current project services. */
export const startDevServer = async (options: StartDevServerOptions): Promise<DevServerSession> => {
  const root = resolve(options.root);
  const registry = options.registry ?? createDefaultRegistry();
  const openBrowser = options.openBrowser ?? openInBrowser;
  const eventHub = new ProjectEventHub();
  const epochStore = new EpochStore({ projectRoot: root });
  const projectService = new ProjectService({
    includeDevRuntime: true,
    mode: 'development',
    outputRoots: ['dist', '.agent-bundle/runtime', '.agent-bundle/playground'],
    registry,
    root,
  });
  const initialPreparedProject = await projectService.prepare('dev');
  let latestValidPreparedProject = initialPreparedProject.source.state === 'ready' && initialPreparedProject.model !== undefined
    ? initialPreparedProject
    : undefined;
  const topologyProviderSessionId = randomUUID();
  let runtimeTopologyChanged = false;
  let status: () => ProjectStatus = () => Object.freeze({
    artifact: Object.freeze({ state: 'missing' }),
    build: Object.freeze({ state: 'idle' }),
    source: Object.freeze({ diagnostics: Object.freeze([]), state: 'unknown' }),
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
        provider = await resolveDevRuntimeProvider(root, initialPreparedProject.devRuntime);
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
      if (!(error instanceof DevRuntimeUnavailableError)) throw error;
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
    outputPaths: ['dist', '.agent-bundle/runtime', '.agent-bundle/playground'],
    prepareCommand: 'dev',
    projectService,
    root,
  });
  status = () => Object.freeze({
    ...coordinator.status(),
    ...(runtimeTopology === undefined ? {} : { runtime: runtimeTopology }),
  });
  const mcpSessions = new McpSessionService({ epochStore, projectRoot: root, registry });
  const hookPlayground = new HookPlaygroundService({ epochStore, registry });
  const skillDocuments = new SkillDocumentService({ epochStore, projectService, root });
  // The resolved root is the project's stable identity: a store copied elsewhere must not reopen.
  const trace = new PlaygroundService({
    projectId: root,
    projectRoot: root,
    storageRoot: join(root, '.agent-bundle', 'playground'),
  });
  const playground = new PlaygroundOrchestrationService({
    coordinator,
    epochStore,
    hookPlayground,
    mcpSessions,
    scripts: new ScriptPlaygroundService({ epochStore, registry }),
    skillDocuments,
    trace,
  });
  const foreground = await (options.testing?.startForegroundServer ?? startForegroundServer)({
    artifacts: new ArtifactInspectionService(epochStore, registry),
    assets: options.assets ?? createWorkbenchAssetSource(),
    coordinator: withMcpSessionLifecycle(coordinator, mcpSessions, () => mcpApps, runtime, clientSurfaces, status, playground),
    evals: new EvalService({ projectRoot: root, registry }),
    eventHub,
    hookPlayground,
    mcpAppPreviews: appPreviews,
    mcpSessions,
    playground,
    port: options.port,
    ...(runtime === undefined ? {} : { runtime }),
    skillDocuments,
  });
  clientSurfaces.bindHostOrigin(foreground.url);
  // Linearize Workbench-owned runtime proxy acquisition before Foreground
  // begins its asynchronous App/SSE drain. The coordinator repeats this fence
  // defensively during lifecycle close, but that happens too late for a proxy
  // open already pending when callers request server.close().
  const closeForeground = (): Promise<void> => {
    foregroundClosing = true;
    // Fence authenticated runtime routes before the foreground begins closing;
    // the lifecycle retains the service for its ordered preview cleanup.
    void appPreviews.prepareClose().catch(() => undefined);
    void mcpApps?.prepareClose().catch(() => undefined);
    clientSurfaces.beginClose();
    return foreground.close();
  };
  try {
    const sandbox = await (options.testing?.createSandboxProxy ?? createMcpAppSandboxProxy)({ hostOrigin: foreground.url });
    mcpApps = new McpAppLifecycle(sandbox);
    const bindings = new McpAppBindingService({ sessionAuthority: mcpSessions });
    previews = new McpAppPreviewService({
      bindingAuthority: bindings,
      host: {
        onDisplayMode: (mode) => mode,
        onDownload: async (download) => {
          // This is a host-created opaque data URL; App-controlled content is
          // encoded before it crosses the browser-launch boundary.
          await openBrowser(`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(download.contents))}`);
        },
        onOpenLink: async (url) => { await openBrowser(url); },
      },
      hostInfo: { name: 'agent-bundle', version: '0.1.0' },
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
    status: () => coordinator.status(),
    url: foreground.url,
  });
};
