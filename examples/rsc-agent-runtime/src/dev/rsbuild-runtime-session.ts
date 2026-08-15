import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createRsbuild, type StartDevServerResult } from '@rsbuild/core';

import {
  createRscRuntimeRsbuildConfig,
  type RscRuntimeCompileSnapshot,
} from '../../rsbuild.config.js';
import {
  captureRuntimeGenerationSnapshot,
  createRscCompilerAssetCheckpointTracker,
  materializeRuntimeGeneration,
  rscRuntimeGenerationMetadataCodec,
  runtimeDefinitionDigest,
  validateRscRuntimeGenerationMetadata,
  type RscCompilerAssetCheckpointTracker,
  type RscRuntimeCapturedGenerationSnapshot,
} from './generation-materializer.js';
import type {
  RscRuntimeGenerationMetadata,
  SerializedRuntimeDefinition,
} from '../runtime/contracts.js';
import {
  RuntimeGenerationStore,
  type RuntimeGeneration,
  type RuntimeGenerationActivationGuard,
  type RuntimeGenerationCandidate,
  type RuntimeGenerationPreparedActivation,
} from '../../../../packages/agent-bundle/src/dev/runtime-generation-store.ts';
import {
  RuntimeMcpRegistry,
  type RuntimeMcpConnection,
  type RuntimeMcpConnector,
  type RuntimeMcpExecutionContext,
  type RuntimeMcpPreparedActivationReconcile,
} from '../../../../packages/agent-bundle/src/dev/runtime-mcp-registry.ts';
import type {
  DevRuntimeClientSurfaceEndpoint,
  DevRuntimeEventInput,
  DevRuntimePreparedProject,
  DevRuntimeSession,
  DevRuntimeStartContext,
} from '../../../../packages/agent-bundle/src/dev/runtime-provider.ts';
import {
  type DevRuntimeAsset,
  type DevRuntimeAssetRequest,
  type DevRuntimeDescriptor,
  type DevRuntimeDiagnostic,
  type DevRuntimeInvocationRequest,
  type DevRuntimeMcpConnectionState,
  type DevRuntimeMcpRegistryReconcileInput,
  type DevRuntimeReplayRequest,
  type DevRuntimeRun,
  type DevRuntimeStateIdentity,
  type DevRuntimeStateResetRequest,
  type DevRuntimeStatus,
  type DevRuntimeSurface,
  type RuntimeVector,
} from '../../../../packages/agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject, JsonValue } from '../../../../packages/agent-bundle/src/dev/types.ts';

const descriptor: DevRuntimeDescriptor = Object.freeze({
  environmentVariables: Object.freeze([]),
  id: 'rsc-agent-runtime',
  label: 'RSC agent runtime',
  schemaVersion: 1,
});
const clientSurfaceId = 'mcp.edit-timeline';
const clientSurfaceEntry = '/edit-timeline-v1.html';
const maximumAssetBytes = 8 * 1024 * 1024;
const stateStoreId = 'playground';

interface AttemptBarrier {
  readonly id: string;
  readonly sequence: number;
  candidate: RuntimeGenerationCandidate | undefined;
  readonly settled: Promise<void>;
  settle(): void;
}

