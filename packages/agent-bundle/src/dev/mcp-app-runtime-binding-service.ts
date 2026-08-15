import { randomUUID } from 'node:crypto';

import { cloneMcpAppFiniteJson, type McpAppJsonValue } from './mcp-app-metadata.ts';
import type { DevRuntimeMcpSessionView } from './runtime-provider.ts';
import type {
  DevRuntimeMcpAppRunBinding,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpSessionBinding,
  RuntimeVector,
} from './runtime-protocol.ts';

export type McpAppProfileId = 'portable' | 'chatgpt' | 'claude';

export interface McpAppStableSessionIdentity {
  readonly definitionDigest: string;
  readonly registryRevision: number;
  readonly serverDigest: string;
  readonly serverName: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly target: string;
  readonly transportDigest: string;
}

/** The complete browser-safe RuntimeVector projection; private authority fields are intentionally absent. */
export interface McpAppPublicRuntimeVector {
  readonly artifactEpochId?: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly stateVersion: number;
}

export interface McpAppPreviewBindingVector extends McpAppStableSessionIdentity {
  readonly evidence: 'simulated';
  readonly profileId: McpAppProfileId;
  readonly profileVersion: string;
  /** Serializable projection: provider/state authority remains private to the service. */
  readonly runVector: McpAppPublicRuntimeVector;
}

export interface McpAppRuntimeBindingSnapshot extends McpAppPreviewBindingVector {
  readonly id: string;
}

export interface McpAppBoundOperationResult {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly value: McpAppJsonValue;
  /** Serializable projection of the leased current implementation vector. */
  readonly vector: McpAppPublicRuntimeVector;
}

export interface McpAppRuntimeBindingTeardown {
  (event: Readonly<{
    readonly binding: McpAppRuntimeBindingSnapshot;
    readonly reason: 'app-closed' | 'runtime-shutdown' | 'session-closed' | 'session-invalidated';
  }>): Promise<void> | void;
}

export interface CreateMcpAppRuntimeBindingOptions {
  readonly onTeardown?: McpAppRuntimeBindingTeardown;
  readonly profileId: McpAppProfileId;
  readonly runBinding: DevRuntimeMcpAppRunBinding;
  readonly runVector: RuntimeVector;
  /** A non-owning stable registry view; runtime App bindings can never close it. */
  readonly session: DevRuntimeMcpSessionView;
}

export type McpAppRuntimeOperationRequest =
  | Readonly<{ readonly kind: 'list-tools' }>
  | Readonly<{ readonly kind: 'list-resources' }>
  | Readonly<{ readonly arguments?: McpAppJsonValue; readonly kind: 'call-tool'; readonly name: string }>
  | Readonly<{ readonly kind: 'read-resource'; readonly uri: string }>;

export interface McpAppRuntimeBindingInvalidation {
  readonly sessionId: string;
  readonly sessionRevision: number;
}

interface McpAppRuntimeBinding {
  closing: boolean;
  readonly operations: Set<Promise<void>>;
  readonly privateRunVector: RuntimeVector;
  releaseAttempt: Promise<void> | undefined;
  readonly session: DevRuntimeMcpSessionView;
  readonly snapshot: McpAppRuntimeBindingSnapshot;
  readonly teardown: McpAppRuntimeBindingTeardown | undefined;
  unsubscribe: () => void;
}

const PROFILE_VERSIONS: Readonly<Record<McpAppProfileId, string>> = Object.freeze({
  chatgpt: 'agent-bundle:chatgpt-sim:1',
  claude: 'agent-bundle:claude-sim:1',
  portable: 'agent-bundle:mcp-apps:2026-01-26',
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
};

const revision = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
};

const stateVersion = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
};

const cloneVector = (value: RuntimeVector, label: string): RuntimeVector => Object.freeze({
  ...(value.artifactEpochId === undefined ? {} : { artifactEpochId: nonempty(value.artifactEpochId, `${label} artifact epoch`) }),
  providerSessionId: nonempty(value.providerSessionId, `${label} provider session id`),
  runtimeGenerationId: nonempty(value.runtimeGenerationId, `${label} generation id`),
  sourceRevision: nonempty(value.sourceRevision, `${label} source revision`),
  stateStoreId: nonempty(value.stateStoreId, `${label} state store id`),
  stateVersion: stateVersion(value.stateVersion, `${label} state version`),
});

/** Redacts trusted provider/state authority before any value is serializable to the browser. */
const publicVector = (value: RuntimeVector): McpAppPublicRuntimeVector => Object.freeze({
  ...(value.artifactEpochId === undefined ? {} : { artifactEpochId: value.artifactEpochId }),
  runtimeGenerationId: value.runtimeGenerationId,
  sourceRevision: value.sourceRevision,
  stateVersion: value.stateVersion,
});

const profile = (value: McpAppProfileId): McpAppProfileId => {
  if (value === 'portable' || value === 'chatgpt' || value === 'claude') return value;
  throw new TypeError(`Unsupported MCP App profile ${JSON.stringify(value)}.`);
};

