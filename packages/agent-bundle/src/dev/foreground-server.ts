import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { basename, extname } from 'node:path';

import { validateOriginHeader } from '@modelcontextprotocol/server';

import { ArtifactRoutes, type ArtifactRouteService } from './artifacts/artifact-routes.ts';
import type { AgentApi } from './agent-api.ts';
import { DevLogRoutes } from './logs/dev-log-routes.ts';
import type { DevLogService } from './logs/dev-log-service.ts';
import { EvalRoutes, type EvalRouteService } from './eval/eval-routes.ts';
import type { ProjectEventHub, ProjectEventSubscription } from './events.ts';
import { InspectorRoutes, type InspectorRouteService } from './inspector-routes.ts';
import { HookPlaygroundRoutes, type HookPlaygroundRouteService } from './playground/hook-playground-routes.ts';
import { HostDiscoveryRoutes, type HostDiscoveryRouteService } from './playground/host-discovery-routes.ts';
import type { HookReceiptRoutes } from './hooks/hook-receipt-endpoint.ts';
import type { HostMcpRoutes } from './host-mcp-routes.ts';
import { HostSessionRoutes, type HostSessionRouteService } from './sessions/host-session-routes.ts';
import { LifecycleReplayRoutes, type LifecycleReplayRouteService } from './playground/lifecycle-replay-routes.ts';
import { McpProbeRoutes, type McpProbeRouteService } from './playground/mcp-probe-routes.ts';
import { McpAppRoutes, type McpAppRoutePreviewService } from './mcp-apps/mcp-app-routes.ts';
import { McpSessionRoutes } from './mcp-session/mcp-session-routes.ts';
import type { McpSessionService } from './mcp-session/mcp-session-service.ts';
import { RuntimeMcpRoutes } from './runtime-mcp-routes.ts';
import { RuntimeRoutes, type AgentDocumentRuntimeModule } from './runtime-routes.ts';
import type { DevRuntimeSession } from './runtime-provider.ts';
import { PlaygroundRoutes, type PlaygroundRouteService } from './playground/playground-routes.ts';
import { RouteInvocationRoutes, type RouteInvocationRouteService } from './routes/route-invocation-routes.ts';
import { RouteManifestRoutes, type RouteManifestRouteService } from './routes/route-manifest-routes.ts';
import { SkillDocumentError, type SkillDocumentService } from './skill-document-service.ts';
import type { TraceHub } from './trace/trace-hub.ts';
import { TraceRoutes } from './trace/trace-routes.ts';
import type { Invalidation, ProjectEventMessage, ProjectStatus } from './types.ts';
import { WebHostRoutes, type WebHostEpochSource, type WebHostLaunchOptions } from './web-host-routes.ts';
import { workbenchAssetCacheControl } from './workbench-assets.ts';
import { isWorkbenchShellPath } from './workbench-shell-paths.ts';
import {
  diagnostic,
  isJsonRequest,
  isRequestDiagnostic,
  rawPathname,
  readBody,
  requestError,
  responseDiagnostic as writeDiagnosticResponse,
  responseJson as writeJsonResponse,
  singleHeader,
  type RequestDiagnostic,
} from './http.ts';

const instanceIdLengthLimit = 128;
const loopbackHosts = new Set(['127.0.0.1', '::1']);
const sseQueueByteLimit = 256 * 1024;

/**
 * A serialized loopback http(s) origin such as `http://localhost:3000`: no
 * path, query, hash, or credentials, and one of the hostnames a browser page
 * on this machine can carry in `Origin`. `URL.hostname` brackets IPv6, so the
 * bind host `::1` is read back as `[::1]`.
 */
const isLoopbackBrowserOrigin = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return hostname === 'localhost' || loopbackHosts.has(hostname);
};

interface QueuedSseFrame {
  readonly bytes: number;
  readonly frame: string;
}

export type ForegroundServerErrorCode = 'AB8000';

/** Configuration errors that prevent a foreground server from starting. */
export class ForegroundServerError extends Error {
  readonly code: ForegroundServerErrorCode;

  constructor(code: ForegroundServerErrorCode, message: string) {
    super(message);
    this.name = 'ForegroundServerError';
    this.code = code;
  }
}

export interface ForegroundServerCloseFailure {
  readonly error: unknown;
  readonly resource: 'agent-api' | 'coordinator' | 'eval-routes' | 'eval-service' | 'hook-playground' | 'host-sessions' | 'logs' | 'mcp-apps' | 'route-invocations' | 'server' | 'trace';
}

export interface ForegroundServerStartFailure {
  readonly error: unknown;
  readonly resource: 'cleanup' | 'start';
}

/** Reports all releases that failed after every foreground resource was asked to close. */
export class ForegroundServerCloseError extends Error {
  readonly failures: readonly ForegroundServerCloseFailure[];

