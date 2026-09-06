import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentDocument, AgentDocumentNode, AgentRenderEvent } from '@agent-bundle/runtime';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import type { TargetHookContract } from '../../adapters/hook-contract.ts';
import { generatedRouteArtifactEpoch } from '../../build/entry-shell.ts';
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
import {
  isProductionRouteInvocationCode,
  ProductionRouteInvocationError,
} from './route-invocation-production-error.ts';
import {
  MAX_RETAINED_RENDER_EVENTS,
  type RouteInvocation,
  type RouteInvocationStart,
  type RouteInvocationStreamMessage,
} from './route-invocation-result.ts';
import { nativeEventRequestContext } from './route-invocation.ts';
import type {
  RouteInvocationEventHost,
  RouteInvocationKind,
  RouteInvocationOutcome,
  RouteInvocationProvider,
  RouteInvocationRequest,
  RunningRouteInvocation,
  RouteInvocationSurface,
  RouteInvocationSummary,
  RouteInvocationTiming,
} from './route-invocation.ts';
import type { RouteManifest, RouteManifestCliCommand, RouteManifestRoute } from './route-manifest.ts';
import type { RouteManifestRouteService } from './route-manifest-routes.ts';

export const ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE = 'AB8231';
export const ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE = 'AB8232';
export const ROUTE_INVOCATION_CHILD_FAILURE_CODE = 'AB8236';
export const ROUTE_INVOCATION_MALFORMED_REQUEST_CODE = 'AB8237';
export const ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE = 'AB8238';
export const ROUTE_INVOCATION_STALE_REVISION_CODE = 'AB8239';
export const ROUTE_INVOCATION_CLI_COMMAND_MISMATCH_CODE = 'AB8253';
export const ROUTE_INVOCATION_PROJECTED_CLI_ID_CODE = 'AB8254';
export const ROUTE_INVOCATION_EVENT_HOST_REQUIRED_CODE = 'AB8255';
export const ROUTE_INVOCATION_ALREADY_FINAL_CODE = 'AB8256';
export const ROUTE_INVOCATION_STALE_REVISION_MESSAGE =
  'The published route manifest changed while this invocation waited to run. Retry against the current revision.';

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
  /** Writable framework state (`devStateRoot`), shared with dev MCP sessions and never the code root. */
  readonly stateRoot: string;
  readonly targets: readonly RouteInvocationEventHost[];
}

export interface RouteInvocationPreparedLease {
  readonly project: RouteInvocationPreparedProject;
  readonly release: () => Promise<void> | void;
}

export interface RouteInvocationScriptRunner {
  run(request: ScriptPlaygroundRunRequest): Promise<ScriptPlaygroundResult>;
}

export interface RouteInvocationServiceOptions {
  readonly concurrency?: number;
  readonly historyLimit?: number;
  readonly manifest: RouteManifestRouteService;
  readonly now?: () => Date;
  readonly prepared: () => Promise<RouteInvocationPreparedLease>;
  readonly registry?: TargetRegistry;
  readonly renderChild?: (
    request: RouteInvocationChildRequest,
    signal: AbortSignal,
    publishKernelEvent: (event: EventTraceEvent) => void,
    publishRenderEvent: (event: AgentRenderEvent) => void,
  ) => Promise<RouteInvocationChildResult>;
  readonly scripts?: RouteInvocationScriptRunner;
  readonly timeoutMs?: number;
  readonly trace?: TracePublisher;
}

export interface RouteInvocationChildRequest {
  readonly artifactEpoch?: string;
  readonly artifactRoot?: string;
  readonly context: RequestContextProvenance;
  readonly input: JsonValue;
  readonly manifest: AgentBundleTestManifest;
  readonly routeId: string;
  readonly stateRoot: string;
  readonly surface: RouteInvocationSurface;
}

export interface RouteInvocationChildResult {
  readonly document: NonNullable<RouteInvocation['document']>;
  readonly events: RouteInvocation['events'];
  /**
   * Process surfaces only: the exit code the generated executable sets for
   * this completed run — a plain script's real exit status, the generated
   * bin's own decision for CLI surfaces, the rendered-script rule otherwise.
   */
  readonly exitCode?: number;
  /** The input handed to the route after hosted-event canonicalization. */
  readonly input: JsonValue;
  /** Runtime-owned MCP projection, computed inside the runtime-bound child. */
  readonly mcp?: JsonObject;
  /**
   * What the child actually measured. Absent for plain scripts and for
   * failures before the child reported measurements.
   */
  readonly observed?: {
    readonly providers: readonly RouteInvocationProvider[];
    readonly timings: readonly RouteInvocationTiming[];
  };
  readonly renderDurationMs?: number;
  readonly result?: JsonValue;
  readonly trace?: readonly EventTraceEvent[];
}

