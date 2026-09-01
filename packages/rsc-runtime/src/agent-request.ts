import { AsyncLocalStorage } from 'node:async_hooks';

export const AGENT_REQUEST_STORE_VERSION = 1;

const STORE_SYMBOL = Symbol.for('@agent-bundle/rsc-runtime/request-store');

export type AgentInvocationKind = 'tool' | 'event' | 'cli' | 'script' | 'workbench';

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

export type AgentProviderValues = Readonly<Record<string, unknown>>;

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
  /** Reserved for the durable state kernel (#98). Wave 1 leaves this undefined. */
  readonly state: undefined;
  /** Reserved for recipient-aware notices (#99). Wave 1 leaves this undefined. */
  readonly notices: undefined;
}

export interface AgentRequestInit {
  readonly actor?: Observed<AgentActorIdentity>;
  readonly capabilities?: AgentRequestCapabilities;
  readonly host?: Observed<AgentHostIdentity>;
  readonly invocation: AgentInvocationInput;
  readonly progress?: AgentProgressReporter;
  readonly providers?: AgentProviderValues;
  readonly services?: AgentServiceRegistry;
  readonly session?: Observed<AgentSessionIdentity>;
  readonly signal?: AbortSignal;
  readonly workspace?: Observed<AgentWorkspaceIdentity>;
}

export type AgentRequestErrorCode = 'outside-invocation' | 'request-closed' | 'store-version-conflict';

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

const silentProgress: AgentProgressReporter = Object.freeze({
  report: async () => undefined,
});

const emptyCapabilities = (): AgentRequestCapabilities => Object.freeze({
  command: unavailable<AgentCommandAuthority>(),
  filesystem: unavailable<AgentFilesystemAuthority>(),
  network: unavailable<AgentNetworkAuthority>(),
  projectRoot: unavailable<AgentProjectRootAuthority>(),
});

const optionalText = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value.trim() === '') throw new Error('Agent invocation fields must be non-empty when present');
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
  readonly notices: undefined;
  readonly progress: AgentProgressReporter;
  readonly providers: AgentProviderValues;
  readonly services: AgentServiceRegistry;
  readonly session: Observed<AgentSessionIdentity>;
  readonly signal: AbortSignal;
  readonly state: undefined;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
}

interface Lease {
  closed: boolean;
  handle: AgentRequestContext;
  readonly values: FrozenValues;
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
        `Incompatible @agent-bundle/rsc-runtime request store version: found ${String(existing.version)}, expected ${String(AGENT_REQUEST_STORE_VERSION)}`,
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

export const agent = async (): Promise<AgentRequestContext> => {
  const lease = currentLease();
  open(lease);
  return lease.handle;
};

export const runAgentRequest = async <T>(
  init: AgentRequestInit,
  operation: () => T | Promise<T>,
): Promise<T> => {
  const values: FrozenValues = Object.freeze({
    actor: init.actor ?? unavailable<AgentActorIdentity>(),
    capabilities: Object.freeze({ ...(init.capabilities ?? emptyCapabilities()) }),
    host: init.host ?? unavailable<AgentHostIdentity>(),
    invocation: invocationFrom(init.invocation),
    notices: undefined,
    progress: init.progress ?? silentProgress,
    providers: Object.freeze({ ...(init.providers ?? {}) }),
    services: Object.freeze({ ...(init.services ?? {}) }),
    session: init.session ?? unavailable<AgentSessionIdentity>(),
    signal: init.signal ?? new AbortController().signal,
    state: undefined,
    workspace: init.workspace ?? unavailable<AgentWorkspaceIdentity>(),
  });
  const lease: Lease = {
    closed: false,
    handle: undefined as unknown as AgentRequestContext,
    values,
  };
  lease.handle = createHandle(lease);

  try {
    return await getStore().storage.run(lease, operation);
  } finally {
    lease.closed = true;
  }
};
