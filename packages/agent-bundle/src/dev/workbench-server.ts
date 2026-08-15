import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { DevCoordinator } from './coordinator.ts';
import { EpochStore } from './epoch-store.ts';
import { ProjectEventHub } from './events.ts';
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
import { ProjectService } from './project-service.ts';
import { DevRuntimeController } from './runtime-controller.ts';
import { RuntimeClientSurfaceProxy } from './runtime-client-surface-proxy.ts';
import { resolveDevRuntimeProvider } from './runtime-provider-loader.ts';
import {
  DevRuntimeUnavailableError,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeClientSurfaceProxyBinding,
  type DevRuntimeEventInput,
} from './runtime-provider.ts';
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
  readonly resource: 'coordinator' | 'mcp-apps' | 'mcp-sessions' | 'runtime' | 'runtime-client-surfaces';
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
  #prepareClosePromise: Promise<void> | undefined;
  #previews: McpAppPreviewService | undefined;
  #runtimePreviews: McpAppRuntimePreviewService | undefined;

  constructor(sandbox: McpAppSandboxProxy) {
    this.#sandbox = sandbox;
  }

  attach(previews: McpAppPreviewService, runtimePreviews?: McpAppRuntimePreviewService): void {
    if (this.#previews !== undefined) throw new Error('MCP App previews are already attached.');
    this.#previews = previews;
    this.#runtimePreviews = runtimePreviews;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  prepareClose(): Promise<void> {
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
  #service: McpAppRoutePreviewService | undefined;
  #runtime: McpAppRuntimePreviewService | undefined;
  #prepareClose: (() => Promise<void>) | undefined;

  attach(service: McpAppRoutePreviewService, runtime?: McpAppRuntimePreviewService, lifecycle?: McpAppLifecycle): void {
    if (this.#service !== undefined) throw new Error('MCP App preview route service is already attached.');
    this.#service = service;
    this.#runtime = runtime;
    this.#prepareClose = lifecycle === undefined ? undefined : () => lifecycle.prepareClose();
  }

  get runtime(): McpAppRuntimePreviewService | undefined { return this.#runtime; }

  prepareClose(): Promise<void> { return this.#prepareClose?.() ?? Promise.resolve(); }

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
class RuntimeClientSurfaceBindings implements Closeable {
  readonly #openProxy: typeof RuntimeClientSurfaceProxy.open;
  readonly #runtime: DevRuntimeController | undefined;
  readonly #bindings = new Set<DevRuntimeClientSurfaceProxyBinding>();
  readonly #lateCloseFailures: unknown[] = [];
  readonly #pending = new Set<Promise<DevRuntimeClientSurfaceProxyBinding | undefined>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    runtime: DevRuntimeController | undefined,
    openProxy: typeof RuntimeClientSurfaceProxy.open = RuntimeClientSurfaceProxy.open,
  ) {
    this.#runtime = runtime;
    this.#openProxy = openProxy;
  }

  async open(surfaceId: string): Promise<DevRuntimeClientSurfaceProxyBinding | undefined> {
    if (this.#closing) throw new Error('Development runtime client surfaces are closed.');
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
    }).then(async (binding) => {
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

/** Closes persistent MCP state alongside the coordinator, preserving all cleanup failures. */
export const closeDevServerLifecycle = async (
  mcpSessions: Closeable,
  coordinator: Closeable,
  mcpApps?: Closeable,
  runtimeResources?: DevServerRuntimeLifecycleResources,
): Promise<void> => {
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
): ForegroundCoordinator => Object.freeze({
  close: () => {
    clientSurfaces.beginClose();
    return closeDevServerLifecycle(mcpSessions, coordinator, mcpApps(), { clientSurfaces, runtime });
  },
  rebuild: (invalidation: Invalidation) => coordinator.rebuild(invalidation),
  start: async () => {
    await coordinator.start();
    await runtime?.start();
  },
  status: () => coordinator.status(),
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
  const projectService = new ProjectService({ includeDevRuntime: true, mode: 'development', registry, root });
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
      },
      environment: process.env,
      preparedRuntime,
      projectRoot: root,
      provider,
      providerLoadError,
      storageRoot: join(root, '.agent-bundle', 'runtime'),
    });
  }
  const coordinator = new DevCoordinator({
    epochStore,
    eventHub,
    initialPreparedProject,
    onPreparedProject: async (prepared) => {
      if (prepared.source.state === 'ready' && prepared.model !== undefined) latestValidPreparedProject = prepared;
      if (runtime !== undefined) {
        await runtime.reconcileDeclaration(prepared.devRuntime, prepared.devRuntimeDiagnostic);
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
    outputPaths: ['dist', '.agent-bundle/runtime'],
    prepareCommand: 'dev',
    projectService,
    root,
  });
  status = () => coordinator.status();
  const mcpSessions = new McpSessionService({ epochStore, projectRoot: root, registry });
  const appPreviews = new DeferredMcpAppPreviewService();
  const clientSurfaces = new RuntimeClientSurfaceBindings(runtime, options.testing?.openRuntimeClientSurface);
  let mcpApps: McpAppLifecycle | undefined;
  const foreground = await (options.testing?.startForegroundServer ?? startForegroundServer)({
    assets: options.assets ?? createWorkbenchAssetSource(),
    coordinator: withMcpSessionLifecycle(coordinator, mcpSessions, () => mcpApps, runtime, clientSurfaces),
    eventHub,
    mcpAppPreviews: appPreviews,
    mcpSessions,
    port: options.port,
    ...(runtime === undefined ? {} : { runtime }),
    skillDocuments: new SkillDocumentService({ epochStore, projectService, root }),
  });
  // Linearize Workbench-owned runtime proxy acquisition before Foreground
  // begins its asynchronous App/SSE drain. The coordinator repeats this fence
  // defensively during lifecycle close, but that happens too late for a proxy
  // open already pending when callers request server.close().
  const closeForeground = (): Promise<void> => {
    clientSurfaces.beginClose();
    return foreground.close();
  };
  try {
    const sandbox = await (options.testing?.createSandboxProxy ?? createMcpAppSandboxProxy)({ hostOrigin: foreground.url });
    mcpApps = new McpAppLifecycle(sandbox);
    const bindings = new McpAppBindingService({ sessionAuthority: mcpSessions });
    const previews = new McpAppPreviewService({
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
    let runtimePreviews: McpAppRuntimePreviewService | undefined;
    if (runtime !== undefined && latestValidPreparedProject !== undefined && (runtime.status().state === 'active' || runtime.status().state === 'degraded')) {
      try {
        // Reading this getter proves that the provider has exposed the stable
        // broker surface; a merely constructed controller is not enough.
        const registry = runtime.mcpRegistry;
        if (typeof registry.session === 'function' && typeof registry.subscribe === 'function') runtimePreviews = new McpAppRuntimePreviewService({
        bindingAuthority: new McpAppRuntimeBindingService(),
        configExtensions: () => {
          const prepared = latestValidPreparedProject;
          if (prepared === undefined || prepared.source.state !== 'ready' || prepared.source.revision === undefined || prepared.model === undefined) {
            throw new Error('No valid prepared project is available for Runtime MCP App inspection.');
          }
          return Object.freeze({
            descriptors: prepared.registry.configExtensions(),
            extensions: prepared.model.extensions,
            projectRoot: prepared.root,
            sourceRevision: prepared.source.revision,
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
      } catch (error) {
        if (!(error instanceof DevRuntimeUnavailableError)) throw error;
      }
    }
    mcpApps.attach(previews, runtimePreviews);
    appPreviews.attach(previews, runtimePreviews, mcpApps);
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
