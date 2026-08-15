import type {
  DevRuntimeEventInput,
  DevRuntimeMcpRegistry,
  DevRuntimeMcpRegistryListener,
  DevRuntimeMcpRegistrySubscription,
  DevRuntimeMcpSession,
  DevRuntimeMcpSessionCloseObservation,
  DevRuntimeMcpSessionView,
} from './runtime-provider.ts';
import type {
  DevRuntimeMcpConnectionState,
  DevRuntimeMcpInvalidatedBinding,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpRegistryReconcileInput,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpRegistryReplayGap,
  DevRuntimeMcpRegistrySnapshot,
  DevRuntimeMcpServerDescriptor,
  DevRuntimeMcpSessionBinding,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
  DevRuntimeMcpSessionSnapshot,
  RuntimeVector,
} from './runtime-protocol.ts';
import { RuntimeGenerationStore, type RuntimeGeneration } from './runtime-generation-store.ts';
import type { JsonObject, JsonValue } from './types.ts';

const maxRetainedResults = 64;
const restartDrainTimeoutMs = 10_000;

type MutationLane = 'activation' | 'none' | 'public';
type RuntimeMcpRegistryMessage = DevRuntimeMcpRegistryReconcileResult | DevRuntimeMcpRegistryReplayGap;

interface RegistryState {
  readonly descriptors: ReadonlyMap<string, DevRuntimeMcpServerDescriptor>;
  readonly input: DevRuntimeMcpRegistryReconcileInput;
  readonly registryRevision: number;
}

interface OperationRecord {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly sessionAbort: AbortController;
}

interface SessionRecord {
  abort: AbortController;
  binding: DevRuntimeMcpSessionBinding;
  connection: RuntimeMcpConnection | undefined;
  connectionState: DevRuntimeMcpConnectionState;
  descriptor: DevRuntimeMcpServerDescriptor;
  readonly id: string;
  operations: Set<OperationRecord>;
  readonly watchers: Set<(reason?: unknown) => Promise<void> | void>;
  closed: boolean;
  state: DevRuntimeMcpSessionSnapshot['state'];
}

interface PreparedActivationRecord {
  readonly current: RegistryState | undefined;
  readonly input: DevRuntimeMcpRegistryReconcileInput;
  readonly invalidatedBindings: readonly DevRuntimeMcpInvalidatedBinding[];
  readonly nextDescriptors: ReadonlyMap<string, DevRuntimeMcpServerDescriptor>;
  readonly replacements: ReadonlyMap<string, ConnectedRuntimeMcp>;
  readonly requiresRestart: boolean;
  readonly reservationRevision: number;
  readonly stagedAbort: AbortController;
}

interface ConnectedRuntimeMcp {
  readonly connection: RuntimeMcpConnection;
  readonly state: DevRuntimeMcpConnectionState;
}

interface RetiredConnectionBatch {
  readonly entries: readonly Readonly<{
    readonly abort: AbortController;
    readonly connection: RuntimeMcpConnection | undefined;
    readonly operations: readonly OperationRecord[];
  }>[];
  finalization: Promise<void> | undefined;
}

interface OrphanedConnection {
  readonly connection: RuntimeMcpConnection;
  finalization: Promise<void> | undefined;
}

interface Subscription {
  closed: boolean;
  lastDeliveredSequence: number;
  readonly listener: DevRuntimeMcpRegistryListener;
  readonly pending: RuntimeMcpRegistryMessage[];
  replaying: boolean;
}

export interface RuntimeMcpConnection {
  readonly state: DevRuntimeMcpConnectionState;
  close(): Promise<void>;
  relist(): Promise<DevRuntimeMcpConnectionState>;
}

export interface RuntimeMcpConnector {
  connect(input: Readonly<{
    readonly descriptor: DevRuntimeMcpServerDescriptor;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }>): Promise<RuntimeMcpConnection>;
}

export interface RuntimeMcpExecutionContext {
  readonly descriptor: DevRuntimeMcpServerDescriptor;
  readonly generation: RuntimeGeneration;
  readonly request: DevRuntimeMcpOperationRequest;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface RuntimeMcpExecutionValue {
  readonly stateVersion: number;
  readonly value: JsonValue;
}

export interface RuntimeMcpRegistryOptions {
  readonly artifactEpochId: () => string | undefined;
  readonly connector: RuntimeMcpConnector;
  readonly createOperationId?: () => string;
  readonly createSessionId?: () => string;
  readonly emit: (event: DevRuntimeEventInput) => void;
  readonly executor: (context: RuntimeMcpExecutionContext) => Promise<RuntimeMcpExecutionValue>;
  readonly generationStore: RuntimeGenerationStore;
  readonly initialRegistry?: DevRuntimeMcpRegistryReconcileInput;
  readonly providerSessionId: string;
  readonly stateStoreId: string;
}

export interface RuntimeMcpPreparedActivationReconcile {
  readonly input: DevRuntimeMcpRegistryReconcileInput;
  readonly reservationRevision: number;
}

export interface RuntimeMcpCommittedActivationReconcile {
  readonly result: DevRuntimeMcpRegistryReconcileResult;
  finalize(): Promise<void>;
  publish(): void;
}

export interface RuntimeMcpRegistryCloseFailure {
  readonly error: unknown;
  readonly resource: string;
}

export class RuntimeMcpRegistryCloseError extends Error {
  readonly failures: readonly RuntimeMcpRegistryCloseFailure[];

