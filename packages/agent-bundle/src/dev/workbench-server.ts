import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { loadConfig } from '../config/load.ts';
import type { AgentBundleDevConfig } from '../core/types.ts';
import { AgentApi } from './agent-api.ts';
import { ArtifactInspectionService } from './artifact-inspection-service.ts';
import { DevCoordinator } from './coordinator.ts';
import { DevLogService } from './dev-log-service.ts';
import { attachProjectEventLogs, createMcpDevLogTraceSink, createProjectDevLogger } from './dev-log-producers.ts';
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
import {
  createMcpAppSandboxProxy,
  type CreateMcpAppSandboxProxyOptions,
  type McpAppSandboxProxy,
} from './mcp-app-sandbox.ts';
import { McpSessionService } from './mcp-session-service.ts';
import { NativePlaygroundService } from './native-playground-service.ts';
import { PlaygroundOrchestrationService } from './playground-orchestration-service.ts';
import { PlaygroundService } from '../services/playground-service.ts';
import { ProjectService } from './project-service.ts';
import { ScriptPlaygroundService } from './script-playground-service.ts';
import { SkillDocumentService } from './skill-document-service.ts';
import { createWorkbenchAssetSource } from './workbench-assets.ts';
import type { Invalidation, ProjectStatus } from './types.ts';

export interface DevServerSession {
  close(): Promise<void>;
  status(): ProjectStatus;
  readonly url: string;
}

export type OpenBrowser = (url: string) => Promise<void> | void;

interface Closeable {
  close(): Promise<void>;
}

export interface DevServerLifecycleCloseFailure {
  readonly error: unknown;
  readonly resource: 'coordinator' | 'logs' | 'mcp-apps' | 'mcp-sessions' | 'playground';
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
  readonly resource: 'previews' | 'sandbox';
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
  #previews: McpAppPreviewService | undefined;

  constructor(sandbox: McpAppSandboxProxy) {
    this.#sandbox = sandbox;
  }