export type RouteInvocationChildResponse =
  | Readonly<{ readonly result: RouteInvocationChildResult; readonly type: 'result' }>
  | Readonly<{ readonly event: AgentRenderEvent; readonly type: 'render' }>
  | Readonly<{ readonly event: EventTraceEvent; readonly type: 'trace' }>
  | Readonly<{
    readonly error: Readonly<{ readonly code?: string; readonly message: string; readonly name: string }>;
    readonly type: 'error';
  }>;

export class RouteInvocationRequestError extends Error {
  readonly code:
    | typeof ROUTE_INVOCATION_MALFORMED_REQUEST_CODE
    | typeof ROUTE_INVOCATION_CLI_COMMAND_MISMATCH_CODE
    | typeof ROUTE_INVOCATION_EVENT_HOST_REQUIRED_CODE
    | typeof ROUTE_INVOCATION_PROJECTED_CLI_ID_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE
    | typeof ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE
    | typeof ROUTE_INVOCATION_ALREADY_FINAL_CODE
    | typeof ROUTE_INVOCATION_STALE_REVISION_CODE;
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

const surfaceOptions = (value: unknown): RouteInvocationSurface => {
  if (!isRecord(value) || !boundedString(value.kind, 32)) return malformed();
  switch (value.kind) {
    case 'mcp':
    case 'script':
    case 'unit-render':
      if (!hasOnlyOwnKeys(value, ['kind'])) return malformed();
      return Object.freeze({ kind: value.kind });
    case 'cli': {
      if (!hasOnlyOwnKeys(value, ['args', 'command', 'kind'])) return malformed();
      if (!boundedString(value.command)) return malformed();
      if (
        !Array.isArray(value.args)
        || value.args.length > 1_024
        || value.args.some((argument) => !boundedString(argument, 16_384))
      ) return malformed();
      return Object.freeze({ args: [...value.args] as readonly string[], command: value.command, kind: 'cli' });
    }
    case 'event': {
      if (!hasOnlyOwnKeys(value, ['fixtureId', 'host', 'kind'])) return malformed();
      const fixtureId = value.fixtureId;
      const host = value.host;
      if (fixtureId !== undefined && !boundedString(fixtureId)) return malformed();
      if (host !== undefined && (typeof host !== 'string' || !concreteHosts.has(host as RouteInvocationEventHost))) {
        return malformed();
      }
      return Object.freeze({
        ...(fixtureId === undefined ? {} : { fixtureId }),
        ...(host === undefined ? {} : { host: host as RouteInvocationEventHost }),
        kind: 'event',
      });
    }
    default:
      return malformed();
  }
};

/** Strict wire decoder used by both the HTTP boundary and unit callers. */
export const parseRouteInvocationRequest = (
  value: Readonly<Record<string, unknown>>,
): RouteInvocationRequest => {
  if (!hasOnlyOwnKeys(value, ['correlationId', 'input', 'routeId', 'surface'])) return malformed();
  const routeId = value.routeId;
  const correlationId = value.correlationId;
  if (!boundedString(routeId)) return malformed();
  if (correlationId !== undefined && !boundedString(correlationId, 256)) return malformed();
  let input: JsonValue | undefined;
  if (Object.hasOwn(value, 'input')) {
    try {
      input = snapshotStrictJsonValue(value.input);
    } catch {
      return malformed();
    }
  }
  const surface = value.surface === undefined ? undefined : surfaceOptions(value.surface);
  return deepFreeze({
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(input === undefined ? {} : { input }),
    routeId,
    ...(surface === undefined ? {} : { surface }),
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
    trace: _trace,
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

  async #execute<T>(operation: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#active < this.#limit) return this.#execute(operation);
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const start = (): void => {
        signal?.removeEventListener('abort', abort);
        void this.#execute(operation).then(resolvePromise, rejectPromise);
      };
      const abort = (): void => {
        const index = this.#waiting.indexOf(start);
        if (index !== -1) this.#waiting.splice(index, 1);
        rejectPromise(signal?.reason);
      };
      this.#waiting.push(start);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

const allManifestRoutes = (manifest: RouteManifest): readonly RouteManifestRoute[] => Object.freeze([
  ...manifest.servers.flatMap((server) => server.routes),
  ...(manifest.cli?.routes ?? []),
  ...manifest.events,
  ...manifest.scripts,
]);

const commandName = (command: RouteManifestCliCommand): string => command.path.join(' ');

const projectedCommandForCliId = (
  manifest: RouteManifest,
  routeId: string,
): RouteManifestCliCommand | undefined => {
  if (!routeId.startsWith('cli:')) return undefined;
  const path = routeId.slice('cli:'.length);
  return manifest.cli?.commands?.find((command) =>
    command.projection !== undefined
    && command.routeId.startsWith('tool:')
    && command.path.join('/') === path);
};

const defaultSurface = (
  route: RouteManifestRoute,
  manifest: RouteManifest,
): RouteInvocationSurface => {
  switch (route.kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
      return Object.freeze({ kind: 'mcp' });
    case 'event-route':
      return Object.freeze({ kind: 'event' });
    case 'script':
      return Object.freeze({ kind: 'script' });
    case 'cli': {
      const command = manifest.cli?.commands?.find((candidate) => candidate.routeId === route.id);
      if (command === undefined) return malformed();
      return Object.freeze({ args: Object.freeze([]), command: commandName(command), kind: 'cli' });
    }
    case 'app':
      return malformed();
    default: {
      const exhaustive: never = route.kind;
      return exhaustive;
    }
  }
};

const resolvedSurface = (
  route: RouteManifestRoute,
  requested: RouteInvocationSurface | undefined,
  manifest: RouteManifest,
): RouteInvocationSurface => {
  const surface = requested ?? defaultSurface(route, manifest);
  switch (surface.kind) {
    case 'mcp':
      if (route.kind !== 'tool' && route.kind !== 'resource' && route.kind !== 'prompt') return malformed();
      return surface;
    case 'event':
      if (route.kind !== 'event-route') return malformed();
      if (route.execution?.preflight !== undefined && surface.host === undefined) {
        throw new RouteInvocationRequestError(
          ROUTE_INVOCATION_EVENT_HOST_REQUIRED_CODE,
          `Event route ${JSON.stringify(route.id)} has compiled preflight; select an event host surface with a concrete host.`,
          400,
        );
      }
      return surface;
    case 'script':
      if (route.kind !== 'script') return malformed();
      return surface;
    case 'unit-render':
      if (route.kind === 'script') return malformed();
      return surface;
    case 'cli': {
      if (route.kind !== 'cli' && route.kind !== 'tool') return malformed();
      const command = manifest.cli?.commands?.find((candidate) =>
        candidate.routeId === route.id
        && commandName(candidate) === surface.command
        && (route.kind === 'cli' || candidate.projection !== undefined));
      if (command === undefined) {
        throw new RouteInvocationRequestError(
          ROUTE_INVOCATION_CLI_COMMAND_MISMATCH_CODE,
          `CLI command ${JSON.stringify(surface.command)} does not project onto canonical operation ${JSON.stringify(route.id)}.`,
          400,
        );
      }
      return surface;
    }
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
};

const diagnostic = (code: string, message: string): Diagnostic =>
  Object.freeze({ code, message, severity: 'error' });

const unavailable = <Value>(
  reason: RequestProvenanceUnavailableReason,
): RequestProvenanceAxis<Value> =>
  Object.freeze({ reason, state: 'unavailable' });

const contextFor = (
  route: RouteManifestRoute,
  root: string,
  surface: RouteInvocationSurface,
): RequestContextProvenance => deepFreeze({
  actor: unavailable('not-provided'),
  host: surface.kind !== 'event' || surface.host === undefined
    ? unavailable('host-omitted')
    : { source: 'derived', state: 'available', value: { name: surface.host } },
  invocation: {
    kind: route.kind === 'event-route'
      ? 'event'
      : route.kind === 'cli'
        ? 'cli'
        : route.kind === 'script'
          ? 'script'
          : 'tool',
    operationId: route.id,
    surface: surface.kind === 'cli'
      ? surface.command
      : surface.kind === 'event'
        ? route.event
        : surface.kind,
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
    exitCode: run.exitCode,
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
  ) return false;
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
  if (value.type === 'render') {
    return isRecord(value.event)
      && typeof value.event.type === 'string'
      && ['complete', 'error', 'progress', 'replace', 'shell'].includes(value.event.type);
  }
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
  publishRenderEvent: (event: AgentRenderEvent) => void,
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
      if (message.type === 'render') {
        publishRenderEvent(message.event);
        return;
      }
      if (message.type === 'error') {
        const error = isProductionRouteInvocationCode(message.error.code)
          ? new ProductionRouteInvocationError(message.error.code, message.error.message)
          : Object.assign(new Error(message.error.message), { name: message.error.name });
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
  surface: RouteInvocationSurface,
  nativeInput: JsonValue,
  registry: TargetRegistry,
): RequestContextProvenance => {
  const host = surface.kind === 'event' ? surface.host : undefined;
  if (route.kind !== 'event-route' || host === undefined || !isJsonRecord(nativeInput)) {
    return contextFor(route, root, surface);
  }
  const mapped = eventContract(registry, host, route.event as CanonicalAgentEvent);
  if (mapped === undefined) return contextFor(route, root, surface);
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
  ...(context.lineage.state === 'available' ? { conversationId: context.lineage.value.conversation } : {}),
  ...(epochId === undefined ? {} : { epochId }),
  ...(context.host.state === 'available' ? { host: context.host.value.name } : {}),
  invocationId,
  routeId: request.routeId,
  ...(context.session.state === 'available' ? { sessionId: context.session.value.sessionId } : {}),
});

const projectionKind = (projection: RouteInvocation['projection']): 'cli' | 'hosts' | 'mcp' | 'none' => {
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

const timing = (phase: string, startedAt: Date, durationMs: number): RouteInvocationTiming =>
  Object.freeze({ durationMs, phase, startedAt: startedAt.toISOString() });

const isChildObservedTiming = (phase: string): boolean =>
  phase === 'handler' || phase === 'providers' || phase.startsWith('provider:');

const unobservedProviders = (manifest: RouteManifest): readonly RouteInvocationProvider[] =>
  Object.freeze(manifest.providers.map((provider) => Object.freeze({
    id: provider.id,
    name: provider.name,
    status: 'unobserved' as const,
  })));

const invocationTimings = (
  child: RouteInvocationChildResult,
  startedAt: Date,
  projectionStartedAt: Date,
  completedAt: Date,
): readonly RouteInvocationTiming[] => Object.freeze([
  ...(child.observed?.timings.filter((entry) => isChildObservedTiming(entry.phase)) ?? []),
  ...(child.renderDurationMs === undefined ? [] : [timing('render', startedAt, child.renderDurationMs)]),
  timing('projection', projectionStartedAt, completedAt.getTime() - projectionStartedAt.getTime()),
]);

const jsonObject = (value: unknown): JsonObject | undefined => {
  if (value === undefined) return undefined;
  const snapshot = snapshotStrictJsonValue(value);
  return isJsonRecord(snapshot) ? snapshot : undefined;
};

const appendErrorSummaries = (node: AgentDocumentNode, summaries: string[]): void => {
  switch (node.kind) {
    case 'result':
      for (const child of node.children) appendErrorSummaries(child, summaries);
      break;
    case 'error':
      summaries.push(`[${node.code}] ${node.message}`);
      break;
    case 'audio':
    case 'context':
    case 'image':
    case 'json':
    case 'markdown':
    case 'progress':
    case 'resource':
    case 'text':
      break;
    default: {
      const exhaustive: never = node;
      throw new Error(`Unsupported Agent Document node ${String((exhaustive as { kind?: unknown }).kind)}.`);
    }
  }
};

/** The `Agent.Error` nodes of a represented-error document, as the MCP projection prints them. */
const documentErrorSummary = (document: AgentDocument): string => {
  const summaries: string[] = [];
  appendErrorSummaries(document.root, summaries);
  return summaries.length === 0 ? `The document reports status ${document.status}.` : summaries.join('; ');
};

/**
 * What the completed run meant, judged by the surface it ran through. A
 * process surface reports the exit code its executable decided (`exitCode` is
 * only ever set by one); an MCP surface reports a projected `isError`; an
 * event surface reports an error document or a `deny` decision.
 */
const invocationOutcome = (
  route: RouteManifestRoute,
  child: RouteInvocationChildResult,
): RouteInvocationOutcome => {
  if (child.exitCode !== undefined) {
    return child.exitCode === 0 ? { kind: 'success' } : { exitCode: child.exitCode, kind: 'process-exit' };
  }
  if (child.mcp?.isError === true || child.document.status !== 'success') {
    return { kind: 'represented-error', summary: documentErrorSummary(child.document) };
  }
  const decision: unknown = child.result ?? child.document.value;
  if (route.kind === 'event-route' && isRecord(decision) && decision.outcome === 'deny') {
    return {
      kind: 'represented-error',
      summary: typeof decision.reason === 'string' ? `deny: ${decision.reason}` : 'deny',
    };
  }
  return { kind: 'success' };
};

const unitRenderProjectionKind = (route: RouteManifestRoute): RouteInvocationSurface['kind'] => {
  switch (route.kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
      return 'mcp';
    case 'event-route':
      return 'event';
    case 'cli':
      return 'cli';
    case 'script':
      return 'script';
    case 'app':
      return 'unit-render';
    default: {
      const exhaustive: never = route.kind;
      return exhaustive;
    }
  }
};

const invocationProjection = (
  route: RouteManifestRoute,
  requested: RouteInvocationSurface,
  input: JsonValue,
  child: RouteInvocationChildResult,
  prepared: RouteInvocationPreparedProject,
  registry: TargetRegistry,
): RouteInvocation['projection'] => {
  const { document, mcp, result } = child;
  // An isolated render is projected the way the route's default surface would be.
  const kind = requested.kind === 'unit-render' ? unitRenderProjectionKind(route) : requested.kind;
  const host = requested.kind === 'event' ? requested.host : undefined;
  if (kind === 'mcp') {
    if (route.kind === 'tool') {
      if (mcp === undefined) throw new Error('Route invocation child omitted the tool MCP projection.');
      return deepFreeze({ mcp });
    }
    return deepFreeze({ ...(jsonObject(result) === undefined ? {} : { mcp: jsonObject(result) }) });
  }
  if (kind === 'cli' || kind === 'script') {
    // The exit code is the executable's own: a plain script's process status,
    // the generated bin's decision, or the rendered-script rule the child applied.
    if (child.exitCode === undefined) throw new Error('Route invocation child omitted the process exit code.');
    return deepFreeze({
      cli: {
        exitCode: child.exitCode,
        ...(result === undefined ? {} : { json: result }),
        text: projectCliDocumentToMarkdown(document),
      },
    });
  }
  if (kind === 'event') {
    const selected = host === undefined ? prepared.targets : [host];
    const hosts = selected.map((target) => {
      const mapped = eventContract(registry, target, route.event as CanonicalAgentEvent);
      if (mapped === undefined) {
        return {
          diagnostics: [diagnostic(
            'route.invocation.projection.unsupported',
            `Event ${JSON.stringify(route.event)} cannot be projected to ${target}.`,
          )],
          host: target,
        };
      }
      try {
        const native = projectEventDocument(
          document,
          route.event as CanonicalAgentEvent,
          target,
          mapped.nativeEvent,
          host === target && isJsonRecord(input) ? input : undefined,
        );
        return { diagnostics: [], host: target, ...(native === undefined ? {} : { native: jsonObject(native) }) };
      } catch (error) {
        return {
          diagnostics: [diagnostic(
            'route.invocation.projection.failed',
            error instanceof Error ? error.message : String(error),
          )],
          host: target,
        };
      }
    });
    return deepFreeze({ hosts });
  }
  // An `app` route rendered in isolation has no host projection.
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
  readonly surface: RouteInvocationSurface;
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
    providers: unobservedProviders(input.manifest),
    routeId: input.route.id,
    source: input.route.source,
    sourceRevision: input.manifest.sourceRevision,
    startedAt: input.startedAt.toISOString(),
    status: 'failed',
    surface: input.surface,
    timings: [timing('elapsed', input.startedAt, input.completedAt.getTime() - input.startedAt.getTime())],
  });
};

interface InvocationStreamRecord {
  readonly controller: AbortController;
  readonly listeners: Set<(message: RouteInvocationStreamMessage) => void>;
  readonly messages: RouteInvocationStreamMessage[];
  readonly running: RunningRouteInvocation;
  cancelRequested: boolean;
  final?: RouteInvocation;
  result?: Promise<RouteInvocation>;
}

const latestDocument = (
  messages: readonly RouteInvocationStreamMessage[],
): AgentDocument | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== 'render') continue;
    if (message.event.type === 'shell' || message.event.type === 'replace' || message.event.type === 'complete') {
      return message.event.document;
    }
  }
  return undefined;
};

const cancelledInvocation = (input: {
  readonly context: RequestContextProvenance;
  readonly id: string;
  readonly manifest: RouteManifest;
  readonly messages: readonly RouteInvocationStreamMessage[];
  readonly request: RouteInvocationRequest;
  readonly route: RouteManifestRoute;
  readonly startedAt: Date;
  readonly surface: RouteInvocationSurface;
  readonly completedAt: Date;
}): RouteInvocation => {
  const events = input.messages.flatMap((message) => message.type === 'render' ? [message.event] : []);
  const document = latestDocument(input.messages);
  return deepFreeze({
    completedAt: input.completedAt.toISOString(),
    context: input.context,
    ...(input.request.correlationId === undefined ? {} : { correlationId: input.request.correlationId }),
    diagnostics: [],
    ...(document === undefined ? {} : { document }),
    events,
    id: input.id,
    input: input.request.input ?? {},
    kind: input.route.kind as RouteInvocationKind,
    manifestDigest: input.manifest.digest,
    projection: {},
    providers: unobservedProviders(input.manifest),
    routeId: input.route.id,
    source: input.route.source,
    sourceRevision: input.manifest.sourceRevision,
    startedAt: input.startedAt.toISOString(),
    status: 'cancelled',
    surface: input.surface,
    timings: [timing('elapsed', input.startedAt, input.completedAt.getTime() - input.startedAt.getTime())],
  });
};

export class RouteInvocationService {
  readonly #completedStreams: string[] = [];
  readonly #controllers = new Set<AbortController>();
  readonly #history: InvocationRingBuffer;
  readonly #historyLimit: number;
  readonly #streams = new Map<string, InvocationStreamRecord>();
  readonly #manifest: RouteManifestRouteService;
  readonly #now: () => Date;
  readonly #pending = new Set<Promise<RouteInvocation>>();
  readonly #prepared: RouteInvocationServiceOptions['prepared'];
  readonly #registry: TargetRegistry;
  readonly #renderChild: NonNullable<RouteInvocationServiceOptions['renderChild']>;
  readonly #scripts: RouteInvocationScriptRunner | undefined;
  readonly #semaphore: InvocationSemaphore;
  readonly #timeoutMs: number;
  readonly #trace: TracePublisher | undefined;
  readonly #closeController = new AbortController();

  constructor(options: RouteInvocationServiceOptions) {
    this.#historyLimit = options.historyLimit ?? defaultHistoryLimit;
    this.#history = new InvocationRingBuffer(this.#historyLimit);
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

  subscribe(id: string, listener: (message: RouteInvocationStreamMessage) => void): () => void {
    const record = this.#streams.get(id);
    if (record === undefined) {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE,
        `Route invocation ${JSON.stringify(id)} was not found.`,
        404,
      );
    }
    for (const message of record.messages) listener(message);
    if (record.final === undefined) record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  async cancel(id: string): Promise<RouteInvocation> {
    const record = this.#streams.get(id);
    if (record === undefined) {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE,
        `Route invocation ${JSON.stringify(id)} was not found.`,
        404,
      );
    }
    if (record.final !== undefined) {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_ALREADY_FINAL_CODE,
        `Route invocation ${JSON.stringify(id)} is already final.`,
        409,
      );
    }
    record.cancelRequested = true;
    record.controller.abort(new DOMException('Route invocation cancelled by the operator.', 'AbortError'));
    const invocation = await record.result!;
    if (invocation.status !== 'cancelled') {
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_ALREADY_FINAL_CODE,
        `Route invocation ${JSON.stringify(id)} is already final.`,
        409,
      );
    }
    return invocation;
  }

