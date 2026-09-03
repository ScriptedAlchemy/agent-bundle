/**
 * The generated-plugin contract matrix — framework-owned wire-contract checks
 * at three proof boundaries (`mcp-in-memory`, packed stdio, and host install).
 *
 * All three entry points share one implementation. Boundary differences are explicit
 * capability flags, not forked check logic. The project supplies only fixtures
 * — valid inputs, declared result-compat policy, version-skew payloads,
 * optional cancellation cases, and deterministic lifecycle transitions —
 * not the transport, schema, render, or assertion logic itself.
 *
 * **`runContractMatrix` (`mcp-in-memory`)** opens one real MCP client against
 * the real generated server over the SDK's in-memory transport and runs the
 * full matrix including module-backed validation: JSON serialized round-trip
 * through each tool route's own `resultSchema`, declared additive/closed compat
 * behavior, and previous-server payload acceptance. In-memory transport may
 * pass structured values without serialization; the explicit
 * `JSON.parse(JSON.stringify(...))` round-trip closes that gap. MCP Apps are
 * not registered at this level: every app route reports `surface-completeness`
 * as `not-applicable` and receives no coverage, sweep, or other check.
 *
 * **`runPackedContractMatrix` (`packed-stdio` / `packed-deleted-source`)** runs
 * against an already-open packed session. It proves process stdio evidence for
 * surface completeness (including compiled MCP App resource URIs), fixture
 * coverage, successful-path sweeps, advertised input-schema rejection, and
 * client-side cancellation hygiene. It cannot load project route modules — source
 * may be deleted and verified absent — so serialized-round-trip, compat-probe,
 * and version-skew are reported `not-applicable`. The packed server validates
 * every tool result through its bundled `resultSchema` before returning; a
 * successful sweep invocation is that evidence.
 *
 * **MCP App coverage.** At every boundary that registers app resources
 * (`packed-stdio`, `packed-deleted-source`, `host-install`, `dev-epoch`) app
 * routes ARE part of the matrix: `surface-completeness` requires the compiled
 * `ui://` URI in `listResources`, and `sweep` reads that resource. With the
 * default `apps: 'auto'` an app route needs no fixture entry — `coverage`
 * passes with a reason naming the auto-covered sweep. An explicit
 * `{ kind: 'resource' }` (or legacy `{}`) fixture is always accepted;
 * `apps: 'explicit'` restores the requirement that every app route be listed.
 *
 * Stateful lifecycle fixtures replay over one open client at every boundary.
 * Same-store restart callbacks add boundary-local durability evidence; a run
 * without one reports restart durability as not-applicable.
 *
 * **The installed-host boundary** discovers and spawns the emitted MCP command
 * from a clean installed layout. It carries static layout checks and the
 * source/artifact/installed/running version quadruple from `installed.ts`.
 *
 * Packed and installed-host runs with event runtimes sample the pinned status
 * IPC before and throughout the sequential matrix events. They fail if the
 * warm instance changes or degrades. Stateful lifecycle fixtures may also pin
 * their mounted-state declaration against the compiler manifest catalog.
 * Boundaries without an event runtime report identity as not-applicable.
 */
import type { Client } from '@modelcontextprotocol/client';

import {
  requestEventRuntimeStatus,
  type EventRuntimeStatusResult,
} from '../events/ipc.ts';
import { AgentTestError, captured } from './errors.ts';
import {
  DEV_EPOCH_PROOF_LEVEL,
  MCP_IN_MEMORY_PROOF_LEVEL,
  proofLevelLabel,
  type AgentBundleTestManifest,
  type AgentTestProofLevel,
} from './manifest.ts';
import {
  openInMemoryMcpServer,
  type InMemoryMcpSessionOptions,
  type McpProjectionProvenance,
} from './mcp.ts';
import type {
  InstalledHostCheckOutcome,
  InstalledHostEvidenceMetadata,
  InstalledHostMcpProvenance,
  InstalledHostMcpSession,
  InstalledHostVersionQuadruple,
} from './installed.ts';
import type { PackedMcpProvenance, PackedMcpSession } from './packed.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import type { AgentRouteModule, TestableRouteDescriptor } from './types.ts';

/** Declared serialized-result compatibility policy for tool routes. */
export type ResultCompatPolicy = 'additive' | 'closed';

export type ContractLifecyclePhase =
  | 'unknown'
  | 'queued'
  | 'running'
  | 'first-progress'
  | 'repeated-progress'
  | 'terminal';

export interface ContractLifecycleTransition {
  readonly expectedStructuredContent: unknown;
  readonly input: unknown;
  readonly phase: ContractLifecyclePhase;
  readonly progressNotifications: number;
  readonly renderedTextIncludes?: string;
}

export interface ContractLifecycleFixture {
  readonly state?: {
    readonly budget?: {
      readonly codePath: readonly string[];
      readonly expectedCode: string;
      readonly input: unknown;
      readonly revisionPath: readonly string[];
    };
    readonly catalog?: {
      readonly id: string;
      readonly lifetime: NonNullable<AgentBundleTestManifest['state']>['lifetime'];
    };
    readonly durability?: {
      readonly expectedStructuredContent: unknown;
      readonly input: unknown;
    };
    readonly idempotency?: {
      readonly phase: ContractLifecyclePhase;
      readonly replayedPath: readonly string[];
      readonly revisionPath: readonly string[];
    };
    readonly journal?: {
      readonly expected: unknown;
      readonly path: readonly string[];
    };
    readonly notice?: {
      readonly expected: unknown;
      readonly path: readonly string[];
      readonly phase: ContractLifecyclePhase;
    };
  };
  /** Pure deterministic phase driver; transport and assertions remain framework-owned. */
  readonly transitionDriver: () => readonly ContractLifecycleTransition[];
}

/**
 * The explicit fixture form for a resource or MCP App route: the sweep reads
 * the route's wire URI and no input, policy, or lifecycle applies. Declaring
 * it on a tool or prompt route is a coverage failure.
 */
export interface ContractResourceFixture {
  readonly kind: 'resource';
}

export interface ContractRouteFixture {
  /**
   * `'resource'` marks a resource/MCP App fixture (see `ContractResourceFixture`).
   * Omit it for tool and prompt fixtures; a legacy `{}` still covers a
   * resource or app route.
   */
  readonly kind?: ContractResourceFixture['kind'];
  /** Valid input for the sweep invocation (tools/prompts; resources need none). */
  readonly input?: unknown;
  /** Additional valid inputs — e.g. one per declared status/discriminant value. */
  readonly inputs?: readonly unknown[];
  /** Declared serialized-result compatibility policy. REQUIRED for tool routes. */
  readonly resultCompat?: ResultCompatPolicy;
  /**
   * Serialized payloads captured from previous server versions; each must parse
   * under the CURRENT `resultSchema` (previous-server + current-client skew).
   */
  readonly previousResults?: readonly unknown[];
  /**
   * Cancellation case: invocation aborted mid-flight must settle rejected and
   * leave the session usable. The input must stay in flight past
   * `abortAfterMs` (default 50ms); an invocation that settles before the abort
   * fires is reported `not-applicable`, not `failed`.
   */
  readonly cancellation?: { readonly abortAfterMs?: number; readonly input?: unknown };
  /** Optional stateful replay over this matrix run's single open client. */
  readonly lifecycle?: ContractLifecycleFixture;
}

/**
 * How MCP App routes are covered at boundaries that register app resources.
 *
 * - `'auto'` (default): app routes need no fixture entry; `coverage` passes
 *   and the sweep reads the compiled `ui://` resource. Explicit entries are
 *   still accepted.
 * - `'explicit'`: every compiled app route must have a fixture entry
 *   (`{ kind: 'resource' }`), matching the rule for every other route kind.
 *
 * Has no effect at `mcp-in-memory`, where apps are never registered.
 */
export type ContractAppCoverage = 'auto' | 'explicit';

/** The shape of one `notifications/progress` delivery a lifecycle fixture counts. */
export interface ContractProgressNotification {
  readonly params?: { readonly progressToken?: string | number };
}

/**
 * The explicit progress path a non-SDK client exposes to lifecycle fixtures.
 * Returns the unsubscribe; an SDK `Client` needs none because its handler map
 * is observed directly.
 */
export interface ContractMatrixProgressSource {
  readonly observeProgress: (listener: (notification: ContractProgressNotification) => void) => () => void;
}

export type ContractMatrixClient = Pick<
  Client,
  'callTool' | 'getPrompt' | 'listPrompts' | 'listResources' | 'listTools' | 'readResource'
> & Partial<ContractMatrixProgressSource>;

export interface ContractMatrixRestartSession {
  readonly client: Client;
}

export interface ContractMatrixOptions extends InMemoryMcpSessionOptions {
  readonly manifest?: AgentBundleTestManifest;
  readonly server?: string;
  /**
   * Route id -> fixture. Every compiled tool, prompt, and resource route on
   * the server must be covered. App routes are not registered at
   * `mcp-in-memory`; entries for them are accepted and ignored.
   */
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  /** Accepted for parity with the other entry points; apps are never registered here. */
  readonly apps?: ContractAppCoverage;
  /** Reopens the same durable store after the matrix closes its initial in-memory session. */
  readonly restart?: () => Promise<ContractMatrixRestartSession>;
}

