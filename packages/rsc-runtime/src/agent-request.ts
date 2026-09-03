import { AsyncLocalStorage } from 'node:async_hooks';

import type { JsonValue } from './lower-mcp.js';
import type {
  AgentNoticeLedger,
  AgentNoticeRequestLease,
  AgentNoticesHandle,
} from './notices/contract.js';
import type { AgentStateHandle } from './state/contract.js';

export const AGENT_REQUEST_STORE_VERSION = 2;

const STORE_SYMBOL = Symbol.for('@agent-bundle/runtime/request-store');

export type AgentInvocationKind = 'tool' | 'event' | 'cli' | 'script' | 'workbench';

export interface AgentToolInvocationProps {
  readonly input: JsonValue;
  readonly operationId: string;
}

export interface AgentEventInvocationProps {
  readonly event: string;
  readonly payload: JsonValue;
}

export interface AgentCliInvocationProps {
  readonly args: readonly string[];
  readonly command: string;
}

export interface AgentScriptInvocationProps {
  readonly input?: JsonValue;
  readonly name: string;
}

export interface AgentWorkbenchInvocationProps {
  readonly input?: JsonValue;
  readonly view: string;
}

export type AgentRenderInvocation =
  | { readonly kind: 'tool'; readonly props: AgentToolInvocationProps }
  | { readonly kind: 'event'; readonly props: AgentEventInvocationProps }
  | { readonly kind: 'cli'; readonly props: AgentCliInvocationProps }
  | { readonly kind: 'script'; readonly props: AgentScriptInvocationProps }
  | { readonly kind: 'workbench'; readonly props: AgentWorkbenchInvocationProps };

export type ObservedSource = 'native' | 'receipt' | 'derived';

export type AgentContextUnavailableReason =
  | 'not-provided'
  | 'unsupported-surface'
  | 'host-omitted'
  | 'unauthenticated';

export type Observed<T> =
  | { readonly source: ObservedSource; readonly state: 'available'; readonly value: T }
  | { readonly reason: AgentContextUnavailableReason; readonly state: 'unavailable' };

export interface AgentHostIdentity {
  readonly name: string;
}

export interface AgentSessionIdentity {
  readonly sessionId: string;
}

export interface AgentActorIdentity {
  readonly id: string;
}

export interface AgentWorkspaceIdentity {
  readonly root: string;
}

export interface AgentFilesystemAuthority {
  readonly roots: readonly string[];
}

export interface AgentCommandAuthority {
  readonly cwd: string;
}

export interface AgentNetworkAuthority {
  readonly allow: readonly string[];
}

export interface AgentProjectRootAuthority {
  readonly root: string;
}

export interface AgentRequestCapabilities {
  readonly command: Observed<AgentCommandAuthority>;
  readonly filesystem: Observed<AgentFilesystemAuthority>;
  readonly network: Observed<AgentNetworkAuthority>;
  readonly projectRoot: Observed<AgentProjectRootAuthority>;
}

export interface AgentProgressUpdate {
  readonly completed?: number;
  readonly message: string;
  readonly total?: number;
}

export interface AgentProgressReporter {
  readonly report: (update: AgentProgressUpdate) => Promise<void>;
}

export type AgentServiceRegistry = Readonly<Record<string, unknown>>;

/**
 * The framework-owned `processLifetime` provider every generated request
 * scope installs: one identity per generated process (Flight worker,
 * rendered-route worker, or routed-CLI executable) with a per-request hit
 * counter. Absent outside generated scopes, so it is typed optional.
 */
export interface AgentProcessLifetime {
  readonly hits: number;
  readonly instanceId: string;
  readonly pid: number;
}

/**
 * Request-scoped provider values keyed by camel-cased provider name. This is
 * an augmentable interface: the compiler's generated `.agent-bundle/routes.d.ts`
 * declares the project's conventional `src/providers/*` keys with their
 * resolved factory return types, so `(await agent()).providers.<key>` is typed
 * without a framework change per provider. Keys without a declaration remain
 * `unknown`.
 */
export interface AgentProviderValues {
  readonly [key: string]: unknown;
  readonly processLifetime?: AgentProcessLifetime;
}

export interface AgentInvocation {
  readonly artifactEpoch?: string;
  readonly hostContractRevision?: string;
  readonly id: string;
  readonly kind: AgentInvocationKind;
  readonly operationId?: string;
  readonly protocolRevision?: string;
  readonly sourceRevision?: string;
  readonly startedAt: string;
  readonly surface?: string;
}

export type AgentInvocationInput = Pick<AgentInvocation, 'kind'> & Partial<Omit<AgentInvocation, 'kind'>>;