const stableIdentity = (binding: DevRuntimeMcpAppRunBinding, label: string): McpAppStableSessionIdentity => Object.freeze({
  definitionDigest: nonempty(binding.definitionDigest, `${label} definition digest`),
  registryRevision: revision(binding.registryRevision, `${label} registry revision`),
  serverDigest: nonempty(binding.serverDigest, `${label} server digest`),
  serverName: nonempty(binding.serverName, `${label} server name`),
  sessionId: nonempty(binding.sessionId, `${label} session id`),
  sessionRevision: revision(binding.sessionRevision, `${label} session revision`),
  target: nonempty(binding.target, `${label} target`),
  transportDigest: nonempty(binding.transportDigest, `${label} transport digest`),
});

const sameStableIdentity = (left: McpAppStableSessionIdentity, right: McpAppStableSessionIdentity): boolean =>
  left.sessionId === right.sessionId
  && left.sessionRevision === right.sessionRevision
  && left.registryRevision === right.registryRevision
  && left.target === right.target
  && left.serverName === right.serverName
  && left.definitionDigest === right.definitionDigest
  && left.transportDigest === right.transportDigest
  && left.serverDigest === right.serverDigest;

const snapshotIdentity = (binding: DevRuntimeMcpSessionBinding): McpAppStableSessionIdentity => stableIdentity(binding, 'Live runtime MCP session');

const canonicalOperation = (request: McpAppRuntimeOperationRequest, expectedSessionRevision: number): DevRuntimeMcpOperationRequest => {
  if (!isRecord(request) || typeof request.kind !== 'string') throw new TypeError('Runtime MCP App operation must be an object.');
  if (request.kind === 'list-tools' || request.kind === 'list-resources') {
    return Object.freeze({ expectedSessionRevision, kind: request.kind });
  }
  if (request.kind === 'read-resource') {
    return Object.freeze({ expectedSessionRevision, kind: 'read-resource', uri: nonempty(request.uri, 'Runtime MCP App resource URI') });
  }
  if (request.kind === 'call-tool') {
    const argumentsValue = request.arguments === undefined ? Object.freeze({}) : cloneMcpAppFiniteJson(request.arguments, 'Runtime MCP App tool arguments');
    if (!isRecord(argumentsValue)) throw new TypeError('Runtime MCP App tool arguments must be a finite JSON object.');
    return Object.freeze({
      arguments: argumentsValue as Readonly<Record<string, McpAppJsonValue>>,
      expectedSessionRevision,
      kind: 'call-tool',
      name: nonempty(request.name, 'Runtime MCP App tool name'),
    });
  }
  throw new TypeError('Unsupported Runtime MCP App operation.');
};

export class McpAppRuntimeBindingService {
  readonly #entries = new Map<string, McpAppRuntimeBinding>();
  readonly #pendingReleases = new Map<string, McpAppRuntimeBinding>();
  #closeAttempt: Promise<void> | undefined;
  #closing = false;

  get(bindingId: string): McpAppRuntimeBindingSnapshot | undefined {
    return this.#entries.get(bindingId)?.snapshot;
  }