export type ContractCheckStatus = 'failed' | 'not-applicable' | 'passed';

export interface ContractCheckOutcome {
  readonly reason?: string;
  readonly status: ContractCheckStatus;
}

export interface ContractRouteReport {
  readonly checks: Readonly<Record<string, ContractCheckOutcome>>;
}

export type ContractMatrixProvenance =
  | DevEpochMcpProvenance
  | InstalledHostMcpProvenance
  | McpProjectionProvenance
  | PackedMcpProvenance;

export interface ContractMatrixReport {
  readonly checks: Readonly<Record<string, ContractCheckOutcome>>;
  readonly provenance: ContractMatrixProvenance;
  readonly routes: Readonly<Record<string, ContractRouteReport>>;
}

export type ContractEventRuntimeAddress =
  | { readonly endpoint: string; readonly endpointId?: never }
  | { readonly endpoint?: never; readonly endpointId: string };

export interface PackedContractMatrixOptions {
  /** App route coverage at this boundary; defaults to `'auto'`. */
  readonly apps?: ContractAppCoverage;
  /** Read-only status address for the generated event runtime, when this artifact has one. */
  readonly eventRuntime?: ContractEventRuntimeAddress;
  /**
   * Route id -> fixture. Every compiled tool, prompt, and resource route on
   * the server must be covered; app routes are auto-covered unless
   * `apps: 'explicit'`.
   */
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly server?: string;
  /** An already-open packed session; this entry point never opens or closes it. */
  readonly session: PackedMcpSession;
  /** Caller-owned packed restart; it must close the initial session and reopen the same artifact/store. */
  readonly restart?: () => Promise<ContractMatrixRestartSession>;
}

export interface DevEpochMcpProvenance {
  readonly epochId: string;
  readonly proofLevel: typeof DEV_EPOCH_PROOF_LEVEL;
  readonly serverName: string;
  readonly target: string;
}

export interface DevEpochContractMatrixSession {
  readonly client: ContractMatrixClient;
  readonly provenance: DevEpochMcpProvenance;
  readonly stderr: () => string;
}

export interface DevEpochContractMatrixOptions {
  /** App route coverage at this boundary; defaults to `'auto'`. */
  readonly apps?: ContractAppCoverage;
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly server?: string;
  /** An already-open epoch-pinned generated stdio session; this entry point never opens or closes it. */
  readonly session: DevEpochContractMatrixSession;
}

export interface InstalledHostContractMatrixOptions {
  /** App route coverage at this boundary; defaults to `'auto'`. */
  readonly apps?: ContractAppCoverage;
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly server?: string;
  /** An already-open installed-host session; this entry point never opens or closes it. */
  readonly session: InstalledHostMcpSession;
}

export interface InstalledHostContractMatrixReport {
  readonly checks: Readonly<Record<string, InstalledHostCheckOutcome>>;
  readonly host: InstalledHostMcpSession['provenance']['host'];
  readonly matrix: ContractMatrixReport;
  readonly metadata: InstalledHostEvidenceMetadata;
  readonly proofLevel: string;
  readonly sessionEvidence: string;
  readonly status: 'passed';
  readonly versions: InstalledHostVersionQuadruple;
}

interface MatrixBoundaryCapabilities {
  readonly canLoadRouteModules: boolean;
  readonly eventRuntime?: ContractEventRuntimeAddress;
  readonly eventRuntimeNotApplicableReason: string;
  readonly moduleSchemaNotApplicableReason: string;
  readonly proofLevel: AgentTestProofLevel;
  readonly registersAppResources: boolean;
  readonly recovery: string;
  readonly restart?: () => Promise<ContractMatrixRestartSession>;
}

const PACKED_MODULE_SCHEMA_NOT_APPLICABLE_REASON =
  'packed sessions cannot load project route modules (source may be deleted and verified absent); loading a module would silently break deleted-source proof. The packed server validates every tool result through its bundled resultSchema before returning — a successful sweep invocation is that evidence.';

const INSTALLED_HOST_MODULE_SCHEMA_NOT_APPLICABLE_REASON =
  'installed-host sessions cannot load project route modules without crossing back into the source/build tree; the installed server validates every tool result through its bundled resultSchema before returning — a successful sweep invocation is that evidence.';

const DEV_EPOCH_MODULE_SCHEMA_NOT_APPLICABLE_REASON =
  'dev-epoch sessions run the generated server process and cannot load project route modules without crossing back into source; the generated server validates every tool result through its bundled resultSchema before returning — a successful sweep invocation is that evidence.';

const IN_MEMORY_BOUNDARY: MatrixBoundaryCapabilities = Object.freeze({
  canLoadRouteModules: true,
  eventRuntimeNotApplicableReason: 'the mcp-in-memory boundary has no generated event runtime.',
  moduleSchemaNotApplicableReason: '',
  proofLevel: MCP_IN_MEMORY_PROOF_LEVEL,
  registersAppResources: false,
  recovery: 'Fix the failing route, fixture, or declared resultCompat policy; re-run runContractMatrix.',
});

const packedBoundaryFromSession = (
  session: PackedMcpSession,
  eventRuntime: ContractEventRuntimeAddress | undefined,
  restart: (() => Promise<ContractMatrixRestartSession>) | undefined,
): MatrixBoundaryCapabilities =>
  Object.freeze({
    canLoadRouteModules: false,
    ...(eventRuntime === undefined ? {} : { eventRuntime }),
    eventRuntimeNotApplicableReason:
      'this packed matrix run was not supplied the generated event runtime endpoint.',
    moduleSchemaNotApplicableReason: PACKED_MODULE_SCHEMA_NOT_APPLICABLE_REASON,
    proofLevel: session.provenance.proofLevel,
    registersAppResources: true,
    recovery: 'Fix the failing route or fixture; re-run runPackedContractMatrix.',
    ...(restart === undefined ? {} : { restart }),
  });

const installedHostBoundaryFromSession = (
  session: InstalledHostMcpSession,
): MatrixBoundaryCapabilities =>
  Object.freeze({
    canLoadRouteModules: false,
    ...(session.eventRuntimeEndpoint === undefined
      ? {}
      : { eventRuntime: { endpoint: session.eventRuntimeEndpoint } }),
    eventRuntimeNotApplicableReason:
      'the installed-host session exposed no generated event runtime endpoint.',
    moduleSchemaNotApplicableReason: INSTALLED_HOST_MODULE_SCHEMA_NOT_APPLICABLE_REASON,
    proofLevel: session.provenance.proofLevel,
    registersAppResources: true,
    recovery: 'Fix the installed layout, route, or fixture; reinstall and re-run runInstalledHostContractMatrix.',
  });

const DEV_EPOCH_BOUNDARY: MatrixBoundaryCapabilities = Object.freeze({
  canLoadRouteModules: false,
  eventRuntimeNotApplicableReason:
    'the dev-epoch MCP session does not expose a generated event runtime endpoint.',
  moduleSchemaNotApplicableReason: DEV_EPOCH_MODULE_SCHEMA_NOT_APPLICABLE_REASON,
  proofLevel: DEV_EPOCH_PROOF_LEVEL,
  registersAppResources: true,
  recovery: 'Fix the failing route or fixture; rebuild so runDevEpochContractMatrix can prove the next epoch.',
});

const COMPAT_PROBE_KEY = '__agentBundleContractProbe';

const CHECK_SURFACE = 'surface-completeness';
const CHECK_COVERAGE = 'coverage';
const CHECK_SWEEP = 'sweep';
const CHECK_SERIALIZED_ROUND_TRIP = 'serialized-round-trip';
const CHECK_COMPAT_PROBE = 'compat-probe';
const CHECK_VERSION_SKEW = 'version-skew';
const CHECK_NEGATIVE_INPUTS = 'negative-inputs';
const CHECK_CANCELLATION = 'cancellation';
const CHECK_LIFECYCLE_REPLAY = 'lifecycle-replay';
const CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP = 'lifecycle-serialized-round-trip';
const CHECK_LIFECYCLE_COMPAT_PROBE = 'lifecycle-compat-probe';
const CHECK_LIVE_PROGRESS = 'live-progress-before-terminal';
const CHECK_STATE_JOURNAL = 'state-journal';
const CHECK_STATE_NOTICE = 'state-notice';
const CHECK_STATE_IDEMPOTENCY = 'state-idempotency';
const CHECK_STATE_BUDGET = 'state-budget';
const CHECK_STATE_CATALOG = 'state-catalog';
const CHECK_RESTART_DURABILITY = 'restart-durability';
const CHECK_RUNTIME_INSTANCE_IDENTITY = 'runtime-instance-identity';

export interface ContractMatrixFailure {
  readonly check: string;
  readonly reason: string;
  readonly routeId: string;
}

export class ContractMatrixViolationError extends AgentTestError {
  readonly failures: readonly ContractMatrixFailure[];
  readonly report: ContractMatrixReport;