  #publishStream(record: InvocationStreamRecord, message: RouteInvocationStreamMessage): void {
    if (message.type === 'render') {
      const renderCount = record.messages.reduce((count, retained) =>
        count + (retained.type === 'render' ? 1 : 0), 0);
      if (renderCount === MAX_RETAINED_RENDER_EVENTS) {
        const oldest = record.messages.findIndex((retained) => retained.type === 'render');
        if (oldest !== -1) record.messages.splice(oldest, 1);
        const markerIndex = record.messages.findIndex((retained) => retained.type === 'truncated');
        if (markerIndex === -1) {
          const marker = deepFreeze<RouteInvocationStreamMessage>({ type: 'truncated' });
          record.messages.unshift(marker);
          for (const listener of record.listeners) listener(marker);
        }
      }
    }
    const frozen = deepFreeze(message);
    record.messages.push(frozen);
    for (const listener of record.listeners) listener(frozen);
  }

  async close(): Promise<void> {
    this.#closeController.abort(new DOMException('Route invocation service closed.', 'AbortError'));
    for (const controller of this.#controllers) {
      controller.abort(new DOMException('Route invocation service closed.', 'AbortError'));
    }
    await Promise.allSettled([...this.#pending]);
  }

  invoke(
    request: RouteInvocationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<RouteInvocation> {
    try {
      return this.#start(request, options, false).result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  start(
    request: RouteInvocationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): RouteInvocationStart {
    return this.#start(request, options, true);
  }

  #start(
    request: RouteInvocationRequest,
    options: Readonly<{ readonly signal?: AbortSignal }>,
    terminalErrors: boolean,
  ): RouteInvocationStart {
    let queued: RouteManifest;
    try {
      queued = this.#manifest.manifest();
    } catch (error) {
      if (error instanceof RouteInvocationRequestError) throw error;
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE,
        'No published build and route manifest are available.',
        409,
      );
    }
    const route = allManifestRoutes(queued).find((candidate) => candidate.id === request.routeId);
    if (route === undefined || !invocationKinds.has(route.kind as RouteInvocationKind)) {
      const projected = projectedCommandForCliId(queued, request.routeId);
      if (projected !== undefined) {
        const command = commandName(projected);
        throw new RouteInvocationRequestError(
          ROUTE_INVOCATION_PROJECTED_CLI_ID_CODE,
          `CLI operation ${JSON.stringify(request.routeId)} is a projection of canonical operation ${JSON.stringify(projected.routeId)}; invoke that route with surface ${JSON.stringify({ kind: 'cli', command, args: [] })}.`,
          400,
        );
      }
      throw new RouteInvocationRequestError(
        ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE,
        `Route ${JSON.stringify(request.routeId)} is not available for invocation.`,
        404,
      );
    }
    const surface = resolvedSurface(route, request.surface, queued);
    const id = `inv_${this.#now().getTime().toString(36)}${randomBytes(8).toString('hex')}`;
    const startedAt = this.#now();
    const operationController = new AbortController();
    const runningInvocation: RunningRouteInvocation = deepFreeze({
      id,
      routeId: route.id,
      startedAt: startedAt.toISOString(),
      status: 'running',
      surface,
    });
    const streamRecord: InvocationStreamRecord = {
      cancelRequested: false,
      controller: operationController,
      listeners: new Set(),
      messages: [],
      running: runningInvocation,
    };
    this.#streams.set(id, streamRecord);
    this.#controllers.add(operationController);
    let traceMeta: Readonly<{
      readonly correlation: TraceCorrelation;
      readonly eventOutcome: () => EventTracePreflightOutcome | undefined;
      readonly href?: string;
      readonly label: string;
    }> | undefined;
    let cancellationContext = deepFreeze({
      ...contextFor(route, '', surface),
      workspace: unavailable<Readonly<{ readonly root: string }>>('not-provided'),
    });
    const admissionSignal = AbortSignal.any([
      this.#closeController.signal,
      operationController.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    const running = this.#semaphore.run<RouteInvocation>(async () => {
      admissionSignal.throwIfAborted();
      let release: RouteInvocationPreparedLease['release'] | undefined;
      try {
        let manifest: RouteManifest;
        let prepared: RouteInvocationPreparedProject;
        try {
          const leased = await this.#prepared();
          release = leased.release;
          prepared = leased.project;
          manifest = this.#manifest.manifest();
        } catch (error) {
          if (error instanceof RouteInvocationRequestError) throw error;
          throw new RouteInvocationRequestError(
            ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE,
            'No published build and route manifest are available.',
            409,
          );
        }
        if (manifest.digest !== queued.digest || manifest.sourceRevision !== queued.sourceRevision) {
          throw new RouteInvocationRequestError(
            ROUTE_INVOCATION_STALE_REVISION_CODE,
            ROUTE_INVOCATION_STALE_REVISION_MESSAGE,
            409,
          );
        }
        const fixtureId = surface.kind === 'event' ? surface.fixtureId : undefined;
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
          ? eventInput(route, rawInput, surface.kind === 'event' ? surface.host : undefined, this.#registry)
          : rawInput;
        const context = contextForRequest(route, prepared.manifest.projectRoot, surface, rawInput, this.#registry);
        cancellationContext = context;
        const correlation = traceCorrelation(request, context, id, prepared.artifact?.epochId);
        const href = routeHref(route.id, id);
        const label = routeLabel(
          route.kind as RouteInvocationKind,
          route.id,
          route.event,
          surface.kind === 'event' ? surface.host : undefined,
        );
        let eventOutcome: EventTracePreflightOutcome | undefined;
        traceMeta = {
          correlation,
          eventOutcome: () => eventOutcome,
          ...(href === undefined ? {} : { href }),
          label,
        };
        admissionSignal.throwIfAborted();
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
        const publishKernelEvent = (event: EventTraceEvent): void => {
          if (event.kind === 'preflight.outcome') eventOutcome = event.outcome;
          this.#publishStream(streamRecord, { event, type: 'trace' });
          this.#trace?.publish({
            correlation: {
              ...correlation,
              executionId: event.execution.executionId,
              host: event.execution.host,
            },
            details: kernelDetails(event),
            ...('durationMs' in event && event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(href === undefined ? {} : { href }),
            kind: `kernel.${event.kind}`,
            source: 'kernel',
            status: kernelStatus(event),
            summary: kernelSummary(event),
          });
        };
        const controller = new AbortController();
        const abort = (): void => controller.abort(admissionSignal.reason);
        this.#controllers.add(controller);
        admissionSignal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => controller.abort(new DOMException('Route invocation timed out.', 'TimeoutError')), this.#timeoutMs);
        let child: RouteInvocationChildResult;
        const plainScript = plainScriptFor(prepared, route);
        try {
          child = plainScript === undefined
            ? await this.#renderChild({
              ...(prepared.artifact === undefined
                ? {}
                : {
                    artifactEpoch: generatedRouteArtifactEpoch(prepared.manifest.plugin),
                    artifactRoot: join(prepared.manifest.projectRoot, '.agent-bundle', 'epochs', prepared.artifact.epochId),
                  }),
              context,
              input,
              manifest: prepared.manifest,
              routeId: route.id,
              stateRoot: prepared.stateRoot,
              surface,
            }, controller.signal, publishKernelEvent, (event) => {
              this.#publishStream(streamRecord, { event, type: 'render' });
            })
            : await runPlainScript(this.#scripts, prepared, plainScript, input, controller.signal);
        } catch (error) {
          const completedAt = this.#now();
          if (streamRecord.cancelRequested) {
            return cancelledInvocation({
              completedAt,
              context,
              id,
              manifest,
              messages: streamRecord.messages,
              request: { ...request, input },
              route,
              startedAt,
              surface,
            });
          }
          const childCode = error instanceof ProductionRouteInvocationError
            ? error.code
            : ROUTE_INVOCATION_CHILD_FAILURE_CODE;
          return failedInvocation({
            code: childCode,
            completedAt,
            context,
            id,
            manifest,
            message: controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError'
              ? 'Route invocation child timed out.'
              : options.signal?.aborted === true
                ? 'Route invocation child stopped because the request was cancelled.'
              : controller.signal.aborted
                ? 'Route invocation child stopped because the service closed.'
              : `${plainScript === undefined ? 'Route invocation child' : 'Script run'} failed: ${error instanceof Error ? error.message : String(error)}`,
            request: { ...request, input },
            route,
            startedAt,
            surface,
          });
        } finally {
          clearTimeout(timeout);
          admissionSignal.removeEventListener('abort', abort);
          this.#controllers.delete(controller);
        }
        const projectionStartedAt = this.#now();
        const projection = invocationProjection(route, surface, rawInput, child, prepared, this.#registry);
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
                  ...(surface.kind !== 'event' || surface.host === undefined
                    ? {}
                    : { host: surface.host, native: rawInput as JsonObject }),
                },
              }
            : {}),
          events: child.events.slice(-MAX_RETAINED_RENDER_EVENTS),
          id,
          input: canonical ?? child.input,
          kind: route.kind as RouteInvocationKind,
          manifestDigest: manifest.digest,
          outcome: invocationOutcome(route, child),
          projection,
          providers: child.observed?.providers ?? unobservedProviders(manifest),
          ...(child.result === undefined ? {} : { result: child.result }),
          routeId: route.id,
          source: route.source,
          sourceRevision: manifest.sourceRevision,
          startedAt: startedAt.toISOString(),
          status: 'succeeded',
          surface,
          ...(child.trace === undefined ? {} : { trace: child.trace }),
          timings: invocationTimings(child, startedAt, projectionStartedAt, completedAt),
        });
      } finally {
        await release?.();
      }
    }, admissionSignal).catch((error: unknown) => {
      const completedAt = this.#now();
      if (streamRecord.cancelRequested) {
        return cancelledInvocation({
          completedAt,
          context: cancellationContext,
          id,
          manifest: queued,
          messages: streamRecord.messages,
          request,
          route,
          startedAt,
          surface,
        });
      }
      if (!terminalErrors) {
        this.#streams.delete(id);
        throw error;
      }
      return failedInvocation({
        code: error instanceof RouteInvocationRequestError ? error.code : ROUTE_INVOCATION_CHILD_FAILURE_CODE,
        completedAt,
        context: cancellationContext,
        id,
        manifest: queued,
        message: error instanceof Error ? error.message : String(error),
        request,
        route,
        startedAt,
        surface,
      });
    });
    this.#pending.add(running);
    const result = (async (): Promise<RouteInvocation> => {
      let invocation: RouteInvocation;
      try {
        invocation = await running;
      } finally {
        this.#pending.delete(running);
        this.#controllers.delete(operationController);
      }
      this.#history.push(invocation);
      streamRecord.final = invocation;
      this.#publishStream(streamRecord, { invocation, type: 'final' });
      streamRecord.listeners.clear();
      this.#completedStreams.push(id);
      while (this.#completedStreams.length > this.#historyLimit) {
        const expired = this.#completedStreams.shift();
        if (expired !== undefined) this.#streams.delete(expired);
      }
      const completedTrace = traceMeta ?? {
        correlation: traceCorrelation(request, cancellationContext, id, undefined),
        eventOutcome: () => undefined,
        href: routeHref(route.id, id),
        label: routeLabel(
          route.kind as RouteInvocationKind,
          route.id,
          route.event,
          surface.kind === 'event' ? surface.host : undefined,
        ),
      };
      const durationMs = new Date(invocation.completedAt).getTime() - new Date(invocation.startedAt).getTime();
      const kind = invocation.status === 'succeeded'
        ? 'invocation.completed'
        : invocation.status === 'cancelled'
          ? 'invocation.cancelled'
          : 'invocation.failed';
      this.#trace?.publish({
        correlation: completedTrace.correlation,
        details: invocationTraceDetails(invocation),
        durationMs,
        ...(completedTrace.href === undefined ? {} : { href: completedTrace.href }),
        kind,
        occurredAt: invocation.completedAt,
        source: 'invocation',
        status: invocation.status === 'succeeded' ? 'ok' : 'error',
        summary: invocation.status === 'succeeded'
          ? `${completedTrace.label} · ${route.kind === 'event-route' && completedTrace.eventOutcome() !== undefined
            ? completedTrace.eventOutcome()
            : durationText(durationMs)}`
          : `${completedTrace.label} · ${invocation.status}`,
      });
      return invocation;
    })();
    streamRecord.result = result;
    return Object.freeze({ invocation: runningInvocation, result });
  }
}
