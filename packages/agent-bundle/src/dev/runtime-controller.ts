import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { ArtifactStatus, RuntimeEvent } from './types.ts';
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

const validDescriptor = (value: unknown): value is DevRuntimeDescriptor => isRecord(value) &&
  typeof value.id === 'string' && typeof value.label === 'string' && value.schemaVersion === 1 &&
  Array.isArray(value.environmentVariables) && value.environmentVariables.every((entry) => typeof entry === 'string');

const states = new Set<DevRuntimeStatus['state']>([
  'starting', 'compiling', 'active', 'degraded', 'failed', 'closed',
]);

const validStatus = (value: unknown): value is DevRuntimeStatus => isRecord(value) &&
  validDescriptor(value.descriptor) && Array.isArray(value.diagnostics) &&
  typeof value.hmrReady === 'boolean' && typeof value.state === 'string' && states.has(value.state as DevRuntimeStatus['state']);

const frozenVector = (vector: RuntimeVector): RuntimeVector => Object.freeze({ ...vector });

const frozenStatus = (status: DevRuntimeStatus): DevRuntimeStatus => Object.freeze({
  ...(status.activeVector === undefined ? {} : { activeVector: frozenVector(status.activeVector) }),
  descriptor: Object.freeze({
    environmentVariables: Object.freeze([...status.descriptor.environmentVariables]),
    id: status.descriptor.id,
    label: status.descriptor.label,
    schemaVersion: 1,
  }),
  diagnostics: Object.freeze(status.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
  hmrReady: status.hmrReady,
  ...(status.lastGoodVector === undefined ? {} : { lastGoodVector: frozenVector(status.lastGoodVector) }),
  state: status.state,
});

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
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #lastAcceptedSourceRevision: string;
  #lastGoodStatus: DevRuntimeStatus | undefined;
  #lateFailures: unknown[] = [];
  #lateStartup: Promise<void> | undefined;
  #reconcileTail: Promise<void> = Promise.resolve();
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
    const status = session.status();
    if (!validStatus(status)) throw new DevRuntimeUnavailableError();
    return frozenStatus(status);
  }

  #adoptStatus(status: DevRuntimeStatus): void {
    this.#status = status;
    if (status.state === 'active' || status.state === 'degraded') this.#lastGoodStatus = status;
  }

  #snapshotSurfaces(session: DevRuntimeSession, tolerateFailure = true): readonly DevRuntimeSurface[] {
    try {
      const surfaces = session.surfaces();
      return Array.isArray(surfaces) ? Object.freeze([...surfaces]) : Object.freeze([]);
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
      if (this.#bufferedPrepared.sourceRevision !== startedPrepared.sourceRevision) {
        await this.#enqueueReconcile(this.#bufferedPrepared);
      }
    } catch {
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
    if (event.type === 'runtime.generation.activated') this.#refreshSnapshot();
    try {
      this.#emit(runtimeEvent(this.#providerSessionId, event));
    } catch {
      // Provider health must not depend on a failed observer.
    }
  }

  /** Refreshes browser-visible snapshots before activation reaches event consumers. */
  #refreshSnapshot(): void {
    if (this.#closed || this.#topologyFailed) return;
    const session = this.#session;
    if (session === undefined) return;
    try {
      const status = this.#captureStatus(session);
      const surfaces = this.#snapshotSurfaces(session, false);
      if (this.#closed || this.#topologyFailed || this.#session !== session) return;
      this.#adoptStatus(status);
      this.#surfaces = surfaces;
    } catch {
      if (!this.#topologyFailed) this.#failLifecycle('degraded');
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
    this.#publish(Object.freeze({
      details: Object.freeze({ ...(restartRequired ? { restartRequired: true } : {}), state }),
      type: 'runtime.status',
    }));
  }

  async #close(): Promise<void> {
    this.#closed = true;
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
