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
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from './runtime-protocol.ts';

const defaultStartupTimeoutMs = 30_000;

const unavailableDescriptor: DevRuntimeDescriptor = Object.freeze({
  environmentVariables: Object.freeze([]),
  id: 'unavailable-runtime',
  label: 'Unavailable development runtime',
  schemaVersion: 1,
});

const lifecycleDiagnostic = (): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8200',
  message: 'Development runtime provider lifecycle failed.',
  phase: 'provider-lifecycle',
  severity: 'error',
});

const unavailableRegistry: DevRuntimeMcpRegistry = Object.freeze({
  close: async () => undefined,
  closeSession: async () => { throw new DevRuntimeUnavailableError(); },
  open: async (): Promise<DevRuntimeMcpSession> => { throw new DevRuntimeUnavailableError(); },
  reconcile: async (_input: DevRuntimeMcpRegistryReconcileInput): Promise<DevRuntimeMcpRegistryReconcileResult> => {
    throw new DevRuntimeUnavailableError();
  },
  restart: async (_request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult> => {
    throw new DevRuntimeUnavailableError();
  },
  session: (_sessionId: string): DevRuntimeMcpSessionView | undefined => undefined,
  snapshot: () => undefined,
  subscribe: (
    _options: Readonly<{ readonly afterSequence?: number }>,
    _listener: DevRuntimeMcpRegistryListener,
  ): DevRuntimeMcpRegistrySubscription => Object.freeze({ unsubscribe: () => undefined }),
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
  readonly #projectRoot: string;
  readonly #provider: DevRuntimeProvider | undefined;
  readonly #providerSessionId: string;
  readonly #startupTimeoutMs: number;
  readonly #storageRoot: string;
  #bufferedPrepared: DevRuntimePreparedProject;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #lastAcceptedSourceRevision: string;
  #lateStartup: Promise<void> | undefined;
  #reconcileTail: Promise<void> = Promise.resolve();
  #session: DevRuntimeSession | undefined;
  #startAbort = new AbortController();
  #startPromise: Promise<void> | undefined;
  #status: DevRuntimeStatus;

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
  }

  get mcpRegistry(): DevRuntimeMcpRegistry {
    return this.#session?.mcpRegistry ?? unavailableRegistry;
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
    if (this.#closed || prepared.sourceRevision === this.#lastAcceptedSourceRevision) return Promise.resolve();
    this.#lastAcceptedSourceRevision = prepared.sourceRevision;
    if (prepared.provider !== this.#initialProviderPath) {
      this.#failLifecycle();
      return Promise.resolve();
    }
    if (this.#startPromise === undefined) {
      this.#bufferedPrepared = prepared;
      return Promise.resolve();
    }
    const reconcile = this.#reconcileTail.then(async () => {
      if (this.#closed) return;
      const session = this.#session;
      if (session === undefined) return;
      try {
        await session.reconcilePreparedRuntime(prepared);
        this.#status = session.status();
      } catch {
        this.#failLifecycle('degraded');
      }
    });
    this.#reconcileTail = reconcile.catch(() => undefined);
    return reconcile;
  }

  /** Core-owned observability bridge for fixed client-surface proxy events. */
  emit(event: DevRuntimeEventInput): void {
    this.#emit(runtimeEvent(this.#providerSessionId, event));
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
    if (this.#session === undefined || this.#status.state === 'degraded' || this.#status.state === 'failed' || this.#status.state === 'closed') {
      return this.#status;
    }
    return this.#session.status();
  }

  surfaces(): readonly DevRuntimeSurface[] {
    return this.#session?.surfaces() ?? Object.freeze([]);
  }

  #activeSession(): DevRuntimeSession {
    if (this.#closed || this.#session === undefined || this.#status.state === 'failed') {
      throw new DevRuntimeUnavailableError();
    }
    return this.#session;
  }

  async #start(): Promise<void> {
    const provider = this.#provider;
    if (provider === undefined || this.#closed) return;
    const context = Object.freeze({
      artifactStatus: this.#artifactStatus,
      emit: (event: DevRuntimeEventInput): void => this.#emit(runtimeEvent(this.#providerSessionId, event)),
      environment: allowedEnvironment(provider.descriptor, this.#environment),
      preparedRuntime: this.#bufferedPrepared,
      projectRoot: this.#projectRoot,
      providerSessionId: this.#providerSessionId,
      signal: this.#startAbort.signal,
      storageRoot: this.#storageRoot,
    });
    const providerStart = provider.start(context);
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
      if (this.#closed) {
        await session.close();
        return;
      }
      this.#session = session;
      this.#status = session.status();
    } catch {
      this.#failLifecycle();
      this.#lateStartup = providerStart.then(
        async (lateSession) => lateSession.close(),
        () => undefined,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #failLifecycle(state: 'degraded' | 'failed' = 'failed'): void {
    const prior = this.#session?.status();
    this.#status = Object.freeze({
      ...(prior?.activeVector === undefined ? {} : { activeVector: prior.activeVector }),
      descriptor: this.#provider?.descriptor ?? unavailableDescriptor,
      diagnostics: Object.freeze([lifecycleDiagnostic()]),
      hmrReady: prior?.hmrReady ?? false,
      ...(prior?.lastGoodVector === undefined ? {} : { lastGoodVector: prior.lastGoodVector }),
      state,
    });
    this.#emit(runtimeEvent(this.#providerSessionId, Object.freeze({
      details: Object.freeze({ state }),
      type: 'runtime.status',
    })));
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#startAbort.abort();
    await this.#startPromise;
    await this.#reconcileTail;
    const session = this.#session;
    this.#session = undefined;
    const results = await Promise.allSettled([
      session?.close() ?? Promise.resolve(),
      this.#lateStartup ?? Promise.resolve(),
    ]);
    this.#status = statusFor(this.#provider?.descriptor ?? unavailableDescriptor, 'closed', this.#status.diagnostics);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
