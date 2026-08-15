import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { ArtifactStatus, JsonObject, JsonValue, RuntimeEvent } from './types.ts';
import {
  DevRuntimeUnavailableError,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeEventInput,
  type DevRuntimeMcpRegistry,
  type DevRuntimeMcpRegistryListener,
  type DevRuntimeMcpRegistrySubscription,
  type DevRuntimeMcpSession,
  type DevRuntimeMcpSessionView,
  type DevRuntimePreparedProject,
  type DevRuntimeProvider,
  type DevRuntimeSession,
} from './runtime-provider.ts';
import type {
  DevRuntimeAsset,
  DevRuntimeAssetRequest,
  DevRuntimeDescriptor,
  DevRuntimeDiagnostic,
  DevRuntimeInvocationRequest,
  DevRuntimeMcpRegistryReconcileInput,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
  RuntimeVector,
} from './runtime-protocol.ts';

const defaultStartupTimeoutMs = 30_000;

const unavailableDescriptor: DevRuntimeDescriptor = Object.freeze({
  environmentVariables: Object.freeze([]),
  id: 'unavailable-runtime',
  label: 'Unavailable development runtime',
  schemaVersion: 1,
});

const lifecycleDiagnostic = (message = 'Development runtime provider lifecycle failed.'): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8200',
  message,
  phase: 'provider-lifecycle',
  severity: 'error',
});

const statusFor = (
  descriptor: DevRuntimeDescriptor,
  state: DevRuntimeStatus['state'],
  diagnostics: readonly DevRuntimeDiagnostic[] = [],
): DevRuntimeStatus => Object.freeze({
  descriptor,
  diagnostics: Object.freeze([...diagnostics]),
  hmrReady: false,
  state,
});

const timeoutError = (): Error => new Error('Development runtime provider startup timed out.');

const allowedEnvironment = (
  descriptor: DevRuntimeDescriptor,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
  descriptor.environmentVariables.flatMap((name) => {
    const value = environment[name];
    return typeof value === 'string' ? [[name, value] as const] : [];
  }),
));

const runtimeEvent = (
  providerSessionId: string,
  event: DevRuntimeEventInput,
): RuntimeEvent => Object.freeze({ ...event, providerSessionId });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const snapshotInvalid = (): never => {
  throw new TypeError('Development runtime provider returned an invalid browser snapshot.');
};

const isEnumerableDataDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & Readonly<{ readonly value: unknown }> =>
  descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');

const ownDataValue = (value: Record<string, unknown>, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!isEnumerableDataDescriptor(descriptor)) return snapshotInvalid();
  return descriptor.value;
};

const exactRecord = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (!isRecord(value)) return snapshotInvalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return snapshotInvalid();
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return snapshotInvalid();
    ownDataValue(value, key);
  }
  for (const key of required) ownDataValue(value, key);
  return value;
};

const snapshotString = (value: unknown): string =>
  typeof value === 'string' ? value : snapshotInvalid();

const snapshotArray = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) return snapshotInvalid();
  if (Object.getPrototypeOf(value) !== Array.prototype) return snapshotInvalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return snapshotInvalid();
    if (key === 'length') continue;
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) return snapshotInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isEnumerableDataDescriptor(descriptor)) return snapshotInvalid();
  }
  return Object.freeze(Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataDescriptor(descriptor)) return snapshotInvalid();
    return descriptor.value;
  }));
};

const snapshotStrings = (value: unknown): readonly string[] =>
  Object.freeze(snapshotArray(value).map(snapshotString));

const snapshotJson = (value: unknown, seen = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : snapshotInvalid();
  if (typeof value !== 'object' || value === null) return snapshotInvalid();
  if (seen.has(value)) return snapshotInvalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(snapshotArray(value).map((entry) => snapshotJson(entry, seen)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return snapshotInvalid();
    const copied = Object.create(null) as Record<string, JsonValue>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return snapshotInvalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) return snapshotInvalid();
      Object.defineProperty(copied, key, {
        configurable: false,
        enumerable: true,
        value: snapshotJson(descriptor.value, seen),
        writable: false,
      });
    }
    return Object.freeze(copied) as JsonObject;
  } finally {
    seen.delete(value);
  }
};