  constructor(failures: readonly ForegroundServerCloseFailure[]) {
    super('Foreground server could not close every resource.');
    this.name = 'ForegroundServerCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

/** Preserves a failed startup and every release failure needed to unwind it. */
export class ForegroundServerStartError extends Error {
  readonly failures: readonly ForegroundServerStartFailure[];

  constructor(failures: readonly ForegroundServerStartFailure[]) {
    super('Foreground server could not start cleanly.');
    this.name = 'ForegroundServerStartError';
    this.failures = Object.freeze([...failures]);
  }
}

/** The small coordinator surface required by foreground HTTP routes. */
export interface ForegroundCoordinator {
  close(): Promise<void>;
  publishServerUrl?(url: string): Promise<void>;
  rebuild(invalidation: Invalidation): Promise<unknown>;
  start(): Promise<unknown>;
  status(): ProjectStatus;
}

/** Test-only ownership of one already-authenticated SSE response. */
export interface ForegroundProjectEventStreamHandle {
  disconnect(): void;
}

export interface ForegroundServerTesting {
  /** Replaces the optional runtime import for Agent Document route tests. */
  readonly loadAgentDocumentRuntime?: () => Promise<AgentDocumentRuntimeModule>;
  /** Observes the current stream only after its subscription and close listeners exist. */
  readonly onProjectEventStream?: (stream: ForegroundProjectEventStreamHandle) => void;
}

export interface WorkbenchAsset {
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

/** W10 supplies prebuilt workbench files through this transport-neutral lookup. */
export interface WorkbenchAssetSource {
  read(path: string): Promise<WorkbenchAsset | undefined>;
}

export interface ForegroundServerOptions {
  /** Optional agent-facing MCP endpoint, mounted only at /mcp. */
  readonly agentApi?: AgentApi;
  /** Read-only inspection over published epochs; the browser names an id, never a path. */
  readonly artifacts?: ArtifactRouteService;
  readonly assets?: WorkbenchAssetSource;
  readonly coordinator: ForegroundCoordinator;
  /** Bounded producer-wide diagnostics; routes expose only redacted snapshots. */
  readonly logs?: DevLogService;
  /** Deterministic and native eval runs; the browser names discovered suites, never a path or command. */
  readonly evals?: EvalRouteService;
  /** The project-owned Eval service closes after foreground Eval routes and Agent API admissions drain. */
  readonly evalLifecycle?: Readonly<{ close(): Promise<void> }>;
  readonly eventHub: ProjectEventHub;
  /** Active composite artifact epochs used by the development Web host. */
  readonly epochs?: WebHostEpochSource;
  readonly host?: string;
  /** Injectable only to make restart-recovery contracts deterministic. */
  readonly instanceId?: string;
  /** Already-bound MCP App previews, never executable data supplied by a browser request. */
  readonly mcpAppPreviews?: McpAppRoutePreviewService;
  /** Deferred until the foreground origin has its distinct loopback App sandbox. */
  readonly mcpAppSandboxOrigin?: () => string | undefined;
  /** Epoch-bound hook playground service; the browser never selects a wrapper or artifact path. */
  readonly hookPlayground?: HookPlaygroundRouteService;
  readonly hookReceipts?: HookReceiptRoutes;
  /** Read-only host probes, install inventory, bundle drift, and runtime endpoint health. */
  readonly hostDiscovery?: HostDiscoveryRouteService;
  /** Stateful MCP surface used only by stable development host proxies. */
  readonly hostMcp?: HostMcpRoutes;
  readonly hostSessions?: HostSessionRouteService;
  /** User-initiated read-only initialize and tools/list probing over trusted artifact servers. */
  readonly mcpProbe?: McpProbeRouteService;
  /** Read-only semantic lifecycle replay over the latest valid prepared graph. */
  readonly lifecycleReplay?: LifecycleReplayRouteService;
  /** Opt-in standalone MCP Inspector child; never auto-started. */
  readonly inspector?: InspectorRouteService;
  /** Persistent MCP sessions are supplied by the workbench service, never by browser input. */
  readonly mcpSessions?: McpSessionService;
  readonly now?: () => Date;
  /** Durable playground trace store; the browser never selects its storage root or project identity. */
  readonly playground?: PlaygroundRouteService;
  readonly port?: number;
  /**
   * Read-only projection of the compiled route graph. The Workbench derives
   * navigation from this one compiler pass; it never re-discovers routes.
   */
  readonly routeManifest?: RouteManifestRouteService;
  /** Route execution over the same prepared compiler pass as `routeManifest`. */
  readonly routeInvocations?: RouteInvocationRouteService;
  /** Optional runtime session; its lifecycle remains Workbench-owned. */
  readonly runtime?: DevRuntimeSession;
  /** Correlated application activity retained for authenticated replay and streaming. */
  readonly trace?: TraceHub;
  /** Read-only Skill document/resource service for the workbench. */
  readonly skillDocuments?: SkillDocumentService;
  /** Injectable only to make integration contracts deterministic. */
  readonly sessionToken?: string;
  /** Test-only foreground stream observation; production callers never supply this. */
  readonly testing?: ForegroundServerTesting;
  /** How the development web host selects the launch of a web-exposed server across declared projections. */
  readonly webHostLaunch?: WebHostLaunchOptions;
  /**
   * Contributor HMR only: browser origins of a separately started Workbench
   * Rsbuild dev server that proxies /api here. Loopback http(s) origins only;
   * never set by default.
   */
  readonly workbenchDevOrigins?: readonly string[];
}

type SkillRoute =
  | Readonly<{ readonly kind: 'source-tree' }>
  | Readonly<{ readonly kind: 'source-document'; readonly skillId: string }>
  | Readonly<{ readonly kind: 'source-resource'; readonly skillId: string; readonly resource: readonly string[] }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-tree'; readonly target: string }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-document'; readonly skillId: string; readonly target: string }>
  | Readonly<{ readonly epochId: string; readonly kind: 'generated-resource'; readonly resource: readonly string[]; readonly skillId: string; readonly target: string }>;

/** Route groups may attach structured diagnostics that are the answer, not an internal detail. */
const attachedDiagnostics = (value: RequestDiagnostic): readonly unknown[] | undefined => {
  const diagnostics = (value as Partial<{ readonly diagnostics: unknown }>).diagnostics;
  return Array.isArray(diagnostics) ? diagnostics : undefined;
};

const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void =>
  writeDiagnosticResponse(response, value, attachedDiagnostics(value));

const attachmentHeader = (relativePath: string): string =>
  `attachment; filename*=UTF-8''${encodeURIComponent(basename(relativePath)).replaceAll("'", '%27')}`;

const cookieValue = (request: IncomingMessage, name: string): string | undefined => {
  const header = singleHeader(request.headers.cookie);
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
};

const decodedAssetPath = (requestTarget: string | undefined): string => {
  const pathname = requestTarget?.split(/[?#]/u, 1)[0];
  if (pathname === undefined || !pathname.startsWith('/')) {
    throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
  }
  if (pathname === '/') return 'index.html';

  const parts = pathname.slice(1).split('/').map((part) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
    }
    if (
      decoded.length === 0 || decoded === '.' || decoded === '..' ||
      decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
    ) {
      throw requestError(diagnostic('AB8005', 'Asset path is not valid.', 400));
    }
    return decoded;
  });
  return parts.join('/');
};

const decodedSkillSegment = (segment: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  return decoded;
};

const skillRoute = (requestTarget: string | undefined): SkillRoute | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/api/skills' && !pathname.startsWith('/api/skills/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'skills') {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  const segments = parts.slice(3).map(decodedSkillSegment);
  if (segments.length === 1 && segments[0] === 'source') return Object.freeze({ kind: 'source-tree' });
  if (segments[0] === 'source') {
    const skillId = segments[1];
    if (skillId === undefined) throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
    if (segments.length === 2) return Object.freeze({ kind: 'source-document', skillId });
    if (segments[2] === 'resources' && segments.length > 3) {
      return Object.freeze({ kind: 'source-resource', resource: Object.freeze(segments.slice(3)), skillId });
    }
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (segments[0] !== 'epochs') {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  const [_, epochId, target, skillId, resourceMarker, ...resource] = segments;
  if (epochId === undefined || target === undefined) {
    throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  }
  if (segments.length === 3) return Object.freeze({ epochId, kind: 'generated-tree', target });
  if (skillId === undefined) throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
  if (segments.length === 4) return Object.freeze({ epochId, kind: 'generated-document', skillId, target });
  if (resourceMarker === 'resources' && resource.length > 0) {
    return Object.freeze({ epochId, kind: 'generated-resource', resource: Object.freeze(resource), skillId, target });
  }
  throw requestError(diagnostic('AB8012', 'Skill route path is not valid.', 400));
};

const manualInvalidation = (body: string, now: () => Date): Invalidation => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  const fields = Object.keys(value);
  if (fields.some((field) => field !== 'paths')) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  const paths = (value as { readonly paths?: unknown }).paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => !isProjectRelativePath(path))) {
    throw requestError(diagnostic('AB8002', 'Request body may contain only an optional paths array.', 400));
  }
  return Object.freeze({
    occurredAt: now().toISOString(),
    paths: Object.freeze([...new Set(paths)].sort((left, right) => left.localeCompare(right))),
    reason: 'manual',
  });
};

const isProjectRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
};

const eventFrame = (event: ProjectEventMessage): string => {
  const id = event.type === 'replay.gap' ? '' : `id: ${event.sequence}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
};

const afterSequence = (request: IncomingMessage, latestSequence: number): number => {
  const header = singleHeader(request.headers['last-event-id']);
  const queryValues = new URL(request.url ?? '/', 'http://foreground.invalid').searchParams.getAll('after');
  if (queryValues.length > 1) {
    throw requestError(diagnostic('AB8006', 'Project event cursor must be singular.', 400));
  }
  const cursor = header === undefined || header.length === 0 ? queryValues[0] : header;
  if (cursor === undefined || cursor.length === 0) return 0;
  if (!/^(0|[1-9]\d*)$/u.test(cursor)) {
    throw requestError(diagnostic('AB8006', 'Project event cursor must be a non-negative integer.', 400));
  }
  const sequence = Number(cursor);
  if (!Number.isSafeInteger(sequence) || sequence > latestSequence) {
    throw requestError(diagnostic('AB8006', 'Project event cursor must not be ahead of the project event stream.', 400));
  }
  return sequence;
};

const closeServer = (server: Server): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  server.close((error) => error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
    ? resolvePromise()
    : rejectPromise(error));
});

const closedError = (): Error => new Error('Foreground server is closed.');

const requestHostMatches = (request: IncomingMessage, origin: string): boolean => {
  const host = singleHeader(request.headers.host);
  if (host === undefined) return false;
  try {
    const requested = new URL(`http://${host}`);
    const expected = new URL(origin);
    return requested.username.length === 0 && requested.password.length === 0 &&
      requested.pathname === '/' && requested.search.length === 0 && requested.hash.length === 0 &&
      requested.hostname === expected.hostname && requested.port === expected.port;
  } catch {
    return false;
  }
};

/**
 * A foreground-only HTTP transport. It starts no executable selected by the
 * browser: product work stays in the injected coordinator.
 */
