import { AsyncLocalStorage } from 'node:async_hooks';

import type { JsonValue } from './lower-mcp.js';
import type {
  AgentNoticeLedger,
  AgentNoticeRequestLease,
  AgentNoticesHandle,
} from './notices/contract.js';
import type { AgentStateHandle } from './state/contract.js';

// Bumped to 3 when `lineage` joined the handle shape: a realm that already
// holds an older store must fail closed rather than hand out handles without it.
export const AGENT_REQUEST_STORE_VERSION = 3;

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
  | 'unauthenticated'
  /** The host defines no subagent start/stop events, so no tree can exist. */
  | 'no-subagent-events'
  /** The payload carried an id the runtime never saw start (registry cold, or the host omitted the link). */
  | 'id-not-resolvable'
  /** Cursor cloud agents run no user hooks, so nothing feeds the registry. */
  | 'cloud-agent-no-user-hooks'
  /** The route ran in a standalone hook process with no warm runtime holding the registry. */
  | 'no-shared-runtime';

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

/** The subagent a lineage describes when the current conversation is not the root. */
export interface AgentLineageSubagent {
  /** The host's own id for the subagent (Claude/Codex `agent_id`, Cursor `subagent_id`). */
  readonly id: string;
  readonly isParallelWorker?: boolean;
  /** The parent's tool call that spawned it, when the host names one. */
  readonly toolCallId?: string;
  readonly type?: string;
}

/**
 * How the runtime arrived at `parent`/`root`/`depth`: straight from host fields
 * (`native`); from the warm runtime's registry fed by subagent start/stop
 * events, the edge matched by spawn-window ordering (`registry`); the same
 * registry edge after the host itself named it — on Claude the parent's
 * `Agent` PostToolUse carries `tool_response.agentId`, the child, beside the
 * spawn `tool_use_id` (`confirmed`); read from the host-written transcript the
 * payload named (`transcript`: a Codex subagent's rollout head records
 * `parent_thread_id` and `depth`, which its hook payloads omit); or by ordering
 * inference the host forced on it (`inferred`, e.g. Cursor binds a child
 * conversation to the most recent pending `subagentStart`). `confirmed`
 * requires every edge from the conversation up to the root to be host-named.
 */
export type AgentLineageResolution = 'native' | 'registry' | 'confirmed' | 'transcript' | 'inferred';

/**
 * One other live conversation in the registry's tree (#457). Every field is
 * what the registry recorded when the host said the conversation started —
 * nothing is derived from the current request — and `resolution` is the trust
 * level of that node's own `parent`/`depth` placement, judged exactly as it
 * would be on a request the node itself made.
 */
export interface AgentLineagePeer {
  readonly conversation: string;
  /** Root is depth 0; each subagent level adds one. */
  readonly depth: number;
  /** Absent at a root. */
  readonly parent?: string;
  readonly resolution: AgentLineageResolution;
  /** When the registry saw the conversation start (the hook's `observedAt`). */
  readonly startedAt: string;
  readonly subagent?: AgentLineageSubagent;
}

/**
 * The live tree around this request, as the same registry that placed the
 * request holds it, scoped to what the conversation may see: everything alive
 * under its own root, and the other live roots beside it. Stopped nodes are
 * never listed; a conversation the registry could not place has no tree.
 */
export interface AgentLineageTree {
  /** Live conversations whose `parent` is this conversation, oldest first. */
  readonly children: readonly AgentLineagePeer[];
  /**
   * Other live depth-0 conversations the registry holds — on Cursor, only
   * those seen in the same `workspace_roots` — oldest first. Never includes
   * this conversation's own root.
   */
  readonly roots: readonly AgentLineagePeer[];
  /**
   * Every other live conversation under the same root, at any depth, oldest
   * first: the root itself when this conversation is a subagent, its
   * ancestors, same-parent siblings, cousins, and descendants (so `children`
   * is a subset). Filter by `parent` for conventional same-parent siblings.
   */
  readonly siblings: readonly AgentLineagePeer[];
}

/**
 * Where this request sits in the conversation tree (#host-lineage). The shape
 * is identical on every surface: events, generated MCP tools, routed CLI, and
 * rendered scripts. `conversation` identifies the agent whose activity this is
 * — the host session for a root, the subagent id (Claude/Codex) or the child
 * conversation id (Cursor) below it.
 */