const snapshotDescriptor = (value: unknown): DevRuntimeDescriptor => {
  const descriptor = exactRecord(value, ['environmentVariables', 'id', 'label', 'schemaVersion']);
  if (ownDataValue(descriptor, 'schemaVersion') !== 1) snapshotInvalid();
  return Object.freeze({
    environmentVariables: snapshotStrings(ownDataValue(descriptor, 'environmentVariables')),
    id: snapshotString(ownDataValue(descriptor, 'id')),
    label: snapshotString(ownDataValue(descriptor, 'label')),
    schemaVersion: 1,
  });
};

const snapshotVector = (value: unknown): RuntimeVector => {
  const vector = exactRecord(
    value,
    ['providerSessionId', 'runtimeGenerationId', 'sourceRevision', 'stateStoreId', 'stateVersion'],
    ['artifactEpochId'],
  );
  const stateVersion = ownDataValue(vector, 'stateVersion');
  if (typeof stateVersion !== 'number' || !Number.isSafeInteger(stateVersion) || stateVersion < 0) return snapshotInvalid();
  const artifactEpochId = Object.hasOwn(vector, 'artifactEpochId')
    ? snapshotString(ownDataValue(vector, 'artifactEpochId'))
    : undefined;
  return Object.freeze({
    ...(artifactEpochId === undefined ? {} : { artifactEpochId }),
    providerSessionId: snapshotString(ownDataValue(vector, 'providerSessionId')),
    runtimeGenerationId: snapshotString(ownDataValue(vector, 'runtimeGenerationId')),
    sourceRevision: snapshotString(ownDataValue(vector, 'sourceRevision')),
    stateStoreId: snapshotString(ownDataValue(vector, 'stateStoreId')),
    stateVersion,
  });
};

const diagnosticPhases = new Set<DevRuntimeDiagnostic['phase']>([
  'source/build',
  'fixture-validation',
  'hook-wrapper',
  'rsc-render',
  'flight-decode',
  'lowering-contract',
  'mcp-protocol',
  'resource-selection',
  'sandbox/csp',
  'app-bridge',
  'provider-lifecycle',
]);

const diagnosticSeverities = new Set<DevRuntimeDiagnostic['severity']>(['error', 'warning', 'info']);

const snapshotDiagnostic = (value: unknown): DevRuntimeDiagnostic => {
  const diagnostic = exactRecord(value, ['code', 'message', 'phase', 'severity']);
  const phase = ownDataValue(diagnostic, 'phase');
  const severity = ownDataValue(diagnostic, 'severity');
  if (typeof phase !== 'string' || !diagnosticPhases.has(phase as DevRuntimeDiagnostic['phase']) ||
    typeof severity !== 'string' || !diagnosticSeverities.has(severity as DevRuntimeDiagnostic['severity'])) return snapshotInvalid();
  return Object.freeze({
    code: snapshotString(ownDataValue(diagnostic, 'code')),
    message: snapshotString(ownDataValue(diagnostic, 'message')),
    phase: phase as DevRuntimeDiagnostic['phase'],
    severity: severity as DevRuntimeDiagnostic['severity'],
  });
};

const states = new Set<DevRuntimeStatus['state']>([
  'starting', 'compiling', 'active', 'degraded', 'failed', 'closed',
]);

const snapshotStatus = (value: unknown): DevRuntimeStatus => {
  const status = exactRecord(value, ['descriptor', 'diagnostics', 'hmrReady', 'state'], ['activeVector', 'lastGoodVector']);
  const state = ownDataValue(status, 'state');
  const hmrReady = ownDataValue(status, 'hmrReady');
  if (typeof state !== 'string' || !states.has(state as DevRuntimeStatus['state']) || typeof hmrReady !== 'boolean') return snapshotInvalid();
  const activeVector = Object.hasOwn(status, 'activeVector')
    ? snapshotVector(ownDataValue(status, 'activeVector'))
    : undefined;
  const lastGoodVector = Object.hasOwn(status, 'lastGoodVector')
    ? snapshotVector(ownDataValue(status, 'lastGoodVector'))
    : undefined;
  return Object.freeze({
    ...(activeVector === undefined ? {} : { activeVector }),
    descriptor: snapshotDescriptor(ownDataValue(status, 'descriptor')),
    diagnostics: Object.freeze(snapshotArray(ownDataValue(status, 'diagnostics')).map(snapshotDiagnostic)),
    hmrReady,
    ...(lastGoodVector === undefined ? {} : { lastGoodVector }),
    state: state as DevRuntimeStatus['state'],
  });
};