  constructor(
    message: string,
    failures: readonly ContractMatrixFailure[],
    report: ContractMatrixReport,
    options: { readonly details: readonly string[]; readonly recovery: string },
  ) {
    super('contract-violation', message, options);
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    this.report = report;
  }
}

interface ToolListingEntry {
  readonly inputSchema?: Record<string, unknown>;
  readonly name: string;
}

interface LiveSurface {
  readonly prompts: readonly string[];
  readonly resources: readonly string[];
  readonly tools: readonly ToolListingEntry[];
}

const routeProtocolName = (descriptor: TestableRouteDescriptor): string =>
  descriptor.id.slice(descriptor.id.lastIndexOf('/') + 1);

const routeResourceUri = (descriptor: TestableRouteDescriptor): string | undefined => {
  const uri = descriptor.config.uri;
  return typeof uri === 'string' ? uri : undefined;
};

const routeAppResourceUri = (
  descriptor: TestableRouteDescriptor,
  manifest: AgentBundleTestManifest,
): string | undefined => {
  const fromConfig = descriptor.config.resourceUri;
  if (typeof fromConfig === 'string') return fromConfig;
  const app = Object.values(manifest.apps).find((entry) => entry.id === descriptor.id);
  return app?.resourceUri;
};

const routeWireUri = (
  descriptor: TestableRouteDescriptor,
  manifest: AgentBundleTestManifest,
): string | undefined => (descriptor.kind === 'app'
  ? routeAppResourceUri(descriptor, manifest)
  : routeResourceUri(descriptor));

const serverRoutes = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => Object.values(manifest.routes)
  .filter((route) => route.serverId === `mcp:${serverName}` && route.kind !== 'app')
  .sort((left, right) => left.id.localeCompare(right.id));

const serverAppRoutes = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => Object.values(manifest.routes)
  .filter((route) => route.serverId === `mcp:${serverName}` && route.kind === 'app')
  .sort((left, right) => left.id.localeCompare(right.id));

const compiledServerNames = (manifest: AgentBundleTestManifest): readonly string[] => [
  ...new Set(Object.values(manifest.routes).flatMap((route) =>
    (route.serverId === undefined ? [] : [route.serverId.replace(/^mcp:/u, '')]))),
].sort((left, right) => left.localeCompare(right));

const resolveServerName = (
  manifest: AgentBundleTestManifest,
  requested: string | undefined,
): string => {
  const names = compiledServerNames(manifest);
  if (requested !== undefined) {
    if (!names.includes(requested)) {
      throw new AgentTestError('server-not-found', `No compiled MCP server is named ${JSON.stringify(requested)}.`, {
        details: [
          `project root: ${manifest.projectRoot}`,
          `compiled:     ${names.length === 0 ? 'this project compiled no MCP servers' : names.join(', ')}`,
        ],
        recovery: 'Name one of the compiled servers, or add route modules under src/mcp/<server>/.',
      });
    }
    return requested;
  }
  if (names.length === 1) return names[0]!;
  throw new AgentTestError(
    'server-not-found',
    names.length === 0
      ? 'This project compiled no MCP servers.'
      : 'This project compiled more than one MCP server, so the contract matrix cannot pick one.',
    {
      details: [
        `project root: ${manifest.projectRoot}`,
        `compiled:     ${names.length === 0 ? 'none' : names.join(', ')}`,
      ],
      recovery: 'Pass { server: "<name>" }.',
    },
  );
};

const passed = (): ContractCheckOutcome => ({ status: 'passed' });
const passedWithReason = (reason: string): ContractCheckOutcome => ({ reason, status: 'passed' });
const failed = (reason: string): ContractCheckOutcome => ({ reason, status: 'failed' });
const notApplicable = (reason: string): ContractCheckOutcome => ({ reason, status: 'not-applicable' });

interface RuntimeIdentityTracker {
  readonly observe: (label: string) => Promise<void>;
  readonly outcome: () => ContractCheckOutcome;
}

const readRuntimeStatus = async (
  address: ContractEventRuntimeAddress,
): Promise<EventRuntimeStatusResult> => address.endpoint === undefined
  ? requestEventRuntimeStatus({ endpointId: address.endpointId, timeoutMs: 1_000 })
  : requestEventRuntimeStatus({ endpoint: address.endpoint, timeoutMs: 1_000 });

const createRuntimeIdentityTracker = (
  boundary: MatrixBoundaryCapabilities,
  manifest: AgentBundleTestManifest,
  serverName: string,
): RuntimeIdentityTracker => {
  const hasEventRoutes = Object.values(manifest.routes)
    .some((route) => route.kind === 'event-route');
  if (!hasEventRoutes) {
    const outcome = notApplicable(
      'the compiled manifest declares no event routes, so this boundary has no event runtime.',
    );
    return Object.freeze({ observe: async () => undefined, outcome: () => outcome });
  }
  const serverId = `mcp:${serverName}`;
  if (manifest.eventRuntimeServerId === undefined) {
    const outcome = notApplicable(
      'the compiled manifest declares event routes, but no generated MCP server owns their event runtime.',
    );
    return Object.freeze({ observe: async () => undefined, outcome: () => outcome });
  }
  if (manifest.eventRuntimeServerId !== serverId) {
    const outcome = notApplicable(
      `compiled server ${JSON.stringify(serverId)} does not own the event runtime; `
      + `owner is ${JSON.stringify(manifest.eventRuntimeServerId)}.`,
    );
    return Object.freeze({ observe: async () => undefined, outcome: () => outcome });
  }
  if (boundary.eventRuntime === undefined) {
    const outcome = notApplicable(boundary.eventRuntimeNotApplicableReason);
    return Object.freeze({ observe: async () => undefined, outcome: () => outcome });
  }

  const expectedArtifactEpoch = `${manifest.plugin.name}@${manifest.plugin.version}`;
  let first: Extract<EventRuntimeStatusResult, { readonly status: 'available' }> | undefined;
  let failure: string | undefined;
  let observations = 0;
  return Object.freeze({
    observe: async (label: string): Promise<void> => {
      if (failure !== undefined) return;
      let status: EventRuntimeStatusResult;
      try {
        status = await readRuntimeStatus(boundary.eventRuntime!);
      } catch (error) {
        failure = `${label} status request failed: ${error instanceof Error ? error.message : captured(error)}`;
        return;
      }
      observations += 1;
      if (status.status !== 'available') {
        failure = `${label} event runtime status was ${status.status}`;
        return;
      }
      if (status.availability !== 'available') {
        failure = `${label} event runtime availability was ${status.availability} for instance ${JSON.stringify(status.instanceId)}`;
        return;
      }
      if (status.artifactEpoch !== expectedArtifactEpoch) {
        failure = `${label} event runtime artifact epoch ${JSON.stringify(status.artifactEpoch)} did not match compiled epoch ${JSON.stringify(expectedArtifactEpoch)}`;
        return;
      }
      if (first === undefined) {
        first = status;
        return;
      }
      if (status.instanceId !== first.instanceId) {
        failure = `${label} event runtime instance changed from ${JSON.stringify(first.instanceId)} to ${JSON.stringify(status.instanceId)}`;
      }
    },
    outcome: (): ContractCheckOutcome => {
      if (failure !== undefined) return failed(failure);
      if (first === undefined || observations < 2) {
        return failed('event runtime identity was not observed before and after the matrix event sequence');
      }
      return passed();
    },
  });
};

const recordFailure = (
  failures: ContractMatrixFailure[],
  routeId: string,
  check: string,
  reason: string,
): void => {
  failures.push({ check, reason, routeId });
};

const outcomeFromCheck = (
  failures: ContractMatrixFailure[],
  routeId: string,
  check: string,
  outcome: ContractCheckOutcome,
): ContractCheckOutcome => {
  if (outcome.status === 'failed') {
    recordFailure(failures, routeId, check, outcome.reason ?? 'check failed');
  }
  return outcome;
};

const fixtureInputs = (fixture: ContractRouteFixture): readonly unknown[] => {
  const inputs = [
    ...(fixture.input === undefined ? [{}] : [fixture.input]),
    ...(fixture.inputs ?? []),
  ];
  return inputs.length === 0 ? [{}] : inputs;
};

