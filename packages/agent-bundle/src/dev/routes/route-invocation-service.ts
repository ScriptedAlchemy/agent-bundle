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
import type { CanonicalAgentEvent } from '../../routes/public.ts';
import { taskkill, terminateProcessTree, waitForProcessTreeExit } from '../../services/process-tree.ts';
import type { AgentBundleTestManifest, TestableScriptDescriptor } from '../../test/manifest.ts';
import type { ScriptPlaygroundResult, ScriptPlaygroundRunRequest } from '../playground/script-playground-service.ts';
import type { RouteInvocation } from './route-invocation-result.ts';
import type {
  RouteInvocationEventHost,
  RouteInvocationKind,
  RouteInvocationProvider,
  RouteInvocationRequest,
  RouteInvocationSummary,
  RouteInvocationTiming,
} from './route-invocation.ts';
import type { RouteManifest, RouteManifestRoute } from './route-manifest.ts';
import type { RouteManifestRouteService } from './route-manifest-routes.ts';

export const ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE = 'AB8231';
export const ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE = 'AB8232';
export const ROUTE_INVOCATION_CHILD_FAILURE_CODE = 'AB8236';
export const ROUTE_INVOCATION_MALFORMED_REQUEST_CODE = 'AB8237';
export const ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE = 'AB8238';
export const ROUTE_INVOCATION_STALE_REVISION_CODE = 'AB8239';
export const ROUTE_INVOCATION_STALE_REVISION_MESSAGE =
  'The published route manifest changed while this invocation waited to run. Retry against the current revision.';

/** Writable state root generated entries mount for the npm-bin cwd fallback. */
export const routeInvocationStateRoot = (projectRoot: string): string =>
  join(projectRoot, '.agent-bundle', 'state');

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
  /**
   * Writable state directory generated entries mount for this project
   * (`<pluginRoot>/state`, never the code root).
   */
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
  readonly prepared: () =>
    | RouteInvocationPreparedLease
    | RouteInvocationPreparedProject
    | Promise<RouteInvocationPreparedLease | RouteInvocationPreparedProject>;
  readonly registry?: TargetRegistry;
  readonly renderChild?: (
    request: RouteInvocationChildRequest,
    signal: AbortSignal,
  ) => Promise<RouteInvocationChildResult>;
  readonly scripts?: RouteInvocationScriptRunner;
  readonly timeoutMs?: number;
}

export interface RouteInvocationChildRequest {
  readonly args?: readonly string[];
  readonly context: RequestContextProvenance;
  readonly input: JsonValue;
  readonly manifest: AgentBundleTestManifest;
  readonly routeId: string;
  readonly stateRoot: string;
}

export interface RouteInvocationChildResult {
  readonly document: NonNullable<RouteInvocation['document']>;
  readonly events: RouteInvocation['events'];
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
  readonly renderDurationMs: number;
  readonly result?: JsonValue;
}

export type RouteInvocationChildResponse =
  | Readonly<{ readonly result: RouteInvocationChildResult; readonly type: 'result' }>
  | Readonly<{
    readonly error: Readonly<{ readonly message: string; readonly name: string }>;
    readonly type: 'error';
  }>;

export class RouteInvocationRequestError extends Error {
  readonly code:
    | typeof ROUTE_INVOCATION_MALFORMED_REQUEST_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_FIXTURE_CODE
    | typeof ROUTE_INVOCATION_UNKNOWN_ROUTE_CODE
    | typeof ROUTE_INVOCATION_MANIFEST_UNAVAILABLE_CODE
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

const isPreparedLease = (
  value: RouteInvocationPreparedLease | RouteInvocationPreparedProject,
): value is RouteInvocationPreparedLease =>
  isRecord(value) && typeof value.release === 'function' && isRecord(value.project);

const bindPrepared = async (
  supplier: RouteInvocationServiceOptions['prepared'],
): Promise<RouteInvocationPreparedLease> => {
  const value = await supplier();
  return isPreparedLease(value) ? value : { project: value, release: () => undefined };
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
  if (!hasOnlyOwnKeys(value, ['args', 'correlationId', 'event', 'input', 'routeId'])) return malformed();
  const routeId = value.routeId;
  const correlationId = value.correlationId;
  const args = value.args;
  if (!boundedString(routeId)) return malformed();
  if (correlationId !== undefined && !boundedString(correlationId, 256)) return malformed();
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

const isChildResponse = (value: unknown): value is RouteInvocationChildResponse => {
  if (!isRecord(value)) return false;
  if (value.type === 'result') return isRecord(value.result);
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
    child.once('message', receive);
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
  timing('render', startedAt, child.renderDurationMs),
  timing('projection', projectionStartedAt, completedAt.getTime() - projectionStartedAt.getTime()),
]);

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
    providers: unobservedProviders(input.manifest),
    routeId: input.route.id,
    source: input.route.source,
    sourceRevision: input.manifest.sourceRevision,
    startedAt: input.startedAt.toISOString(),
    status: 'failed',
    timings: [timing('elapsed', input.startedAt, input.completedAt.getTime() - input.startedAt.getTime())],
  });
};

export class RouteInvocationService {
  readonly #controllers = new Set<AbortController>();
  readonly #history: InvocationRingBuffer;
  readonly #manifest: RouteManifestRouteService;
  readonly #now: () => Date;
  readonly #pending = new Set<Promise<RouteInvocation>>();
  readonly #prepared: RouteInvocationServiceOptions['prepared'];
  readonly #registry: TargetRegistry;
  readonly #renderChild: NonNullable<RouteInvocationServiceOptions['renderChild']>;
  readonly #scripts: RouteInvocationScriptRunner | undefined;
  readonly #semaphore: InvocationSemaphore;
  readonly #timeoutMs: number;
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
    const id = `inv_${this.#now().getTime().toString(36)}${randomBytes(8).toString('hex')}`;
    const startedAt = this.#now();
    const running = this.#semaphore.run<RouteInvocation>(async () => {
      let release: RouteInvocationPreparedLease['release'] | undefined;
      try {
        let manifest: RouteManifest;
        let prepared: RouteInvocationPreparedProject;
        try {
          const leased = await bindPrepared(this.#prepared);
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
        const context = contextFor(route, prepared.manifest.projectRoot, request.event?.host);
        const controller = new AbortController();
        this.#controllers.add(controller);
        if (this.#closed) {
          controller.abort(new DOMException('Route invocation service closed.', 'AbortError'));
        }
        const timeout = setTimeout(() => controller.abort(new DOMException('Route invocation timed out.', 'TimeoutError')), this.#timeoutMs);
        let child: RouteInvocationChildResult;
        const plainScript = plainScriptFor(prepared, route);
        try {
          child = plainScript === undefined
            ? await this.#renderChild({
              ...(request.args === undefined ? {} : { args: request.args }),
              context,
              input,
              manifest: prepared.manifest,
              routeId: route.id,
              stateRoot: prepared.stateRoot,
            }, controller.signal)
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
        providers: child.observed?.providers ?? unobservedProviders(manifest),
        ...(child.result === undefined ? {} : { result: child.result }),
        routeId: route.id,
        source: route.source,
        sourceRevision: manifest.sourceRevision,
        startedAt: startedAt.toISOString(),
        status: 'succeeded',
        timings: invocationTimings(child, startedAt, projectionStartedAt, completedAt),
      });
      } finally {
        await release?.();
      }
    });
    this.#pending.add(running);
    let invocation: RouteInvocation;
    try {
      invocation = await running;
    } finally {
      this.#pending.delete(running);
    }
    this.#history.push(invocation);
    return invocation;
  }
}