const surfaceKinds = new Set<DevRuntimeSurface['kind']>(['hook', 'mcp-tool', 'mcp-resource', 'mcp-app']);

const snapshotFixture = (value: unknown): DevRuntimeSurface['fixtures'][number] => {
  const fixture = exactRecord(value, ['id', 'label'], ['seed']);
  const seed = Object.hasOwn(fixture, 'seed') ? snapshotJson(ownDataValue(fixture, 'seed')) : undefined;
  return Object.freeze({
    id: snapshotString(ownDataValue(fixture, 'id')),
    label: snapshotString(ownDataValue(fixture, 'label')),
    ...(seed === undefined ? {} : { seed }),
  });
};

const snapshotSurface = (value: unknown): DevRuntimeSurface => {
  const surface = exactRecord(
    value,
    ['fixtures', 'id', 'kind', 'label', 'readOnly', 'targets'],
    ['defaultTarget', 'inputSchema'],
  );
  const kind = ownDataValue(surface, 'kind');
  const readOnly = ownDataValue(surface, 'readOnly');
  if (typeof kind !== 'string' || !surfaceKinds.has(kind as DevRuntimeSurface['kind']) || typeof readOnly !== 'boolean') return snapshotInvalid();
  const defaultTarget = Object.hasOwn(surface, 'defaultTarget')
    ? snapshotString(ownDataValue(surface, 'defaultTarget'))
    : undefined;
  const inputSchemaValue = Object.hasOwn(surface, 'inputSchema')
    ? snapshotJson(ownDataValue(surface, 'inputSchema'))
    : undefined;
  if (inputSchemaValue !== undefined && !isRecord(inputSchemaValue)) return snapshotInvalid();
  const inputSchema = inputSchemaValue as JsonObject | undefined;
  return Object.freeze({
    ...(defaultTarget === undefined ? {} : { defaultTarget }),
    fixtures: Object.freeze(snapshotArray(ownDataValue(surface, 'fixtures')).map(snapshotFixture)),
    id: snapshotString(ownDataValue(surface, 'id')),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    kind: kind as DevRuntimeSurface['kind'],
    label: snapshotString(ownDataValue(surface, 'label')),
    readOnly,
    targets: snapshotStrings(ownDataValue(surface, 'targets')),
  });
};

const snapshotSurfaces = (value: unknown): readonly DevRuntimeSurface[] =>
  Object.freeze(snapshotArray(value).map(snapshotSurface));

const call = <TResult>(owner: object, key: PropertyKey, args: readonly unknown[] = []): TResult => {
  const candidate = (owner as Record<PropertyKey, unknown>)[key];
  if (typeof candidate !== 'function') throw new DevRuntimeUnavailableError();
  return Reflect.apply(candidate, owner, args) as TResult;
};

export interface DevRuntimeControllerOptions {
  readonly artifactStatus: () => ArtifactStatus;
  readonly emit: (event: RuntimeEvent) => void;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly projectRoot: string;
  readonly provider?: DevRuntimeProvider;
  readonly providerLoadError?: unknown;
  readonly providerSessionId?: string;
  readonly startupTimeoutMs?: number;
  readonly storageRoot: string;
}

/**
 * Workbench-owned adapter around one optional trusted runtime provider. It owns
 * the stable controller identity and keeps provider start/reconcile failures
 * supplemental to the ordinary artifact build lane.
 */