const loadRouteModule = async (
  manifest: AgentBundleTestManifest,
  descriptor: TestableRouteDescriptor,
): Promise<AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } }> => {
  const loader = registeredRouteLoader(manifest, descriptor.id);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Route ${descriptor.id} is compiled but no test-time module loader is registered for it.`,
      { recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers route loaders.' },
    );
  }
  const module = await loader();
  if (module.resultSchema === undefined) {
    throw new AgentTestError(
      'invalid-route-module',
      `Route ${descriptor.id} exports no resultSchema, which the contract matrix requires for validation checks.`,
    );
  }
  return { ...module, resultSchema: module.resultSchema };
};

const listLiveSurface = async (client: ContractMatrixClient): Promise<LiveSurface> => {
  const [tools, resources, prompts] = await Promise.all([
    client.listTools(),
    client.listResources(),
    client.listPrompts(),
  ]);
  return {
    prompts: Object.freeze(prompts.prompts.map((entry) => entry.name).sort()),
    resources: Object.freeze(resources.resources.map((entry) => entry.uri).sort()),
    tools: Object.freeze(tools.tools.map((entry) => ({
      inputSchema: entry.inputSchema as Record<string, unknown> | undefined,
      name: entry.name,
    })).sort((left, right) => left.name.localeCompare(right.name))),
  };
};

type ToolInvocationResult =
  | { readonly content?: unknown; readonly isError: boolean; readonly structuredContent?: unknown; readonly threw: false }
  | { readonly threw: true; readonly error: unknown };

const invocationCacheKey = (name: string, input: unknown): string =>
  `${name}\0${JSON.stringify(input ?? {})}`;

const callToolResult = async (
  client: ContractMatrixClient,
  name: string,
  input: unknown,
  options?: {
    readonly cache?: Map<string, ToolInvocationResult>;
    readonly progressToken?: string | number;
    readonly signal?: AbortSignal;
    readonly timeout?: number;
  },
): Promise<ToolInvocationResult> => {
  if (options?.signal === undefined && options?.cache !== undefined) {
    const cached = options.cache.get(invocationCacheKey(name, input));
    if (cached !== undefined) return cached;
  }
  try {
    const result = await client.callTool(
      {
        arguments: (input ?? {}) as Record<string, unknown>,
        name,
        ...(options?.progressToken === undefined
          ? {}
          : { _meta: { progressToken: options.progressToken } }),
      },
      {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      },
    ) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
    const settled: ToolInvocationResult = {
      ...(result.content === undefined ? {} : { content: result.content }),
      isError: result.isError === true,
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      threw: false,
    };
    if (options?.signal === undefined && options?.cache !== undefined) {
      options.cache.set(invocationCacheKey(name, input), settled);
    }
    return settled;
  } catch (error) {
    const settled: ToolInvocationResult = { error, threw: true };
    if (options?.signal === undefined && options?.cache !== undefined) {
      options.cache.set(invocationCacheKey(name, input), settled);
    }
    return settled;
  }
};

const serializedRoundTrip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value)) as unknown;

const compatProbe = (
  payload: unknown,
  policy: ResultCompatPolicy,
  parse: (value: unknown) => unknown,
): { readonly accepted: boolean; readonly error?: unknown } => {
  const probed = {
    ...(typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {}),
    [COMPAT_PROBE_KEY]: true,
  };
  try {
    parse(probed);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error };
  }
};

const wrongJsonType = (schemaType: unknown): unknown => {
  switch (schemaType) {
    case 'string':
      return 0;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return {};
    case 'object':
      return 'not-an-object';
    default:
      return null;
  }
};

/**
 * Derives negative input cases from a tool's ADVERTISED input JSON Schema — the
 * wire contract from `listTools`, not the route module's zod source.
 *
 * Generates, when the schema has top-level object structure:
 * - one unknown-extra-key case
 * - one missing-required-property case per required field
 * - one wrong-JSON-type case per typed top-level property
 *
 * **Unknown-extra-key tolerance:** when the advertised schema declares
 * `additionalProperties: false`, plain `z.object` tool routes may still strip
 * unknown keys without a protocol failure. The negative-inputs check records
 * that acceptance when other generated negatives still prove rejection paths.
 *
 * Does NOT prove deep nested validation, format constraints, or enum exhaustiveness
 * beyond the top-level object shape the MCP SDK advertises.
 */
export const negativeInputsFromJsonSchema = (
  schema: Record<string, unknown>,
): readonly { readonly label: string; readonly input: Record<string, unknown> }[] | undefined => {
  if (schema.type !== 'object') return undefined;
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  const propertyEntries = Object.entries(properties as Record<string, Record<string, unknown>>);
  if (propertyEntries.length === 0 && !Array.isArray(schema.required)) {
    return [{ input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' }];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const negatives: { readonly label: string; readonly input: Record<string, unknown> }[] = [
    { input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' },
  ];
  for (const key of required) {
    const present = Object.fromEntries(
      required.filter((candidate) => candidate !== key).map((candidate) => {
        const propertySchema = (properties as Record<string, Record<string, unknown>>)[candidate];
        const type = propertySchema?.type;
        return [candidate, typeof type === 'string' ? defaultValueForType(type) : 'value'];
      }),
    );
    negatives.push({ input: present, label: `missing-required:${key}` });
  }
  for (const [key, propertySchema] of propertyEntries) {
    const type = propertySchema.type;
    if (typeof type !== 'string') continue;
    const base = Object.fromEntries(
      propertyEntries.map(([propertyKey, property]) => [
        propertyKey,
        propertyKey === key ? wrongJsonType(type) : defaultValueForType(typeof property.type === 'string' ? property.type : 'string'),
      ]),
    );
    negatives.push({ input: base, label: `wrong-type:${key}` });
  }
  return negatives;
};

const defaultValueForType = (type: string): unknown => {
  switch (type) {
    case 'string':
      return 'value';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'value';
  }
};

const checkSurfaceCompleteness = (
  descriptor: TestableRouteDescriptor,
  surface: LiveSurface,
  manifest: AgentBundleTestManifest,
  boundary: MatrixBoundaryCapabilities,
): ContractCheckOutcome => {
  switch (descriptor.kind) {
    case 'tool': {
      const name = routeProtocolName(descriptor);
      return surface.tools.some((entry) => entry.name === name)
        ? passed()
        : failed(`tool ${JSON.stringify(name)} is missing from listTools`);
    }
    case 'resource': {
      const uri = routeResourceUri(descriptor);
      if (uri === undefined) {
        return failed('resource route config exports no uri to compare against listResources');
      }
      return surface.resources.includes(uri)
        ? passed()
        : failed(`resource URI ${JSON.stringify(uri)} is missing from listResources`);
    }
    case 'prompt': {
      const name = routeProtocolName(descriptor);
      return surface.prompts.includes(name)
        ? passed()
        : failed(`prompt ${JSON.stringify(name)} is missing from listPrompts`);
    }
    case 'app': {
      if (!boundary.registersAppResources) {
        return notApplicable('MCP Apps are not registered by the in-memory projection level.');
      }
      const uri = routeAppResourceUri(descriptor, manifest);
      if (uri === undefined) {
        return failed('app route config exports no resourceUri to compare against listResources');
      }
      return surface.resources.includes(uri)
        ? passed()
        : failed(`MCP App resource URI ${JSON.stringify(uri)} is missing from listResources`);
    }
    case 'cli':
    case 'event-route':
    case 'script':
      return notApplicable(`route kind ${descriptor.kind} is not registered on the MCP server surface.`);
    default: {
      const exhaustive: never = descriptor.kind;
      return failed(`unsupported route kind ${String(exhaustive)} for surface completeness`);
    }
  }
};

const runSweep = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  manifest: AgentBundleTestManifest,
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  switch (descriptor.kind) {
    case 'tool': {
      for (const input of fixtureInputs(fixture)) {
        const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
        if (result.threw) {
          return failed(`callTool threw: ${result.error instanceof Error ? result.error.message : captured(result.error)}`);
        }
        if (result.isError) {
          return notApplicable(
            'Invocation returned isError; sweep proves successful invocation paths only.',
          );
        }
        if (result.structuredContent === undefined) {
          return failed(`callTool returned no structuredContent for input ${captured(input)}`);
        }
      }
      return passed();
    }
    case 'resource':
    case 'app': {
      const uri = routeWireUri(descriptor, manifest);
      if (uri === undefined) {
        return failed(`${descriptor.kind} route config exports no uri to read`);
      }
      let read: { contents?: unknown };
      try {
        read = await client.readResource({ uri }) as { contents?: unknown };
      } catch (error) {
        return failed(`readResource threw for ${JSON.stringify(uri)}: ${error instanceof Error ? error.message : captured(error)}`);
      }
      const contents = Array.isArray(read.contents) ? read.contents : [];
      return contents.length === 0
        ? failed(`readResource returned no contents for ${JSON.stringify(uri)}`)
        : passed();
    }
    case 'prompt': {
      const result = await client.getPrompt({
        arguments: (fixture.input ?? {}) as Record<string, string>,
        name: routeProtocolName(descriptor),
      }) as { messages?: unknown };
      const messages = Array.isArray(result.messages) ? result.messages : [];
      return messages.length === 0
        ? failed(`getPrompt returned no messages for input ${captured(fixture.input ?? {})}`)
        : passed();
    }
    default:
      return notApplicable(`route kind ${descriptor.kind} has no sweep invocation at the MCP level.`);
  }
};

const runSerializedRoundTrip = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('serialized round-trip applies to tool structuredContent only.');
  }
  for (const input of fixtureInputs(fixture)) {
    const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
    if (result.threw) {
      return failed(`callTool threw before round-trip: ${result.error instanceof Error ? result.error.message : captured(result.error)}`);
    }
    if (result.isError) {
      return notApplicable('serialized round-trip requires a successful tool result.');
    }
    if (result.structuredContent === undefined) {
      return failed(`callTool returned no structuredContent for input ${captured(input)}`);
    }
    try {
      module.resultSchema.parse(serializedRoundTrip(result.structuredContent));
    } catch (error) {
      return failed(
        `JSON round-tripped structuredContent failed resultSchema.parse: ${error instanceof Error ? error.message : captured(error)}`,
      );
    }
  }
  return passed();
};

const runCompatProbe = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('result compat policy applies to tool routes only.');
  }
  if (fixture.resultCompat === undefined) {
    return failed('tool route fixture must declare resultCompat (additive or closed).');
  }
  const input = fixtureInputs(fixture)[0] ?? {};
  const result = await callToolResult(client, routeProtocolName(descriptor), input, { cache });
  if (result.threw || result.structuredContent === undefined || result.isError) {
    return notApplicable('compat probe requires a successful tool result with structuredContent.');
  }
  const roundTripped = serializedRoundTrip(result.structuredContent);
  const probe = compatProbe(roundTripped, fixture.resultCompat, module.resultSchema.parse.bind(module.resultSchema));
  if (fixture.resultCompat === 'additive') {
    return probe.accepted
      ? passed()
      : failed(`declared additive policy but resultSchema rejected unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`);
  }
  return probe.accepted
    ? failed(`declared closed policy but resultSchema accepted unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`)
    : passed();
};

const runVersionSkew = (
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
): ContractCheckOutcome => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('version-skew fixtures apply to tool routes only.');
  }
  if (fixture.previousResults === undefined || fixture.previousResults.length === 0) {
    return notApplicable('no previousResults fixtures declared.');
  }
  for (const [index, payload] of fixture.previousResults.entries()) {
    try {
      module.resultSchema.parse(payload);
    } catch (error) {
      return failed(
        `previousResults[${String(index)}] failed current resultSchema.parse: ${error instanceof Error ? error.message : captured(error)}`,
      );
    }
  }
  return passed();
};

const runNegativeInputs = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  surface: LiveSurface,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('negative input generation applies to tool routes only.');
  }
  const listing = surface.tools.find((entry) => entry.name === routeProtocolName(descriptor));
  if (listing?.inputSchema === undefined) {
    return notApplicable('listTools did not advertise an inputSchema for this tool.');
  }
  const negatives = negativeInputsFromJsonSchema(listing.inputSchema);
  if (negatives === undefined) {
    return notApplicable('advertised inputSchema has no top-level object structure to derive negative cases from.');
  }
  let anyRejected = false;
  let unknownExtraKeyAccepted = false;
  for (const negative of negatives) {
    const result = await callToolResult(client, routeProtocolName(descriptor), negative.input);
    if (result.threw || result.isError || result.structuredContent === undefined) {
      anyRejected = true;
      continue;
    }
    if (negative.label === 'unknown-extra-key') {
      unknownExtraKeyAccepted = true;
      continue;
    }
    return failed(`negative input ${negative.label} produced a successful tool result: ${captured(negative.input)}`);
  }
  if (!anyRejected) {
    return failed('no generated negative input caused callTool to fail or return isError');
  }
  return unknownExtraKeyAccepted
    ? passedWithReason(
      'unknown-extra-key input was accepted (advertised additionalProperties: false, but plain z.object routes may strip unknown keys without protocol failure); other generated negatives still proved rejection paths.',
    )
    : passed();
};

const runCancellation = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture,
  cache: Map<string, ToolInvocationResult>,
): Promise<ContractCheckOutcome> => {
  if (descriptor.kind !== 'tool') {
    return notApplicable('cancellation applies to tool routes only.');
  }
  if (fixture.cancellation === undefined) {
    return notApplicable('no cancellation fixture declared.');
  }
  const abortAfterMs = fixture.cancellation.abortAfterMs ?? 50;
  const settleWithinMs = abortAfterMs + 2_000;
  const controller = new AbortController();
  const input = fixture.cancellation.input ?? { holdMs: 5000 };
  const call = callToolResult(client, routeProtocolName(descriptor), input, {
    signal: controller.signal,
    timeout: settleWithinMs,
  });
  // The timer and the settlement race; `abortFired` is read the moment the
  // call settles so the verdict reflects whether the abort was ever delivered
  // while the invocation was still in flight.
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort();
  }, abortAfterMs);
  const result = await Promise.race([
    call.then((settled) => ({ abortedInFlight: abortFired, kind: 'settled' as const, settled })),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), settleWithinMs);
    }),
  ]);
  clearTimeout(timer);
  if (result.kind === 'timeout') {
    return failed(`callTool did not settle within ${String(settleWithinMs)}ms after abort`);
  }
  if (!result.abortedInFlight) {
    return notApplicable(
      result.settled.threw
        ? `invocation rejected before abort (${result.settled.error instanceof Error ? result.settled.error.message : captured(result.settled.error)}); use an input that stays in flight past ${String(abortAfterMs)}ms.`
        : `invocation completed before abort; use an input that stays in flight past ${String(abortAfterMs)}ms.`,
    );
  }
  if (!result.settled.threw) {
    return failed('aborted callTool settled without throwing or rejecting.');
  }
  const recoveryInput = fixtureInputs(fixture)[0] ?? {};
  const healthy = await callToolResult(client, routeProtocolName(descriptor), recoveryInput, { cache });
  if (healthy.threw) {
    return failed(`session did not recover: subsequent callTool threw: ${healthy.error instanceof Error ? healthy.error.message : captured(healthy.error)}`);
  }
  if (healthy.isError || healthy.structuredContent === undefined) {
    return failed('session did not recover: subsequent healthy invocation failed.');
  }
  return passed();
};

const LIFECYCLE_PHASES: readonly ContractLifecyclePhase[] = Object.freeze([
  'unknown',
  'queued',
  'running',
  'first-progress',
  'repeated-progress',
  'terminal',
]);

const valueAtPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

const containsExpected = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((entry, index) => containsExpected(actual[index], entry));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      containsExpected((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
};

const renderedText = (content: unknown): string => Array.isArray(content)
  ? content.flatMap((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
    const text = (block as { readonly text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  }).join('\n')
  : '';

interface LifecyclePhaseEvidence {
  readonly liveProgress: number;
  readonly result: ToolInvocationResult;
  readonly transition: ContractLifecycleTransition;
}

interface LifecycleEvidence {
  readonly byPhase: ReadonlyMap<ContractLifecyclePhase, LifecyclePhaseEvidence>;
  readonly orderFailure?: string;
}

type ClientNotificationHandler = (
  ...arguments_: readonly unknown[]
) => void | Promise<void>;

const progressMethod = 'notifications/progress';

const sdkProgressObserver = (
  notificationHandlers: Map<string, ClientNotificationHandler>,
): ContractMatrixProgressSource['observeProgress'] => (listener) => {
  const callerHandler = notificationHandlers.get(progressMethod);
  notificationHandlers.set(progressMethod, async (...arguments_) => {
    listener(arguments_[0] as ContractProgressNotification);
    await callerHandler?.(...arguments_);
  });
  return () => {
    if (callerHandler === undefined) {
      notificationHandlers.delete(progressMethod);
    } else {
      notificationHandlers.set(progressMethod, callerHandler);
    }
  };
};

/**
 * Resolves how lifecycle fixtures observe live progress: an explicit
 * `observeProgress` seam wins, an SDK `Client` exposes its handler map, and
 * anything else cannot gate a lifecycle fixture and says so instead of
 * failing on a missing private field.
 */
export const contractProgressObserver = (
  client: ContractMatrixClient,
): ContractMatrixProgressSource['observeProgress'] => {
  if (typeof client.observeProgress === 'function') return client.observeProgress;
  const handlers = (client as { readonly _notificationHandlers?: unknown })._notificationHandlers;
  if (handlers instanceof Map) return sdkProgressObserver(handlers as Map<string, ClientNotificationHandler>);
  throw new Error(
    'Contract matrix client exposes no progress notification path; lifecycle fixtures need an SDK Client or observeProgress.',
  );
};

const executeLifecycleTransitions = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  lifecycle: ContractLifecycleFixture,
  runtimeIdentity: RuntimeIdentityTracker,
): Promise<LifecycleEvidence> => {
  let transitions: readonly ContractLifecycleTransition[];
  try {
    transitions = lifecycle.transitionDriver();
  } catch (error) {
    return {
      byPhase: new Map(),
      orderFailure: `transitionDriver threw: ${error instanceof Error ? error.message : captured(error)}`,
    };
  }
  const actualPhases = transitions.map((transition) => transition.phase);
  if (
    actualPhases.length !== LIFECYCLE_PHASES.length
    || actualPhases.some((phase, index) => phase !== LIFECYCLE_PHASES[index])
  ) {
    return {
      byPhase: new Map(),
      orderFailure: `transitionDriver returned ${actualPhases.join(' → ') || '(no phases)'}; expected ${LIFECYCLE_PHASES.join(' → ')}`,
    };
  }

  const byPhase = new Map<ContractLifecyclePhase, LifecyclePhaseEvidence>();
  let observeProgress: ContractMatrixProgressSource['observeProgress'];
  try {
    observeProgress = contractProgressObserver(client);
  } catch (error) {
    return {
      byPhase: new Map(),
      orderFailure: error instanceof Error ? error.message : captured(error),
    };
  }
  let activeProgressToken: string | undefined;
  let settled = true;
  let liveProgress = 0;
  const stopObserving = observeProgress((notification) => {
    if (
      notification.params?.progressToken === activeProgressToken
      && !settled
    ) {
      liveProgress += 1;
    }
  });
  try {
    for (const [index, transition] of transitions.entries()) {
      activeProgressToken = `agent-bundle-contract-lifecycle:${descriptor.id}:${String(index)}`;
      settled = false;
      liveProgress = 0;
      const result = await callToolResult(
        client,
        routeProtocolName(descriptor),
        transition.input,
        { progressToken: activeProgressToken, timeout: 10_000 },
      );
      settled = true;
      byPhase.set(transition.phase, { liveProgress, result, transition });
      await runtimeIdentity.observe(`${descriptor.id}/${transition.phase}`);
    }
  } finally {
    stopObserving();
  }
  return { byPhase };
};

const checkLifecycleReplay = (evidence: LifecycleEvidence): ContractCheckOutcome => {
  if (evidence.orderFailure !== undefined) return failed(evidence.orderFailure);
  for (const phase of LIFECYCLE_PHASES) {
    const phaseEvidence = evidence.byPhase.get(phase);
    if (phaseEvidence === undefined) return failed(`transitionDriver produced no ${phase} evidence`);
    const { result, transition } = phaseEvidence;
    if (result.threw) {
      return failed(`${phase} callTool threw: ${result.error instanceof Error ? result.error.message : captured(result.error)}`);
    }
    if (result.isError || result.structuredContent === undefined) {
      return failed(`${phase} did not return successful structuredContent`);
    }
    if (!containsExpected(result.structuredContent, transition.expectedStructuredContent)) {
      return failed(`${phase} structuredContent did not include ${captured(transition.expectedStructuredContent)}; received ${captured(result.structuredContent)}`);
    }
    if (renderedText(result.content) === '') {
      return failed(`${phase} returned no rendered Agent Document text output`);
    }
    if (transition.renderedTextIncludes !== undefined && !renderedText(result.content).includes(transition.renderedTextIncludes)) {
      return failed(`${phase} rendered output did not include ${JSON.stringify(transition.renderedTextIncludes)}`);
    }
  }
  return passed();
};

const checkLifecycleSchema = (
  evidence: LifecycleEvidence,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
): ContractCheckOutcome => {
  if (evidence.orderFailure !== undefined) return notApplicable('lifecycle phase order failed before schema validation.');
  for (const phase of LIFECYCLE_PHASES) {
    const result = evidence.byPhase.get(phase)?.result;
    if (result === undefined || result.threw || result.isError || result.structuredContent === undefined) {
      return notApplicable(`${phase} produced no successful structuredContent to validate.`);
    }
    try {
      module.resultSchema.parse(serializedRoundTrip(result.structuredContent));
    } catch (error) {
      return failed(`${phase} JSON round-tripped structuredContent failed resultSchema.parse: ${error instanceof Error ? error.message : captured(error)}`);
    }
  }
  return passed();
};

const checkLifecycleCompat = (
  evidence: LifecycleEvidence,
  fixture: ContractRouteFixture,
  module: AgentRouteModule & { readonly resultSchema: { parse: (value: unknown) => unknown } },
): ContractCheckOutcome => {
  if (fixture.resultCompat === undefined) return failed('lifecycle tool fixture must declare resultCompat.');
  for (const phase of LIFECYCLE_PHASES) {
    const result = evidence.byPhase.get(phase)?.result;
    if (result === undefined || result.threw || result.isError || result.structuredContent === undefined) {
      return notApplicable(`${phase} produced no successful structuredContent for compat probing.`);
    }
    const probe = compatProbe(
      serializedRoundTrip(result.structuredContent),
      fixture.resultCompat,
      module.resultSchema.parse.bind(module.resultSchema),
    );
    if (fixture.resultCompat === 'additive' && !probe.accepted) {
      return failed(`${phase} declared additive policy but resultSchema rejected unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`);
    }
    if (fixture.resultCompat === 'closed' && probe.accepted) {
      return failed(`${phase} declared closed policy but resultSchema accepted unknown key ${JSON.stringify(COMPAT_PROBE_KEY)}`);
    }
  }
  return passed();
};

const checkLiveProgress = (evidence: LifecycleEvidence): ContractCheckOutcome => {
  if (evidence.orderFailure !== undefined) return notApplicable('lifecycle phase order failed before progress assertions.');
  for (const phase of LIFECYCLE_PHASES) {
    const phaseEvidence = evidence.byPhase.get(phase);
    if (phaseEvidence === undefined) continue;
    if (phaseEvidence.liveProgress < phaseEvidence.transition.progressNotifications) {
      return failed(
        `${phase} exposed ${String(phaseEvidence.liveProgress)} live progress notification(s) before settlement; expected at least ${String(phaseEvidence.transition.progressNotifications)}`,
      );
    }
  }
  return passed();
};

const checkLifecyclePath = (
  evidence: LifecycleEvidence,
  phase: ContractLifecyclePhase,
  path: readonly string[],
  expected: unknown,
): ContractCheckOutcome => {
  const result = evidence.byPhase.get(phase)?.result;
  if (result === undefined || result.threw || result.structuredContent === undefined) {
    return notApplicable(`${phase} produced no structuredContent for state assertion.`);
  }
  const actual = valueAtPath(result.structuredContent, path);
  return containsExpected(actual, expected)
    ? passed()
    : failed(`${phase} structuredContent path ${path.join('.')} expected ${captured(expected)}; received ${captured(actual)}`);
};

const checkStateCatalog = (
  manifest: AgentBundleTestManifest,
  lifecycle: ContractLifecycleFixture,
): ContractCheckOutcome => {
  const expected = lifecycle.state?.catalog;
  if (expected === undefined) {
    return notApplicable('no lifecycle state catalog assertion declared.');
  }
  const actual = manifest.state;
  if (actual === undefined) {
    return failed(`lifecycle fixture declares state ${JSON.stringify(expected.id)}, but the compiled manifest declares no state`);
  }
  if (actual.id !== expected.id || actual.lifetime !== expected.lifetime) {
    return failed(
      `compiled state catalog was ${JSON.stringify(actual.id)} (${actual.lifetime}); `
      + `the mounted-state lifecycle fixture declares ${JSON.stringify(expected.id)} (${expected.lifetime})`,
    );
  }
  return passed();
};

const runStateIdempotency = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  evidence: LifecycleEvidence,
  assertion: NonNullable<NonNullable<ContractLifecycleFixture['state']>['idempotency']>,
): Promise<ContractCheckOutcome> => {
  const original = evidence.byPhase.get(assertion.phase);
  if (original === undefined || original.result.threw || original.result.structuredContent === undefined) {
    return notApplicable(`${assertion.phase} produced no structuredContent for idempotency replay.`);
  }
  const replay = await callToolResult(client, routeProtocolName(descriptor), original.transition.input);
  if (replay.threw || replay.isError || replay.structuredContent === undefined) {
    return failed(`replaying ${assertion.phase} did not return successful structuredContent`);
  }
  const originalRevision = valueAtPath(original.result.structuredContent, assertion.revisionPath);
  const replayRevision = valueAtPath(replay.structuredContent, assertion.revisionPath);
  if (!Object.is(originalRevision, replayRevision)) {
    return failed(`idempotent replay changed revision from ${captured(originalRevision)} to ${captured(replayRevision)}`);
  }
  return valueAtPath(replay.structuredContent, assertion.replayedPath) === true
    ? passed()
    : failed(`idempotent replay did not report true at ${assertion.replayedPath.join('.')}`);
};

const runStateBudget = async (
  client: ContractMatrixClient,
  descriptor: TestableRouteDescriptor,
  evidence: LifecycleEvidence,
  assertion: NonNullable<NonNullable<ContractLifecycleFixture['state']>['budget']>,
): Promise<ContractCheckOutcome> => {
  const terminal = evidence.byPhase.get('terminal')?.result;
  if (terminal === undefined || terminal.threw || terminal.structuredContent === undefined) {
    return notApplicable('terminal produced no structuredContent for budget boundary comparison.');
  }
  const result = await callToolResult(client, routeProtocolName(descriptor), assertion.input);
  if (result.threw || result.isError || result.structuredContent === undefined) {
    return failed('budget probe did not return typed successful fixture evidence');
  }
  const code = valueAtPath(result.structuredContent, assertion.codePath);
  if (code !== assertion.expectedCode) {
    return failed(`budget probe expected typed code ${JSON.stringify(assertion.expectedCode)}; received ${captured(code)}`);
  }
  const before = valueAtPath(terminal.structuredContent, assertion.revisionPath);
  const after = valueAtPath(result.structuredContent, assertion.revisionPath);
  return Object.is(before, after)
    ? passed()
    : failed(`budget-exceeded commit changed revision from ${captured(before)} to ${captured(after)}`);
};

const matrixRouteDescriptors = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => [
  ...serverRoutes(manifest, serverName),
  ...serverAppRoutes(manifest, serverName),
].sort((left, right) => left.id.localeCompare(right.id));

const finalizeContractMatrixReport = (
  failures: ContractMatrixFailure[],
  boundary: MatrixBoundaryCapabilities,
  checks: Readonly<Record<string, ContractCheckOutcome>>,
  provenance: ContractMatrixProvenance,
  routeReports: Record<string, ContractRouteReport>,
): ContractMatrixReport => {
  const report: ContractMatrixReport = Object.freeze({
    checks: Object.freeze(checks),
    provenance,
    routes: Object.freeze(routeReports),
  });
  if (failures.length === 0) return report;

  const proofLabel = proofLevelLabel(boundary.proofLevel);
  const details = failures.map((entry) =>
    `- ${entry.routeId} / ${entry.check}: ${entry.reason} (${proofLabel})`);
  throw new ContractMatrixViolationError(
    `Contract matrix reported ${String(failures.length)} violation(s) at the ${boundary.proofLevel} proof level.`,
    failures,
    report,
    {
      details,
      recovery: boundary.recovery,
    },
  );
};

const AUTO_APP_FIXTURE: ContractResourceFixture = Object.freeze({ kind: 'resource' });

const APP_AUTO_COVERAGE_REASON =
  'app route auto-covered (apps: "auto"): the sweep reads its compiled MCP App resource URI.';

interface ResolvedRouteFixture {
  readonly coverage: ContractCheckOutcome;
  readonly fixture: ContractRouteFixture | undefined;
}

const resolveRouteFixture = (
  descriptor: TestableRouteDescriptor,
  fixture: ContractRouteFixture | undefined,
  apps: ContractAppCoverage,
): ResolvedRouteFixture => {
  if (fixture === undefined) {
    if (descriptor.kind !== 'app') {
      return { coverage: failed('compiled route has no fixture entry'), fixture };
    }
    switch (apps) {
      case 'auto':
        return { coverage: passedWithReason(APP_AUTO_COVERAGE_REASON), fixture: AUTO_APP_FIXTURE };
      case 'explicit':
        return {
          coverage: failed('compiled app route has no fixture entry (apps: "explicit"); add { kind: "resource" } or use apps: "auto"'),
          fixture,
        };
      default: {
        const exhaustive: never = apps;
        return { coverage: failed(`unsupported apps coverage mode ${String(exhaustive)}`), fixture: undefined };
      }
    }
  }
  if (fixture.kind === 'resource' && descriptor.kind !== 'resource' && descriptor.kind !== 'app') {
    return {
      coverage: failed(`fixture kind "resource" declared for a ${descriptor.kind} route; resource fixtures apply to resource and app routes only`),
      fixture: undefined,
    };
  }
  return { coverage: passed(), fixture };
};

const executeContractMatrix = async (options: {
  readonly apps: ContractAppCoverage;
  readonly boundary: MatrixBoundaryCapabilities;
  readonly client: ContractMatrixClient;
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly manifest: AgentBundleTestManifest;
  readonly provenance: ContractMatrixProvenance;
  readonly serverName: string;
}): Promise<ContractMatrixReport> => {
  const { apps, boundary, client, fixtures, manifest, provenance, serverName } = options;
  const failures: ContractMatrixFailure[] = [];
  const matrixChecks: Record<string, ContractCheckOutcome> = {};
  const routeReports: Record<string, ContractRouteReport> = {};
  const runtimeIdentity = createRuntimeIdentityTracker(boundary, manifest, serverName);
  const moduleSchemaNotApplicable = (): ContractCheckOutcome =>
    notApplicable(boundary.moduleSchemaNotApplicableReason);

  const unknownFixtureKeys = Object.keys(fixtures).filter(
    (routeId) => manifest.routes[routeId] === undefined,
  );
  if (unknownFixtureKeys.length > 0) {
    for (const routeId of unknownFixtureKeys.sort()) {
      recordFailure(
        failures,
        routeId,
        CHECK_COVERAGE,
        `fixture names unknown route ${JSON.stringify(routeId)}`,
      );
      routeReports[routeId] = {
        checks: {
          [CHECK_COVERAGE]: failed(`fixture names unknown route ${JSON.stringify(routeId)}`),
        },
      };
    }
  }

  await runtimeIdentity.observe('before matrix events');
  const surface = await listLiveSurface(client);
  const invocationCache = new Map<string, ToolInvocationResult>();
  const durabilityChecks: Array<{
    readonly assertion: NonNullable<NonNullable<ContractLifecycleFixture['state']>['durability']>;
    readonly checks: Record<string, ContractCheckOutcome>;
    readonly descriptor: TestableRouteDescriptor;
  }> = [];

  for (const descriptor of matrixRouteDescriptors(manifest, serverName)) {
    if (descriptor.kind === 'app' && !boundary.registersAppResources) {
      routeReports[descriptor.id] = {
        checks: {
          [CHECK_SURFACE]: notApplicable('MCP Apps are not registered by the in-memory projection level.'),
        },
      };
      await runtimeIdentity.observe(`after ${descriptor.id}`);
      continue;
    }

    const checks: Record<string, ContractCheckOutcome> = {};
    const { coverage, fixture } = resolveRouteFixture(descriptor, fixtures[descriptor.id], apps);

    checks[CHECK_COVERAGE] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_COVERAGE,
      coverage,
    );

    checks[CHECK_SURFACE] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_SURFACE,
      checkSurfaceCompleteness(descriptor, surface, manifest, boundary),
    );

    if (fixture === undefined) {
      routeReports[descriptor.id] = { checks };
      await runtimeIdentity.observe(`after ${descriptor.id}`);
      continue;
    }

    checks[CHECK_SWEEP] = outcomeFromCheck(
      failures,
      descriptor.id,
      CHECK_SWEEP,
      await runSweep(client, descriptor, fixture, manifest, invocationCache),
    );

    if (descriptor.kind === 'tool') {
      if (boundary.canLoadRouteModules) {
        const module = await loadRouteModule(manifest, descriptor);
        checks[CHECK_SERIALIZED_ROUND_TRIP] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_SERIALIZED_ROUND_TRIP,
          await runSerializedRoundTrip(client, descriptor, fixture, module, invocationCache),
        );
        checks[CHECK_COMPAT_PROBE] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_COMPAT_PROBE,
          await runCompatProbe(client, descriptor, fixture, module, invocationCache),
        );
        checks[CHECK_VERSION_SKEW] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_VERSION_SKEW,
          runVersionSkew(descriptor, fixture, module),
        );
      } else {
        checks[CHECK_SERIALIZED_ROUND_TRIP] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_SERIALIZED_ROUND_TRIP,
          moduleSchemaNotApplicable(),
        );
        checks[CHECK_COMPAT_PROBE] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_COMPAT_PROBE,
          moduleSchemaNotApplicable(),
        );
        checks[CHECK_VERSION_SKEW] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_VERSION_SKEW,
          moduleSchemaNotApplicable(),
        );
      }
      checks[CHECK_NEGATIVE_INPUTS] = outcomeFromCheck(
        failures,
        descriptor.id,
        CHECK_NEGATIVE_INPUTS,
        await runNegativeInputs(client, descriptor, surface),
      );
      checks[CHECK_CANCELLATION] = outcomeFromCheck(
        failures,
        descriptor.id,
        CHECK_CANCELLATION,
        await runCancellation(client, descriptor, fixture, invocationCache),
      );

      if (fixture.lifecycle === undefined) {
        const reason = 'no lifecycle fixture declared.';
        checks[CHECK_LIFECYCLE_REPLAY] = notApplicable(reason);
        checks[CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP] = notApplicable(reason);
        checks[CHECK_LIFECYCLE_COMPAT_PROBE] = notApplicable(reason);
        checks[CHECK_LIVE_PROGRESS] = notApplicable(reason);
        checks[CHECK_STATE_JOURNAL] = notApplicable(reason);
        checks[CHECK_STATE_NOTICE] = notApplicable(reason);
        checks[CHECK_STATE_IDEMPOTENCY] = notApplicable(reason);
        checks[CHECK_STATE_BUDGET] = notApplicable(reason);
        checks[CHECK_STATE_CATALOG] = notApplicable(reason);
        checks[CHECK_RESTART_DURABILITY] = notApplicable(reason);
      } else {
        const lifecycle = fixture.lifecycle;
        const evidence = await executeLifecycleTransitions(
          client,
          descriptor,
          lifecycle,
          runtimeIdentity,
        );
        checks[CHECK_LIFECYCLE_REPLAY] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_LIFECYCLE_REPLAY,
          checkLifecycleReplay(evidence),
        );
        checks[CHECK_LIVE_PROGRESS] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_LIVE_PROGRESS,
          checkLiveProgress(evidence),
        );
        if (boundary.canLoadRouteModules) {
          const module = await loadRouteModule(manifest, descriptor);
          checks[CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP] = outcomeFromCheck(
            failures,
            descriptor.id,
            CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP,
            checkLifecycleSchema(evidence, module),
          );
          checks[CHECK_LIFECYCLE_COMPAT_PROBE] = outcomeFromCheck(
            failures,
            descriptor.id,
            CHECK_LIFECYCLE_COMPAT_PROBE,
            checkLifecycleCompat(evidence, fixture, module),
          );
        } else {
          checks[CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP] = moduleSchemaNotApplicable();
          checks[CHECK_LIFECYCLE_COMPAT_PROBE] = moduleSchemaNotApplicable();
        }
        const journal = lifecycle.state?.journal;
        checks[CHECK_STATE_JOURNAL] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_STATE_JOURNAL,
          journal === undefined
            ? notApplicable('no lifecycle state journal assertion declared.')
            : checkLifecyclePath(evidence, 'terminal', journal.path, journal.expected),
        );
        const notice = lifecycle.state?.notice;
        checks[CHECK_STATE_NOTICE] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_STATE_NOTICE,
          notice === undefined
            ? notApplicable('no lifecycle notice assertion declared.')
            : checkLifecyclePath(evidence, notice.phase, notice.path, notice.expected),
        );
        const idempotency = lifecycle.state?.idempotency;
        checks[CHECK_STATE_IDEMPOTENCY] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_STATE_IDEMPOTENCY,
          idempotency === undefined
            ? notApplicable('no lifecycle idempotency assertion declared.')
            : await runStateIdempotency(client, descriptor, evidence, idempotency),
        );
        const budget = lifecycle.state?.budget;
        checks[CHECK_STATE_BUDGET] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_STATE_BUDGET,
          budget === undefined
            ? notApplicable('no lifecycle budget assertion declared.')
            : await runStateBudget(client, descriptor, evidence, budget),
        );
        checks[CHECK_STATE_CATALOG] = outcomeFromCheck(
          failures,
          descriptor.id,
          CHECK_STATE_CATALOG,
          checkStateCatalog(manifest, lifecycle),
        );
        const durability = lifecycle.state?.durability;
        if (durability === undefined) {
          checks[CHECK_RESTART_DURABILITY] = notApplicable(
            'no lifecycle restart-durability assertion declared.',
          );
        } else {
          durabilityChecks.push({ assertion: durability, checks, descriptor });
        }
      }
    } else {
      checks[CHECK_SERIALIZED_ROUND_TRIP] = notApplicable('applies to tool routes only.');
      checks[CHECK_COMPAT_PROBE] = notApplicable('applies to tool routes only.');
      checks[CHECK_VERSION_SKEW] = notApplicable('applies to tool routes only.');
      checks[CHECK_NEGATIVE_INPUTS] = notApplicable('applies to tool routes only.');
      checks[CHECK_CANCELLATION] = notApplicable('applies to tool routes only.');
      checks[CHECK_LIFECYCLE_REPLAY] = notApplicable('applies to tool routes only.');
      checks[CHECK_LIFECYCLE_SERIALIZED_ROUND_TRIP] = notApplicable('applies to tool routes only.');
      checks[CHECK_LIFECYCLE_COMPAT_PROBE] = notApplicable('applies to tool routes only.');
      checks[CHECK_LIVE_PROGRESS] = notApplicable('applies to tool routes only.');
      checks[CHECK_STATE_JOURNAL] = notApplicable('applies to tool routes only.');
      checks[CHECK_STATE_NOTICE] = notApplicable('applies to tool routes only.');
      checks[CHECK_STATE_IDEMPOTENCY] = notApplicable('applies to tool routes only.');
      checks[CHECK_STATE_BUDGET] = notApplicable('applies to tool routes only.');
      checks[CHECK_STATE_CATALOG] = notApplicable('applies to tool routes only.');
      checks[CHECK_RESTART_DURABILITY] = notApplicable('applies to tool routes only.');
    }

    routeReports[descriptor.id] = { checks };
    await runtimeIdentity.observe(`after ${descriptor.id}`);
  }

  matrixChecks[CHECK_RUNTIME_INSTANCE_IDENTITY] = outcomeFromCheck(
    failures,
    'boundary',
    CHECK_RUNTIME_INSTANCE_IDENTITY,
    runtimeIdentity.outcome(),
  );

  if (durabilityChecks.length > 0) {
    if (boundary.restart === undefined) {
      for (const pending of durabilityChecks) {
        pending.checks[CHECK_RESTART_DURABILITY] = notApplicable(
          'this matrix run was not supplied a same-store restart callback; durability cannot be inferred from the initial connection.',
        );
      }
    } else {
      let restarted: ContractMatrixRestartSession | undefined;
      let restartError: unknown;
      try {
        restarted = await boundary.restart();
      } catch (error) {
        restartError = error;
      }
      for (const pending of durabilityChecks) {
        let outcome: ContractCheckOutcome;
        if (restarted === undefined) {
          outcome = failed(`same-store restart failed: ${restartError instanceof Error ? restartError.message : captured(restartError)}`);
        } else {
          const result = await callToolResult(
            restarted.client,
            routeProtocolName(pending.descriptor),
            pending.assertion.input,
          );
          outcome = result.threw || result.isError || result.structuredContent === undefined
            ? failed('restarted session did not return successful structuredContent')
            : containsExpected(result.structuredContent, pending.assertion.expectedStructuredContent)
              ? passed()
              : failed(`restarted structuredContent did not include ${captured(pending.assertion.expectedStructuredContent)}; received ${captured(result.structuredContent)}`);
        }
        pending.checks[CHECK_RESTART_DURABILITY] = outcomeFromCheck(
          failures,
          pending.descriptor.id,
          CHECK_RESTART_DURABILITY,
          outcome,
        );
      }
    }
  }

  return finalizeContractMatrixReport(
    failures,
    boundary,
    matrixChecks,
    provenance,
    routeReports,
  );
};

/**
 * Runs the contract matrix against one compiled MCP server at the
 * `mcp-in-memory` proof level. Returns a per-route report; throws one
 * aggregated `AgentTestError` with code `contract-violation` when any check
 * failed (never first-failure-only).
 */
export const runContractMatrix = async (
  options: ContractMatrixOptions,
): Promise<ContractMatrixReport> => {
  const manifest = options.manifest ?? testManifest();
  const serverName = resolveServerName(manifest, options.server);
  const session = await openInMemoryMcpServer(options);
  try {
    const boundary: MatrixBoundaryCapabilities = options.restart === undefined
      ? IN_MEMORY_BOUNDARY
      : Object.freeze({
        ...IN_MEMORY_BOUNDARY,
        restart: async () => {
          await session.close();
          return options.restart!();
        },
      });
    return await executeContractMatrix({
      apps: options.apps ?? 'auto',
      boundary,
      client: session.client,
      fixtures: options.fixtures,
      manifest,
      provenance: session.provenance,
      serverName,
    });
  } finally {
    await session.close();
  }
};

/**
 * Runs #218 stage 4's shared matrix against an already-open dev epoch session.
 * The caller owns the epoch lease and process lifetime so host adoption can
 * settle without replacing or dropping an existing live host connection.
 */
export const runDevEpochContractMatrix = async (
  options: DevEpochContractMatrixOptions,
): Promise<ContractMatrixReport> => {
  const serverName = resolveServerName(options.manifest, options.server);
  return executeContractMatrix({
    apps: options.apps ?? 'auto',
    boundary: DEV_EPOCH_BOUNDARY,
    client: options.session.client,
    fixtures: options.fixtures,
    manifest: options.manifest,
    provenance: options.session.provenance,
    serverName,
  });
};

/**
 * Runs the contract matrix against an already-open packed stdio session.
 * Never opens or closes the session; stamps the session's own proof level.
 * Compiled MCP App routes are covered here (surface + `ui://` sweep) and
 * auto-covered without a fixture entry unless `apps: 'explicit'`.
 */
export const runPackedContractMatrix = async (
  options: PackedContractMatrixOptions,
): Promise<ContractMatrixReport> => {
  const serverName = resolveServerName(options.manifest, options.server);
  return executeContractMatrix({
    apps: options.apps ?? 'auto',
    boundary: packedBoundaryFromSession(
      options.session,
      options.eventRuntime,
      options.restart,
    ),
    client: options.session.client,
    fixtures: options.fixtures,
    manifest: options.manifest,
    provenance: options.session.provenance,
    serverName,
  });
};

/**
 * Runs the shared contract matrix over an already-open MCP process discovered
 * and spawned from a host-owned installed layout. The returned report carries
 * the separately observed source/artifact/installed/running version evidence.
 */
export const runInstalledHostContractMatrix = async (
  options: InstalledHostContractMatrixOptions,
): Promise<InstalledHostContractMatrixReport> => {
  const serverName = resolveServerName(options.manifest, options.server);
  const matrix = await executeContractMatrix({
    apps: options.apps ?? 'auto',
    boundary: installedHostBoundaryFromSession(options.session),
    client: options.session.client,
    fixtures: options.fixtures,
    manifest: options.manifest,
    provenance: options.session.provenance,
    serverName,
  });
  return Object.freeze({
    checks: options.session.observation.checks,
    host: options.session.observation.host,
    matrix,
    metadata: options.session.observation.metadata,
    proofLevel: options.session.observation.proofLevel,
    sessionEvidence: options.session.observation.sessionEvidence,
    status: 'passed',
    versions: options.session.observation.versions,
  });
};