  constructor(failures: readonly RuntimeMcpRegistryCloseFailure[]) {
    super('Runtime MCP registry could not release every resource.');
    this.name = 'RuntimeMcpRegistryCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

export type RuntimeMcpRegistryErrorCode =
  | 'RUNTIME_MCP_REGISTRY_CLOSED'
  | 'RUNTIME_MCP_REGISTRY_CONFLICT'
  | 'RUNTIME_MCP_REGISTRY_INVALID'
  | 'RUNTIME_MCP_REGISTRY_NOT_FOUND';

export class RuntimeMcpRegistryError extends Error {
  readonly code: RuntimeMcpRegistryErrorCode;

  constructor(code: RuntimeMcpRegistryErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeMcpRegistryError';
    this.code = code;
  }
}

const registryClosed = (): RuntimeMcpRegistryError =>
  new RuntimeMcpRegistryError('RUNTIME_MCP_REGISTRY_CLOSED', 'Runtime MCP registry is closed.');

const registryConflict = (message: string): RuntimeMcpRegistryError =>
  new RuntimeMcpRegistryError('RUNTIME_MCP_REGISTRY_CONFLICT', message);

const registryInvalid = (message: string): RuntimeMcpRegistryError =>
  new RuntimeMcpRegistryError('RUNTIME_MCP_REGISTRY_INVALID', message);

const registryNotFound = (message: string): RuntimeMcpRegistryError =>
  new RuntimeMcpRegistryError('RUNTIME_MCP_REGISTRY_NOT_FOUND', message);

const descriptorKey = (name: string, target: string): string => `${name}\u0000${target}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteJson = (value: unknown, seen = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw registryInvalid('Runtime MCP definitions must be finite JSON values.');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw registryInvalid('Runtime MCP definitions must not contain cycles.');
    seen.add(value);
    const copied = Object.freeze(value.map((item) => finiteJson(item, seen)));
    seen.delete(value);
    return copied;
  }
  if (!isRecord(value)) throw registryInvalid('Runtime MCP definitions must be JSON values.');
  if (seen.has(value)) throw registryInvalid('Runtime MCP definitions must not contain cycles.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw registryInvalid('Runtime MCP definitions must be plain JSON objects.');
  }
  seen.add(value);
  const copied: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || property.get !== undefined || property.set !== undefined) {
      throw registryInvalid('Runtime MCP definitions must not contain accessors.');
    }
    copied[key] = finiteJson(property.value, seen);
  }
  seen.delete(value);
  return Object.freeze(copied);
};

const jsonObject = (value: unknown, label: string): JsonObject => {
  const copied = finiteJson(value);
  if (!isRecord(copied)) throw registryInvalid(`${label} must be a JSON object.`);
  return copied;
};

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw registryInvalid(`${label} must be a nonempty string.`);
  return value;
};

const freezeDescriptor = (input: DevRuntimeMcpServerDescriptor): DevRuntimeMcpServerDescriptor => Object.freeze({
  definitionDigest: nonempty(input.definitionDigest, 'Runtime MCP descriptor definition digest'),
  name: nonempty(input.name, 'Runtime MCP descriptor name'),
  resources: Object.freeze(input.resources.map((resource) => jsonObject(resource, 'Runtime MCP resource'))),
  serverDigest: nonempty(input.serverDigest, 'Runtime MCP descriptor server digest'),
  target: nonempty(input.target, 'Runtime MCP descriptor target'),
  tools: Object.freeze(input.tools.map((tool) => jsonObject(tool, 'Runtime MCP tool'))),
  transportDigest: nonempty(input.transportDigest, 'Runtime MCP descriptor transport digest'),
});

const freezeInput = (input: DevRuntimeMcpRegistryReconcileInput): DevRuntimeMcpRegistryReconcileInput => {
  const definitionDigest = nonempty(input.definitionDigest, 'Runtime MCP definition digest');
  const runtimeGenerationId = nonempty(input.runtimeGenerationId, 'Runtime MCP generation id');
  const transportDigest = nonempty(input.transportDigest, 'Runtime MCP transport digest');
  const keys = new Set<string>();
  const descriptors = input.servers.map((server) => {
    const descriptor = freezeDescriptor(server);
    if (descriptor.definitionDigest !== definitionDigest || descriptor.transportDigest !== transportDigest) {
      throw registryInvalid('Runtime MCP server descriptors must match the registry definition and transport digests.');
    }
    const key = descriptorKey(descriptor.name, descriptor.target);
    if (keys.has(key)) throw registryInvalid(`Runtime MCP registry has duplicate server ${JSON.stringify(descriptor.name)} for target ${JSON.stringify(descriptor.target)}.`);
    keys.add(key);
    return descriptor;
  });
  return Object.freeze({
    definitionDigest,
    runtimeGenerationId,
    servers: Object.freeze(descriptors),
    transportDigest,
  });
};

const descriptorMap = (input: DevRuntimeMcpRegistryReconcileInput): ReadonlyMap<string, DevRuntimeMcpServerDescriptor> =>
  new Map(input.servers.map((descriptor) => [descriptorKey(descriptor.name, descriptor.target), descriptor]));

const defaultConnectionState = (): DevRuntimeMcpConnectionState => Object.freeze({
  capabilities: undefined,
  protocolEra: undefined,
  protocolVersion: undefined,
  server: undefined,
});

const staticValue = (descriptor: DevRuntimeMcpServerDescriptor, request: DevRuntimeMcpOperationRequest): JsonValue | undefined => {
  if (request.kind === 'list-tools') return descriptor.tools;
  if (request.kind === 'list-resources') return descriptor.resources;
  return undefined;
};

const declaredTool = (descriptor: DevRuntimeMcpServerDescriptor, name: string): boolean =>
  descriptor.tools.some((tool) => tool.name === name);

const declaredResource = (descriptor: DevRuntimeMcpServerDescriptor, uri: string): boolean =>
  descriptor.resources.some((resource) => resource.uri === uri);

const timeout = (durationMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

export class RuntimeMcpRegistry implements DevRuntimeMcpRegistry {
  readonly #activation = new WeakMap<RuntimeMcpPreparedActivationReconcile, PreparedActivationRecord>();
  readonly #preparedActivations = new Set<RuntimeMcpPreparedActivationReconcile>();
  readonly #closeAbort = new AbortController();
  readonly #history: DevRuntimeMcpRegistryReconcileResult[] = [];
  readonly #opening = new Map<AbortController, Promise<void>>();
  readonly #publicMutations = new Set<Promise<void>>();
  readonly #options: Required<Pick<RuntimeMcpRegistryOptions, 'createOperationId' | 'createSessionId'>> & RuntimeMcpRegistryOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #subscriptions = new Set<Subscription>();
  readonly #pendingPublications = new Map<number, DevRuntimeMcpRegistryReconcileResult>();
  readonly #orphanedConnections = new Map<RuntimeMcpConnection, OrphanedConnection>();
  readonly #retirements = new Set<RetiredConnectionBatch>();
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #preparingActivation: Readonly<{ readonly abort: AbortController; readonly settled: Promise<void> }> | undefined;
  #mutation: MutationLane = 'none';
  #nextPublicationSequence = 1;
  #publishing = false;
  #reservationRevision = 0;
  #sequence = 0;
  #state: RegistryState | undefined;

  constructor(options: RuntimeMcpRegistryOptions) {
    if (typeof options.artifactEpochId !== 'function' || typeof options.connector.connect !== 'function' ||
      typeof options.emit !== 'function' || typeof options.executor !== 'function') {
      throw new TypeError('Runtime MCP registry requires connector, executor, artifact, and event functions.');
    }
    nonempty(options.providerSessionId, 'Runtime MCP provider session id');
    nonempty(options.stateStoreId, 'Runtime MCP state store id');
    this.#options = Object.freeze({
      ...options,
      createOperationId: options.createOperationId ?? (() => crypto.randomUUID()),
      createSessionId: options.createSessionId ?? (() => crypto.randomUUID()),
    });
    if (options.initialRegistry !== undefined) {
      const input = freezeInput(options.initialRegistry);
      this.#state = Object.freeze({ descriptors: descriptorMap(input), input, registryRevision: 1 });
    }
  }

  snapshot(): DevRuntimeMcpRegistrySnapshot | undefined {
    const state = this.#state;
    if (state === undefined) return undefined;
    return Object.freeze({
      definitionDigest: state.input.definitionDigest,
      providerSessionId: this.#options.providerSessionId,
      registryRevision: state.registryRevision,
      runtimeGenerationId: state.input.runtimeGenerationId,
      servers: state.input.servers,
      transportDigest: state.input.transportDigest,
    });
  }

  async open(request: DevRuntimeMcpSessionRequest): Promise<DevRuntimeMcpSession> {
    const release = this.#reserve('public');
    const controller = new AbortController();
    let settled!: () => void;
    const settling = new Promise<void>((resolve) => { settled = resolve; });
    this.#opening.set(controller, settling);
    try {
      const state = this.#requireState();
      if (request.expectedRegistryRevision !== undefined && request.expectedRegistryRevision !== state.registryRevision) {
        throw registryConflict('Expected runtime MCP registry revision does not match the current registry revision.');
      }
      const descriptor = state.descriptors.get(descriptorKey(request.serverName, request.target));
      if (descriptor === undefined) throw registryNotFound('Unknown runtime MCP server or target.');
      const id = this.#options.createSessionId();
      nonempty(id, 'Runtime MCP session id');
      if (this.#sessions.has(id)) throw registryConflict(`Runtime MCP session ${JSON.stringify(id)} already exists.`);
      const connected = await this.#connectAndRelist(descriptor, id, controller.signal);
      const record: SessionRecord = {
        abort: new AbortController(),
        binding: this.#binding(id, 1, state, descriptor),
        closed: false,
        connection: connected.connection,
        connectionState: connected.state,
        descriptor,
        id,
        operations: new Set(),
        state: 'ready',
        watchers: new Set(),
      };
      this.#sessions.set(id, record);
      return this.#ownedSession(record);
    } finally {
      this.#opening.delete(controller);
      settled();
      release();
    }
  }

  session(sessionId: string): DevRuntimeMcpSessionView | undefined {
    const record = this.#sessions.get(sessionId);
    return record === undefined ? undefined : this.#view(record);
  }

  async reconcile(input: DevRuntimeMcpRegistryReconcileInput): Promise<DevRuntimeMcpRegistryReconcileResult> {
    const frozen = freezeInput(input);
    const release = this.#reserve('public');
    const settle = this.#trackPublicMutation();
    try {
      const current = this.#state;
      if (current === undefined) {
        this.#state = Object.freeze({ descriptors: descriptorMap(frozen), input: frozen, registryRevision: 1 });
        const result = this.#result('implementation-updated', [], [], this.#state);
        this.#publishResult(result);
        return result;
      }
      if (!requiresRestart(current.input, frozen)) {
        this.#installImplementation(current, frozen);
        const result = this.#result('implementation-updated', [], [], this.#requireState());
        this.#publishResult(result);
        return result;
      }

      const invalidatedBindings = this.#startVisibleRestart(current, frozen, this.#sessions.values());
      const restartedSessionIds: string[] = [];
      let failure: unknown;
      for (const record of this.#sessions.values()) {
        try {
          await this.#replaceVisibleConnection(record);
          restartedSessionIds.push(record.id);
          this.#emit('runtime.mcp.ready', record);
        } catch (error) {
          failure ??= error;
          record.state = 'failed';
          record.connection = undefined;
          this.#emit('runtime.mcp.failed', record);
        }
      }
      const result = this.#result(
        failure === undefined ? 'sessions-restarted' : 'restart-failed',
        invalidatedBindings,
        restartedSessionIds,
        this.#requireState(),
      );
      this.#publishResult(result);
      return result;
    } finally {
      release();
      settle();
    }
  }

  async restart(request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult> {
    const release = this.#reserve('public');
    const settle = this.#trackPublicMutation();
    try {
      const current = this.#requireState();
      const record = this.#sessionForControl(request);
      const previous = bindingCopy(record.binding);
      record.binding = this.#binding(record.id, record.binding.sessionRevision + 1, current, record.descriptor);
      record.state = 'restarting';
      this.#emit('runtime.mcp.restarting', record);
      try {
        await this.#replaceVisibleConnection(record);
        this.#emit('runtime.mcp.ready', record);
        const result = this.#result('sessions-restarted', [previous], [record.id], current);
        this.#publishResult(result);
        return result;
      } catch {
        record.state = 'failed';
        record.connection = undefined;
        this.#emit('runtime.mcp.failed', record);
        const result = this.#result('restart-failed', [previous], [], current);
        this.#publishResult(result);
        return result;
      }
    } finally {
      release();
      settle();
    }
  }

  async closeSession(request: DevRuntimeMcpSessionControlRequest): Promise<void> {
    const release = this.#reserve('public');
    const settle = this.#trackPublicMutation();
    try {
      const record = this.#sessionForControl(request);
      await this.#closeRecord(record, new Error('Runtime MCP session was closed.'));
      this.#sessions.delete(record.id);
    } finally {
      release();
      settle();
    }
  }

  subscribe(
    options: Readonly<{ readonly afterSequence?: number }>,
    listener: DevRuntimeMcpRegistryListener,
  ): DevRuntimeMcpRegistrySubscription {
    if (typeof listener !== 'function') throw new TypeError('A runtime MCP registry listener is required.');
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.#sequence) {
      throw registryConflict('afterSequence must be a current runtime MCP registry cursor.');
    }
    const subscription: Subscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      replaying: true,
    };
    this.#subscriptions.add(subscription);
    const earliest = this.#history[0]?.sequence;
    if (earliest !== undefined && afterSequence < earliest - 1) {
      this.#deliver(subscription, Object.freeze({
        earliestAvailableSequence: earliest,
        latestDroppedSequence: earliest - 1,
        requestedAfterSequence: afterSequence,
        type: 'replay.gap' as const,
      }));
    }
    const boundary = this.#sequence;
    for (const result of this.#history) {
      if (result.sequence > afterSequence && result.sequence <= boundary) this.#deliver(subscription, result);
    }
    while (!subscription.closed && subscription.pending.length > 0) {
      const message = subscription.pending.shift();
      if (message !== undefined) this.#deliver(subscription, message);
    }
    subscription.replaying = false;
    return Object.freeze({ unsubscribe: () => this.#unsubscribe(subscription) });
  }

  async prepareActivationReconcile(input: DevRuntimeMcpRegistryReconcileInput): Promise<RuntimeMcpPreparedActivationReconcile> {
    const frozen = freezeInput(input);
    const release = this.#reserve('activation');
    const current = this.#state;
    const reservationRevision = ++this.#reservationRevision;
    const prepared = Object.freeze({ input: frozen, reservationRevision });
    const stagedAbort = new AbortController();
    let markPreparedSettled!: () => void;
    const preparedSettled = new Promise<void>((resolve) => { markPreparedSettled = resolve; });
    const preparation = Object.freeze({ abort: stagedAbort, settled: preparedSettled });
    this.#preparingActivation = preparation;
    const replacements = new Map<string, ConnectedRuntimeMcp>();
    try {
      const restart = current !== undefined && requiresRestart(current.input, frozen);
      const nextDescriptors = descriptorMap(frozen);
      const invalidatedBindings: DevRuntimeMcpInvalidatedBinding[] = [];
      if (restart) {
        for (const record of this.#sessions.values()) {
          const next = nextDescriptors.get(descriptorKey(record.binding.serverName, record.binding.target));
          if (next === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
          invalidatedBindings.push(bindingCopy(record.binding));
          replacements.set(record.id, await this.#connectAndRelist(next, record.id, stagedAbort.signal));
        }
      }
      this.#activation.set(prepared, Object.freeze({
        current,
        input: frozen,
        invalidatedBindings: Object.freeze(invalidatedBindings),
        nextDescriptors,
        replacements,
        requiresRestart: restart,
        reservationRevision,
        stagedAbort,
      }));
      this.#preparedActivations.add(prepared);
      if (this.#preparingActivation === preparation) this.#preparingActivation = undefined;
      markPreparedSettled();
      return prepared;
    } catch (error) {
      stagedAbort.abort(error);
      const cleanupFailures = await this.#closeConnectionsAndRetain(
        [...replacements.values()].map(({ connection }) => connection),
      );
      release();
      if (this.#preparingActivation === preparation) this.#preparingActivation = undefined;
      markPreparedSettled();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          'Runtime MCP activation staging and cleanup both failed.',
        );
      }
      throw error;
    }
  }

  commitActivationReconcile(prepared: RuntimeMcpPreparedActivationReconcile): RuntimeMcpCommittedActivationReconcile {
    const record = this.#activation.get(prepared);
    if (record === undefined || record.reservationRevision !== prepared.reservationRevision || this.#mutation !== 'activation') {
      throw registryConflict('Runtime MCP activation reconciliation is no longer reserved.');
    }
    const previousState = record.current;
    const nextState = Object.freeze({
      descriptors: record.nextDescriptors,
      input: record.input,
      registryRevision: previousState === undefined ? 1 : previousState.registryRevision + (record.requiresRestart ? 1 : 0),
    });
    const transitions: Array<Readonly<{
      readonly descriptor: DevRuntimeMcpServerDescriptor;
      readonly replacement: ConnectedRuntimeMcp | undefined;
      readonly session: SessionRecord;
    }>> = [];
    if (record.requiresRestart) {
      for (const session of this.#sessions.values()) {
        const descriptor = record.nextDescriptors.get(descriptorKey(session.binding.serverName, session.binding.target));
        const replacement = record.replacements.get(session.id);
        if (descriptor === undefined || replacement === undefined) {
          throw registryConflict('Runtime MCP activation reconciliation is incomplete.');
        }
        transitions.push(Object.freeze({ descriptor, replacement, session }));
      }
    } else {
      for (const session of this.#sessions.values()) {
        const descriptor = record.nextDescriptors.get(descriptorKey(session.binding.serverName, session.binding.target));
        if (descriptor === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
        transitions.push(Object.freeze({ descriptor, replacement: undefined, session }));
      }
    }

    this.#activation.delete(prepared);
    this.#preparedActivations.delete(prepared);
    const retired: RetiredConnectionBatch['entries'][number][] = [];
    if (record.requiresRestart) {
      for (const { descriptor, replacement, session } of transitions) {
        retired.push(Object.freeze({
          abort: session.abort,
          connection: session.connection,
          operations: Object.freeze([...session.operations]),
        }));
        session.abort = new AbortController();
        session.connection = replacement!.connection;
        session.connectionState = replacement!.state;
        session.descriptor = descriptor;
        session.binding = this.#binding(session.id, session.binding.sessionRevision + 1, nextState, descriptor);
        session.state = 'ready';
      }
    } else {
      for (const { descriptor, session } of transitions) {
        session.descriptor = descriptor;
        session.binding = this.#binding(session.id, session.binding.sessionRevision, nextState, descriptor);
      }
    }
    this.#state = nextState;
    const result = this.#result(
      record.requiresRestart ? 'sessions-restarted' : 'implementation-updated',
      record.invalidatedBindings,
      record.requiresRestart ? [...this.#sessions.keys()] : [],
      nextState,
    );
    this.#mutation = 'none';
    const retirement: RetiredConnectionBatch | undefined = retired.length === 0
      ? undefined
      : { entries: Object.freeze(retired), finalization: undefined };
    if (retirement !== undefined) this.#retirements.add(retirement);
    let published = false;
    return Object.freeze({
      finalize: () => {
        return retirement === undefined ? Promise.resolve() : this.#finalizeRetirement(retirement);
      },
      publish: () => {
        if (published) return;
        published = true;
        this.#publishResult(result);
        if (record.requiresRestart) {
          for (const session of this.#sessions.values()) this.#emit('runtime.mcp.ready', session);
        }
      },
      result,
    });
  }

  async abortActivationReconcile(prepared: RuntimeMcpPreparedActivationReconcile): Promise<void> {
    const record = this.#activation.get(prepared);
    if (record === undefined) return;
    this.#activation.delete(prepared);
    this.#preparedActivations.delete(prepared);
    record.stagedAbort.abort(new Error('Runtime MCP activation reconciliation was aborted.'));
    const entries = [...record.replacements.entries()];
    const results = await Promise.allSettled(entries.map(async ([id, replacement]) => {
      await this.#closeOrRetain(replacement.connection);
      return id;
    }));
    this.#mutation = 'none';
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: `staged:${entries[index]![0]}` })]
      : []);
    if (failures.length > 0) throw new RuntimeMcpRegistryCloseError(failures);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closeAbort.abort(new Error('Runtime MCP registry was closed.'));
    this.#preparingActivation?.abort.abort(new Error('Runtime MCP registry was closed.'));
    for (const subscription of this.#subscriptions) subscription.closed = true;
    this.#subscriptions.clear();
    for (const controller of this.#opening.keys()) controller.abort(new Error('Runtime MCP registry was closed.'));
    this.#closePromise = this.#closeAll();
    return this.#closePromise;
  }

  async #closeAll(): Promise<void> {
    await Promise.all([...this.#publicMutations]);
    const preparing = this.#preparingActivation?.settled;
    if (preparing !== undefined) await preparing;
    const prepared = [...this.#preparedActivations];
    const activationResults = await Promise.allSettled(prepared.map((activation) => this.abortActivationReconcile(activation)));
    await Promise.all([...this.#opening.values()]);
    const retirements = [...this.#retirements];
    const retirementResults = await Promise.allSettled(retirements.map((retirement) => this.#finalizeRetirement(retirement)));
    const records = [...this.#sessions.values()];
    this.#sessions.clear();
    const results = await Promise.allSettled(records.map((record) => this.#closeRecord(record, new Error('Runtime MCP registry was closed.'))));
    const orphans = [...this.#orphanedConnections.values()];
    const orphanResults = await Promise.allSettled(orphans.map((orphan) => this.#finalizeOrphan(orphan)));
    const failures = [
      ...activationResults.flatMap((result, index) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: `activation:${prepared[index]!.reservationRevision}` })]
        : []),
      ...retirementResults.flatMap((result, index) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: `retirement:${index}` })]
        : []),
      ...results.flatMap((result, index) => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: `session:${records[index]!.id}` })]
      : []),
      ...orphanResults.flatMap((result, index) => result.status === 'rejected'
        ? [Object.freeze({ error: result.reason, resource: `orphan:${index}` })]
        : []),
    ];
    if (failures.length > 0) throw new RuntimeMcpRegistryCloseError(failures);
  }

  #ownedSession(record: SessionRecord): DevRuntimeMcpSession {
    return Object.freeze({
      close: async () => {
        if (record.closed) return;
        await this.#closeOwned(record);
      },
      ...this.#view(record),
    });
  }

  #view(record: SessionRecord): DevRuntimeMcpSessionView {
    return Object.freeze({
      execute: async (request: DevRuntimeMcpOperationRequest) => this.#execute(record, request),
      snapshot: () => this.#sessionSnapshot(record),
      watchClosed: (listener: (reason?: unknown) => Promise<void> | void) => this.#watchClosed(record, listener),
    });
  }

  async #closeOwned(record: SessionRecord): Promise<void> {
    const release = this.#reserve('public');
    const settle = this.#trackPublicMutation();
    try {
      if (record.closed) return;
      await this.#closeRecord(record, new Error('Runtime MCP session was closed.'));
      this.#sessions.delete(record.id);
    } finally {
      release();
      settle();
    }
  }

  #sessionSnapshot(record: SessionRecord): DevRuntimeMcpSessionSnapshot {
    return Object.freeze({ binding: record.binding, connection: record.connectionState, state: record.state });
  }

  #watchClosed(record: SessionRecord, listener: (reason?: unknown) => Promise<void> | void): DevRuntimeMcpSessionCloseObservation {
    if (typeof listener !== 'function') throw new TypeError('A runtime MCP session close listener is required.');
    if (record.closed) return Object.freeze({ closed: true, unsubscribe: () => undefined });
    record.watchers.add(listener);
    if (record.closed) {
      record.watchers.delete(listener);
      return Object.freeze({ closed: true, unsubscribe: () => undefined });
    }
    let subscribed = true;
    return Object.freeze({
      closed: false,
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        record.watchers.delete(listener);
      },
    });
  }

  async #execute(record: SessionRecord, request: DevRuntimeMcpOperationRequest): Promise<DevRuntimeMcpOperationResult> {
    this.#assertSessionReady(record, request.expectedSessionRevision);
    const binding = record.binding;
    const descriptor = record.descriptor;
    const sessionAbort = record.abort;
    const state = this.#requireState();
    const generationId = state.input.runtimeGenerationId;
    const lease = await this.#options.generationStore.lease(generationId);
    if (sessionAbort.signal.aborted) {
      await lease.release();
      throw sessionAbort.signal.reason ?? registryConflict('Runtime MCP session is restarting.');
    }
    const controller = new AbortController();
    const signal = combineSignals([this.#closeAbort.signal, sessionAbort.signal, controller.signal]);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const operation: OperationRecord = Object.freeze({ controller, done, sessionAbort });
    record.operations.add(operation);
    try {
      const value = staticValue(descriptor, request);
      const execution = value === undefined
        ? await this.#executeDynamic(descriptor, binding.sessionId, request, lease.generation, signal)
        : Object.freeze({ stateVersion: 0, value });
      const vector: RuntimeVector = Object.freeze({
        ...(this.#options.artifactEpochId() === undefined ? {} : { artifactEpochId: this.#options.artifactEpochId() }),
        providerSessionId: this.#options.providerSessionId,
        runtimeGenerationId: lease.generation.id,
        sourceRevision: lease.generation.sourceRevision,
        stateStoreId: this.#options.stateStoreId,
        stateVersion: execution.stateVersion,
      });
      return Object.freeze({
        operationId: this.#options.createOperationId(),
        sessionId: binding.sessionId,
        sessionRevision: binding.sessionRevision,
        value: finiteJson(execution.value),
        vector,
      });
    } finally {
      record.operations.delete(operation);
      resolveDone();
      await lease.release();
    }
  }

  async #executeDynamic(
    descriptor: DevRuntimeMcpServerDescriptor,
    sessionId: string,
    request: DevRuntimeMcpOperationRequest,
    generation: RuntimeGeneration,
    signal: AbortSignal,
  ): Promise<RuntimeMcpExecutionValue> {
    if (request.kind === 'call-tool' && !declaredTool(descriptor, request.name)) {
      throw registryInvalid(`Runtime MCP tool ${JSON.stringify(request.name)} is not declared.`);
    }
    if (request.kind === 'read-resource' && !declaredResource(descriptor, request.uri)) {
      throw registryInvalid(`Runtime MCP resource ${JSON.stringify(request.uri)} is not declared.`);
    }
    const value = await this.#options.executor(Object.freeze({
      descriptor,
      generation,
      request,
      sessionId,
      signal,
    }));
    if (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0) {
      throw registryInvalid('Runtime MCP executor returned an invalid state version.');
    }
    return Object.freeze({ stateVersion: value.stateVersion, value: finiteJson(value.value) });
  }

  #startVisibleRestart(
    current: RegistryState,
    input: DevRuntimeMcpRegistryReconcileInput,
    sessions: Iterable<SessionRecord>,
  ): readonly DevRuntimeMcpInvalidatedBinding[] {
    const next = Object.freeze({ descriptors: descriptorMap(input), input, registryRevision: current.registryRevision + 1 });
    const invalidated: DevRuntimeMcpInvalidatedBinding[] = [];
    const affected = [...sessions];
    for (const record of affected) {
      const descriptor = next.descriptors.get(descriptorKey(record.binding.serverName, record.binding.target));
      if (descriptor === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
    }
    for (const record of affected) {
      const descriptor = next.descriptors.get(descriptorKey(record.binding.serverName, record.binding.target));
      if (descriptor === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
      invalidated.push(bindingCopy(record.binding));
      record.descriptor = descriptor;
      record.binding = this.#binding(record.id, record.binding.sessionRevision + 1, next, descriptor);
      record.state = 'restarting';
      record.abort.abort(new Error('Runtime MCP session is restarting.'));
      this.#emit('runtime.mcp.restarting', record);
    }
    this.#state = next;
    return Object.freeze(invalidated);
  }

  #installImplementation(current: RegistryState, input: DevRuntimeMcpRegistryReconcileInput): void {
    const next = Object.freeze({ descriptors: descriptorMap(input), input, registryRevision: current.registryRevision });
    for (const record of this.#sessions.values()) {
      const descriptor = next.descriptors.get(descriptorKey(record.binding.serverName, record.binding.target));
      if (descriptor === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
    }
    for (const record of this.#sessions.values()) {
      const descriptor = next.descriptors.get(descriptorKey(record.binding.serverName, record.binding.target));
      if (descriptor === undefined) throw registryInvalid('A registered runtime MCP session no longer has a static descriptor.');
      record.descriptor = descriptor;
      record.binding = this.#binding(record.id, record.binding.sessionRevision, next, descriptor);
    }
    this.#state = next;
  }

  async #replaceVisibleConnection(record: SessionRecord): Promise<void> {
    const oldConnection = record.connection;
    const oldOperations = [...record.operations];
    await this.#cancelAndDrain(oldOperations, record.abort);
    if (oldConnection !== undefined) await this.#closeOrRetain(oldConnection);
    const nextAbort = new AbortController();
    record.abort = nextAbort;
    const connected = await this.#connectAndRelist(
      record.descriptor,
      record.id,
      combineSignals([this.#closeAbort.signal, nextAbort.signal]),
    );
    record.connection = connected.connection;
    record.connectionState = connected.state;
    record.state = 'ready';
  }

  #finalizeRetirement(retirement: RetiredConnectionBatch): Promise<void> {
    retirement.finalization ??= this.#finalizeRetirementInternal(retirement).then(
      () => { this.#retirements.delete(retirement); },
      (error: unknown) => {
        retirement.finalization = undefined;
        throw error;
      },
    );
    return retirement.finalization;
  }

  async #finalizeRetirementInternal(retirement: RetiredConnectionBatch): Promise<void> {
    const results = await Promise.allSettled(retirement.entries.flatMap((entry) => [
      this.#cancelAndDrain(entry.operations, entry.abort),
      ...(entry.connection === undefined ? [] : [this.#closeOrRetain(entry.connection)]),
    ]));
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: `retired:${index}` })]
      : []);
    if (failures.length > 0) throw new RuntimeMcpRegistryCloseError(failures);
  }

  async #closeRecord(record: SessionRecord, reason: unknown): Promise<void> {
    if (record.closed) return;
    record.closed = true;
    record.state = 'closed';
    record.abort.abort(reason);
    this.#notifyClosed(record, reason);
    const operations = [...record.operations];
    const connection = record.connection;
    record.connection = undefined;
    const results = await Promise.allSettled([
      this.#cancelAndDrain(operations, record.abort),
      ...(connection === undefined ? [] : [this.#closeOrRetain(connection)]),
    ]);
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [Object.freeze({ error: result.reason, resource: `${record.id}:${index}` })]
      : []);
    if (failures.length > 0) throw new RuntimeMcpRegistryCloseError(failures);
  }

  #retainOrphan(connection: RuntimeMcpConnection): void {
    if (this.#orphanedConnections.has(connection)) return;
    this.#orphanedConnections.set(connection, { connection, finalization: undefined });
  }

  async #closeOrRetain(connection: RuntimeMcpConnection): Promise<void> {
    try {
      await connection.close();
    } catch (error) {
      this.#retainOrphan(connection);
      throw error;
    }
  }

  #finalizeOrphan(orphan: OrphanedConnection): Promise<void> {
    orphan.finalization ??= this.#closeOrRetain(orphan.connection).then(
      () => { this.#orphanedConnections.delete(orphan.connection); },
      (error: unknown) => {
        orphan.finalization = undefined;
        throw error;
      },
    );
    return orphan.finalization;
  }

  async #closeConnectionsAndRetain(connections: readonly RuntimeMcpConnection[]): Promise<readonly unknown[]> {
    const results = await Promise.allSettled(connections.map((connection) => this.#closeOrRetain(connection)));
    return Object.freeze(results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
  }

  async #cancelAndDrain(operations: readonly OperationRecord[], abort: AbortController): Promise<void> {
    abort.abort(new Error('Runtime MCP session is restarting.'));
    for (const operation of operations) operation.controller.abort(new Error('Runtime MCP operation was cancelled.'));
    if (operations.length === 0) return;
    await Promise.race([
      Promise.allSettled(operations.map((operation) => operation.done)).then(() => undefined),
      timeout(restartDrainTimeoutMs),
    ]);
  }

  #notifyClosed(record: SessionRecord, reason: unknown): void {
    const listeners = [...record.watchers];
    record.watchers.clear();
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(reason)).catch(() => undefined);
      } catch {
        // Close observers cannot stop owned resource cleanup.
      }
    }
  }

  #binding(id: string, revision: number, state: RegistryState, descriptor: DevRuntimeMcpServerDescriptor): DevRuntimeMcpSessionBinding {
    return Object.freeze({
      definitionDigest: state.input.definitionDigest,
      providerSessionId: this.#options.providerSessionId,
      registryRevision: state.registryRevision,
      serverDigest: descriptor.serverDigest,
      serverName: descriptor.name,
      sessionId: id,
      sessionRevision: revision,
      stateStoreId: this.#options.stateStoreId,
      target: descriptor.target,
      transportDigest: state.input.transportDigest,
    });
  }

  #result(
    action: DevRuntimeMcpRegistryReconcileResult['action'],
    invalidatedBindings: readonly DevRuntimeMcpInvalidatedBinding[],
    restartedSessionIds: readonly string[],
    state: RegistryState,
  ): DevRuntimeMcpRegistryReconcileResult {
    return Object.freeze({
      action,
      invalidatedBindings: Object.freeze([...invalidatedBindings]),
      registryRevision: state.registryRevision,
      restartedSessionIds: Object.freeze([...restartedSessionIds]),
      runtimeGenerationId: state.input.runtimeGenerationId,
      sequence: ++this.#sequence,
    });
  }

  #publishResult(result: DevRuntimeMcpRegistryReconcileResult): void {
    this.#pendingPublications.set(result.sequence, result);
    if (this.#publishing) return;
    this.#publishing = true;
    try {
      while (true) {
        const next = this.#pendingPublications.get(this.#nextPublicationSequence);
        if (next === undefined) return;
        this.#pendingPublications.delete(next.sequence);
        this.#nextPublicationSequence += 1;
        this.#history.push(next);
        if (this.#history.length > maxRetainedResults) this.#history.splice(0, this.#history.length - maxRetainedResults);
        const subscribers = [...this.#subscriptions];
        for (const subscription of subscribers) {
          if (subscription.closed) continue;
          if (subscription.replaying) subscription.pending.push(next);
          else this.#deliver(subscription, next);
        }
      }
    } finally {
      this.#publishing = false;
    }
  }

  #deliver(subscription: Subscription, message: RuntimeMcpRegistryMessage): void {
    if (subscription.closed) return;
    if ('sequence' in message) {
      if (message.sequence <= subscription.lastDeliveredSequence) return;
      subscription.lastDeliveredSequence = message.sequence;
    }
    try {
      subscription.listener(message);
    } catch {
      this.#unsubscribe(subscription);
    }
  }

  #unsubscribe(subscription: Subscription): void {
    if (subscription.closed) return;
    subscription.closed = true;
    subscription.pending.length = 0;
    this.#subscriptions.delete(subscription);
  }

  #emit(type: DevRuntimeEventInput['type'], record: SessionRecord): void {
    this.#options.emit(Object.freeze({
      mcpRegistryRevision: record.binding.registryRevision,
      mcpSessionId: record.id,
      mcpSessionRevision: record.binding.sessionRevision,
      runtimeGenerationId: this.#state?.input.runtimeGenerationId,
      type,
    }));
  }

  #sessionForControl(request: DevRuntimeMcpSessionControlRequest): SessionRecord {
    const record = this.#sessions.get(request.sessionId);
    if (record === undefined || record.closed) throw registryNotFound('Runtime MCP session was not found.');
    if (request.expectedSessionRevision !== record.binding.sessionRevision) {
      throw registryConflict('Expected runtime MCP session revision does not match the current session revision.');
    }
    return record;
  }

  #assertSessionReady(record: SessionRecord, expectedRevision: number): void {
    if (this.#closed || record.closed) throw registryClosed();
    if (expectedRevision !== record.binding.sessionRevision) {
      throw registryConflict('Expected runtime MCP session revision does not match the current session revision.');
    }
    if (record.state === 'restarting') throw registryConflict('Runtime MCP session is restarting.');
    if (record.state !== 'ready' || record.connection === undefined) throw registryConflict('Runtime MCP session is not ready.');
  }

  #requireState(): RegistryState {
    if (this.#closed) throw registryClosed();
    if (this.#state === undefined) throw registryConflict('Runtime MCP registry has not been reconciled.');
    return this.#state;
  }

  #reserve(lane: Exclude<MutationLane, 'none'>): () => void {
    if (this.#closed) throw registryClosed();
    if (this.#mutation !== 'none') throw registryConflict('Runtime MCP registry mutation is reserved.');
    this.#mutation = lane;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#mutation === lane) this.#mutation = 'none';
    };
  }

  #trackPublicMutation(): () => void {
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    this.#publicMutations.add(settled);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#publicMutations.delete(settled);
      resolve();
    };
  }

  async #connect(descriptor: DevRuntimeMcpServerDescriptor, sessionId: string, signal: AbortSignal): Promise<RuntimeMcpConnection> {
    if (signal.aborted) throw signal.reason ?? registryClosed();
    const connection = await this.#options.connector.connect(Object.freeze({ descriptor, sessionId, signal }));
    if (signal.aborted) {
      await this.#closeAfterFailedSetup(connection, signal.reason ?? registryClosed());
    }
    return connection;
  }

  async #connectAndRelist(
    descriptor: DevRuntimeMcpServerDescriptor,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ConnectedRuntimeMcp> {
    const connection = await this.#connect(descriptor, sessionId, signal);
    try {
      const state = finiteConnectionState(await connection.relist());
      if (signal.aborted) throw signal.reason ?? registryClosed();
      return Object.freeze({ connection, state });
    } catch (error) {
      return this.#closeAfterFailedSetup(connection, error);
    }
  }

  async #closeAfterFailedSetup(connection: RuntimeMcpConnection, error: unknown): Promise<never> {
    const cleanupFailures = await this.#closeConnectionsAndRetain([connection]);
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'Runtime MCP connection setup and cleanup both failed.');
    }
    throw error;
  }
}

const requiresRestart = (
  current: DevRuntimeMcpRegistryReconcileInput,
  input: DevRuntimeMcpRegistryReconcileInput,
): boolean => current.definitionDigest !== input.definitionDigest || current.transportDigest !== input.transportDigest;

const bindingCopy = (binding: DevRuntimeMcpSessionBinding): DevRuntimeMcpInvalidatedBinding => Object.freeze({
  sessionId: binding.sessionId,
  sessionRevision: binding.sessionRevision,
});

const combineSignals = (signals: readonly AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) abort(signal);
    else signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
};

const finiteConnectionState = (input: DevRuntimeMcpConnectionState): DevRuntimeMcpConnectionState => Object.freeze({
  capabilities: input.capabilities === undefined ? undefined : jsonObject(input.capabilities, 'Runtime MCP connection capabilities'),
  protocolEra: input.protocolEra,
  protocolVersion: input.protocolVersion,
  server: input.server === undefined ? undefined : Object.freeze({
    name: nonempty(input.server.name, 'Runtime MCP connection server name'),
    version: nonempty(input.server.version, 'Runtime MCP connection server version'),
  }),
});