export class DevRuntimeController implements DevRuntimeSession {
  readonly #artifactStatus: () => ArtifactStatus;
  readonly #emit: (event: RuntimeEvent) => void;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #initialProviderPath: string;
  readonly #mcpRegistry: DevRuntimeMcpRegistry;
  readonly #projectRoot: string;
  readonly #provider: DevRuntimeProvider | undefined;
  readonly #providerSessionId: string;
  readonly #sessionClosures = new WeakMap<object, Promise<void>>();
  readonly #startupTimeoutMs: number;
  readonly #storageRoot: string;
  #bufferedPrepared: DevRuntimePreparedProject;
  #bufferedStartupEvents: readonly DevRuntimeEventInput[] = Object.freeze([]);
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #lastAcceptedSourceRevision: string;
  #lastGoodStatus: DevRuntimeStatus | undefined;
  #lateFailures: unknown[] = [];
  #lateStartup: Promise<void> | undefined;
  #publishingLifecycleStatus = false;
  #reconcileTail: Promise<void> = Promise.resolve();
  #refreshingSnapshot = false;
  #session: DevRuntimeSession | undefined;
  #startAbort = new AbortController();
  #startPromise: Promise<void> | undefined;
  #status: DevRuntimeStatus;
  #surfaces: readonly DevRuntimeSurface[] = Object.freeze([]);
  #topologyFailed = false;

  constructor(options: DevRuntimeControllerOptions) {
    this.#artifactStatus = options.artifactStatus;
    this.#emit = options.emit;
    this.#environment = options.environment;
    this.#bufferedPrepared = options.preparedRuntime;
    this.#initialProviderPath = options.preparedRuntime.provider;
    this.#lastAcceptedSourceRevision = options.preparedRuntime.sourceRevision;
    this.#projectRoot = resolve(options.projectRoot);
    this.#provider = options.provider;
    this.#providerSessionId = options.providerSessionId ?? randomUUID();
    this.#startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    this.#storageRoot = resolve(options.storageRoot, this.#providerSessionId);
    this.#status = options.provider === undefined
      ? statusFor(unavailableDescriptor, 'failed', [lifecycleDiagnostic()])
      : statusFor(options.provider.descriptor, 'starting');
    this.#mcpRegistry = this.#createMcpRegistry();
  }

  get mcpRegistry(): DevRuntimeMcpRegistry {
    return this.#mcpRegistry;
  }

  get providerSessionId(): string {
    return this.#providerSessionId;
  }