  attach(previews: McpAppPreviewService): void {
    if (this.#previews !== undefined) throw new Error('MCP App previews are already attached.');
    this.#previews = previews;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const preview = this.#previews === undefined
      ? undefined
      : await Promise.allSettled([this.#previews.closeAll()]);
    const sandbox = await Promise.allSettled([this.#sandbox.close()]);
    const failures: McpAppLifecycleCloseFailure[] = [
      ...(preview?.flatMap((result) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'previews' as const })]
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

  attach(service: McpAppRoutePreviewService): void {
    if (this.#service !== undefined) throw new Error('MCP App preview route service is already attached.');
    this.#service = service;
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

  #active(): McpAppRoutePreviewService {
    if (this.#service === undefined) throw new Error('MCP App preview service is not ready.');
    return this.#service;
  }
}

/** Closes persistent MCP state alongside the coordinator, preserving all cleanup failures. */
export const closeDevServerLifecycle = async (
  mcpSessions: Closeable,
  coordinator: Closeable,
  mcpApps?: Closeable,
  playground?: Closeable,
  logs?: DevLogService,
  detachProjectLogs?: () => void,
): Promise<void> => {
  // ForegroundServer owns the Agent API admission gate. This lifecycle owns
  // only the shared services that are released after foreground routing ends.
  logs?.log({
    kind: 'dev.shutdown.started',
    level: 'info',
    producer: 'project',
    summary: 'Development workbench shutdown started.',
  });
  const playgroundResults = playground === undefined ? [] : await Promise.allSettled([playground.close()]);
  const appResults = mcpApps === undefined ? [] : await Promise.allSettled([mcpApps.close()]);
  const sessionResults = await Promise.allSettled([mcpSessions.close()]);
  const coordinatorResults = await Promise.allSettled([coordinator.close()]);
  try { detachProjectLogs?.(); }
  catch { /* The subscription is observability-only and cannot hold shutdown. */ }
  const producerFailures = [
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
  logs?.log({
    details: { failures: producerFailures.length },
    kind: 'dev.shutdown.completed',
    level: producerFailures.length === 0 ? 'info' : 'warning',
    producer: 'project',
    summary: producerFailures.length === 0 ? 'Development workbench shutdown completed.' : 'Development workbench shutdown completed with failures.',
  });
  const logsResults = logs === undefined ? [] : await Promise.allSettled([logs.close()]);
  const failures = [
    ...producerFailures,
    ...logsResults.flatMap((result): readonly DevServerLifecycleCloseFailure[] =>
      result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: 'logs' as const })]
        : [],
    ),
  ];
  if (failures.length > 0) throw new DevServerLifecycleCloseError(failures);
};

const withMcpSessionLifecycle = (
  coordinator: DevCoordinator,
  mcpSessions: McpSessionService,
  mcpApps: () => Closeable | undefined,
  logs: DevLogService,
  detachProjectLogs: () => void,
): ForegroundCoordinator => Object.freeze({
  close: () => closeDevServerLifecycle(mcpSessions, coordinator, mcpApps(), undefined, logs, detachProjectLogs),
  rebuild: (invalidation: Invalidation) => coordinator.rebuild(invalidation),
  start: () => coordinator.start(),
  status: () => coordinator.status(),
});

const agentApiEnabledFromConfig = async (root: string): Promise<boolean> => {
  const { config } = await loadConfig({ command: 'dev', mode: 'development', root });
  const dev = config.dev;
  if (dev === undefined) return false;
  if (typeof dev !== 'object' || dev === null || Array.isArray(dev)) {
    throw new TypeError('Configuration field "dev" must be an object when provided.');
  }
  const agentApi = (dev as AgentBundleDevConfig).agentApi;
  if (agentApi !== undefined && typeof agentApi !== 'boolean') {
    throw new TypeError('Configuration field "dev.agentApi" must be a boolean when provided.');
  }
  return agentApi === true;
};

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
  const agentApiEnabled = options.agentApi ?? await agentApiEnabledFromConfig(root);
  const registry = options.registry ?? createDefaultRegistry();
  const eventHub = new ProjectEventHub();
  const epochStore = new EpochStore({ projectRoot: root });
  const logs = new DevLogService({ projectRoot: root });
  const detachProjectLogs = attachProjectEventLogs(logs, eventHub);
  const projectService = new ProjectService({ logger: createProjectDevLogger(logs), registry, root });
  const coordinator = new DevCoordinator({ epochStore, eventHub, projectService, root });
  const mcpSessions = new McpSessionService({ epochStore, projectRoot: root, registry, traceSink: createMcpDevLogTraceSink(logs) });
  const hookPlayground = new HookPlaygroundService({ epochStore, logger: logs, registry });
  const skillDocuments = new SkillDocumentService({ epochStore, projectService, root });
  const artifacts = new ArtifactInspectionService(epochStore, registry);
  const evals = new EvalService({ logger: logs, projectRoot: root, registry });
  const appPreviews = new DeferredMcpAppPreviewService();
  // The resolved root is the project's stable identity: a store copied elsewhere must not reopen.
  const trace = new PlaygroundService({
    logger: logs,
    projectId: root,
    projectRoot: root,
    storageRoot: join(root, '.agent-bundle', 'playground'),
  });
  const nativePlayground = new NativePlaygroundService({ projectRoot: root });
  const playground = new PlaygroundOrchestrationService({
    coordinator,
    epochStore,
    hookPlayground,
    mcpSessions,
    native: nativePlayground,
    scripts: new ScriptPlaygroundService({ epochStore, registry }),
    skillDocuments,
    trace,
  });
  const agentApi = agentApiEnabled
    ? new AgentApi({
      artifacts,
      coordinator,
      diagnostics: {
        list: async () => {
          const status = coordinator.status();
          return Object.freeze({ build: status.build, source: status.source });
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
  let mcpApps: McpAppLifecycle | undefined;
  const foreground = await (options.testing?.startForegroundServer ?? startForegroundServer)({
    ...(agentApi === undefined ? {} : { agentApi }),
    artifacts,
    assets: options.assets ?? createWorkbenchAssetSource(),
    coordinator: withMcpSessionLifecycle(coordinator, mcpSessions, () => mcpApps, logs, detachProjectLogs),
    evals,
    evalLifecycle: evals,
    eventHub,
    hookPlayground,
    logs,
    mcpAppPreviews: appPreviews,
    mcpSessions,
    playground,
    playgroundLifecycle: playground,
    port: options.port,
    skillDocuments,
  });
  try {
    const sandbox = await (options.testing?.createSandboxProxy ?? createMcpAppSandboxProxy)({ hostOrigin: foreground.url });
    mcpApps = new McpAppLifecycle(sandbox);
    const bindings = new McpAppBindingService({ sessionAuthority: mcpSessions });
    const previews = new McpAppPreviewService({
      bindingAuthority: bindings,
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
    appPreviews.attach(previews);
    if (options.open === true) await (options.openBrowser ?? openInBrowser)(foreground.url);
  } catch (error) {
    const [cleanup] = await Promise.allSettled([foreground.close()]);
    if (cleanup?.status === 'rejected') {
      throw new DevServerStartError([
        Object.freeze({ error, resource: 'start' }),
        Object.freeze({ error: cleanup.reason, resource: 'cleanup' }),
      ]);
    }
    throw error;
  }
  return Object.freeze({
    close: () => foreground.close(),
    status: () => coordinator.status(),
    url: foreground.url,
  });
};