  async createBinding(options: CreateMcpAppRuntimeBindingOptions): Promise<McpAppRuntimeBindingSnapshot> {
    if (this.#closing) throw new Error('Runtime MCP App binding service is closed.');
    if (options === null || typeof options !== 'object') throw new TypeError('Runtime MCP App binding options must be an object.');
    if (options.onTeardown !== undefined && typeof options.onTeardown !== 'function') throw new TypeError('Runtime MCP App teardown callback must be a function.');
    const profileId = profile(options.profileId);
    const runIdentity = stableIdentity(options.runBinding, 'Stored runtime MCP App binding');
    const privateRunVector = cloneVector(options.runVector, 'Stored runtime run vector');
    const liveSnapshot = options.session.snapshot();
    const liveIdentity = snapshotIdentity(liveSnapshot.binding);
    if (!sameStableIdentity(runIdentity, liveIdentity)
      || liveSnapshot.binding.providerSessionId !== privateRunVector.providerSessionId
      || liveSnapshot.binding.stateStoreId !== privateRunVector.stateStoreId) {
      throw new Error('Stored runtime MCP App binding does not match the live stable runtime MCP session.');
    }
    if (liveSnapshot.state === 'closed') throw new Error('Runtime MCP session closed before its App binding completed.');

    let entry: McpAppRuntimeBinding | undefined;
    let sessionClosed = false;
    const observation = options.session.watchClosed(() => {
      sessionClosed = true;
      return entry === undefined ? undefined : this.#releaseEntry(entry, 'session-closed');
    });
    try {
      sessionClosed ||= observation.closed;
      if (sessionClosed || this.#closing) throw new Error('Runtime MCP session closed before its App binding completed.');
      const snapshot = Object.freeze({
        ...runIdentity,
        evidence: 'simulated' as const,
        id: randomUUID(),
        profileId,
        profileVersion: PROFILE_VERSIONS[profileId],
        runVector: publicVector(privateRunVector),
      });
      entry = {
        closing: false,
        operations: new Set(),
        privateRunVector,
        releaseAttempt: undefined,
        session: options.session,
        snapshot,
        teardown: options.onTeardown,
        unsubscribe: observation.unsubscribe,
      };
      this.#entries.set(snapshot.id, entry);
      if (sessionClosed || this.#closing) {
        await this.#releaseEntry(entry, this.#closing ? 'runtime-shutdown' : 'session-closed');
        throw new Error('Runtime MCP session closed before its App binding completed.');
      }
      return snapshot;
    } catch (error) {
      if (entry === undefined) observation.unsubscribe();
      throw error;
    }
  }

  async execute(bindingId: string, request: McpAppRuntimeOperationRequest): Promise<McpAppBoundOperationResult> {
    const entry = this.#entry(bindingId);
    const canonical = canonicalOperation(request, entry.snapshot.sessionRevision);
    let finish: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    entry.operations.add(settled);
    try {
      const operation = await entry.session.execute(canonical);
      this.#assertActive(entry);
      return this.#operationResult(entry, operation);
    } finally {
      entry.operations.delete(settled);
      finish?.();
    }
  }

  async closeBinding(bindingId: string): Promise<boolean> {
    const entry = this.#entries.get(bindingId) ?? this.#pendingReleases.get(bindingId);
    if (entry === undefined) return false;
    await this.#releaseEntry(entry, 'app-closed');
    return true;
  }

  async invalidateBindings(invalidation: McpAppRuntimeBindingInvalidation): Promise<void> {
    const sessionId = nonempty(invalidation.sessionId, 'Runtime MCP App invalidation session id');
    const sessionRevision = revision(invalidation.sessionRevision, 'Runtime MCP App invalidation session revision');
    const entries = [...new Set([...this.#entries.values(), ...this.#pendingReleases.values()])].filter((entry) =>
      entry.snapshot.sessionId === sessionId && entry.snapshot.sessionRevision === sessionRevision,
    );
    const outcomes = await Promise.allSettled(entries.map(async (entry) => this.#releaseEntry(entry, 'session-invalidated')));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
  }

  async close(): Promise<void> {
    if (this.#closeAttempt !== undefined) return this.#closeAttempt;
    this.#closing = true;
    const close = (async () => {
      const entries = [...new Set([...this.#entries.values(), ...this.#pendingReleases.values()])];
      const outcomes = await Promise.allSettled(entries.map(async (entry) => this.#releaseEntry(entry, 'runtime-shutdown')));
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      if (failure !== undefined) throw failure.reason;
    })();
    this.#closeAttempt = close;
    return close;
  }

  #entry(bindingId: string): McpAppRuntimeBinding {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closing) throw new Error(`Unknown runtime MCP App binding ${JSON.stringify(bindingId)}.`);
    return entry;
  }

  #assertActive(entry: McpAppRuntimeBinding): void {
    if (entry.closing || this.#entries.get(entry.snapshot.id) !== entry) {
      throw new Error(`Runtime MCP App binding ${JSON.stringify(entry.snapshot.id)} is closed.`);
    }
  }

  #operationResult(entry: McpAppRuntimeBinding, operation: DevRuntimeMcpOperationResult): McpAppBoundOperationResult {
    if (operation.sessionId !== entry.snapshot.sessionId) {
      throw new Error('Runtime MCP operation returned another session identity.');
    }
    if (operation.sessionRevision !== entry.snapshot.sessionRevision) {
      throw new Error('Runtime MCP operation returned another session revision.');
    }
    const privateVector = cloneVector(operation.vector, 'Runtime MCP operation vector');
    if (privateVector.providerSessionId !== entry.privateRunVector.providerSessionId
      || privateVector.stateStoreId !== entry.privateRunVector.stateStoreId) {
      throw new Error('Runtime MCP operation returned a foreign provider/state authority.');
    }
    return Object.freeze({
      operationId: nonempty(operation.operationId, 'Runtime MCP operation id'),
      sessionId: entry.snapshot.sessionId,
      sessionRevision: entry.snapshot.sessionRevision,
      value: cloneMcpAppFiniteJson(operation.value, 'Runtime MCP operation result'),
      vector: publicVector(privateVector),
    });
  }

  #releaseEntry(
    entry: McpAppRuntimeBinding,
    reason: 'app-closed' | 'runtime-shutdown' | 'session-closed' | 'session-invalidated',
  ): Promise<void> {
    if (entry.releaseAttempt !== undefined) return entry.releaseAttempt;
    entry.closing = true;
    entry.unsubscribe();
    this.#entries.delete(entry.snapshot.id);
    const release = (async () => {
      await Promise.allSettled([...entry.operations]);
      if (entry.teardown !== undefined) await entry.teardown(Object.freeze({ binding: entry.snapshot, reason }));
    })();
    entry.releaseAttempt = release;
    this.#pendingReleases.set(entry.snapshot.id, entry);
    void release.then(
      () => {
        if (this.#pendingReleases.get(entry.snapshot.id) === entry) this.#pendingReleases.delete(entry.snapshot.id);
      },
      () => undefined,
    );
    return release;
  }
}