export class ResourceLedger {
  readonly #closers: Array<() => Promise<void>> = [];
  readonly #failures: unknown[] = [];
  readonly #running = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  add(close: () => Promise<void>): Promise<void> | undefined {
    if (!this.#closed) {
      this.#closers.push(close);
      return undefined;
    }
    return this.#run(close);
  }

  #run(close: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(close);
    this.#running.add(task);
    void task.then(
      () => undefined,
      (error: unknown) => { this.#failures.push(error); },
    ).finally(() => { this.#running.delete(task); });
    return task;
  }

  async #drain(): Promise<void> {
    while (this.#closers.length > 0) this.#run(this.#closers.shift()!);
    while (this.#running.size > 0) {
      await Promise.allSettled([...this.#running]);
      while (this.#closers.length > 0) this.#run(this.#closers.shift()!);
    }
    if (this.#failures.length > 0) {
      throw new AggregateError([...this.#failures], 'RSC runtime startup cleanup failed.');
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#drain();
    return this.#closePromise;
  }
}

const isInside = (root: string, path: string): boolean => {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
};

const safeSegment = (value: string): boolean =>
  value.length > 0 && value !== '.' && value !== '..' &&
  !value.includes('/') && !value.includes('\\') && !value.includes('\0') && !value.includes('%');

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('Runtime prepared configuration cannot contain cycles.');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property !== undefined && 'value' in property) deepFreeze(property.value, seen);
  }
  seen.delete(value);
  return Object.freeze(value);
};

const clonePrepared = (prepared: DevRuntimePreparedProject): DevRuntimePreparedProject =>
  deepFreeze(structuredClone(prepared));

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime metadata contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Runtime metadata is not JSON serializable.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().flatMap((key) => {
    const item = record[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
  }).join(',')}}`;
};

const digestValue = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

const transportDigest = (prepared: DevRuntimePreparedProject): string => digestValue({
  provider: prepared.provider,
  servers: prepared.servers.map((server) => ({
    args: server.args === undefined ? undefined : [...server.args],
    command: server.command,
    cwd: server.cwd,
    env: server.env === undefined ? undefined : Object.fromEntries(Object.entries(server.env)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, digestValue(value)])),
    headers: server.headers === undefined ? undefined : Object.fromEntries(Object.entries(server.headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, digestValue(value)])),
    id: server.id,
    name: server.name,
    source: server.source,
    targets: [...server.targets],
    transport: server.transport,
    url: server.url,
  })),
});

const asJsonObject = (value: unknown): JsonObject => value as JsonObject;

const descriptorsFor = (
  prepared: DevRuntimePreparedProject,
  metadata: RscRuntimeGenerationMetadata,
  definitionDigest: string,
  nextTransportDigest: string,
) => {
  const template = metadata.servers[0];
  if (template === undefined) throw new Error('The active runtime generation has no MCP server descriptor.');
  return Object.freeze(prepared.servers.flatMap((server) => server.targets.map((target) => Object.freeze({
    definitionDigest,
    name: server.name,
    resources: Object.freeze(template.resources.map(asJsonObject)),
    serverDigest: metadata.serverDigest,
    target,
    tools: Object.freeze(template.tools.map(asJsonObject)),
    transportDigest: nextTransportDigest,
  }))));
};

const lifecycleDiagnostic = (error: unknown): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8200',
  message: error instanceof Error ? error.message : 'RSC runtime provider failed.',
  phase: 'provider-lifecycle',
  severity: 'error',
});

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new Error('RSC runtime provider startup was aborted.');

export interface RsbuildRuntimeSessionStartTesting {
  readonly createRsbuild?: typeof createRsbuild;
  readonly beforeGenerationCapture?: () => Promise<void> | void;
  readonly afterActivationPrepare?: (input: Readonly<{
    readonly phase: 'store' | 'registry';
    readonly session: RsbuildRuntimeSession;
  }>) => Promise<void> | void;
  readonly beforeAssetRead?: (input: Readonly<{
    readonly request: DevRuntimeAssetRequest;
    readonly runtimeGenerationId: string;
  }>) => Promise<void> | void;
  readonly beforeMcpRelist?: () => Promise<void> | void;
}

/**
 * One provider-owned compiler, generation store, and runtime MCP registry.
 * The private compiler URL is exposed only through `clientSurface`.
 */
export class RsbuildRuntimeSession implements DevRuntimeSession {
  readonly #checkpointTracker: RscCompilerAssetCheckpointTracker;
  readonly #candidatesByAttempt = new Map<string, RuntimeGenerationCandidate>();
  readonly #captureTasks = new Set<Promise<void>>();
  readonly #context: DevRuntimeStartContext;
  readonly #generationStore: RuntimeGenerationStore<RscRuntimeGenerationMetadata>;
  readonly #mcpRegistry: RuntimeMcpRegistry;
  readonly #preparedRevisions = new Set<string>();
  readonly #runs = new Map<string, DevRuntimeRun>();
  readonly #surfaceAssetBindings = new WeakMap<RuntimeGeneration<RscRuntimeGenerationMetadata>, ReadonlyMap<string, string>>();
  readonly #surfaces = new Map<string, DevRuntimeSurface>();
  readonly #testing: RsbuildRuntimeSessionStartTesting;
  readonly #attempts = new Map<string, AttemptBarrier>();
  readonly #failedAttempts = new Set<string>();
  #active: RuntimeGeneration<RscRuntimeGenerationMetadata> | undefined;
  #clientSurface: DevRuntimeClientSurfaceEndpoint | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #generationSequence = 0;
  #failureTail: Promise<void> = Promise.resolve();
  #hmrReady = false;
  #latestAttemptSequence = 0;
  #latestPreparedRuntime: DevRuntimePreparedProject;
  #latestRscCohortRevision = 0;
  #providerTail: Promise<void> = Promise.resolve();
  #server: StartDevServerResult['server'] | undefined;
  #status: DevRuntimeStatus;

  private constructor(input: Readonly<{
    readonly checkpointTracker: RscCompilerAssetCheckpointTracker;
    readonly context: DevRuntimeStartContext;
    readonly generationStore: RuntimeGenerationStore<RscRuntimeGenerationMetadata>;
    readonly mcpRegistry: RuntimeMcpRegistry;
    readonly preparedRuntime: DevRuntimePreparedProject;
    readonly testing: RsbuildRuntimeSessionStartTesting;
  }>) {
    this.#context = input.context;
    this.#checkpointTracker = input.checkpointTracker;
    this.#generationStore = input.generationStore;
    this.#mcpRegistry = input.mcpRegistry;
    this.#latestPreparedRuntime = input.preparedRuntime;
    this.#testing = input.testing;
    this.#preparedRevisions.add(input.preparedRuntime.sourceRevision);
    this.#status = Object.freeze({
      descriptor,
      diagnostics: Object.freeze([]),
      hmrReady: false,
      state: 'starting',
    });
  }

  static async start(
    context: DevRuntimeStartContext,
    testing: RsbuildRuntimeSessionStartTesting = {},
  ): Promise<RsbuildRuntimeSession> {
    context.signal.throwIfAborted();
    const preparedRuntime = clonePrepared(context.preparedRuntime);
    RsbuildRuntimeSession.#validateStartContext(context, preparedRuntime);
    const ledger = new ResourceLedger();
    let aborting = false;
    const abort = (): void => {
      aborting = true;
      void ledger.close();
    };
    context.signal.addEventListener('abort', abort, { once: true });

    try {
      context.signal.throwIfAborted();
      const storageRoot = resolve(context.storageRoot);
      const generationStore = new RuntimeGenerationStore<RscRuntimeGenerationMetadata>({
        metadataCodec: rscRuntimeGenerationMetadataCodec,
        retainInactive: 5,
        storageRoot: join(storageRoot, 'generation-store'),
        validateMetadata: validateRscRuntimeGenerationMetadata,
      });
      ledger.add(() => generationStore.close());
      const checkpointTracker = createRscCompilerAssetCheckpointTracker();
      ledger.add(async () => { checkpointTracker.close(); });
      await Promise.all([
        mkdir(join(storageRoot, 'compiler'), { recursive: true }),
        mkdir(join(storageRoot, 'runs'), { recursive: true }),
        mkdir(join(storageRoot, 'state'), { recursive: true }),
      ]);
      context.signal.throwIfAborted();

      const connectionState: DevRuntimeMcpConnectionState = Object.freeze({
        capabilities: Object.freeze({}),
        protocolEra: 'modern',
        protocolVersion: '2025-06-18',
        server: Object.freeze({ name: 'rsc-agent-runtime-demo', version: '1.0.0' }),
      });
      const sessionReference: { current: RsbuildRuntimeSession | undefined } = { current: undefined };
      const connector: RuntimeMcpConnector = Object.freeze({
        connect: async ({ signal }: Parameters<RuntimeMcpConnector['connect']>[0]) => {
          signal.throwIfAborted();
          const connection: RuntimeMcpConnection = Object.freeze({
            close: async () => undefined,
            relist: async () => {
              signal.throwIfAborted();
              await testing.beforeMcpRelist?.();
              signal.throwIfAborted();
              return connectionState;
            },
            state: connectionState,
          });
          return connection;
        },
      });
      const mcpRegistry = new RuntimeMcpRegistry({
        artifactEpochId: () => undefined,
        connector,
        emit: (event) => {
          const session = sessionReference.current;
          if (session !== undefined) session.#emit(event);
        },
        executor: async (execution) => {
          const session = sessionReference.current;
          if (session === undefined) throw new Error('RSC runtime session is unavailable.');
          return session.#executeMcp(execution);
        },
        generationStore: generationStore as RuntimeGenerationStore,
        providerSessionId: context.providerSessionId,
        stateStoreId,
      });
      ledger.add(() => mcpRegistry.close());
      const session = new RsbuildRuntimeSession({
        checkpointTracker,
        context,
        generationStore,
        mcpRegistry,
        preparedRuntime,
        testing,
      });
      sessionReference.current = session;
      context.signal.throwIfAborted();

      const rsbuild = await (testing.createRsbuild ?? createRsbuild)({
        callerName: 'agent-bundle-rsc-runtime',
        config: createRscRuntimeRsbuildConfig({
          compilerRoot: join(storageRoot, 'compiler'),
          mode: 'development',
          onCompile: session.#compileObserver(),
        }),
        cwd: context.projectRoot,
      });
      context.signal.throwIfAborted();
      const started = await rsbuild.startDevServer({ getPortSilently: true });
      await ledger.add(() => started.server.close());
      context.signal.throwIfAborted();
      session.#attachServer(started);
      await session.#providerTail;
      context.signal.throwIfAborted();
      context.signal.removeEventListener('abort', abort);
      return session;
    } catch (error) {
      context.signal.removeEventListener('abort', abort);
      await ledger.close().catch(() => undefined);
      if (aborting || context.signal.aborted) throw abortReason(context.signal);
      throw error;
    }
  }

  get mcpRegistry(): RuntimeMcpRegistry {
    return this.#mcpRegistry;
  }

  get providerSessionId(): string {
    return this.#context.providerSessionId;
  }

  clientSurface(surfaceId: string): DevRuntimeClientSurfaceEndpoint | undefined {
    return !this.#closed && surfaceId === clientSurfaceId ? this.#clientSurface : undefined;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async invoke(_request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    throw new Error('RSC runtime invocation is not available until a generation is active.');
  }

  async readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined> {
    if (this.#closed || !this.#surfaces.has(request.surfaceId) || request.runtimeGenerationId.length === 0) return undefined;
    const segments = request.path.map((segment) => {
      if (!safeSegment(segment)) return undefined;
      try {
        return decodeURIComponent(segment) === segment ? segment : undefined;
      } catch {
        return undefined;
      }
    });
    if (segments.some((segment) => segment === undefined)) return undefined;
    const requestPath = `/${segments.join('/')}`;
    let lease;
    try {
      lease = await this.#generationStore.lease(request.runtimeGenerationId);
      await this.#testing.beforeAssetRead?.(Object.freeze({
        request,
        runtimeGenerationId: lease.generation.id,
      }));
      const boundSurfaceId = this.#surfaceAssetBindings.get(lease.generation)?.get(request.surfaceId);
      if (boundSurfaceId === undefined) return undefined;
      const descriptor = lease.generation.manifest.metadata.surfaceAssets[boundSurfaceId]
        ?.find((asset) => asset.requestPath === requestPath);
      if (descriptor === undefined || descriptor.bytes > maximumAssetBytes) return undefined;
      const assetSegments = descriptor.generationPath.split('/');
      if (assetSegments.some((segment) => !safeSegment(segment))) return undefined;
      const path = join(lease.generation.root, ...assetSegments);
      if (!isInside(lease.generation.root, path)) return undefined;
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size !== descriptor.bytes) return undefined;
      const body = await readFile(path);
      if (body.byteLength !== descriptor.bytes || createHash('sha256').update(body).digest('hex') !== descriptor.sha256) return undefined;
      return Object.freeze({ body, contentType: descriptor.contentType });
    } catch {
      return undefined;
    } finally {
      await lease?.release();
    }
  }

  async readRunFlight(_runId: string): Promise<DevRuntimeAsset | undefined> {
    return undefined;
  }

  reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void> {
    const next = clonePrepared(prepared);
    this.#validatePreparedRuntime(next);
    if (this.#closed) return Promise.reject(new Error('RSC runtime session is closed.'));
    if (this.#preparedRevisions.has(next.sourceRevision)) {
      return Promise.reject(new Error('Runtime prepared configuration source revision is stale or unchanged.'));
    }
    this.#preparedRevisions.add(next.sourceRevision);
    this.#latestPreparedRuntime = next;
    return this.#append(async () => this.#reconcilePreparedRuntime(next));
  }

  async replay(_request: DevRuntimeReplayRequest): Promise<DevRuntimeRun> {
    throw new Error('RSC runtime replay is not available until a generation is active.');
  }

  async resetState(_request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity> {
    throw new Error('RSC runtime state reset is not available until a generation is active.');
  }

  run(runId: string): DevRuntimeRun | undefined {
    return this.#runs.get(runId);
  }

  runs(limit: number): readonly DevRuntimeRun[] {
    if (!Number.isSafeInteger(limit) || limit < 0) return Object.freeze([]);
    return Object.freeze([...this.#runs.values()].slice(-limit));
  }

  status(): DevRuntimeStatus {
    return this.#status;
  }

  surfaces(): readonly DevRuntimeSurface[] {
    return Object.freeze([...this.#surfaces.values()]);
  }

  #attachServer(started: StartDevServerResult): void {
    if (this.#closed) return;
    const url = started.urls.find((candidate) => candidate.startsWith('http://127.0.0.1:')) ?? `http://127.0.0.1:${String(started.port)}`;
    const origin = new URL(url).origin;
    this.#server = started.server;
    this.#clientSurface = Object.freeze({
      entryPath: clientSurfaceEntry,
      httpOrigin: origin,
      httpPathPrefixes: Object.freeze(['/']),
      surfaceId: clientSurfaceId,
      webSocketOrigin: origin.replace(/^http:/u, 'ws:'),
      webSocketPath: '/rsbuild-hmr',
    });
    this.#hmrReady = true;
    this.#setStatus(this.#active === undefined ? 'compiling' : 'active');
  }

  #compileObserver(): NonNullable<Parameters<typeof createRscRuntimeRsbuildConfig>[0]['onCompile']> {
    return Object.freeze({
      beforeAttempt: () => this.#beforeAttempt(),
      capture: async (input) => this.#trackCapture(input),
      enqueue: (snapshot) => this.#enqueue(snapshot),
      failAttempt: (attemptId, error) => { void this.#failAttempt(attemptId, error); },
    });
  }

  #trackCapture(input: Readonly<{
    readonly attemptId: string;
    readonly cohortChanged: boolean;
    readonly hasErrors: boolean;
    readonly sourceRevision: string;
  }>): Promise<RscRuntimeCompileSnapshot | undefined> {
    const capture = this.#capture(input);
    const tracked = capture.then(() => undefined, () => undefined);
    this.#captureTasks.add(tracked);
    void tracked.then(() => { this.#captureTasks.delete(tracked); });
    return capture;
  }

  #beforeAttempt(): string {
    if (this.#closed) throw new Error('RSC runtime session is closed.');
    const sequence = ++this.#latestAttemptSequence;
    const id = `attempt-${String(sequence)}`;
    let settlePromise!: () => void;
    const settled = new Promise<void>((resolve) => { settlePromise = resolve; });
    const barrier: AttemptBarrier = {
      candidate: undefined,
      id,
      sequence,
      settle: () => {
        if (!this.#attempts.delete(id)) return;
        settlePromise();
      },
      settled,
    };
    this.#attempts.set(id, barrier);
    return id;
  }

  async #capture(input: Readonly<{
    readonly attemptId: string;
    readonly cohortChanged: boolean;
    readonly hasErrors: boolean;
    readonly sourceRevision: string;
  }>): Promise<RscRuntimeCompileSnapshot | undefined> {
    const barrier = this.#attempts.get(input.attemptId);
    if (barrier === undefined) throw new Error('RSC runtime compile capture has no live attempt barrier.');
    if (input.hasErrors || input.sourceRevision.length === 0) {
      await this.#failAttempt(input.attemptId, new Error('RSC runtime compilation failed.'));
      return undefined;
    }
    if (!input.cohortChanged) {
      barrier.settle();
      return undefined;
    }
    const cohortRevision = ++this.#latestRscCohortRevision;
    const preparedRuntime = this.#latestPreparedRuntime;
    barrier.settle();
    this.#emit(Object.freeze({ runtimeGenerationId: undefined, type: 'runtime.generation.compiling' }));
    try {
      const candidate = await this.#generationStore.begin({
        id: `generation-${String(++this.#generationSequence)}`,
        sourceRevision: input.sourceRevision,
      });
      barrier.candidate = candidate;
      this.#candidatesByAttempt.set(input.attemptId, candidate);
      await this.#testing.beforeGenerationCapture?.();
      if (this.#closed) throw new Error('RSC runtime session is closed.');
      const snapshot = await captureRuntimeGenerationSnapshot({
        attemptId: input.attemptId,
        candidate,
        compilerAssetCheckpointTracker: this.#checkpointTracker,
        compilerRoot: join(this.#context.storageRoot, 'compiler'),
        preparedRuntime,
        rscCohortRevision: cohortRevision,
        sourceRevision: input.sourceRevision,
      });
      if (this.#closed) throw new Error('RSC runtime session is closed.');
      return Object.freeze({
        acceptCompilerAssetCheckpoint: snapshot.acceptCompilerAssetCheckpoint,
        attemptId: snapshot.attemptId,
        candidateId: snapshot.candidate.id,
        discardCompilerAssetCheckpoint: snapshot.discardCompilerAssetCheckpoint,
        preparedRevision: snapshot.preparedRuntime.sourceRevision,
        rscCohortRevision: snapshot.rscCohortRevision,
        sourceRevision: snapshot.sourceRevision,
        snapshot,
      } as RscRuntimeCompileSnapshot & Readonly<{ readonly snapshot: RscRuntimeCapturedGenerationSnapshot }>);
    } catch (error) {
      await this.#failAttempt(input.attemptId, error);
      throw error;
    }
  }

  #enqueue(snapshot: RscRuntimeCompileSnapshot): Promise<'activated' | 'failed'> {
    const captured = (snapshot as RscRuntimeCompileSnapshot & Readonly<{ readonly snapshot?: RscRuntimeCapturedGenerationSnapshot }>).snapshot;
    if (captured === undefined) throw new Error('RSC runtime compile snapshot was not captured by this session.');
    if (this.#closed) {
      snapshot.discardCompilerAssetCheckpoint?.();
      return this.#failAttempt(snapshot.attemptId, new Error('RSC runtime session is closed.')).then(() => 'failed');
    }
    return this.#append(async () => this.#activate(captured));
  }

  async #failAttempt(attemptId: string, error: unknown): Promise<void> {
    if (this.#failedAttempts.has(attemptId)) return;
    this.#failedAttempts.add(attemptId);
    const barrier = this.#attempts.get(attemptId);
    barrier?.settle();
    const candidate = barrier?.candidate ?? this.#candidatesByAttempt.get(attemptId);
    this.#candidatesByAttempt.delete(attemptId);
    if (candidate !== undefined) {
      const cleanup = this.#failureTail.then(() => this.#generationStore.fail(candidate));
      this.#failureTail = cleanup.catch(() => undefined);
      await cleanup.catch(() => undefined);
    }
    this.#emit(Object.freeze({ type: 'runtime.generation.failed' }));
    if (!this.#closed) this.#setStatus(this.#active === undefined ? 'degraded' : 'active', [lifecycleDiagnostic(error)]);
  }

  #activationGuard(snapshot: RscRuntimeCapturedGenerationSnapshot): RuntimeGenerationActivationGuard<RscRuntimeGenerationMetadata> {
    let waitedSequence = -1;
    return Object.freeze({
      check: () => !this.#closed &&
        waitedSequence === this.#latestAttemptSequence &&
        ![...this.#attempts.values()].some((attempt) => attempt.sequence > this.#sequenceFor(snapshot.attemptId)) &&
        snapshot.rscCohortRevision === this.#latestRscCohortRevision &&
        snapshot.preparedRuntime.sourceRevision === this.#latestPreparedRuntime.sourceRevision,
      wait: async () => {
        while (!this.#closed) {
          const sequence = this.#sequenceFor(snapshot.attemptId);
          const pending = [...this.#attempts.values()].filter((attempt) => attempt.sequence > sequence);
          if (pending.length === 0) {
            waitedSequence = this.#latestAttemptSequence;
            return;
          }
          await Promise.all(pending.map((attempt) => attempt.settled));
        }
        throw new Error('RSC runtime session is closed.');
      },
    });
  }

  async #activate(snapshot: RscRuntimeCapturedGenerationSnapshot): Promise<'activated' | 'failed'> {
    const guard = this.#activationGuard(snapshot);
    let preparedGeneration: RuntimeGenerationPreparedActivation<RscRuntimeGenerationMetadata> | undefined;
    let preparedRegistry: RuntimeMcpPreparedActivationReconcile | undefined;
    try {
      preparedGeneration = await materializeRuntimeGeneration({
        guard,
        snapshot,
        stateStoreId,
        store: this.#generationStore,
      });
      await this.#testing.afterActivationPrepare?.(Object.freeze({ phase: 'store', session: this }));
      const metadata = preparedGeneration.generation.manifest.metadata;
      preparedRegistry = await this.#mcpRegistry.prepareActivationReconcile({
        definitionDigest: metadata.definitionDigest,
        runtimeGenerationId: preparedGeneration.generation.id,
        servers: metadata.servers,
        transportDigest: metadata.transportDigest,
      });
      await this.#testing.afterActivationPrepare?.(Object.freeze({ phase: 'registry', session: this }));
      await guard.wait(preparedGeneration.generation.manifest);
      if (!guard.check(preparedGeneration.generation.manifest) || !this.#generationStore.canCommit(preparedGeneration)) {
        throw new Error('RSC runtime generation activation was superseded.');
      }
      const generation = this.#generationStore.commit(preparedGeneration);
      const committed = this.#mcpRegistry.commitActivationReconcile(preparedRegistry);
      preparedGeneration = undefined;
      preparedRegistry = undefined;
      this.#active = generation;
      this.#updateSurfaces(snapshot, snapshot.preparedRuntime);
      this.#updateSurfaceAssetBindings(generation, snapshot.preparedRuntime, metadata);
      this.#setStatus('active');
      this.#emit(Object.freeze({
        mcpRegistryRevision: this.#mcpRegistry.snapshot()?.registryRevision,
        runtimeGenerationId: generation.id,
        type: 'runtime.generation.activated',
      }));
      committed.publish();
      try {
        await committed.finalize();
      } catch (error) {
        if (!this.#closed) this.#setStatus('degraded', [lifecycleDiagnostic(error)]);
      }
      return 'activated';
    } catch (error) {
      if (preparedGeneration !== undefined || preparedRegistry !== undefined) {
        await Promise.allSettled([
          ...(preparedGeneration === undefined ? [] : [this.#generationStore.abort(preparedGeneration)]),
          ...(preparedRegistry === undefined ? [] : [this.#mcpRegistry.abortActivationReconcile(preparedRegistry)]),
        ]);
      }
      snapshot.discardCompilerAssetCheckpoint?.();
      await this.#failAttempt(snapshot.attemptId, error);
      return 'failed';
    } finally {
      this.#candidatesByAttempt.delete(snapshot.attemptId);
    }
  }

  async #reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void> {
    const active = this.#active;
    if (active === undefined || this.#closed) return;
    const metadata = active.manifest.metadata;
    const definition = JSON.parse(await readFile(join(active.root, 'rsc', 'runtime-definition.json'), 'utf8')) as SerializedRuntimeDefinition;
    const nextDefinitionDigest = runtimeDefinitionDigest(definition, prepared);
    const nextTransportDigest = transportDigest(prepared);
    const current = this.#mcpRegistry.snapshot();
    if (
      current?.runtimeGenerationId === active.id &&
      current.definitionDigest === nextDefinitionDigest &&
      current.transportDigest === nextTransportDigest
    ) return;
    const input: DevRuntimeMcpRegistryReconcileInput = Object.freeze({
      definitionDigest: nextDefinitionDigest,
      runtimeGenerationId: active.id,
      servers: descriptorsFor(prepared, metadata, nextDefinitionDigest, nextTransportDigest),
      transportDigest: nextTransportDigest,
    });
    this.#setStatus('compiling');
    try {
      await this.#mcpRegistry.reconcile(input);
      this.#updateSurfaces({ definition }, prepared);
      this.#updateSurfaceAssetBindings(active, prepared, metadata);
      this.#setStatus('active');
    } catch (error) {
      this.#setStatus('degraded', [lifecycleDiagnostic(error)]);
      throw error;
    }
  }

  async #executeMcp(execution: RuntimeMcpExecutionContext): Promise<Readonly<{ readonly stateVersion: number; readonly value: JsonValue }>> {
    execution.signal.throwIfAborted();
    throw new Error(`Runtime MCP operation ${JSON.stringify(execution.request.kind)} is not available until the invocation lane is configured.`);
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#hmrReady = false;
    for (const attempt of [...this.#attempts.values()]) attempt.settle();
    this.#checkpointTracker.close();
    this.#setStatus('closed');
    this.#active = undefined;
    this.#surfaces.clear();
    const mcpRegistryClose = this.#mcpRegistry.close();
    while (this.#captureTasks.size > 0) await Promise.all([...this.#captureTasks]);
    await Promise.all([this.#providerTail.catch(() => undefined), this.#failureTail]);
    const results = await Promise.allSettled([
      this.#server?.close() ?? Promise.resolve(),
      mcpRegistryClose,
      this.#generationStore.close(),
    ]);
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'RSC runtime session close failed.');
  }

  #append<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#providerTail.then(work, work);
    this.#providerTail = next.then(() => undefined, () => undefined);
    return next;
  }

  #emit(event: DevRuntimeEventInput): void {
    if (this.#closed) return;
    try {
      this.#context.emit(event);
    } catch {
      // Runtime listeners cannot affect lifecycle ordering.
    }
  }

  #sequenceFor(attemptId: string): number {
    const match = /^attempt-(\d+)$/u.exec(attemptId);
    return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
  }

  #setStatus(state: DevRuntimeStatus['state'], diagnostics: readonly DevRuntimeDiagnostic[] = []): void {
    const active = this.#active;
    const vector = active === undefined ? undefined : this.#vector(active);
    this.#status = Object.freeze({
      ...(vector === undefined ? {} : { activeVector: vector, lastGoodVector: vector }),
      descriptor,
      diagnostics: Object.freeze([...diagnostics]),
      hmrReady: this.#hmrReady,
      state,
    });
  }

  #updateSurfaces(
    snapshot: Pick<RscRuntimeCapturedGenerationSnapshot, 'definition'>,
    prepared: Pick<DevRuntimePreparedProject, 'apps' | 'servers'>,
  ): void {
    this.#surfaces.clear();
    for (const hook of snapshot.definition.nativeHooks) {
      this.#surfaces.set(`hook.${hook.host}`, Object.freeze({
        id: `hook.${hook.host}`,
        kind: 'hook',
        label: `After tool hook (${hook.host})`,
        readOnly: false,
        targets: Object.freeze([hook.host]),
        fixtures: Object.freeze([]),
      }));
    }
    for (const tool of snapshot.definition.tools) {
      this.#surfaces.set(`mcp.${tool.name}`, Object.freeze({
        id: `mcp.${tool.name}`,
        kind: 'mcp-tool',
        label: tool.description,
        readOnly: tool.annotations.readOnlyHint,
        targets: Object.freeze([...prepared.servers.flatMap((server) => server.targets)]),
        fixtures: Object.freeze([]),
      }));
    }
    for (const resource of snapshot.definition.resources) {
      this.#surfaces.set(`mcp.${resource.name}`, Object.freeze({
        id: `mcp.${resource.name}`,
        kind: 'mcp-resource',
        label: resource.name,
        readOnly: true,
        targets: Object.freeze([...prepared.servers.flatMap((server) => server.targets)]),
        fixtures: Object.freeze([]),
      }));
    }
    for (const app of prepared.apps) {
      this.#surfaces.set(`mcp.${app.name}`, Object.freeze({
        id: `mcp.${app.name}`,
        kind: 'mcp-app',
        label: app.name,
        readOnly: true,
        targets: Object.freeze([...app.targets]),
        fixtures: Object.freeze([]),
      }));
    }
  }

  #updateSurfaceAssetBindings(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    prepared: Pick<DevRuntimePreparedProject, 'apps'>,
    metadata: Pick<RscRuntimeGenerationMetadata, 'appDefinitions' | 'surfaceAssets'>,
  ): void {
    const bindings = new Map<string, string>();
    const byIdentity = new Map<string, string>();
    const byResourceUri = new Map<string, string | undefined>();
    for (const app of metadata.appDefinitions) {
      const surfaceId = `mcp.${app.name}`;
      if (metadata.surfaceAssets[surfaceId] === undefined) continue;
      byIdentity.set(`${app.id}\0${app.resourceUri}`, surfaceId);
      byResourceUri.set(app.resourceUri, byResourceUri.has(app.resourceUri) ? undefined : surfaceId);
    }
    for (const app of prepared.apps) {
      const surfaceId = `mcp.${app.name}`;
      const binding = byIdentity.get(`${app.id}\0${app.resourceUri}`) ?? byResourceUri.get(app.resourceUri);
      if (binding !== undefined) bindings.set(surfaceId, binding);
    }
    this.#surfaceAssetBindings.set(generation, bindings);
  }

  #vector(generation: RuntimeGeneration<RscRuntimeGenerationMetadata>): RuntimeVector {
    return Object.freeze({
      providerSessionId: this.providerSessionId,
      runtimeGenerationId: generation.id,
      sourceRevision: generation.sourceRevision,
      stateStoreId,
      stateVersion: 0,
    });
  }

  #validatePreparedRuntime(prepared: DevRuntimePreparedProject): void {
    RsbuildRuntimeSession.#validateStartContext(this.#context, prepared);
  }

  static #validateStartContext(context: DevRuntimeStartContext, prepared: DevRuntimePreparedProject): void {
    if (prepared.provider !== './src/dev/provider.ts') throw new Error('RSC runtime provider declaration does not match this provider.');
    if (!isInside(context.projectRoot, resolve(context.projectRoot, prepared.provider))) {
      throw new Error('RSC runtime provider declaration escapes the project root.');
    }
    for (const source of [
      ...prepared.servers.flatMap((server) => [server.cwd, server.source]),
      ...prepared.apps.flatMap((app) => [app.source, app.template]),
    ]) {
      if (source !== undefined && !isInside(context.projectRoot, resolve(context.projectRoot, source))) {
        throw new Error('RSC runtime prepared declaration contains a path outside the project root.');
      }
    }
  }
}
