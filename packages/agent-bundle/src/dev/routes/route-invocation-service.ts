import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentDocument } from '@agent-bundle/runtime';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import type { TargetHookContract } from '../../adapters/hook-contract.ts';
import { projectCliDocumentToMarkdown } from '../../cli-entry.ts';
import { sleep } from '../../core/async.ts';
import type { Diagnostic } from '../../core/diagnostics.ts';
import { deepFreeze } from '../../core/freeze.ts';
import {
  hasOnlyOwnKeys,
  isJsonRecord,
  isRecord,
  snapshotStrictJsonValue,
  type JsonObject,
  type JsonValue,
} from '../../core/strict-json.ts';
import type {
  RequestContextProvenance,
  RequestProvenanceAxis,
  RequestProvenanceUnavailableReason,
} from '../../contracts/request-provenance.ts';
import { createCanonicalEventProps, projectEventDocument } from '../../events/projection.ts';
import {
  eventTraceEventKinds,
  type EventTraceEvent,
  type EventTracePreflightOutcome,
} from '../../events/trace.ts';
import {
  canonicalAgentEvents,
  type CanonicalAgentEvent,
} from '../../routes/public.ts';
import { taskkill, terminateProcessTree, waitForProcessTreeExit } from '../../services/process-tree.ts';
import type { AgentBundleTestManifest, TestableScriptDescriptor } from '../../test/manifest.ts';
import type { ScriptPlaygroundResult, ScriptPlaygroundRunRequest } from '../playground/script-playground-service.ts';
import type { TraceCorrelation, TraceStatus } from '../trace/trace-entry.ts';
import type { TracePublisher } from '../trace/trace-hub.ts';
import { applicationNodePath, applicationNodeRefForRouteId } from './application-node.ts';
import type { RouteInvocation } from './route-invocation-result.ts';
import {
  nativeEventRequestContext,
  type RouteInvocationProjection,
  type RouteInvocationEventHost,
  type RouteInvocationKind,
  type RouteInvocationProvider,
  type RouteInvocationRequest,
  type RouteInvocationSummary,
  type RouteInvocationTiming,
} from './route-invocation.ts';
import type { RouteManifest, RouteManifestRoute } from './route-manifest.ts';
import type { RouteManifestRouteService } from './route-manifest-routes.ts';

export const ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE = 'AB8231';
export const ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE = 'AB8232';
export const ROUTE_INVOCATION_CHILD_FAILURE_CODE = 'AB8236';
export const ROUTE_INVOCATION_MALFORMED_REQUEST_CODE = 'AB8237';
export const ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE = 'AB8238';

const defaultHistoryLimit = 200;
const defaultTimeoutMs = 60_000;
const defaultConcurrency = 2;
const childTerminationGraceMs = 250;
const childTerminationPollMs = 10;
const concreteHosts = new Set<RouteInvocationEventHost>(['claude', 'codex', 'cursor']);
const invocationKinds = new Set<RouteInvocationKind>(['cli', 'event-route', 'prompt', 'resource', 'script', 'tool']);

export interface RouteInvocationFixture {
  readonly id: string;
  readonly input: JsonValue;
  readonly label: string;
}

/**
 * Execution-only material from the same prepared compiler pass that produced
 * the browser manifest. The service never compiles or discovers a second
 * graph; the child receives this immutable harness manifest solely to install
 * route, provider, layout, and state loaders.
 */
export interface RouteInvocationPreparedProject {
  /**
   * The published build a plain script runs from, and a target whose layout
   * emits the `scripts/` directory. Absent while no build is published.
   */
  readonly artifact?: Readonly<{ epochId: string; target: string }>;
  readonly fixtures?: Readonly<Record<string, readonly RouteInvocationFixture[]>>;
  readonly manifest: AgentBundleTestManifest;
  readonly targets: readonly RouteInvocationEventHost[];
}

export interface RouteInvocationScriptRunner {
  run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult>;
}

export interface RouteInvocationServiceOptions {
  readonly concurrency?: number;
  readonly historyLimit?: number;
  readonly manifest: RouteManifestRouteService;
  readonly now?: () => Date;
  readonly prepared: () => RouteInvocationPreparedProject;
  readonly registry?: TargetRegistry;
  readonly renderChild?: (
    request: RouteInvocationChildRequest,
    signal: AbortSignal,
    publishKernelEvent: (event: EventTraceEvent) => void,
  ) => Promise<RouteInvocationChildResult>;
  readonly scripts?: RouteInvocationScriptRunner;
  readonly timeoutMs?: number;
  readonly trace?: TracePublisher;
}

export interface RouteInvocationChildRequest {
  readonly args?: readonly string[];
  readonly context: RequestContextProvenance;
  readonly input: JsonValue;
  readonly manifest: AgentBundleTestManifest;
  readonly routeId: string;
}

export interface RouteInvocationChildResult {
  readonly document: NonNullable<RouteInvocation['document']>;
  readonly events: RouteInvocation['events'];
  /** The input handed to the route after hosted-event canonicalization. */
  readonly input: JsonValue;
  /** Runtime-owned MCP projection, computed inside the runtime-bound child. */
  readonly mcp?: JsonObject;
  readonly renderDurationMs: number;
  readonly result?: JsonValue;
}