export class ForegroundServer {
  readonly #agentApi: AgentApi | undefined;
  readonly #artifactRoutes: ArtifactRoutes;
  readonly #assets: WorkbenchAssetSource | undefined;
  readonly #coordinator: ForegroundCoordinator;
  readonly #devLogRoutes: DevLogRoutes;
  readonly #evalLifecycle: Readonly<{ close(): Promise<void> }> | undefined;
  readonly #evalRoutes: EvalRoutes;
  readonly #eventHub: ProjectEventHub;
  readonly #hookPlaygroundRoutes: HookPlaygroundRoutes;
  readonly #hookReceiptRoutes: HookReceiptRoutes | undefined;
  readonly #hostDiscoveryRoutes: HostDiscoveryRoutes;
  readonly #hostMcpRoutes: HostMcpRoutes | undefined;
  readonly #hostSessionRoutes: HostSessionRoutes;
  readonly #host: string;
  readonly #inspectorRoutes: InspectorRoutes;
  readonly #lifecycleReplayRoutes: LifecycleReplayRoutes;
  readonly #mcpAppPreviews: McpAppRoutePreviewService | undefined;
  readonly #mcpAppRoutes: McpAppRoutes;
  readonly #mcpProbeRoutes: McpProbeRoutes;
  readonly #runtimeMcpRoutes: RuntimeMcpRoutes;
  readonly #mcpSessionRoutes: McpSessionRoutes;
  readonly #runtimeRoutes: RuntimeRoutes;
  readonly #now: () => Date;
  readonly #playgroundRoutes: PlaygroundRoutes;
  readonly #port: number;
  readonly #routeManifestRoutes: RouteManifestRoutes;
  readonly #routeInvocationRoutes: RouteInvocationRoutes;
  readonly #server: Server;
  readonly #skillDocuments: SkillDocumentService | undefined;
  readonly #sockets = new Set<Socket>();
  readonly #streamSubscriptions = new Set<ProjectEventSubscription>();
  readonly #testing: ForegroundServerTesting | undefined;
  readonly #traceRoutes: TraceRoutes;
  readonly #webHostEpochSubscription: ProjectEventSubscription | undefined;
  readonly #webHostRoutes: WebHostRoutes;
  readonly #workbenchDevOrigins: ReadonlySet<string>;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #listenStarted = false;
  #releasePromise: Promise<readonly ForegroundServerCloseFailure[]> | undefined;
  #startPromise: Promise<void> | undefined;
  #url: string | undefined;

  constructor(options: ForegroundServerOptions) {
    const host = options.host ?? '127.0.0.1';
    if (!loopbackHosts.has(host)) {
      throw new ForegroundServerError('AB8000', 'Foreground servers may bind only to 127.0.0.1 or ::1.');
    }
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      throw new ForegroundServerError('AB8000', 'Foreground server port must be a safe TCP port number.');
    }
    const instanceId = options.instanceId ?? randomUUID();
    if (instanceId.length === 0 || instanceId.length > instanceIdLengthLimit || instanceId.trim() !== instanceId) {
      throw new ForegroundServerError('AB8000', 'Foreground server instance ID must be a trimmed string between 1 and 128 characters.');
    }
    const workbenchDevOrigins = options.workbenchDevOrigins ?? [];
    if (!workbenchDevOrigins.every(isLoopbackBrowserOrigin)) {
      throw new ForegroundServerError(
        'AB8000',
        'Foreground server Workbench dev origins must be loopback http(s) origins such as http://localhost:3000.',
      );
    }