  start(): Promise<void> {
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  clientSurface(surfaceId: string): DevRuntimeClientSurfaceEndpoint | undefined {
    return this.#activeSession().clientSurface(surfaceId);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    return this.#activeSession().invoke(request);
  }

  readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined> {
    return this.#activeSession().readAsset(request);
  }

  readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined> {
    return this.#activeSession().readRunFlight(runId);
  }

  reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void> {
    return this.reconcileDeclaration(prepared);
  }

  /** Handles a changed runtime declaration without dynamically changing Workbench topology. */
  reconcileDeclaration(
    prepared: DevRuntimePreparedProject | undefined,
    diagnostic?: unknown,
  ): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (prepared === undefined || diagnostic !== undefined || prepared.provider !== this.#initialProviderPath) {
      if (!this.#topologyFailed) {
        this.#topologyFailed = true;
        this.#bufferedStartupEvents = Object.freeze([]);
        this.#failLifecycle('failed', true);
      }
      return Promise.resolve();
    }
    if (this.#topologyFailed) return Promise.resolve();
    if (prepared.sourceRevision === this.#lastAcceptedSourceRevision) return Promise.resolve();
    this.#lastAcceptedSourceRevision = prepared.sourceRevision;
    this.#bufferedPrepared = prepared;
    if (this.#session === undefined) return Promise.resolve();
    return this.#enqueueReconcile(prepared);
  }

  /** Core-owned observability bridge for fixed client-surface proxy events. */
  emit(event: DevRuntimeEventInput): void {
    this.#publish(event);
  }

  replay(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun> {
    return this.#activeSession().replay(request);
  }

  resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity> {
    return this.#activeSession().resetState(request);
  }

  run(runId: string): DevRuntimeRun | undefined {
    return this.#activeSession().run(runId);
  }

  runs(limit: number): readonly DevRuntimeRun[] {
    return this.#activeSession().runs(limit);
  }

  status(): DevRuntimeStatus {
    return this.#status;
  }

  surfaces(): readonly DevRuntimeSurface[] {
    return this.#surfaces;
  }

  #activeSession(): DevRuntimeSession {
    if (this.#closed || this.#session === undefined || this.#status.state === 'failed' || this.#status.state === 'closed') {
      throw new DevRuntimeUnavailableError();
    }
    return this.#session;
  }

  #rawRegistry(): DevRuntimeMcpRegistry {
    const registry = this.#activeSession().mcpRegistry;
    if (!isRecord(registry)) throw new DevRuntimeUnavailableError();
    for (const name of ['close', 'closeSession', 'open', 'reconcile', 'restart', 'session', 'snapshot', 'subscribe'] as const) {
      if (typeof registry[name] !== 'function') throw new DevRuntimeUnavailableError();
    }
    return registry as unknown as DevRuntimeMcpRegistry;
  }

  #createMcpView(resolveView: () => DevRuntimeMcpSessionView | undefined): DevRuntimeMcpSessionView {
    const current = (): DevRuntimeMcpSessionView => {
      this.#rawRegistry();
      const view = resolveView();
      if (view === undefined) throw new DevRuntimeUnavailableError();
      return view;
    };
    return Object.freeze({
      execute: async (request: DevRuntimeMcpOperationRequest) =>
        call<Promise<Awaited<ReturnType<DevRuntimeMcpSessionView['execute']>>>>(current(), 'execute', [request]),
      snapshot: () => call<ReturnType<DevRuntimeMcpSessionView['snapshot']>>(current(), 'snapshot'),
      watchClosed: (listener: (reason?: unknown) => Promise<void> | void) =>
        call<ReturnType<DevRuntimeMcpSessionView['watchClosed']>>(current(), 'watchClosed', [listener]),
    });
  }

  #createMcpSession(resolveSession: () => DevRuntimeMcpSession | undefined): DevRuntimeMcpSession {
    const view = this.#createMcpView(resolveSession);
    return Object.freeze({
      ...view,
      close: async () => {
        this.#rawRegistry();
        return call<Promise<void>>(resolveSession() ?? this.#activeSession(), 'close');
      },
    });
  }

  #createMcpRegistry(): DevRuntimeMcpRegistry {
    return Object.freeze({
      close: async () => call<Promise<void>>(this.#rawRegistry(), 'close'),
      closeSession: async (request: DevRuntimeMcpSessionControlRequest) =>
        call<Promise<void>>(this.#rawRegistry(), 'closeSession', [request]),
      open: async (request: DevRuntimeMcpSessionRequest) => {
        const opened = await call<Promise<DevRuntimeMcpSession>>(this.#rawRegistry(), 'open', [request]);
        return this.#createMcpSession(() => opened);
      },
      reconcile: async (input: DevRuntimeMcpRegistryReconcileInput): Promise<DevRuntimeMcpRegistryReconcileResult> =>
        call<Promise<DevRuntimeMcpRegistryReconcileResult>>(this.#rawRegistry(), 'reconcile', [input]),
      restart: async (request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult> =>
        call<Promise<DevRuntimeMcpRegistryReconcileResult>>(this.#rawRegistry(), 'restart', [request]),
      session: (sessionId: string): DevRuntimeMcpSessionView | undefined => {
        const existing = call<DevRuntimeMcpSessionView | undefined>(this.#rawRegistry(), 'session', [sessionId]);
        return existing === undefined
          ? undefined
          : this.#createMcpView(() => call<DevRuntimeMcpSessionView | undefined>(this.#rawRegistry(), 'session', [sessionId]));
      },
      snapshot: () => call<ReturnType<DevRuntimeMcpRegistry['snapshot']>>(this.#rawRegistry(), 'snapshot'),
      subscribe: (
        options: Readonly<{ readonly afterSequence?: number }>,
        listener: DevRuntimeMcpRegistryListener,
      ): DevRuntimeMcpRegistrySubscription => call<DevRuntimeMcpRegistrySubscription>(
        this.#rawRegistry(),
        'subscribe',
        [options, listener],
      ),
    });
  }

  #captureStatus(session: DevRuntimeSession): DevRuntimeStatus {
    if (!isRecord(session) || typeof session.status !== 'function' || typeof session.close !== 'function') {
      throw new DevRuntimeUnavailableError();
    }
    return snapshotStatus(session.status());
  }

  #adoptStatus(status: DevRuntimeStatus): void {
    this.#status = status;
    if (status.state === 'active' || status.state === 'degraded') this.#lastGoodStatus = status;
  }

  #snapshotSurfaces(session: DevRuntimeSession, tolerateFailure = true): readonly DevRuntimeSurface[] {
    try {
      if (!isRecord(session) || typeof session.surfaces !== 'function') throw new DevRuntimeUnavailableError();
      return snapshotSurfaces(session.surfaces());
    } catch (error) {
      if (!tolerateFailure) throw error;
      return Object.freeze([]);
    }
  }

  async #closeSessionOnce(session: DevRuntimeSession): Promise<void> {
    if (!isRecord(session) || typeof session.close !== 'function') throw new DevRuntimeUnavailableError();
    const existing = this.#sessionClosures.get(session);
    if (existing !== undefined) return existing;
    const closing = Promise.resolve().then(() => session.close());
    this.#sessionClosures.set(session, closing);
    return closing;
  }

  #observeLateStart(providerStart: Promise<DevRuntimeSession>): void {
    this.#lateStartup ??= providerStart.then(
      async (session) => {
        try {
          await this.#closeSessionOnce(session);
        } catch (error) {
          this.#lateFailures.push(error);
          this.#failLifecycle();
        }
      },
      () => undefined,
    );
  }

  async #start(): Promise<void> {
    const provider = this.#provider;
    if (provider === undefined || this.#closed) return;
    const startedPrepared = this.#bufferedPrepared;
    const context = Object.freeze({
      artifactStatus: this.#artifactStatus,
      emit: (event: DevRuntimeEventInput): void => this.#publish(event),
      environment: allowedEnvironment(provider.descriptor, this.#environment),
      preparedRuntime: startedPrepared,
      projectRoot: this.#projectRoot,
      providerSessionId: this.#providerSessionId,
      signal: this.#startAbort.signal,
      storageRoot: this.#storageRoot,
    });
    const providerStart = Promise.resolve().then(() => provider.start(context));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolvePromise, rejectPromise) => {
      timer = setTimeout(() => {
        this.#startAbort.abort();
        rejectPromise(timeoutError());
      }, this.#startupTimeoutMs);
    });
    const aborted = new Promise<never>((_resolvePromise, rejectPromise) => {
      if (this.#startAbort.signal.aborted) {
        rejectPromise(new Error('Development runtime provider startup was aborted.'));
        return;
      }
      this.#startAbort.signal.addEventListener(
        'abort',
        () => rejectPromise(new Error('Development runtime provider startup was aborted.')),
        { once: true },
      );
    });
    try {
      const session = await Promise.race([providerStart, deadline, aborted]);
      if (this.#closed || this.#topologyFailed) {
        try {
          await this.#closeSessionOnce(session);
        } catch (error) {
          this.#lateFailures.push(error);
        }
        return;
      }
      const status = this.#captureStatus(session);
      const surfaces = this.#snapshotSurfaces(session);
      if (this.#closed || this.#topologyFailed) {
        try {
          await this.#closeSessionOnce(session);
        } catch (error) {
          this.#lateFailures.push(error);
        }
        return;
      }
      this.#session = session;
      this.#adoptStatus(status);
      this.#surfaces = surfaces;
      this.#flushStartupEvents();
      if (this.#bufferedPrepared.sourceRevision !== startedPrepared.sourceRevision) {
        await this.#enqueueReconcile(this.#bufferedPrepared);
      }
    } catch {
      this.#bufferedStartupEvents = Object.freeze([]);
      if (!this.#topologyFailed) this.#failLifecycle();
      this.#observeLateStart(providerStart);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #enqueueReconcile(prepared: DevRuntimePreparedProject): Promise<void> {
    const reconcile = this.#reconcileTail.then(async () => {
      if (this.#closed || this.#topologyFailed) return;
      const session = this.#session;
      if (session === undefined) return;
      try {
        await session.reconcilePreparedRuntime(prepared);
        if (this.#closed || this.#topologyFailed) return;
        const status = this.#captureStatus(session);
        const surfaces = this.#snapshotSurfaces(session);
        if (this.#closed || this.#topologyFailed || this.#session !== session) return;
        this.#adoptStatus(status);
        this.#surfaces = surfaces;
      } catch {
        if (!this.#topologyFailed) this.#failLifecycle('degraded');
      }
    });
    this.#reconcileTail = reconcile;
    return reconcile;
  }

  #publish(event: DevRuntimeEventInput): void {
    const authoritative = event.type === 'runtime.generation.activated' ||
      event.type === 'runtime.generation.failed' || event.type === 'runtime.status';
    const controllerLifecycleStatus = event.type === 'runtime.status' && this.#publishingLifecycleStatus;
    if (authoritative && !controllerLifecycleStatus) {
      if (this.#closed || this.#topologyFailed) return;
      if (this.#session === undefined) {
        if (this.#startPromise === undefined || this.#status.state !== 'starting') return;
        this.#bufferStartupEvent(event);
        return;
      }
      if (!this.#refreshingSnapshot) this.#refreshSnapshot();
    }
    try {
      this.#emit(runtimeEvent(this.#providerSessionId, event));
    } catch {
      // Provider health must not depend on a failed observer.
    }
  }

  /** Coalesces startup lifecycle events until browser-visible snapshots are installed. */
  #bufferStartupEvent(event: DevRuntimeEventInput): void {
    this.#bufferedStartupEvents = Object.freeze([
      ...this.#bufferedStartupEvents.filter((buffered) => buffered.type !== event.type),
      event,
    ]);
  }

  #flushStartupEvents(): void {
    const events = this.#bufferedStartupEvents;
    this.#bufferedStartupEvents = Object.freeze([]);
    for (const event of events) {
      if (this.#closed || this.#topologyFailed || this.#session === undefined || !this.#refreshSnapshot()) return;
      try {
        this.#emit(runtimeEvent(this.#providerSessionId, event));
      } catch {
        // Provider health must not depend on a failed observer.
      }
    }
  }

  /** Refreshes browser-visible snapshots before an authoritative lifecycle event reaches consumers. */
  #refreshSnapshot(): boolean {
    if (this.#closed || this.#topologyFailed || this.#refreshingSnapshot) return false;
    const session = this.#session;
    if (session === undefined) return false;
    this.#refreshingSnapshot = true;
    try {
      const status = this.#captureStatus(session);
      const surfaces = this.#snapshotSurfaces(session, false);
      if (this.#closed || this.#topologyFailed || this.#session !== session) return false;
      this.#adoptStatus(status);
      this.#surfaces = surfaces;
      return true;
    } catch {
      if (!this.#topologyFailed) this.#failLifecycle('degraded');
      return false;
    } finally {
      this.#refreshingSnapshot = false;
    }
  }

  #failLifecycle(state: 'degraded' | 'failed' = 'failed', restartRequired = false): void {
    if (this.#topologyFailed && !restartRequired) return;
    const prior = this.#lastGoodStatus ?? this.#status;
    this.#status = Object.freeze({
      ...(prior.activeVector === undefined ? {} : { activeVector: prior.activeVector }),
      descriptor: this.#provider?.descriptor ?? unavailableDescriptor,
      diagnostics: Object.freeze([lifecycleDiagnostic(restartRequired
        ? 'Development runtime declaration changed; restart required.'
        : undefined)]),
      hmrReady: prior.hmrReady,
      ...(prior.lastGoodVector === undefined ? {} : { lastGoodVector: prior.lastGoodVector }),
      state,
    });
    this.#publishingLifecycleStatus = true;
    try {
      this.#publish(Object.freeze({
        details: Object.freeze({ ...(restartRequired ? { restartRequired: true } : {}), state }),
        type: 'runtime.status',
      }));
    } finally {
      this.#publishingLifecycleStatus = false;
    }
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#bufferedStartupEvents = Object.freeze([]);
    this.#startAbort.abort();
    await this.#startPromise;
    await this.#reconcileTail;
    const session = this.#session;
    this.#session = undefined;
    const results = await Promise.allSettled([
      session === undefined ? Promise.resolve() : this.#closeSessionOnce(session),
      this.#lateStartup ?? Promise.resolve(),
    ]);
    this.#status = statusFor(this.#provider?.descriptor ?? unavailableDescriptor, 'closed', this.#status.diagnostics);
    const failures = [
      ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...this.#lateFailures,
    ];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Development runtime could not close every resource.');
  }
}