export type RouteInvocationChildResponse =
  | Readonly<{ readonly result: RouteInvocationChildResult; readonly type: 'result' }>
  | Readonly<{ readonly event: EventTraceEvent; readonly type: 'trace' }>
  | Readonly<{
    readonly error: Readonly<{ readonly message: string; readonly name: string }>;
    readonly type: 'error';
  }>;

export class RouteInvocationRequestError extends Error {
  readonly code:
    | typeof ROUTE_INVOCATION_MALFORMED_REQUEST_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE
    | typeof ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE;
  readonly status: 400 | 404 | 409;

  constructor(
    code: RouteInvocationRequestError['code'],
    message: string,
    status: RouteInvocationRequestError['status'],
  ) {
    super(message);
    this.name = 'RouteInvocationRequestError';
    this.code = code;
    this.status = status;
  }
}

const malformed = (): never => {
  throw new RouteInvocationRequestError(
    ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
    'Route invocation request has an invalid shape.',
    400,
  );
};

const boundedString = (value: unknown, maxLength = 4_096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value && !value.includes('\0');

const eventOptions = (value: unknown): RouteInvocationRequest['event'] => {
  if (!isRecord(value) || !hasOnlyOwnKeys(value, ['fixtureId', 'host'])) return malformed();
  const fixtureId = value.fixtureId;
  const host = value.host;
  if (fixtureId !== undefined && !boundedString(fixtureId)) return malformed();
  if (host !== undefined && (typeof host !== 'string' || !concreteHosts.has(host as RouteInvocationEventHost))) {
    return malformed();
  }
  return Object.freeze({
    ...(fixtureId === undefined ? {} : { fixtureId }),
    ...(host === undefined ? {} : { host: host as RouteInvocationEventHost }),
  });
};

/** Strict wire decoder used by both the HTTP boundary and unit callers. */
export const parseRouteInvocationRequest = (
  value: Readonly<Record<string, unknown>>,
): RouteInvocationRequest => {
  if (!hasOnlyOwnKeys(value, ['args', 'correlationId', 'event', 'input', 'requestId', 'routeId'])) return malformed();
  const routeId = value.routeId;
  const correlationId = value.correlationId;
  const requestId = value.requestId;
  const args = value.args;
  if (!boundedString(routeId)) return malformed();
  if (correlationId !== undefined && !boundedString(correlationId, 256)) return malformed();
  if (requestId !== undefined && !boundedString(requestId, 256)) return malformed();
  if (args !== undefined && (!Array.isArray(args) || args.length > 1_024 || args.some((argument) => !boundedString(argument, 16_384)))) {
    return malformed();
  }
  let input: JsonValue | undefined;
  if (Object.hasOwn(value, 'input')) {
    try {
      input = snapshotStrictJsonValue(value.input);
    } catch {
      return malformed();
    }
  }
  const event = value.event === undefined ? undefined : eventOptions(value.event);
  return deepFreeze({
    ...(args === undefined ? {} : { args: [...args] as readonly string[] }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(event === undefined ? {} : { event }),
    ...(input === undefined ? {} : { input }),
    ...(requestId === undefined ? {} : { requestId }),
    routeId,
  });
};

/** Removes stream/document-heavy fields for history and project events. */
export const invocationSummary = (invocation: RouteInvocation): RouteInvocationSummary => {
  const {
    context: _context,
    document: _document,
    events: _events,
    projection: _projection,
    providers: _providers,
    result: _result,
    ...summary
  } = invocation;
  return deepFreeze(summary);
};

export class InvocationRingBuffer {
  readonly #capacity: number;
  readonly #values: RouteInvocation[] = [];

  constructor(capacity = defaultHistoryLimit) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invocation history capacity must be positive.');
    this.#capacity = capacity;
  }

  push(invocation: RouteInvocation): void {
    this.#values.push(invocation);
    if (this.#values.length > this.#capacity) this.#values.shift();
  }

  read(id: string): RouteInvocation | undefined {
    return this.#values.findLast((invocation) => invocation.id === id);
  }

  list(limit = this.#capacity): readonly RouteInvocationSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invocation history limit must be positive.');
    return Object.freeze(this.#values.slice(-Math.min(limit, this.#capacity)).reverse().map(invocationSummary));
  }
}

class InvocationSemaphore {
  readonly #limit: number;
  readonly #waiting: Array<() => void> = [];
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invocation concurrency must be positive.');
    this.#limit = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolvePromise) => this.#waiting.push(resolvePromise));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

const allManifestRoutes = (manifest: RouteManifest): readonly RouteManifestRoute[] => Object.freeze([
  ...manifest.servers.flatMap((server) => server.routes),
  ...(manifest.cli?.routes ?? []),
  ...manifest.events,
  ...manifest.scripts,
]);

const diagnostic = (code: string, message: string): Diagnostic =>
  Object.freeze({ code, message, severity: 'error' });

const unavailable = <Value>(
  reason: RequestProvenanceUnavailableReason,
): RequestProvenanceAxis<Value> =>
  Object.freeze({ reason, state: 'unavailable' });

const contextFor = (
  route: RouteManifestRoute,
  root: string,
  host: RouteInvocationEventHost | undefined,
): RequestContextProvenance => deepFreeze({
  actor: unavailable('not-provided'),
  host: host === undefined
    ? unavailable('host-omitted')
    : { source: 'derived', state: 'available', value: { name: host } },
  invocation: {
    kind: route.kind === 'event-route'
      ? 'event'
      : route.kind === 'cli' ? 'cli' : route.kind === 'script' ? 'script' : 'tool',
    operationId: route.id,
    surface: route.event ?? route.id.slice(route.id.lastIndexOf('/') + 1),
  },
  lineage: unavailable('no-shared-runtime'),
  session: unavailable('not-provided'),
  workspace: { source: 'derived', state: 'available', value: { root } },
});

const childPath = (): string => {
  const current = fileURLToPath(import.meta.url);
  const here = dirname(current);
  const candidates = current.endsWith('.ts')
    ? [
        join(here, 'route-invocation-child.ts'),
        join(here, '..', '..', '..', 'dist', 'route-invocation-child.js'),
      ]
    : [
        join(here, 'route-invocation-child.js'),
        join(here, 'route-invocation-child.ts'),
        resolve(process.cwd(), 'packages/agent-bundle/src/dev/routes/route-invocation-child.ts'),
      ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error('Unable to locate the route invocation render child.');
  return found;
};

const plainScriptFor = (prepared: RouteInvocationPreparedProject, route: RouteManifestRoute): TestableScriptDescriptor | undefined =>
  route.kind === 'script'
    ? prepared.manifest.scripts.find((script) => script.routeId === route.id && !script.rendered)
    : undefined;

/**
 * Plain scripts have no route component for the Agent renderer. Run the
 * emitted executable and project its output into the invocation result.
 */
const runPlainScript = async (
  scripts: RouteInvocationScriptRunner | undefined,
  prepared: RouteInvocationPreparedProject,
  script: TestableScriptDescriptor,
  input: JsonValue,
  signal: AbortSignal,
): Promise<RouteInvocationChildResult> => {
  if (scripts === undefined) throw new Error('No script runner is available for a plain script.');
  if (prepared.artifact === undefined) throw new Error('A plain script runs from the published build; none is published.');
  const startedAt = performance.now();
  const run = await scripts.run({
    epochId: prepared.artifact.epochId,
    scriptId: script.routeId,
    signal,
    target: prepared.artifact.target,
  });
  const document: AgentDocument = {
    root: { kind: 'text', text: run.stdout },
    status: run.exitCode === 0 ? 'success' : 'represented-error',
    version: 1,
  };
  return deepFreeze({
    document,
    events: [{ document, sequence: 1, type: 'complete' }],
    input,
    renderDurationMs: performance.now() - startedAt,
    result: { exitCode: run.exitCode, stderr: run.stderr, stdout: run.stdout },
  });
};

const eventTracePhases = new Set(['preflight', 'execute', 'providers', 'render']);
const canonicalEvents = new Set<string>(canonicalAgentEvents);
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isEventTraceEvent = (value: unknown): value is EventTraceEvent => {
  if (!isRecord(value) || !isRecord(value.execution)) return false;
  const execution = value.execution;
  if (
    typeof value.kind !== 'string'
    || !(eventTraceEventKinds as readonly string[]).includes(value.kind)
    || typeof value.phase !== 'string'
    || !eventTracePhases.has(value.phase)
    || !finiteNonnegative(value.at)
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0
    || typeof execution.event !== 'string'
    || !canonicalEvents.has(execution.event)
    || typeof execution.executionId !== 'string'
    || typeof execution.host !== 'string'
    || typeof execution.nativeEvent !== 'string'
    || !hasOnlyOwnKeys(execution, ['event', 'executionId', 'host', 'nativeEvent'])
  ) {
    return false;
  }
  const durationValid = value.durationMs === undefined || finiteNonnegative(value.durationMs);
  switch (value.kind) {
    case 'preflight.start':
      return value.phase === 'preflight'
        && hasOnlyOwnKeys(value, ['at', 'execution', 'kind', 'phase', 'sequence']);
    case 'preflight.outcome':
      return value.phase === 'preflight'
        && durationValid
        && (value.outcome === 'continue' || value.outcome === 'deny' || value.outcome === 'execute')
        && hasOnlyOwnKeys(value, ['at', 'durationMs', 'execution', 'kind', 'outcome', 'phase', 'sequence']);
    case 'execute.start':
      return value.phase === 'execute'
        && (value.runtime === 'shared' || value.runtime === 'standalone')
        && hasOnlyOwnKeys(value, ['at', 'execution', 'kind', 'phase', 'runtime', 'sequence']);
    case 'providers.start':
      return value.phase === 'providers'
        && hasOnlyOwnKeys(value, ['at', 'execution', 'kind', 'phase', 'sequence']);
    case 'providers.finish':
      return value.phase === 'providers'
        && durationValid
        && Number.isSafeInteger(value.count)
        && (value.count as number) >= 0
        && hasOnlyOwnKeys(value, ['at', 'count', 'durationMs', 'execution', 'kind', 'phase', 'sequence']);
    case 'render.start':
      return value.phase === 'render'
        && hasOnlyOwnKeys(value, ['at', 'execution', 'kind', 'phase', 'sequence']);
    case 'render.finish':
      return value.phase === 'render'
        && durationValid
        && hasOnlyOwnKeys(value, ['at', 'durationMs', 'execution', 'kind', 'phase', 'sequence']);
    case 'failure':
      return durationValid
        && isRecord(value.error)
        && typeof value.error.name === 'string'
        && typeof value.error.message === 'string'
        && (value.error.code === undefined || typeof value.error.code === 'string')
        && hasOnlyOwnKeys(value.error, ['code', 'message', 'name'])
        && hasOnlyOwnKeys(value, ['at', 'durationMs', 'error', 'execution', 'kind', 'phase', 'sequence']);
    default:
      return false;
  }
};

const isChildResponse = (value: unknown): value is RouteInvocationChildResponse => {
  if (!isRecord(value)) return false;
  if (value.type === 'result') return isRecord(value.result);
  if (value.type === 'trace') {
    return hasOnlyOwnKeys(value, ['event', 'type']) && isEventTraceEvent(value.event);
  }
  return value.type === 'error' && isRecord(value.error)
    && typeof value.error.name === 'string' && typeof value.error.message === 'string';
};

const alreadyExited = (child: ChildProcess): boolean =>
  child.pid === undefined || typeof child.exitCode === 'number' || typeof child.signalCode === 'string';

const waitForExit = (child: ChildProcess): Promise<void> => new Promise((resolvePromise) => {
  if (alreadyExited(child)) {
    resolvePromise();
    return;
  }
  child.once('exit', () => resolvePromise());
});

const terminateTree = (child: ChildProcess, signal: NodeJS.Signals): Promise<boolean> =>
  terminateProcessTree(child, signal, {
    onTreeTerminationFailure: () => undefined,
    platform: process.platform,
    taskkill,
  });

const treeExited = (child: ChildProcess): Promise<boolean> => waitForProcessTreeExit(child, {
  platform: process.platform,
  pollMilliseconds: childTerminationPollMs,
  timeoutMilliseconds: childTerminationGraceMs,
});

const terminateChild = async (child: ChildProcess): Promise<void> => {
  await terminateTree(child, 'SIGTERM');
  const graceful = await Promise.race([
    waitForExit(child).then(() => true),
    sleep(childTerminationGraceMs).then(() => false),
  ]);
  if (graceful && await treeExited(child)) return;
  await terminateTree(child, 'SIGKILL');
  await waitForExit(child);
  await treeExited(child);
};

const renderInChild = async (
  request: RouteInvocationChildRequest,
  signal: AbortSignal,
  publishKernelEvent: (event: EventTraceEvent) => void,
): Promise<RouteInvocationChildResult> => {
  if (signal.aborted) throw signal.reason;
  const executable = childPath();
  const jitiRegister = join(dirname(createRequire(import.meta.url).resolve('jiti/package.json')), 'lib', 'jiti-register.mjs');
  const child = fork(executable, [], {
    cwd: request.manifest.projectRoot,
    detached: process.platform !== 'win32',
    execArgv: ['--conditions=react-server', ...(executable.endsWith('.ts') ? ['--import', jitiRegister] : [])],
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  const response = new Promise<RouteInvocationChildResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort);
      child.removeListener('exit', exited);
      child.removeListener('message', receive);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abort = (): void => settle(() => rejectPromise(signal.reason));
    const fail = (error: Error): void => settle(() => rejectPromise(error));
    const exited = (code: number | null, exitSignal: NodeJS.Signals | null): void =>
      settle(() => rejectPromise(new Error(
        `Route invocation child exited before replying (code ${String(code)}, signal ${String(exitSignal)}).`,
      )));
    const receive = (message: unknown): void => {
      if (!isChildResponse(message)) return settle(() => rejectPromise(new Error('Route invocation child returned an invalid response.')));
      if (message.type === 'trace') {
        publishKernelEvent(message.event);
        return;
      }
      if (message.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        return settle(() => rejectPromise(error));
      }
      settle(() => resolvePromise(message.result));
    };
    signal.addEventListener('abort', abort, { once: true });
    // Kept for the child's whole life: a `kill()` that fails after the reply
    // still emits `error`, and an unobserved one would crash the dev server.
    child.on('error', fail);
    child.once('exit', exited);
    child.on('message', receive);
    child.send(request, (error) => {
      if (error !== null) fail(error);
    });
  });
  try {
    return await response;
  } finally {
    await terminateChild(child);
  }
};

const eventContract = (
  registry: TargetRegistry,
  host: RouteInvocationEventHost,
  event: CanonicalAgentEvent,
): Readonly<{ contract: TargetHookContract; hostContractRevision: string; nativeEvent: string }> | undefined => {
  const contract = registry.hookContract(host);
  const nativeEvent = contract?.eventRouteNames?.[event];
  const hostContractRevision = contract?.hostContractRevision;
  if (contract === undefined || !boundedString(nativeEvent) || !boundedString(hostContractRevision)) return undefined;
  return Object.freeze({ contract, hostContractRevision, nativeEvent });
};

const contextForRequest = (
  route: RouteManifestRoute,
  root: string,
  request: RouteInvocationRequest,
  nativeInput: JsonValue,
  registry: TargetRegistry,
): RequestContextProvenance => {
  const host = request.event?.host;
  if (route.kind !== 'event-route' || host === undefined || !isJsonRecord(nativeInput)) {
    return contextFor(route, root, host);
  }
  const mapped = eventContract(registry, host, route.event as CanonicalAgentEvent);
  if (mapped === undefined) return contextFor(route, root, host);
  return nativeEventRequestContext({
    event: route.event!,
    hostContractRevision: mapped.hostContractRevision,
    native: nativeInput,
    routeId: route.id,
    target: host,
  });
};

const routeHref = (routeId: string, invocationId: string): string | undefined => {
  const node = applicationNodeRefForRouteId(routeId);
  return node === undefined
    ? undefined
    : `${applicationNodePath(node)}?invocation=${encodeURIComponent(invocationId)}`;
};

const routeLabel = (
  kind: RouteInvocationKind,
  routeId: string,
  event: string | undefined,
  host: RouteInvocationEventHost | undefined,
): string => {
  const identity = routeId.slice(routeId.indexOf(':') + 1);
  switch (kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
      return `MCP ${kind} ${identity}`;
    case 'event-route':
      return `event ${event ?? identity}${host === undefined ? '' : ` (${host})`}`;
    case 'cli':
      return `CLI ${identity}`;
    case 'script':
      return `script ${identity}`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

const durationText = (durationMs: number): string => `${durationMs.toFixed(1)} ms`;

const traceCorrelation = (
  request: RouteInvocationRequest,
  context: RequestContextProvenance,
  invocationId: string,
  epochId: string | undefined,
): TraceCorrelation => ({
  ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
  ...(context.lineage.state === 'available'
    ? { conversationId: context.lineage.value.conversation }
    : {}),
  ...(epochId === undefined ? {} : { epochId }),
  ...(context.host.state === 'available' ? { host: context.host.value.name } : {}),
  invocationId,
  ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  routeId: request.routeId,
  ...(context.session.state === 'available'
    ? { sessionId: context.session.value.sessionId }
    : {}),
});

const projectionKind = (projection: RouteInvocationProjection): 'cli' | 'hosts' | 'mcp' | 'none' => {
  if (projection.mcp !== undefined) return 'mcp';
  if (projection.cli !== undefined) return 'cli';
  if (projection.hosts !== undefined) return 'hosts';
  return 'none';
};

const invocationTraceDetails = (invocation: RouteInvocation): JsonObject => ({
  diagnosticCodes: invocation.diagnostics.map((entry) => entry.code),
  ...(invocation.projection.cli === undefined ? {} : { exitCode: invocation.projection.cli.exitCode }),
  projectionKind: projectionKind(invocation.projection),
  providers: invocation.providers.map((provider) => ({
    ...(provider.durationMs === undefined ? {} : { durationMs: provider.durationMs }),
    name: provider.name,
  })),
  status: invocation.status,
});

const kernelStatus = (event: EventTraceEvent): TraceStatus => {
  switch (event.kind) {
    case 'failure':
      return 'error';
    case 'preflight.outcome':
    case 'providers.finish':
    case 'render.finish':
      return 'ok';
    case 'preflight.start':
    case 'execute.start':
    case 'providers.start':
    case 'render.start':
      return 'running';
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

const kernelSummary = (event: EventTraceEvent): string => {
  const label = `event ${event.execution.event} (${event.execution.host})`;
  switch (event.kind) {
    case 'preflight.start':
      return `${label} · preflight started`;
    case 'preflight.outcome':
      return `${label} · ${event.outcome}`;
    case 'execute.start':
      return `${label} · ${event.runtime} execution`;
    case 'providers.start':
      return `${label} · providers started`;
    case 'providers.finish':
      return `${label} · providers finished`;
    case 'render.start':
      return `${label} · render started`;
    case 'render.finish':
      return `${label} · render finished`;
    case 'failure':
      return `${label} · ${event.error.name}: ${event.error.message}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

const kernelDetails = (event: EventTraceEvent): JsonObject => {
  const base = {
    event: event.execution.event,
    nativeEvent: event.execution.nativeEvent,
    phase: event.phase,
    sequence: event.sequence,
  };
  switch (event.kind) {
    case 'preflight.start':
    case 'providers.start':
    case 'render.start':
      return base;
    case 'preflight.outcome':
      return { ...base, outcome: event.outcome };
    case 'execute.start':
      return { ...base, runtime: event.runtime };
    case 'providers.finish':
      return { ...base, count: event.count };
    case 'render.finish':
      return base;
    case 'failure':
      return {
        ...base,
        error: {
          ...(event.error.code === undefined ? {} : { code: event.error.code }),
          message: event.error.message,
          name: event.error.name,
        },
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

const eventInput = (
  route: RouteManifestRoute,
  input: JsonValue,
  host: RouteInvocationEventHost | undefined,
  registry: TargetRegistry,
): JsonValue => {
  if (!isJsonRecord(input)) return malformed();
  if (host === undefined) return Object.freeze({ canonical: input, native: {} });
  const mapped = eventContract(registry, host, route.event as CanonicalAgentEvent);
  if (mapped === undefined) {
    throw new RouteInvocationRequestError(
      ROUTE_INVOCATION_MALFORMED_REQUEST_CODE,
      `Route event ${JSON.stringify(route.event)} is not supported by ${host}.`,
      400,
    );
  }
  const props = createCanonicalEventProps(
    route.event as CanonicalAgentEvent,
    input,
    host,
    mapped.nativeEvent,
    mapped.hostContractRevision,
    new AbortController().signal,
  );
  return snapshotStrictJsonValue({
    canonical: props.canonical,
    native: props.native,
  });
};

const providerProjection = (
  manifest: RouteManifest,
  durationMs: number,
  status: RouteInvocationProvider['status'],
): readonly RouteInvocationProvider[] => Object.freeze(manifest.providers.map((provider) => Object.freeze({
  durationMs,
  id: provider.id,
  name: provider.name,
  status,
})));

const timing = (phase: string, startedAt: Date, durationMs: number): RouteInvocationTiming =>
  Object.freeze({ durationMs, phase, startedAt: startedAt.toISOString() });

const jsonObject = (value: unknown): JsonObject | undefined => {
  if (value === undefined) return undefined;
  const snapshot = snapshotStrictJsonValue(value);
  return isJsonRecord(snapshot) ? snapshot : undefined;
};

const resultExitCode = (policy: 'result' | 'zero', result: JsonValue | undefined): number => {
  if (policy === 'zero') return 0;
  if (result === undefined || !isJsonRecord(result)) return 1;
  const value = result.exitCode;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255 ? value : 1;
};

const invocationProjection = (
  route: RouteManifestRoute,
  request: RouteInvocationRequest,
  input: JsonValue,
  result: JsonValue | undefined,
  mcp: JsonObject | undefined,
  document: NonNullable<RouteInvocation['document']>,
  manifest: RouteManifest,
  prepared: RouteInvocationPreparedProject,
  registry: TargetRegistry,
): RouteInvocation['projection'] => {
  if (route.kind === 'tool') {
    if (mcp === undefined) throw new Error('Route invocation child omitted the tool MCP projection.');
    return deepFreeze({ mcp });
  }
  if (route.kind === 'resource' || route.kind === 'prompt') {
    return deepFreeze({ ...(jsonObject(result) === undefined ? {} : { mcp: jsonObject(result) }) });
  }
  if (route.kind === 'cli' || route.kind === 'script') {
    const command = manifest.cli?.commands?.find((candidate) => candidate.routeId === route.id);
    // A plain script's exit code is its process status, carried in `result`;
    // a rendered script exits zero like a rendered CLI command.
    const policy = route.kind === 'script'
      ? (plainScriptFor(prepared, route) === undefined ? 'zero' : 'result')
      : command?.exitCode ?? 'zero';
    return deepFreeze({
      cli: {
        exitCode: resultExitCode(policy, result),
        ...(result === undefined ? {} : { json: result }),
        text: projectCliDocumentToMarkdown(document),
      },
    });
  }
  if (route.kind === 'event-route') {
    const selected = request.event?.host === undefined ? prepared.targets : [request.event.host];
    const hosts = selected.map((host) => {
      const mapped = eventContract(registry, host, route.event as CanonicalAgentEvent);
      if (mapped === undefined) {
        return {
          diagnostics: [diagnostic(
            'route.invocation.projection.unsupported',
            `Event ${JSON.stringify(route.event)} cannot be projected to ${host}.`,
          )],
          host,
        };
      }
      try {
        const native = projectEventDocument(
          document,
          route.event as CanonicalAgentEvent,
          host,
          mapped.nativeEvent,
          request.event?.host === host && isJsonRecord(input) ? input : undefined,
        );
        return { diagnostics: [], host, ...(native === undefined ? {} : { native: jsonObject(native) }) };
      } catch (error) {
        return {
          diagnostics: [diagnostic(
            'route.invocation.projection.failed',
            error instanceof Error ? error.message : String(error),
          )],
          host,
        };
      }
    });
    return deepFreeze({ hosts });
  }
  return {};
};

const failedInvocation = (input: {
  readonly code: string;
  readonly completedAt: Date;
  readonly context: RequestContextProvenance;
  readonly id: string;
  readonly manifest: RouteManifest;
  readonly message: string;
  readonly request: RouteInvocationRequest;
  readonly route: RouteManifestRoute;
  readonly startedAt: Date;
}): RouteInvocation => {
  const renderedInput = input.request.input;
  const canonical = input.route.kind === 'event-route' && renderedInput !== undefined && isJsonRecord(renderedInput)
    ? renderedInput.canonical
    : undefined;
  return deepFreeze({
    completedAt: input.completedAt.toISOString(),
    context: input.context,
    ...(input.request.correlationId === undefined ? {} : { correlationId: input.request.correlationId }),
    diagnostics: [diagnostic(input.code, input.message)],
    events: [],
    id: input.id,
    input: canonical ?? renderedInput ?? {},
    kind: input.route.kind as RouteInvocationKind,
    manifestDigest: input.manifest.digest,
    projection: {},
    providers: providerProjection(input.manifest, 0, 'failed'),
    ...(input.request.requestId === undefined ? {} : { requestId: input.request.requestId }),
    routeId: input.route.id,
    source: input.route.source,
    sourceRevision: input.manifest.sourceRevision,
    startedAt: input.startedAt.toISOString(),
    status: 'failed',
    timings: [timing('render', input.startedAt, input.completedAt.getTime() - input.startedAt.getTime())],
  });
};

export class RouteInvocationService {
  readonly #controllers = new Set<AbortController>();
  readonly #history: InvocationRingBuffer;
  readonly #manifest: RouteManifestRouteService;
  readonly #now: () => Date;
  readonly #pending = new Set<Promise<RouteInvocation>>();
  readonly #prepared: () => RouteInvocationPreparedProject;
  readonly #registry: TargetRegistry;
  readonly #renderChild: NonNullable<RouteInvocationServiceOptions['renderChild']>;
  readonly #scripts: RouteInvocationScriptRunner | undefined;
  readonly #semaphore: InvocationSemaphore;
  readonly #timeoutMs: number;
  readonly #trace: TracePublisher | undefined;
  #closed = false;

  constructor(options: RouteInvocationServiceOptions) {
    this.#history = new InvocationRingBuffer(options.historyLimit);
    this.#manifest = options.manifest;
    this.#now = options.now ?? (() => new Date());
    this.#prepared = options.prepared;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#renderChild = options.renderChild ?? renderInChild;
    this.#scripts = options.scripts;
    this.#semaphore = new InvocationSemaphore(options.concurrency ?? defaultConcurrency);
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#trace = options.trace;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) throw new RangeError('Invocation timeout must be positive.');
  }

  list(limit?: number): readonly RouteInvocationSummary[] {
    return this.#history.list(limit);
  }

  read(id: string): RouteInvocation | undefined {
    return this.#history.read(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) {
      controller.abort(new DOMException('Route invocation service closed.', 'AbortError'));
    }
    await Promise.allSettled([...this.#pending]);
  }

  async invoke(request: RouteInvocationRequest): Promise<RouteInvocation> {
    let manifest: RouteManifest;
    let prepared: RouteInvocationPreparedProject;
    try {
      manifest = this.#manifest.manifest();
      prepared = this.#prepared();
    } catch (error) {
      if (error instanceof RouteInvocationRequestError) throw error;
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE,
        'No published build and route manifest are available.',
        409,
      );
    }
    const route = allManifestRoutes(manifest).find((candidate) => candidate.id === request.routeId);
    if (route === undefined || !invocationKinds.has(route.kind as RouteInvocationKind)) {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE,
        `Route ${JSON.stringify(request.routeId)} is not available for invocation.`,
        404,
      );
    }
    if (
      (request.event !== undefined && route.kind !== 'event-route')
      || (request.args !== undefined && route.kind !== 'cli')
    ) {
      return malformed();
    }
    const fixtureId = request.event?.fixtureId;
    const fixture = fixtureId === undefined
      ? undefined
      : prepared.fixtures?.[route.id]?.find((candidate) => candidate.id === fixtureId);
    if (fixtureId !== undefined && fixture === undefined) {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE,
        `Fixture ${JSON.stringify(fixtureId)} is not available for route ${JSON.stringify(route.id)}.`,
        400,
      );
    }
    const rawInput = request.input ?? fixture?.input ?? {};
    const input = route.kind === 'event-route'
      ? eventInput(route, rawInput, request.event?.host, this.#registry)
      : rawInput;
    const id = `inv_${this.#now().getTime().toString(36)}${randomBytes(8).toString('hex')}`;
    const startedAt = this.#now();
    const context = contextForRequest(route, prepared.manifest.projectRoot, request, rawInput, this.#registry);
    const correlation = traceCorrelation(request, context, id, prepared.artifact?.epochId);
    const href = routeHref(route.id, id);
    const label = routeLabel(route.kind as RouteInvocationKind, route.id, route.event, request.event?.host);
    this.#trace?.publish({
      correlation,
      details: { status: 'running' },
      ...(href === undefined ? {} : { href }),
      kind: 'invocation.started',
      occurredAt: startedAt.toISOString(),
      source: 'invocation',
      status: 'running',
      summary: `${label} · running`,
    });
    let eventOutcome: EventTracePreflightOutcome | undefined;
    let providersDurationMs = 0;
    const running = this.#semaphore.run<RouteInvocation>(async () => {
      const controller = new AbortController();
      this.#controllers.add(controller);
      if (this.#closed) {
        controller.abort(new DOMException('Route invocation service closed.', 'AbortError'));
      }
      const timeout = setTimeout(() => controller.abort(new DOMException('Route invocation timed out.', 'TimeoutError')), this.#timeoutMs);
      let child: RouteInvocationChildResult;
      const plainScript = plainScriptFor(prepared, route);
      const publishKernelEvent = (event: EventTraceEvent): void => {
        if (event.kind === 'preflight.outcome') eventOutcome = event.outcome;
        if (event.kind === 'providers.finish' && event.durationMs !== undefined) {
          providersDurationMs = event.durationMs;
        }
        this.#trace?.publish({
          correlation: {
            ...correlation,
            executionId: event.execution.executionId,
            host: event.execution.host,
          },
          details: kernelDetails(event),
          ...('durationMs' in event && event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(href === undefined ? {} : { href }),
          kind: `kernel.${event.kind}`,
          source: 'kernel',
          status: kernelStatus(event),
          summary: kernelSummary(event),
        });
      };
      try {
        child = plainScript === undefined
          ? await this.#renderChild({
            ...(request.args === undefined ? {} : { args: request.args }),
            context,
            input,
            manifest: prepared.manifest,
            routeId: route.id,
          }, controller.signal, publishKernelEvent)
          : await runPlainScript(this.#scripts, prepared, plainScript, input, controller.signal);
      } catch (error) {
        const completedAt = this.#now();
        return failedInvocation({
          code: ROUTE_INVOCATION_CHILD_FAILURE_CODE,
          completedAt,
          context,
          id,
          manifest,
          message: controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError'
            ? 'Route invocation child timed out.'
            : controller.signal.aborted
              ? 'Route invocation child stopped because the service closed.'
            : `${plainScript === undefined ? 'Route invocation child' : 'Script run'} failed: ${error instanceof Error ? error.message : String(error)}`,
          request: { ...request, input },
          route,
          startedAt,
        });
      } finally {
        clearTimeout(timeout);
        this.#controllers.delete(controller);
      }
      const projectionStartedAt = this.#now();
      const projection = invocationProjection(
        route,
        request,
        rawInput,
        child.result,
        child.mcp,
        child.document,
        manifest,
        prepared,
        this.#registry,
      );
      const completedAt = this.#now();
      const canonical = route.kind === 'event-route'
        ? (child.input as JsonObject).canonical
        : undefined;
      return deepFreeze<RouteInvocation>({
        completedAt: completedAt.toISOString(),
        context,
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        diagnostics: [],
        document: child.document,
        ...(canonical !== undefined && isJsonRecord(canonical)
          ? {
              event: {
                // Project events reject repeated object references. Keep the
                // event detail detached from the identical public `input`.
                canonical: jsonObject(canonical)!,
                event: route.event!,
                ...(request.event?.host === undefined ? {} : { host: request.event.host, native: rawInput as JsonObject }),
              },
            }
          : {}),
        events: child.events,
        id,
        input: canonical ?? child.input,
        kind: route.kind as RouteInvocationKind,
        manifestDigest: manifest.digest,
        projection,
        providers: providerProjection(manifest, 0, 'mounted'),
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        ...(child.result === undefined ? {} : { result: child.result }),
        routeId: route.id,
        source: route.source,
        sourceRevision: manifest.sourceRevision,
        startedAt: startedAt.toISOString(),
        status: 'succeeded',
        timings: [
          timing('providers', startedAt, providersDurationMs),
          ...manifest.providers.map((provider) => timing(`provider:${provider.name}`, startedAt, 0)),
          timing('handler', startedAt, 0),
          timing('render', startedAt, child.renderDurationMs),
          timing('projection', projectionStartedAt, completedAt.getTime() - projectionStartedAt.getTime()),
        ],
      });
    });
    this.#pending.add(running);
    let invocation: RouteInvocation;
    try {
      invocation = await running;
    } finally {
      this.#pending.delete(running);
    }
    this.#history.push(invocation);
    const durationMs = new Date(invocation.completedAt).getTime() - new Date(invocation.startedAt).getTime();
    this.#trace?.publish({
      correlation,
      details: invocationTraceDetails(invocation),
      durationMs,
      ...(href === undefined ? {} : { href }),
      kind: invocation.status === 'succeeded' ? 'invocation.completed' : 'invocation.failed',
      occurredAt: invocation.completedAt,
      source: 'invocation',
      status: invocation.status === 'succeeded' ? 'ok' : 'error',
      summary: invocation.status === 'succeeded'
        ? `${label} · ${route.kind === 'event-route' && eventOutcome !== undefined ? eventOutcome : durationText(durationMs)}`
        : `${label} · failed`,
    });
    return invocation;
  }
}