export interface AgentLineage {
  readonly conversation: string;
  /** Root is depth 0; each subagent level adds one. */
  readonly depth: number;
  /** Turn-shaped id when the host has one: Cursor `generation_id`, Codex `turn_id`, Claude `prompt_id`. */
  readonly generation?: string;
  readonly parent?: string;
  readonly resolution: AgentLineageResolution;
  readonly root: string;
  readonly subagent?: AgentLineageSubagent;
  /**
   * The live tree around this conversation (#457), present when the warm
   * runtime's registry placed it; absent for lineages a payload proved on its
   * own (a standalone hook, a Codex `_meta` the registry never saw start) —
   * the axis then still answers "who am I" but not "who else is here".
   */
  readonly tree?: AgentLineageTree;
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

/**
 * The project-registration seam, after TanStack Router's `Register`. It is
 * empty here; the compiler's generated `.agent-bundle/routes.d.ts` augments it
 * with `routes: AgentBundleRouteContracts` — a thin `{ input, result }` map
 * keyed by route id: what the `agent-bundle/test` harness accepts and returns
 * for that route, inferred from each schema route's own `inputSchema` and
 * `resultSchema`, and for an event route its `{ canonical, native }` payload
 * with an `undefined` result — in the same `declare module
 * '@agent-bundle/runtime'` block that declares
 * provider keys on {@link AgentProviderValues}.
 *
 * Every route-aware public type reads through this one registration, the way
 * TanStack's `RegisteredRouter` reaches `Link to`, `useNavigate`, and
 * `RoutesByPath`: {@link RegisteredRouteId}, {@link RegisteredRouteInput}, and
 * {@link RegisteredRouteResult} for a route id; {@link RegisteredMcpServerName},
 * {@link RegisteredMcpRouteName}, and {@link RegisteredMcpRouteId} for the MCP
 * server and protocol names a registered `tool:`/`prompt:`/`resource:` id
 * encodes. `agent-bundle/test` types `renderRoute`, `renderRouteEvents`,
 * `invokeMcpTool`, `getMcpPrompt`, the contract-matrix `fixtures`, and
 * `invokeCli`'s reported `routeId` from them, and `agent-bundle/eval` types
 * `expectMcpCall`/`expectNoMcpCall`'s `tool` from them. All of them degrade to
 * their unregistered shape (`string`, `unknown`) when the file is absent or
 * excluded from the program, so nothing here is required for a project to
 * type-check.
 */
// rslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merge extension point
export interface Register {}

/** One registered route's harness contract: the `input` a render accepts and the `result` it returns (`undefined` for routes without a `resultSchema`). */
export interface RegisteredRouteContract {
  readonly input: unknown;
  readonly result: unknown;
}

/** Every registered route contract keyed by route id; `unknown` until a project registers. */
export type RegisteredRoutes = Register extends { readonly routes: infer Routes extends Record<string, RegisteredRouteContract> }
  ? Routes
  : unknown;

/** The registered route ids, or `string` when no project has registered. */
export type RegisteredRouteId = unknown extends RegisteredRoutes ? string : keyof RegisteredRoutes & string;

/** The registered input type for one route id; `unknown` for an unregistered id. */
export type RegisteredRouteInput<Id extends string> = Id extends keyof RegisteredRoutes
  ? RegisteredRoutes[Id] extends RegisteredRouteContract ? RegisteredRoutes[Id]['input'] : unknown
  : unknown;

/** The registered result type for one route id; `unknown` for an unregistered id. */
export type RegisteredRouteResult<Id extends string> = Id extends keyof RegisteredRoutes
  ? RegisteredRoutes[Id] extends RegisteredRouteContract ? RegisteredRoutes[Id]['result'] : unknown
  : unknown;

/** The route kinds whose ids encode an MCP server and protocol name: `<kind>:<server>/<name>`. */
export type RegisteredMcpRouteKind = 'prompt' | 'resource' | 'tool';

/**
 * The registered MCP route ids of `Kind` on `Server` whose protocol name is
 * `Name` (`tool:curator/find` for `<'tool', 'curator', 'find'>`; the `string`
 * defaults match every server or name), after TanStack Router's
 * `RoutesByPath`. `string` when no project has registered.
 */
export type RegisteredMcpRouteId<
  Kind extends RegisteredMcpRouteKind = RegisteredMcpRouteKind,
  Server extends string = string,
  Name extends string = string,
> = unknown extends RegisteredRoutes ? string : Extract<RegisteredRouteId, `${Kind}:${Server}/${Name}`>;

/** Distributes over a route-id union so each member yields its own server segment. */
type McpServerSegment<Id> = Id extends `${RegisteredMcpRouteKind}:${infer Server}/${string}` ? Server : never;

/** The MCP server names the registered routes belong to (`curator` for `tool:curator/find`); `string` when no project has registered. */
export type RegisteredMcpServerName = unknown extends RegisteredRoutes ? string : McpServerSegment<RegisteredRouteId>;

/** Distributes over a route-id union so each member yields its own protocol name. */
type McpNameSegment<Id, Kind extends RegisteredMcpRouteKind, Server extends string> =
  Id extends `${Kind}:${Server}/${infer Name}` ? Name : never;

/**
 * The protocol names (the wire `tools/call` or `prompts/get` name) of the
 * registered MCP routes of `Kind` on `Server`: `find | status` for the tool
 * routes `tool:curator/find` and `tool:curator/status`. `string` when no
 * project has registered.
 */
export type RegisteredMcpRouteName<
  Kind extends RegisteredMcpRouteKind = RegisteredMcpRouteKind,
  Server extends string = string,
> = unknown extends RegisteredRoutes ? string : McpNameSegment<RegisteredRouteId, Kind, Server>;

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
  /**
   * Conversation lineage resolved by the warm runtime's registry (fed by the
   * subagent start/stop event families and pre-tool hooks) or straight from
   * host fields; `unavailable` carries the per-host reason.
   */
  readonly lineage: Observed<AgentLineage>;
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

/**
 * The `providers` member of {@link AgentRequestInit}. It is optional only while
 * {@link AgentProviderValues} has no required keys. Once a project's generated
 * `.agent-bundle/routes.d.ts` augmentation declares its conventional providers,
 * every direct `runAgentRequest` caller — custom hosts and route-unit fixtures
 * alike — must supply the full record, so a handler typed against those keys
 * never observes an unchecked `undefined`. Generated request scopes always run
 * the providers before the handler and are unaffected.
 */
export type AgentRequestProvidersInit = Record<never, never> extends AgentProviderValues
  ? { readonly providers?: AgentProviderValues }
  : { readonly providers: AgentProviderValues };

export interface AgentRequestInitBase {
  readonly actor?: Observed<AgentActorIdentity>;
  readonly capabilities?: AgentRequestCapabilities;
  readonly host?: Observed<AgentHostIdentity>;
  readonly invocation: AgentInvocationInput;
  readonly lineage?: Observed<AgentLineage>;
  /** Optional durable notice authority; omitted projects load no notice code. */
  readonly noticeLedger?: AgentNoticeLedger;
  readonly progress?: AgentProgressReporter;
  readonly services?: AgentServiceRegistry;
  readonly session?: Observed<AgentSessionIdentity>;
  readonly signal?: AbortSignal;
  /** Request-bound state handle from `createAgentStateHandle` (subpath `./state`). */
  readonly state?: AgentStateHandle;
  readonly workspace?: Observed<AgentWorkspaceIdentity>;
}

export type AgentRequestInit = AgentRequestInitBase & AgentRequestProvidersInit;

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
  readonly lineage: Observed<AgentLineage>;
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
  get lineage() {
    return open(lease).lineage;
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

/**
 * Synchronous convenience over {@link agent} for Server Components and
 * ordinary server utilities that cannot `await`. It returns the identical
 * request handle (`useAgent() === await agent()` within one invocation) from
 * the same realm-singleton store, so every lease rule holds unchanged: a call
 * with no request in its async context — including a call made after
 * `runAgentRequest` has settled — throws `outside-invocation`, and a handle
 * captured inside the request (or a continuation that retained its lease)
 * throws `request-closed` once the request completes. No React dependency:
 * the handle is already resolved in the request's async context, so nothing
 * has to suspend.
 */
export const useAgent = (): AgentRequestContext => {
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
  const lineage = snapshotObserved(init.lineage ?? unavailable<AgentLineage>());
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
    lineage,
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