    this.#agentApi = options.agentApi;
    this.#assets = options.assets;
    this.#coordinator = options.coordinator;
    this.#evalLifecycle = options.evalLifecycle;
    this.#eventHub = options.eventHub;
    this.#host = host;
    this.#hostMcpRoutes = options.hostMcp;
    this.#hookReceiptRoutes = options.hookReceipts;
    this.instanceId = instanceId;
    this.#mcpAppPreviews = options.mcpAppPreviews;
    this.#now = options.now ?? (() => new Date());
    this.#port = port;
    this.#skillDocuments = options.skillDocuments;
    this.#testing = options.testing;
    this.sessionToken = options.sessionToken ?? randomUUID();
    this.#hostSessionRoutes = new HostSessionRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.hostSessions === undefined ? {} : { service: options.hostSessions }),
    });
    this.#workbenchDevOrigins = Object.freeze(new Set(workbenchDevOrigins));
    this.#webHostRoutes = new WebHostRoutes({
      authorize: (request) => this.#assertWebHostNavigation(request),
      ...(options.epochs === undefined ? {} : { epochs: options.epochs }),
      ...(options.webHostLaunch === undefined ? {} : { launch: options.webHostLaunch }),
      ...(options.mcpSessions === undefined ? {} : { mcpSessions: options.mcpSessions }),
      ...(options.mcpAppPreviews === undefined ? {} : { previews: options.mcpAppPreviews }),
      sandboxOrigin: options.mcpAppSandboxOrigin ?? (() => undefined),
      sessionToken: this.sessionToken,
    });
    // Web-host session retirement follows successful epoch publications only:
    // a failed rebuild publishes no artifact.available and retires nothing.
    // Subscribed only when the web host is functional, so a foreground server
    // without it keeps the hub's SSE-only subscription accounting.
    this.#webHostEpochSubscription =
      options.epochs === undefined || options.mcpSessions === undefined || options.webHostLaunch === undefined
        ? undefined
        : options.eventHub.subscribe(
          { afterSequence: options.eventHub.latestSequence },
          (event) => {
            if (event.type === 'artifact.available') this.#webHostRoutes.adoptActiveEpoch(event.epochId);
          },
        );
    this.#mcpAppRoutes = new McpAppRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      openingCall: (sessionId, toolName, opening) => this.#webHostRoutes.openingCall(sessionId, toolName, opening),
      ...(options.mcpAppPreviews === undefined ? {} : { service: options.mcpAppPreviews }),
    });
    this.#mcpSessionRoutes = new McpSessionRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.mcpSessions === undefined ? {} : { service: options.mcpSessions }),
    });
    this.#runtimeMcpRoutes = new RuntimeMcpRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.mcpAppPreviews === undefined
        ? {}
        : {
            awaitRegistryMutation: async () => { await options.mcpAppPreviews?.runtime?.flushRegistry?.(); },
            awaitSessionClose: async ({ expectedSessionRevision, sessionId }) => {
              await options.mcpAppPreviews?.runtime?.closeSession?.(sessionId, expectedSessionRevision);
            },
          }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    });
    this.#runtimeRoutes = new RuntimeRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.testing?.loadAgentDocumentRuntime === undefined
        ? {}
        : { loadAgentDocumentRuntime: options.testing.loadAgentDocumentRuntime }),
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    });
    this.#hookPlaygroundRoutes = new HookPlaygroundRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.hookPlayground === undefined ? {} : { service: options.hookPlayground }),
    });
    this.#hostDiscoveryRoutes = new HostDiscoveryRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.hostDiscovery === undefined ? {} : { service: options.hostDiscovery }),
    });
    this.#mcpProbeRoutes = new McpProbeRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.mcpProbe === undefined ? {} : { service: options.mcpProbe }),
    });
    this.#lifecycleReplayRoutes = new LifecycleReplayRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.lifecycleReplay === undefined ? {} : { service: options.lifecycleReplay }),
    });
    this.#inspectorRoutes = new InspectorRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.inspector === undefined ? {} : { service: options.inspector }),
    });
    this.#playgroundRoutes = new PlaygroundRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.playground === undefined ? {} : { service: options.playground }),
    });
    this.#artifactRoutes = new ArtifactRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.artifacts === undefined ? {} : { service: options.artifacts }),
    });
    this.#routeManifestRoutes = new RouteManifestRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.routeManifest === undefined ? {} : { service: options.routeManifest }),
    });
    this.#routeInvocationRoutes = new RouteInvocationRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      eventHub: options.eventHub,
      ...(options.routeInvocations === undefined ? {} : { service: options.routeInvocations }),
    });
    this.#evalRoutes = new EvalRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.evals === undefined ? {} : { service: options.evals }),
    });
    this.#devLogRoutes = new DevLogRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.logs === undefined ? {} : { service: options.logs }),
    });
    this.#traceRoutes = new TraceRoutes({
      authorize: (request) => this.#assertMutationSession(request),
      ...(options.trace === undefined ? {} : { hub: options.trace }),
    });
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        responseDiagnostic(
          response,
          isRequestDiagnostic(error)
            ? error
            : diagnostic('AB8007', 'Request could not be completed.', 500),
        );
      });
    });
    this.#server.on('connection', (socket: Socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
    });
  }

  /** Identity for this foreground server process, disclosed solely through same-origin bootstrap. */
  readonly instanceId: string;

  /** Browser-only capability, disclosed solely through same-origin bootstrap. */
  readonly sessionToken: string;

  get url(): string {
    if (this.#url === undefined) throw new Error('Foreground server has not started.');
    return this.#url;
  }

  async start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    if (this.#closing) throw closedError();
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  /**
   * Releasing a resource can re-enter shutdown: a cancelled hook simulation runs
   * its abort callback synchronously, and that callback may close this server. The
   * single outcome is therefore published before any resource is asked to release,
   * so every nested, concurrent, and repeated caller receives the identical promise
   * and no resource is released twice.
   */
  close(): Promise<void> {
    const closing = this.#closePromise;
    if (closing !== undefined) return closing;
    this.#closing = true;
    const published = Promise.withResolvers<void>();
    this.#closePromise = published.promise;
    try {
      this.#close().then(published.resolve, published.reject);
    } catch (error) {
      published.reject(error);
    }
    return published.promise;
  }

  async #start(): Promise<void> {
    try {
      await this.#coordinator.start();
      this.#assertOpen();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const fail = (error: Error) => {
          this.#server.off('listening', succeed);
          rejectPromise(error);
        };
        const succeed = () => {
          this.#server.off('error', fail);
          resolvePromise();
        };
        this.#server.once('error', fail);
        this.#server.once('listening', succeed);
        this.#listenStarted = true;
        this.#server.listen({ host: this.#host, port: this.#port });
      });
      this.#assertOpen();
      const address = this.#server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Foreground server did not report a TCP address.');
      }
      this.#url = `http://${addressToHost(address)}:${address.port}`;
      await this.#coordinator.publishServerUrl?.(this.#url);
    } catch (error) {
      if (this.#closePromise !== undefined) throw error;
      this.#closing = true;
      const cleanupFailures = await this.#releaseResources();
      if (cleanupFailures.length > 0) {
        throw new ForegroundServerStartError([
          Object.freeze({ error, resource: 'start' }),
          Object.freeze({ error: new ForegroundServerCloseError(cleanupFailures), resource: 'cleanup' }),
        ]);
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closing) throw closedError();
  }

  async #close(): Promise<void> {
    const startup = this.#startPromise;
    const failures = await this.#releaseResources();
    await startup?.catch(() => undefined);
    if (failures.length > 0) throw new ForegroundServerCloseError(failures);
  }

  /** Published before the first release for the same reason close() is. */
  #releaseResources(): Promise<readonly ForegroundServerCloseFailure[]> {
    const releasing = this.#releasePromise;
    if (releasing !== undefined) return releasing;
    const published = Promise.withResolvers<readonly ForegroundServerCloseFailure[]>();
    this.#releasePromise = published.promise;
    try {
      this.#release().then(published.resolve, published.reject);
    } catch (error) {
      published.reject(error);
    }
    return published.promise;
  }

  async #release(): Promise<readonly ForegroundServerCloseFailure[]> {
    this.#webHostEpochSubscription?.unsubscribe();
    this.#webHostRoutes.close();
    this.#mcpAppRoutes.close();
    this.#hostMcpRoutes?.close();
    this.#mcpSessionRoutes.close();
    this.#runtimeMcpRoutes.close();
    this.#runtimeRoutes.close();
    // Publish the hook playground drain before awaiting App tombstones. Its
    // abort callbacks may synchronously re-enter foreground shutdown, and
    // must observe the already-published close outcome.
    const releaseHookPlayground = this.#hookPlaygroundRoutes.close();
    this.#mcpProbeRoutes.close();
    this.#hostDiscoveryRoutes.close();
    // App tombstone publication below deliberately yields once before joining
    // resource drains. Observe this promise now so a fast drain failure cannot
    // become an unhandled rejection during that handoff; allSettled below still
    // records and reports the same rejection.
    void releaseHookPlayground.catch(() => undefined);
    this.#playgroundRoutes.close();
    this.#inspectorRoutes.close();
    this.#artifactRoutes.close();
    const releaseRouteInvocations = this.#routeInvocationRoutes.close();
    void releaseRouteInvocations.catch(() => undefined);
    const releaseHostSessions = this.#hostSessionRoutes.close();
    void releaseHostSessions.catch(() => undefined);
    this.#routeManifestRoutes.close();
    this.#lifecycleReplayRoutes.close();
    const releaseEvals = this.#evalRoutes.close();
    void releaseEvals.catch(() => undefined);
    // Fence both public Eval authorities in this turn. Agent API handlers can
    // still enter EvalService while Eval routes drain their readers, so the
    // service waits for both fences rather than letting either admit new work.
    const releaseAgentApi = this.#agentApi?.close() ?? Promise.resolve();
    void releaseAgentApi.catch(() => undefined);
    const releaseEvalService = Promise.allSettled([releaseEvals, releaseAgentApi])
      .then(() => this.#evalLifecycle?.close());
    void releaseEvalService.catch(() => undefined);
    // Fence all authenticated log streams before the shared coordinator begins
    // producer shutdown.  Observe an early rejection until the all-settled
    // aggregation below can report it with its fixed resource label.
    const releaseLogs = this.#devLogRoutes.close();
    void releaseLogs.catch(() => undefined);
    const releaseTrace = this.#traceRoutes.close();
    void releaseTrace.catch(() => undefined);
    // The Agent API owns admissions over every shared foreground service. It
    // must publish closure and drain active handlers before those services or
    // the epoch-owning coordinator begin their own shutdown.
    const [agentApi] = await Promise.allSettled([releaseAgentApi]);
    // Publish runtime App tombstones while authenticated event streams are
    // still subscribed. Lifecycle close below owns proxies and sandboxes.
    const appPreparation = await Promise.allSettled([this.#mcpAppPreviews?.prepareClose?.() ?? Promise.resolve()]);
    // EventHub delivery is synchronous, while a socket write may need one
    // turn to leave Node's stream buffer before shutdown destroys sockets.
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    // Eval terminal events are producer-owned diagnostics.  Fence their
    // lifecycle drain before the coordinator can close that producer, even
    // when route closure itself reported an independent failure.
    const releaseCoordinator = releaseEvalService.then(
      () => this.#coordinator.close(),
      () => this.#coordinator.close(),
    );
    void releaseCoordinator.catch(() => undefined);
    const releaseServer = this.#listenStarted
      ? (() => {
          this.#listenStarted = false;
          for (const subscription of this.#streamSubscriptions) subscription.unsubscribe();
          this.#streamSubscriptions.clear();
          for (const socket of this.#sockets) socket.destroy();
          return closeServer(this.#server);
        })()
      : Promise.resolve();
    const [server, coordinator, evalRoutes, evalService, hookPlayground, hostSessions, logs, routeInvocations, trace] = await Promise.allSettled([
      releaseServer,
      releaseCoordinator,
      releaseEvals,
      releaseEvalService,
      releaseHookPlayground,
      releaseHostSessions,
      releaseLogs,
      releaseRouteInvocations,
      releaseTrace,
    ]);
    const failures: ForegroundServerCloseFailure[] = [];
    if (agentApi.status === 'rejected') failures.push(Object.freeze({ error: agentApi.reason, resource: 'agent-api' }));
    for (const result of appPreparation) {
      if (result.status === 'rejected') failures.push(Object.freeze({ error: result.reason, resource: 'mcp-apps' }));
    }
    if (server.status === 'rejected') failures.push(Object.freeze({ error: server.reason, resource: 'server' }));
    if (coordinator.status === 'rejected') failures.push(Object.freeze({ error: coordinator.reason, resource: 'coordinator' }));
    if (evalRoutes.status === 'rejected') failures.push(Object.freeze({ error: evalRoutes.reason, resource: 'eval-routes' }));
    if (evalService.status === 'rejected') failures.push(Object.freeze({ error: evalService.reason, resource: 'eval-service' }));
    if (hookPlayground.status === 'rejected') {
      failures.push(Object.freeze({ error: hookPlayground.reason, resource: 'hook-playground' }));
    }
    if (hostSessions.status === 'rejected') failures.push(Object.freeze({ error: hostSessions.reason, resource: 'host-sessions' }));
    if (logs.status === 'rejected') failures.push(Object.freeze({ error: logs.reason, resource: 'logs' }));
    if (routeInvocations.status === 'rejected') {
      failures.push(Object.freeze({ error: routeInvocations.reason, resource: 'route-invocations' }));
    }
    if (trace.status === 'rejected') failures.push(Object.freeze({ error: trace.reason, resource: 'trace' }));
    return Object.freeze(failures);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!requestHostMatches(request, this.url)) {
      throw requestError(diagnostic('AB8008', 'Request host is not this foreground server.', 400));
    }
    const pathname = new URL(request.url ?? '/', this.url).pathname;
    const method = request.method ?? 'GET';
    if (await this.#hostMcpRoutes?.handle(request, response)) return;
    if (await this.#hookReceiptRoutes?.handle(request, response)) return;
    if (pathname === '/mcp') {
      if (this.#agentApi === undefined) return responseDiagnostic(response, diagnostic('AB8007', 'Route was not found.', 404));
      this.#assertAgentApiOrigin(request);
      return this.#agentApi.handle(request, response);
    }
    if (await this.#mcpAppRoutes.handle(request, response)) return;
    if (await this.#mcpSessionRoutes.handle(request, response)) return;
    if (await this.#runtimeMcpRoutes.handle(request, response)) return;
    if (await this.#runtimeRoutes.handle(request, response)) return;
    if (await this.#hookPlaygroundRoutes.handle(request, response)) return;
    if (await this.#mcpProbeRoutes.handle(request, response)) return;
    if (await this.#hostDiscoveryRoutes.handle(request, response)) return;
    if (await this.#lifecycleReplayRoutes.handle(request, response)) return;
    if (await this.#playgroundRoutes.handle(request, response)) return;
    if (await this.#inspectorRoutes.handle(request, response)) return;
    if (await this.#artifactRoutes.handle(request, response)) return;
    if (await this.#routeInvocationRoutes.handle(request, response)) return;
    if (await this.#hostSessionRoutes.handle(request, response)) return;
    if (this.#routeManifestRoutes.handle(request, response)) return;
    if (await this.#evalRoutes.handle(request, response)) return;
    if (await this.#devLogRoutes.handle(request, response)) return;
    if (await this.#traceRoutes.handle(request, response)) return;
    const route = skillRoute(request.url);
    if (route !== undefined) return this.#serveSkill(route, response, method);
    if (pathname === '/api/project/status') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return writeJsonResponse(response, { status: this.#coordinator.status() });
    }
    if (pathname === '/api/project/session') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      this.#assertBrowserOrigin(request);
      const cookieName = this.#sessionCookieName();
      const devOrigins = [...this.#workbenchDevOrigins].sort((left, right) => left.localeCompare(right));
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${cookieName}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/api`,
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify({
        cookieName,
        ...(devOrigins.length === 0 ? {} : { devOrigins }),
        instanceId: this.instanceId,
        origin: this.url,
        token: this.sessionToken,
      }));
      return;
    }
    if (pathname === '/api/project/rebuild') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      this.#assertMutationSession(request);
      if (!isJsonRequest(request)) {
        return responseDiagnostic(response, diagnostic('AB8009', 'Request body must use application/json.', 415));
      }
      await this.#coordinator.rebuild(manualInvalidation(await readBody(request), this.#now));
      return writeJsonResponse(response, { status: this.#coordinator.status() });
    }
    if (pathname === '/api/project/events') {
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return this.#streamEvents(request, response);
    }
    if (await this.#webHostRoutes.handle(request, response)) return;
    return this.#serveAsset(request, response, method);
  }

  async #serveSkill(route: SkillRoute, response: ServerResponse, method: string): Promise<void> {
    const service = this.#skillDocuments;
    if (service === undefined) {
      return responseDiagnostic(response, diagnostic('AB8011', 'Skill workbench service is not available.', 404));
    }
    const resource = route.kind === 'source-resource' || route.kind === 'generated-resource';
    if (method !== 'GET' && (!resource || method !== 'HEAD')) {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    try {
      if (route.kind === 'source-tree') return writeJsonResponse(response, await service.sourceTree());
      if (route.kind === 'source-document') return writeJsonResponse(response, { document: await service.source(route.skillId) });
      if (route.kind === 'generated-tree') {
        return writeJsonResponse(response, await service.generatedTree(route.epochId, route.target));
      }
      if (route.kind === 'generated-document') {
        return writeJsonResponse(response, { document: await service.generated(route.epochId, route.target, route.skillId) });
      }
      const value = route.kind === 'source-resource'
        ? await service.sourceResource(route.skillId, route.resource)
        : await service.generatedResource(route.epochId, route.target, route.skillId, route.resource);
      const headers: Record<string, string> = {
        'content-length': String(value.body.byteLength),
        'content-type': value.contentType,
        'x-content-type-options': 'nosniff',
      };
      if (value.contentDisposition === 'attachment') {
        headers['content-disposition'] = attachmentHeader(value.relativePath);
      }
      response.writeHead(200, headers);
      response.end(method === 'HEAD' ? undefined : value.body);
    } catch (error) {
      if (error instanceof SkillDocumentError) {
        return responseDiagnostic(response, diagnostic(error.code, error.message, 404));
      }
      throw error;
    }
  }

  /** This foreground origin, or an operator-listed Workbench dev-server origin whose pages reach /api through its proxy. */
  #isBrowserOrigin(origin: string): boolean {
    return origin === this.url || this.#workbenchDevOrigins.has(origin);
  }

  /** Browser routes require an accepted `Origin`; a missing one passes only with same-origin fetch provenance. */
  #assertBrowserOrigin(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin === undefined ? singleHeader(request.headers['sec-fetch-site']) === 'same-origin' : this.#isBrowserOrigin(origin)) {
      return;
    }
    throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
  }

  /** Top-level same-origin navigations have no Origin and may report `none`. */
  #assertWebHostNavigation(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin !== undefined) {
      if (this.#isBrowserOrigin(origin)) return;
    } else {
      const site = singleHeader(request.headers['sec-fetch-site']);
      if (site === undefined || site === 'none' || site === 'same-origin') return;
    }
    throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
  }

  /** Codex MCP clients may omit Origin; browsers with one must be this exact foreground origin. */
  #assertAgentApiOrigin(request: IncomingMessage): void {
    const origin = singleHeader(request.headers.origin);
    if (origin === undefined) return;
    const allowedOrigin = new URL(this.url).hostname;
    if (!validateOriginHeader(origin, [allowedOrigin]).ok || origin !== this.url) {
      throw requestError(diagnostic('AB8003', 'Request origin is not this foreground server.', 403));
    }
  }

  #assertMutationSession(request: IncomingMessage): void {
    this.#assertBrowserOrigin(request);
    if (singleHeader(request.headers['x-agent-bundle-session']) !== this.sessionToken) {
      throw requestError(diagnostic('AB8004', 'A valid same-session token is required.', 403));
    }
  }

  #assertEventSession(request: IncomingMessage): void {
    this.#assertBrowserOrigin(request);
    if (cookieValue(request, this.#sessionCookieName()) !== this.sessionToken) {
      throw requestError(diagnostic('AB8004', 'A valid foreground session cookie is required.', 403));
    }
  }

  /** Stable per-origin names overwrite restart credentials while isolating concurrent loopback ports. */
  #sessionCookieName(): string {
    return `agent-bundle-foreground-session-${createHash('sha256').update(this.url).digest('hex').slice(0, 32)}`;
  }

  #streamEvents(request: IncomingMessage, response: ServerResponse): void {
    try {
      this.#assertEventSession(request);
    } catch (error) {
      const failure = isRequestDiagnostic(error)
        ? error
        : diagnostic('AB8007', 'Request could not be completed.', 500);
      response.writeHead(failure.status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify({ diagnostic: { code: failure.code, message: failure.message } }));
      return;
    }
    const sequence = afterSequence(request, this.#eventHub.latestSequence);
    response.writeHead(200, {
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    response.flushHeaders();
    let backpressured = false;
    let closed = false;
    let bufferedBytes = 0;
    let queuedBytes = 0;
    const queued: QueuedSseFrame[] = [];
    const stream = { subscription: undefined as ProjectEventSubscription | undefined };
    const unsubscribe = () => {
      stream.subscription?.unsubscribe();
      if (stream.subscription !== undefined) this.#streamSubscriptions.delete(stream.subscription);
      bufferedBytes = 0;
      queued.length = 0;
      queuedBytes = 0;
    };
    const closeStream = () => {
      closed = true;
      unsubscribe();
    };
    const closeSlowStream = () => {
      closeStream();
      response.destroy();
    };
    const drain = () => {
      if (closed || response.writableEnded || response.destroyed) return;
      backpressured = false;
      bufferedBytes = 0;
      while (queued.length > 0) {
        const next = queued.shift()!;
        queuedBytes -= next.bytes;
        if (!response.write(next.frame)) {
          backpressured = true;
          bufferedBytes = next.bytes;
          response.once('drain', drain);
          return;
        }
      }
    };
    const deliver = (frame: string) => {
      if (closed || response.writableEnded || response.destroyed) return;
      const bytes = Buffer.byteLength(frame);
      if (!backpressured) {
        if (!response.write(frame)) {
          backpressured = true;
          bufferedBytes = bytes;
          response.once('drain', drain);
        }
        return;
      }
      if (bufferedBytes + queuedBytes + bytes > sseQueueByteLimit) {
        closeSlowStream();
        return;
      }
      queued.push({ bytes, frame });
      queuedBytes += bytes;
    };
    const subscription = this.#eventHub.subscribe({ afterSequence: sequence }, (event) => {
      deliver(eventFrame(event));
    });
    stream.subscription = subscription;
    if (closed || request.destroyed || response.destroyed) {
      closeStream();
      return;
    }
    this.#streamSubscriptions.add(subscription);
    request.once('close', closeStream);
    response.once('close', closeStream);
    const handle = Object.freeze({
      disconnect: () => {
        if (closed) return;
        closeSlowStream();
      },
    });
    try {
      this.#testing?.onProjectEventStream?.(handle);
    } catch {
      // Test observation cannot perturb an authenticated project stream.
    }
  }

  async #serveAsset(request: IncomingMessage, response: ServerResponse, method: string): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') {
      return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    }
    const pathname = rawPathname(request.url);
    const path = method === 'GET' && isWorkbenchShellPath(pathname) && extname(pathname) === ''
      ? 'index.html'
      : decodedAssetPath(request.url);
    const asset = await this.#assets?.read(path);
    if (asset === undefined) return responseDiagnostic(response, diagnostic('AB8007', 'Route was not found.', 404));
    response.writeHead(200, {
      'cache-control': workbenchAssetCacheControl(path),
      'content-type': asset.contentType,
    });
    response.end(method === 'HEAD' ? undefined : asset.body);
  }
}

const addressToHost = (address: AddressInfo): string => address.family === 'IPv6'
  ? `[${address.address}]`
  : address.address;

export const startForegroundServer = async (options: ForegroundServerOptions): Promise<ForegroundServer> => {
  const server = new ForegroundServer(options);
  await server.start();
  return server;
};
