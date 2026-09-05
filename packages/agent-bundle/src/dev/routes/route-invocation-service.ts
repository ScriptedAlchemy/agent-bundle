import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { documentToCallToolResult } from '@agent-bundle/runtime';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import type { TargetHookContract } from '../../adapters/hook-contract.ts';
import { projectCliDocumentToMarkdown } from '../../cli-entry.ts';
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
import type { AgentBundleTestManifest } from '../../test/manifest.ts';
import type {
  RouteInvocation,
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

const defaultHistoryLimit = 200;
const defaultTimeoutMs = 60_000;
const defaultConcurrency = 2;
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
  readonly fixtures?: Readonly<Record<string, readonly RouteInvocationFixture[]>>;
  readonly manifest: AgentBundleTestManifest;
  readonly targets: readonly RouteInvocationEventHost[];
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
  ) => Promise<RouteInvocationChildResult>;
  readonly timeoutMs?: number;
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

const isChildResponse = (value: unknown): value is RouteInvocationChildResponse => {
  if (!isRecord(value)) return false;
  if (value.type === 'result') return isRecord(value.result);
  return value.type === 'error' && isRecord(value.error)
    && typeof value.error.name === 'string' && typeof value.error.message === 'string';
};

const renderInChild = (
  request: RouteInvocationChildRequest,
  signal: AbortSignal,
): Promise<RouteInvocationChildResult> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  const executable = childPath();
  const jitiRegister = join(dirname(createRequire(import.meta.url).resolve('jiti/package.json')), 'lib', 'jiti-register.mjs');
  const child = fork(executable, [], {
    cwd: request.manifest.projectRoot,
    execArgv: ['--conditions=react-server', ...(executable.endsWith('.ts') ? ['--import', jitiRegister] : [])],
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort);
      child.removeListener('error', fail);
      child.removeListener('exit', exited);
      child.removeListener('message', receive);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abort = (): void => {
      child.kill('SIGKILL');
      settle(() => rejectPromise(signal.reason));
    };
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
    child.once('error', fail);
    child.once('exit', exited);
    child.once('message', receive);
    child.send(request, (error) => {
      if (error !== null) fail(error);
    });
  });
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
  document: NonNullable<RouteInvocation['document']>,
  manifest: RouteManifest,
  prepared: RouteInvocationPreparedProject,
  registry: TargetRegistry,
): RouteInvocation['projection'] => {
  if (route.kind === 'tool') {
    return deepFreeze({ mcp: documentToCallToolResult(document, { structuredContent: result }) as JsonObject });
  }
  if (route.kind === 'resource' || route.kind === 'prompt') {
    return deepFreeze({ ...(jsonObject(result) === undefined ? {} : { mcp: jsonObject(result) }) });
  }
  if (route.kind === 'cli' || route.kind === 'script') {
    const command = manifest.cli?.commands?.find((candidate) => candidate.routeId === route.id);
    const policy = route.kind === 'script' ? 'zero' : command?.exitCode ?? 'zero';
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
    let manifest: RouteManifest;
    let prepared: RouteInvocationPreparedProject;
    try {
      manifest = this.#manifest.manifest();
      prepared = this.#prepared();
    } catch {
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
    const context = contextFor(route, prepared.manifest.projectRoot, request.event?.host);
    const running = this.#semaphore.run<RouteInvocation>(async () => {
      const controller = new AbortController();
      this.#controllers.add(controller);
      if (this.#closed) {
        controller.abort(new DOMException('Route invocation service closed.', 'AbortError'));
      }
      const timeout = setTimeout(() => controller.abort(new DOMException('Route invocation timed out.', 'TimeoutError')), this.#timeoutMs);
      let child: RouteInvocationChildResult;
      try {
        child = await this.#renderChild({
          ...(request.args === undefined ? {} : { args: request.args }),
          context,
          input,
          manifest: prepared.manifest,
          routeId: route.id,
        }, controller.signal);
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
            : `Route invocation child failed: ${error instanceof Error ? error.message : String(error)}`,
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
        ...(child.result === undefined ? {} : { result: child.result }),
        routeId: route.id,
        source: route.source,
        sourceRevision: manifest.sourceRevision,
        startedAt: startedAt.toISOString(),
        status: 'succeeded',
        timings: [
          timing('providers', startedAt, 0),
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
    return invocation;
  }
}
