import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createFileRuntimeKernel } from '../runtime/state-file.js';
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
import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  type DevRuntimeClientSurfaceEndpoint,
  type DevRuntimeEventInput,
  type DevRuntimePreparedProject,
  type DevRuntimeSession,
  type DevRuntimeStartContext,
} from '../../../../packages/agent-bundle/src/dev/runtime-provider.ts';
import {
  type DevRuntimeAsset,
  type DevRuntimeAssetRequest,
  type DevRuntimeDescriptor,
  type DevRuntimeDiagnostic,
  type DevRuntimeInspectionEnvelope,
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
const maximumInvocationWorkers = 4;
const maximumInvocationStdoutBytes = 4 * 1024 * 1024;
const maximumInvocationFlightBytes = 4 * 1024 * 1024;
const maximumInvocationStderrBytes = 256 * 1024;
const maximumRunHistory = 50;
const invocationTimeoutMs = 10_000;
const invocationTerminationGraceMs = 100;
const flightPreviewBytes = 32 * 1024;

interface InvocationWorker {
  readonly done: Promise<void>;
  terminate(reason: Error): void;
}

interface ValidatedInvocation {
  readonly fixtureId?: string;
  readonly input: JsonValue;
  readonly request: DevRuntimeInvocationRequest;
  readonly surface: DevRuntimeSurface;
}

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

const cloneJson = (value: unknown, ancestors = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime invocation input must contain only finite JSON numbers.');
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('Runtime invocation input must be an acyclic JSON value.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneJson(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Runtime invocation input must contain only plain JSON objects.');
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('Runtime invocation input cannot contain symbol keys.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Runtime invocation input cannot contain accessors or non-enumerable fields.');
      }
      result[key] = cloneJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
};