export interface AgentRequestContext {
  readonly invocation: AgentInvocation;
  readonly host: Observed<AgentHostIdentity>;
  readonly session: Observed<AgentSessionIdentity>;
  readonly actor: Observed<AgentActorIdentity>;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
  readonly capabilities: AgentRequestCapabilities;
  readonly progress: AgentProgressReporter;
  readonly signal: AbortSignal;
  readonly services: AgentServiceRegistry;
  readonly providers: AgentProviderValues;
  /**
   * State kernel handle (#98) installed by the host wiring via
   * `runAgentRequest({ state })`; undefined for stateless projects.
   */
  readonly state: AgentStateHandle | undefined;
  /**
   * Request-bound recipient notice handle (#99). `inbox()` exposes authorized
   * pending notices without acknowledging them, `read()` exposes notices
   * attempted on this admitted event, and `publish()` persists a detached
   * Agent Document snapshot after publish-time authorization.
   */
  readonly notices: AgentNoticesHandle | undefined;
}

export interface AgentRequestInit {
  readonly actor?: Observed<AgentActorIdentity>;
  readonly capabilities?: AgentRequestCapabilities;
  readonly host?: Observed<AgentHostIdentity>;
  readonly invocation: AgentInvocationInput;
  /** Optional durable notice authority; omitted projects load no notice code. */
  readonly noticeLedger?: AgentNoticeLedger;
  readonly progress?: AgentProgressReporter;
  readonly providers?: AgentProviderValues;
  readonly services?: AgentServiceRegistry;
  readonly session?: Observed<AgentSessionIdentity>;
  readonly signal?: AbortSignal;
  /** Request-bound state handle from `createAgentStateHandle` (subpath `./state`). */
  readonly state?: AgentStateHandle;
  readonly workspace?: Observed<AgentWorkspaceIdentity>;
}

export type AgentRequestErrorCode = 'invalid-invocation' | 'outside-invocation' | 'request-closed' | 'store-version-conflict';

export class AgentRequestError extends Error {
  readonly code: AgentRequestErrorCode;

  constructor(code: AgentRequestErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'AgentRequestError';
  }
}

const freezeValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeValue(item))) as T;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const copy: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      copy[key] = freezeValue(nested);
    }
    return Object.freeze(copy) as T;
  }
  return value;
};

export const available = <T>(value: T, source: ObservedSource): Observed<T> => Object.freeze({
  source,
  state: 'available',
  value: freezeValue(value),
});

export const unavailable = <T = never>(reason: AgentContextUnavailableReason = 'not-provided'): Observed<T> =>
  Object.freeze({ reason, state: 'unavailable' });

const snapshotObserved = <T>(observed: Observed<T>): Observed<T> => (
  observed.state === 'available'
    ? available(observed.value, observed.source)
    : unavailable(observed.reason)
);

const silentProgress: AgentProgressReporter = Object.freeze({
  report: async () => undefined,
});

const emptyCapabilities = (): AgentRequestCapabilities => Object.freeze({
  command: unavailable<AgentCommandAuthority>(),
  filesystem: unavailable<AgentFilesystemAuthority>(),
  network: unavailable<AgentNetworkAuthority>(),
  projectRoot: unavailable<AgentProjectRootAuthority>(),
});

const snapshotCapabilities = (capabilities: AgentRequestCapabilities): AgentRequestCapabilities =>
  Object.freeze({
    command: snapshotObserved(capabilities.command),
    filesystem: snapshotObserved(capabilities.filesystem),
    network: snapshotObserved(capabilities.network),
    projectRoot: snapshotObserved(capabilities.projectRoot),
  });

const optionalText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value.trim() === '') {
    throw new AgentRequestError('invalid-invocation', 'Agent invocation fields must be non-empty when present');
  }
  return value;
};

const invocationFrom = (input: AgentInvocationInput): AgentInvocation => Object.freeze({
  id: optionalText(input.id) ?? crypto.randomUUID(),
  kind: input.kind,
  startedAt: optionalText(input.startedAt) ?? new Date().toISOString(),
  ...(input.artifactEpoch === undefined ? {} : { artifactEpoch: optionalText(input.artifactEpoch) }),
  ...(input.hostContractRevision === undefined ? {} : { hostContractRevision: optionalText(input.hostContractRevision) }),
  ...(input.operationId === undefined ? {} : { operationId: optionalText(input.operationId) }),
  ...(input.protocolRevision === undefined ? {} : { protocolRevision: optionalText(input.protocolRevision) }),
  ...(input.sourceRevision === undefined ? {} : { sourceRevision: optionalText(input.sourceRevision) }),
  ...(input.surface === undefined ? {} : { surface: optionalText(input.surface) }),
});