const redactInvocationDiagnostics = (value: string): string => value
  .slice(0, maximumInvocationStderrBytes)
  .replace(/((?:authorization|password|secret|token|credential|cookie)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[redacted]')
  .replace(/\b(?:Bearer\s+|sk-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})[^\s,;]*/gu, '[redacted]');

const invocationDiagnostic = (error: unknown): DevRuntimeDiagnostic => Object.freeze({
  code: 'AB8203',
  message: error instanceof Error ? redactInvocationDiagnostics(error.message) : 'RSC runtime invocation failed.',
  phase: 'rsc-render',
  severity: 'error',
});

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
  readonly #invocations = new Set<Promise<DevRuntimeRun>>();
  readonly #runReadTasks = new Map<string, Set<Promise<unknown>>>();
  readonly #runRoot: string;
  readonly #stateFile: string;
  readonly #stateKernel: ReturnType<typeof createFileRuntimeKernel>;
  readonly #runs = new Map<string, DevRuntimeRun>();
  readonly #surfaceAssetApps = new Map<string, DevRuntimePreparedProject['apps'][number]>();
  readonly #surfaces = new Map<string, DevRuntimeSurface>();
  readonly #testing: RsbuildRuntimeSessionStartTesting;
  readonly #attempts = new Map<string, AttemptBarrier>();
  readonly #workers = new Map<string, InvocationWorker>();
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
    this.#runRoot = join(resolve(input.context.storageRoot), 'runs');
    this.#stateFile = join(resolve(input.context.storageRoot), 'state', `${stateStoreId}.jsonl`);
    this.#stateKernel = createFileRuntimeKernel({ stateFile: this.#stateFile });
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

  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    if (this.#closed) return Promise.reject(new DevRuntimeUnavailableError('RSC runtime session is closed.'));
    const task = this.#invoke(request);
    this.#invocations.add(task);
    void task.finally(() => { this.#invocations.delete(task); }).catch(() => undefined);
    return task;
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
      const app = this.#surfaceAssetApps.get(request.surfaceId);
      if (app === undefined) return undefined;
      const boundSurfaceId = this.#surfaceAssetBinding(lease.generation, app);
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

  async readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined> {
    if (this.#closed || !safeSegment(runId)) return undefined;
    const run = this.#runs.get(runId);
    if (run?.status !== 'succeeded' || run.vector.providerSessionId !== this.providerSessionId) return undefined;
    const flightPath = join(this.#runRoot, runId, 'flight.bin');
    if (!isInside(this.#runRoot, flightPath)) return undefined;
    const task = (async (): Promise<DevRuntimeAsset | undefined> => {
      try {
        const details = await lstat(flightPath);
        if (!details.isFile() || details.isSymbolicLink() || details.size > maximumInvocationFlightBytes) return undefined;
        const body = await readFile(flightPath);
        if (body.byteLength !== details.size || body.byteLength > maximumInvocationFlightBytes) return undefined;
        return Object.freeze({ body, contentType: 'application/octet-stream' });
      } catch {
        return undefined;
      }
    })();
    const reads = this.#runReadTasks.get(runId) ?? new Set<Promise<unknown>>();
    this.#runReadTasks.set(runId, reads);
    reads.add(task);
    try {
      return await task;
    } finally {
      reads.delete(task);
      if (reads.size === 0) this.#runReadTasks.delete(runId);
    }
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

  async replay(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun> {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    const historical = this.#runs.get(request.runId);
    if (historical === undefined) throw new Error(`Runtime run ${JSON.stringify(request.runId)} does not exist.`);
    const historicalGenerationId = historical.vector.runtimeGenerationId;
    const activeGenerationId = this.#active?.id;
    if (request.mode === 'exact' && request.expectedGenerationId !== undefined && request.expectedGenerationId !== historicalGenerationId) {
      throw new DevRuntimeGenerationConflictError(request.expectedGenerationId, historicalGenerationId);
    }
    if (request.mode === 'latest' && request.expectedGenerationId !== undefined && request.expectedGenerationId !== activeGenerationId) {
      throw new DevRuntimeGenerationConflictError(request.expectedGenerationId, activeGenerationId);
    }
    const expectedGenerationId = request.mode === 'exact' ? historicalGenerationId : activeGenerationId;
    if (expectedGenerationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
    return this.invoke({
      expectedGenerationId,
      ...(historical.fixtureId === undefined ? {} : { fixtureId: historical.fixtureId }),
      input: historical.input,
      surfaceId: historical.surfaceId,
      target: historical.target,
    });
  }

  async resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity> {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    if (request.stateStoreId !== stateStoreId) throw new Error(`Unknown runtime state store ${JSON.stringify(request.stateStoreId)}.`);
    const generationId = request.expectedGenerationId ?? this.#active?.id;
    if (generationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
    let lease;
    try {
      lease = await this.#generationStore.lease(generationId);
    } catch {
      throw new DevRuntimeGenerationConflictError(generationId, this.#active?.id);
    }
    try {
      if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
      const snapshot = await this.#stateKernel.resetState({
        idempotencyKey: `runtime:reset:${randomUUID()}`,
        ...(request.seed === undefined ? {} : { seed: cloneJson(request.seed) }),
      });
      return Object.freeze({ stateStoreId, stateVersion: snapshot.stateVersion });
    } finally {
      await lease.release();
    }
  }

  run(runId: string): DevRuntimeRun | undefined {
    return this.#closed ? undefined : this.#runs.get(runId);
  }

  runs(limit: number): readonly DevRuntimeRun[] {
    if (this.#closed) return Object.freeze([]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumRunHistory) {
      throw new RangeError(`Runtime run history limit must be an integer from 1 through ${maximumRunHistory}.`);
    }
    return Object.freeze([...this.#runs.values()].reverse().slice(0, limit));
  }

  status(): DevRuntimeStatus {
    return this.#status;
  }

  surfaces(): readonly DevRuntimeSurface[] {
    return Object.freeze([...this.#surfaces.values()]);
  }

  async #invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun> {
    const invocation = this.#validateInvocation(request);
    const generationId = invocation.request.expectedGenerationId ?? this.#active?.id;
    if (generationId === undefined) throw new DevRuntimeUnavailableError('RSC runtime has no active generation.');
    if (this.#workers.size >= maximumInvocationWorkers) {
      throw new Error(`RSC runtime invocation limit of ${maximumInvocationWorkers} concurrent workers has been reached.`);
    }

    let lease;
    try {
      lease = await this.#generationStore.lease(generationId);
    } catch {
      throw new DevRuntimeGenerationConflictError(generationId, this.#active?.id);
    }

    let runDirectory: string | undefined;
    let running: DevRuntimeRun | undefined;
    try {
      if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
      if (this.#workers.size >= maximumInvocationWorkers) {
        throw new Error(`RSC runtime invocation limit of ${maximumInvocationWorkers} concurrent workers has been reached.`);
      }
      const stateBefore = await this.#stateKernel.readSnapshot();
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      running = Object.freeze({
        ...(invocation.fixtureId === undefined ? {} : { fixtureId: invocation.fixtureId }),
        id: runId,
        input: invocation.input,
        startedAt,
        status: 'running' as const,
        surfaceId: invocation.surface.id,
        target: invocation.request.target,
        vector: this.#vector(lease.generation, stateBefore.stateVersion),
      });
      await this.#insertRun(running);
      runDirectory = join(this.#runRoot, runId);
      if (!isInside(this.#runRoot, runDirectory) || !safeSegment(runId)) {
        throw new Error('RSC runtime run directory escaped its provider storage root.');
      }
      await mkdir(runDirectory, { recursive: false });
      if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
      this.#emit(Object.freeze({ runId, runtimeGenerationId: lease.generation.id, type: 'runtime.run.started' }));

      const response = await this.#runInvocationWorker({
        generation: lease.generation,
        input: await this.#workerRequest(invocation),
        runId,
      });
      const flight = this.#decodeFlight(response.flightBase64);
      const stateAfter = await this.#stateKernel.readSnapshot();
      const result = this.#inspectionResult(response.inspection, flight, stateAfter.stateVersion, runId);
      const flightPath = join(runDirectory, 'flight.bin');
      if (!isInside(runDirectory, flightPath)) throw new Error('RSC runtime Flight path escaped its run directory.');
      await writeFile(flightPath, flight, { flag: 'wx' });
      const completed = Object.freeze({
        ...(invocation.fixtureId === undefined ? {} : { fixtureId: invocation.fixtureId }),
        completedAt: new Date().toISOString(),
        id: runId,
        input: invocation.input,
        result,
        startedAt,
        status: 'succeeded' as const,
        surfaceId: invocation.surface.id,
        target: invocation.request.target,
        vector: this.#vector(lease.generation, stateAfter.stateVersion),
      });
      this.#runs.set(runId, completed);
      this.#emit(Object.freeze({ runId, runtimeGenerationId: lease.generation.id, type: 'runtime.run.completed' }));
      return completed;
    } catch (error) {
      if (runDirectory !== undefined) await rm(runDirectory, { force: true, recursive: true }).catch(() => undefined);
      if (running === undefined) throw error;
      const failed = Object.freeze({
        ...(running.fixtureId === undefined ? {} : { fixtureId: running.fixtureId }),
        completedAt: new Date().toISOString(),
        diagnostics: Object.freeze([invocationDiagnostic(error)]),
        id: running.id,
        input: running.input,
        startedAt: running.startedAt,
        status: 'failed' as const,
        surfaceId: running.surfaceId,
        target: running.target,
        vector: running.vector,
      });
      this.#runs.set(running.id, failed);
      this.#emit(Object.freeze({ runId: running.id, runtimeGenerationId: lease.generation.id, type: 'runtime.run.failed' }));
      return failed;
    } finally {
      await lease.release();
    }
  }

  #validateInvocation(request: DevRuntimeInvocationRequest): ValidatedInvocation {
    if (this.#closed) throw new DevRuntimeUnavailableError('RSC runtime session is closed.');
    if (request === null || typeof request !== 'object') throw new TypeError('Runtime invocation request must be an object.');
    if (typeof request.surfaceId !== 'string' || request.surfaceId.length === 0) {
      throw new TypeError('Runtime invocation requires a nonempty surfaceId.');
    }
    if (typeof request.target !== 'string' || request.target.length === 0) {
      throw new TypeError('Runtime invocation requires a nonempty target.');
    }
    if (request.expectedGenerationId !== undefined && (typeof request.expectedGenerationId !== 'string' || request.expectedGenerationId.length === 0)) {
      throw new TypeError('Runtime invocation expectedGenerationId must be nonempty when provided.');
    }
    const surface = this.#surfaces.get(request.surfaceId);
    if (surface === undefined) throw new Error(`Runtime surface ${JSON.stringify(request.surfaceId)} does not exist.`);
    if (!surface.targets.includes(request.target)) {
      throw new Error(`Runtime surface ${JSON.stringify(request.surfaceId)} does not support target ${JSON.stringify(request.target)}.`);
    }
    if (!['hook.claude', 'hook.codex', 'mcp.render_edit_timeline', 'mcp.recent_edits', 'mcp.runtime_status'].includes(surface.id)) {
      throw new Error(`Runtime surface ${JSON.stringify(surface.id)} is not invocable.`);
    }
    if (request.fixtureId !== undefined) {
      if (typeof request.fixtureId !== 'string' || request.fixtureId.length === 0) {
        throw new TypeError('Runtime invocation fixtureId must be nonempty when provided.');
      }
      if (!surface.fixtures.some((fixture) => fixture.id === request.fixtureId)) {
        throw new Error(`Runtime surface ${JSON.stringify(surface.id)} has no fixture ${JSON.stringify(request.fixtureId)}.`);
      }
    }
    return Object.freeze({
      ...(request.fixtureId === undefined ? {} : { fixtureId: request.fixtureId }),
      input: cloneJson(request.input),
      request: Object.freeze({ ...request }),
      surface,
    });
  }

  async #workerRequest(invocation: ValidatedInvocation): Promise<JsonObject> {
    if (invocation.surface.id === 'hook.claude' || invocation.surface.id === 'hook.codex') {
      if (invocation.input === null || typeof invocation.input !== 'object' || Array.isArray(invocation.input)) {
        throw new TypeError('Native hook runtime invocation input must be an object.');
      }
      return Object.freeze({
        host: invocation.surface.id === 'hook.claude' ? 'claude' : 'codex',
        input: invocation.input,
        stateFile: this.#stateFile,
        stateStoreId,
        type: 'hook/after-file-edit',
      });
    }
    if (invocation.surface.id === 'mcp.render_edit_timeline' || invocation.surface.id === 'mcp.recent_edits') {
      return Object.freeze({
        snapshot: cloneJson(await this.#stateKernel.readSnapshot()),
        stateFile: this.#stateFile,
        stateStoreId,
        type: 'mcp/render-timeline',
      });
    }
    return Object.freeze({ stateFile: this.#stateFile, stateStoreId, type: 'mcp/runtime-status' });
  }

  async #insertRun(run: DevRuntimeRun): Promise<void> {
    this.#runs.set(run.id, run);
    while (this.#runs.size > maximumRunHistory) {
      const oldestId = this.#runs.keys().next().value as string | undefined;
      if (oldestId === undefined) return;
      this.#runs.delete(oldestId);
      const reads = this.#runReadTasks.get(oldestId);
      if (reads !== undefined) await Promise.allSettled([...reads]);
      const oldDirectory = join(this.#runRoot, oldestId);
      if (safeSegment(oldestId) && isInside(this.#runRoot, oldDirectory)) {
        await rm(oldDirectory, { force: true, recursive: true });
      }
    }
  }

  #inspectionResult(
    inspection: DevRuntimeInspectionEnvelope,
    flight: Buffer,
    stateVersion: number,
    runId: string,
  ): DevRuntimeInspectionEnvelope {
    return Object.freeze({
      ...inspection,
      flight: Object.freeze({
        bytes: flight.byteLength,
        downloadPath: `/api/runtime/runs/${encodeURIComponent(runId)}/flight`,
        preview: flight.subarray(0, flightPreviewBytes).toString('base64'),
        truncated: flight.byteLength > flightPreviewBytes,
      }),
      state: Object.freeze({
        ...inspection.state,
        identity: Object.freeze({ stateStoreId, stateVersion }),
      }),
    });
  }

  #decodeFlight(value: unknown): Buffer {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      throw new Error('RSC invocation response did not contain valid base64 Flight data.');
    }
    const flight = Buffer.from(value, 'base64');
    if (flight.byteLength > maximumInvocationFlightBytes) {
      throw new Error(`RSC invocation Flight exceeded ${maximumInvocationFlightBytes} bytes.`);
    }
    return flight;
  }

  #runInvocationWorker(input: Readonly<{
    readonly generation: RuntimeGeneration<RscRuntimeGenerationMetadata>;
    readonly input: JsonObject;
    readonly runId: string;
  }>): Promise<Readonly<{ readonly flightBase64: string; readonly inspection: DevRuntimeInspectionEnvelope }>> {
    const entry = join(input.generation.root, 'rsc', 'dev', 'invoke.js');
    if (!isInside(input.generation.root, entry)) return Promise.reject(new Error('RSC invocation entry escaped its generation root.'));
    const child = spawn(process.execPath, [entry], {
      cwd: resolve(this.#context.projectRoot),
      detached: process.platform !== 'win32',
      env: {
        ...this.#context.environment,
        AGENT_RUNTIME_STATE_FILE: this.#stateFile,
        NODE_ENV: 'development',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill('SIGKILL');
      return Promise.reject(new Error('RSC invocation worker streams are unavailable.'));
    }

    let termination: Error | undefined;
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
          return;
        }
        if (signal === 'SIGKILL') {
          const terminator = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          terminator.unref();
          return;
        }
        child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* Child already exited. */ }
      }
    };
    const terminate = (reason: Error): void => {
      if (termination !== undefined || settled) return;
      termination = reason;
      child.stdin.destroy();
      signalGroup('SIGTERM');
      terminationGrace = setTimeout(() => signalGroup('SIGKILL'), invocationTerminationGraceMs);
    };

    const response = new Promise<Readonly<{ readonly flightBase64: string; readonly inspection: DevRuntimeInspectionEnvelope }>>((resolveResponse, rejectResponse) => {
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (terminationGrace !== undefined) clearTimeout(terminationGrace);
        callback();
      };
      stdout.on('data', (chunk: Buffer | string) => {
        if (termination !== undefined) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > maximumInvocationStdoutBytes) {
          terminate(new Error(`RSC invocation stdout exceeded ${maximumInvocationStdoutBytes} bytes.`));
          return;
        }
        stdoutChunks.push(bytes);
      });
      stdout.once('error', () => terminate(new Error('RSC invocation stdout stream failed.')));
      stderr.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = Math.min(bytes.byteLength, Math.max(0, maximumInvocationStderrBytes - stderrBytes));
        if (retained > 0) stderrChunks.push(bytes.subarray(0, retained));
        stderrBytes += bytes.byteLength;
        if (stderrBytes > maximumInvocationStderrBytes) {
          terminate(new Error(`RSC invocation stderr exceeded ${maximumInvocationStderrBytes} bytes.`));
        }
      });
      stderr.once('error', () => terminate(new Error('RSC invocation stderr stream failed.')));
      child.stdin.once('error', () => terminate(new Error('RSC invocation request stream failed.')));
      child.once('error', (error) => terminate(new Error(`RSC invocation worker could not be started: ${error.message}`)));
      child.once('close', (code) => {
        const diagnostics = redactInvocationDiagnostics(Buffer.concat(stderrChunks).toString('utf8'));
        if (termination !== undefined) {
          const message = termination.message;
          finish(() => rejectResponse(new Error(`${message}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`)));
          return;
        }
        if (code !== 0) {
          finish(() => rejectResponse(new Error(`RSC invocation worker exited with code ${String(code)}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`)));
          return;
        }
        try {
          const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdoutChunks));
          if (!output.endsWith('\n') || output.indexOf('\n') !== output.length - 1) {
            throw new Error('RSC invocation worker did not emit exactly one JSON response line.');
          }
          const parsed = JSON.parse(output) as unknown;
          if (
            parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
            typeof (parsed as { flightBase64?: unknown }).flightBase64 !== 'string' ||
            (parsed as { inspection?: unknown }).inspection === null ||
            typeof (parsed as { inspection?: unknown }).inspection !== 'object' ||
            Array.isArray((parsed as { inspection?: unknown }).inspection)
          ) {
            throw new Error('RSC invocation worker emitted an invalid response.');
          }
          finish(() => resolveResponse(Object.freeze({
            flightBase64: (parsed as { flightBase64: string }).flightBase64,
            inspection: deepFreeze((parsed as { inspection: DevRuntimeInspectionEnvelope }).inspection),
          })));
        } catch (error) {
          finish(() => rejectResponse(error instanceof Error ? error : new Error('RSC invocation worker emitted invalid JSON.')));
        }
      });
      timeout = setTimeout(() => terminate(new Error(`RSC invocation worker exceeded ${invocationTimeoutMs} ms.`)), invocationTimeoutMs);
      try {
        child.stdin.end(JSON.stringify(input.input));
      } catch {
        terminate(new Error('RSC invocation request could not be encoded.'));
      }
    });
    const worker: InvocationWorker = Object.freeze({
      done: response.then(() => undefined, () => undefined),
      terminate,
    });
    this.#workers.set(input.runId, worker);
    void worker.done.finally(() => {
      if (this.#workers.get(input.runId) === worker) this.#workers.delete(input.runId);
    });
    return response;
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
      this.#updateSurfaceAssetApps(snapshot.preparedRuntime);
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
      this.#updateSurfaceAssetApps(prepared);
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
    for (const worker of this.#workers.values()) {
      worker.terminate(new Error('RSC runtime session is closing.'));
    }
    this.#checkpointTracker.close();
    this.#setStatus('closed');
    this.#surfaceAssetApps.clear();
    const mcpRegistryClose = this.#mcpRegistry.close();
    while (this.#captureTasks.size > 0) await Promise.all([...this.#captureTasks]);
    while (this.#invocations.size > 0) await Promise.allSettled([...this.#invocations]);
    while (this.#runReadTasks.size > 0) {
      await Promise.allSettled([...this.#runReadTasks.values()].flatMap((reads) => [...reads]));
    }
    await rm(this.#runRoot, { force: true, recursive: true });
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

  #updateSurfaceAssetApps(prepared: Pick<DevRuntimePreparedProject, 'apps'>): void {
    this.#surfaceAssetApps.clear();
    for (const app of prepared.apps) {
      this.#surfaceAssetApps.set(`mcp.${app.name}`, app);
    }
  }

  #surfaceAssetBinding(
    generation: RuntimeGeneration<RscRuntimeGenerationMetadata>,
    app: DevRuntimePreparedProject['apps'][number],
  ): string | undefined {
    const metadata = generation.manifest.metadata;
    const exact = metadata.appDefinitions.find((candidate) =>
      candidate.id === app.id && candidate.resourceUri === app.resourceUri,
    );
    if (exact !== undefined) {
      const surfaceId = `mcp.${exact.name}`;
      return metadata.surfaceAssets[surfaceId] === undefined ? undefined : surfaceId;
    }
    const matches = metadata.appDefinitions.filter((candidate) =>
      candidate.resourceUri === app.resourceUri && metadata.surfaceAssets[`mcp.${candidate.name}`] !== undefined,
    );
    return matches.length === 1 ? `mcp.${matches[0]!.name}` : undefined;
  }

  #vector(generation: RuntimeGeneration<RscRuntimeGenerationMetadata>, stateVersion = 0): RuntimeVector {
    return Object.freeze({
      providerSessionId: this.providerSessionId,
      runtimeGenerationId: generation.id,
      sourceRevision: generation.sourceRevision,
      stateStoreId,
      stateVersion,
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