interface FrozenValues {
  readonly actor: Observed<AgentActorIdentity>;
  readonly capabilities: AgentRequestCapabilities;
  readonly host: Observed<AgentHostIdentity>;
  readonly invocation: AgentInvocation;
  readonly notices: AgentNoticesHandle | undefined;
  readonly progress: AgentProgressReporter;
  readonly providers: AgentProviderValues;
  readonly services: AgentServiceRegistry;
  readonly session: Observed<AgentSessionIdentity>;
  readonly signal: AbortSignal;
  readonly state: AgentStateHandle | undefined;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
}

/** A class so the lease/handle reference cycle closes in the constructor without casts. */
class Lease {
  closed = false;
  readonly handle: AgentRequestContext;

  constructor(readonly values: FrozenValues) {
    this.handle = createHandle(this);
  }
}

interface RealmStore {
  readonly storage: AsyncLocalStorage<Lease>;
  readonly version: number;
}

const realm = globalThis as typeof globalThis & {
  [STORE_SYMBOL]?: RealmStore;
};

const getStore = (): RealmStore => {
  const existing = realm[STORE_SYMBOL];
  if (existing !== undefined) {
    if (existing.version !== AGENT_REQUEST_STORE_VERSION) {
      throw new AgentRequestError(
        'store-version-conflict',
        `Incompatible @agent-bundle/runtime request store version: found ${String(existing.version)}, expected ${String(AGENT_REQUEST_STORE_VERSION)}`,
      );
    }
    return existing;
  }
  const created: RealmStore = {
    storage: new AsyncLocalStorage<Lease>(),
    version: AGENT_REQUEST_STORE_VERSION,
  };
  realm[STORE_SYMBOL] = created;
  return created;
};

const open = (lease: Lease): FrozenValues => {
  if (lease.closed) {
    throw new AgentRequestError('request-closed', 'agent() used after the request completed');
  }
  return lease.values;
};

const createHandle = (lease: Lease): AgentRequestContext => Object.freeze({
  get invocation() {
    return open(lease).invocation;
  },
  get host() {
    return open(lease).host;
  },
  get session() {
    return open(lease).session;
  },
  get actor() {
    return open(lease).actor;
  },
  get workspace() {
    return open(lease).workspace;
  },
  get capabilities() {
    return open(lease).capabilities;
  },
  get progress() {
    return open(lease).progress;
  },
  get signal() {
    return open(lease).signal;
  },
  get services() {
    return open(lease).services;
  },
  get providers() {
    return open(lease).providers;
  },
  get state() {
    return open(lease).state;
  },
  get notices() {
    return open(lease).notices;
  },
});

const currentLease = (): Lease => {
  const lease = getStore().storage.getStore();
  if (lease === undefined) {
    throw new AgentRequestError('outside-invocation', 'agent() used outside a real invocation');
  }
  return lease;
};

export const currentAgentRequest = (): AgentRequestContext | undefined => {
  const lease = getStore().storage.getStore();
  return lease === undefined || lease.closed ? undefined : lease.handle;
};

export const agent = async (): Promise<AgentRequestContext> => {
  const lease = currentLease();
  open(lease);
  return lease.handle;
};

export const runAgentRequest = async <T>(
  init: AgentRequestInit,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const actor = snapshotObserved(init.actor ?? unavailable<AgentActorIdentity>());
  const host = snapshotObserved(init.host ?? unavailable<AgentHostIdentity>());
  const invocation = invocationFrom(init.invocation);
  const session = snapshotObserved(init.session ?? unavailable<AgentSessionIdentity>());
  const signal = init.signal ?? new AbortController().signal;
  const workspace = snapshotObserved(init.workspace ?? unavailable<AgentWorkspaceIdentity>());
  const noticeLease: AgentNoticeRequestLease | undefined = init.noticeLedger === undefined
    ? undefined
    : await init.noticeLedger.openRequest({
      invocation,
      principal: Object.freeze({ actor, host, session, workspace }),
      signal,
    });
  const values: FrozenValues = Object.freeze({
    actor,
    capabilities: snapshotCapabilities(init.capabilities ?? emptyCapabilities()),
    host,
    invocation,
    notices: noticeLease?.handle,
    progress: init.progress ?? silentProgress,
    providers: Object.freeze({ ...(init.providers ?? {}) }),
    services: Object.freeze({ ...(init.services ?? {}) }),
    session,
    signal,
    state: init.state,
    workspace,
  });
  const lease = new Lease(values);

  try {
    return await getStore().storage.run(lease, operation);
  } finally {
    lease.closed = true;
    noticeLease?.close();
  }
};
