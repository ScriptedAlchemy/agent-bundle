# Optional RSC Development Runtime Provider and HMR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly opt-in development-runtime provider boundary to Agent Bundle and prove the RSC example can run a real long-lived Rsbuild/Rspack RSC compiler with immutable, generation-pinned hook/tool operations, a stable runtime MCP broker, real App Fast Refresh, and last-good HMR recovery.

**Architecture:** Agent Bundle core owns provider discovery, serializable wire contracts, fixed authenticated foreground routes, lifecycle aggregation, and an immutable runtime-generation store; it never imports React or RSC. The example provider owns Rsbuild, `rsbuild-plugin-rsc`, worker execution, external state, and generation materialization. Rsbuild's raw `rsc:update` remains an invalidation hint; Agent Bundle publishes `runtime.generation.activated` only after every server entry, paired client reference, manifest, initial asset, and async chunk has been copied, digested, validated, and atomically activated.

**Tech Stack:** TypeScript 7, Node.js 22.19+, Rstest 0.11, Agent Bundle foreground server/SSE, Rsbuild 2.1.13, Rspack 2.1.10, `rsbuild-plugin-rsc` 0.1.1, React 19.2.8, `react-server-dom-rspack` 0.0.3, Jiti 2.7.

## Global Constraints

- The runtime is supplemental and opt-in through `dev.runtime.provider`; ordinary skills, MCPs, evaluations, native hooks, builds, packages, tests, and `agent-bundle dev` must continue without importing a provider, React, React Server Components, or `rsbuild-plugin-rsc`.
- `provider` is project-relative and must remain inside the real project root after symlink resolution; browser input can select only provider-declared opaque identifiers and never a module, executable, command, cwd, environment, output root, or upstream URL.
- Core contracts are React-free and JSON-serializable. No `ReactNode`, Flight stream, secret value, child environment value, or executable path crosses the foreground JSON boundary.
- Rslib remains the production/library packaging tool. The RSC provider must use a long-lived Rsbuild development compiler, not Rslib watch mode, for RSC HMR, the browser client, middleware, WebSocket messages, and React Fast Refresh.
- The RSC environments remain named `rsc`, `widget`, and `app`; `pluginRSC({ environments: { server: 'rsc', client: 'widget' } })` remains the RSC pairing.
- Preserve the scoped `rules[].parser = { importMeta: { url: false } }` override only for `src/flight/request-render.ts`; do not disable `import.meta` transformation globally because `rsbuild-plugin-rsc` needs `import.meta.rspackRsc` processing.
- Keep real async runtime chunks under `chunks/` and include every initial and async asset in the immutable generation manifest. Do not restore eager bundling to avoid manifest work.
- A raw `rsc:update` is invalidation only. Automatic rerun is permitted only after `runtime.generation.activated` identifies the fully activated generation.
- Every hook run and every individual runtime MCP list/read/call operation captures and leases one exact `RuntimeVector` from start through completion. The stable MCP broker/session is not generation-pinned; an implementation-only activation moves its execution pointer while already running operations drain on their original leases.
- A generation becomes active only in one provider-tail transaction: immutable store preparation and MCP reconcile preparation remain non-public, then generation active pointer, MCP execution pointer/revisions, runtime status, and activated event commit in one no-yield synchronous section. Implicit leases can observe only the old fully published transaction or the new fully published transaction.
- MCP definitions are serialized and registered before a session lists capabilities; JSX cannot register tools/resources dynamically. Definition or transport digest changes trigger controlled restart/reconnect/relist, increment session/registry revisions, and invalidate old App bindings. Implementation-only generation/server digest changes do not reconnect or change `sessionId`/`sessionRevision`.
- Shared state is external and identified by `stateStoreId` plus monotonic `stateVersion`; no API promises shared JavaScript module memory across workers or generations.
- Runtime compilation failure preserves the last-good generation and run output. Cleanup retains the active generation plus the five newest unreferenced inactive generations.
- `close()` is idempotent and attempts every owned cleanup: Rsbuild server/compiler, workers, runtime MCP sessions, generation leases, temporary run data, middleware/WebSocket listeners, and generation staging.
- Existing foreground Host, Origin, same-session token, 64 KiB mutation-body, loopback, and path-containment checks remain in force. Runtime execution additionally enforces 10 s run time, 4 MiB stdout/Flight, 256 KiB stderr, and four concurrent workers.
- This plan supplies the stable runtime MCP registry/broker contract and reconciliation policy. The MCP Apps/host-profiles plan exposes it through `/api/runtime/mcp/sessions*`, the official SDK/Inspector transport, sandbox bindings, and host simulations; it does not reuse the artifact-epoch `/api/mcp/sessions*` implementation.

---

## Planned File Topology

```text
packages/agent-bundle/src/
├── core/types.ts                         # optional dev.runtime config types only
└── dev/
    ├── runtime-protocol.ts               # JSON wire identities, status, surfaces, runs, inspection
    ├── runtime-provider.ts               # provider/session/start contracts; no React imports
    ├── runtime-provider-loader.ts        # realpath containment + Jiti named-export loading
    ├── runtime-controller.ts             # provider start/failure/event/lifecycle boundary
    ├── runtime-generation-store.ts       # staging, validation, fencing, activation, leases, retention
    ├── runtime-mcp-registry.ts           # stable broker, per-operation leases, restart/relist policy
    ├── runtime-client-surface-proxy.ts   # fixed loopback HTTP/WS App HMR proxy
    ├── runtime-routes.ts                 # fixed /api/runtime HTTP transport
    ├── project-service.ts                # dev-only declaration extraction into PreparedProject
    ├── coordinator.ts                    # consume one pre-prepared first build; ignore runtime output root
    ├── foreground-server.ts              # compose RuntimeRoutes; no arbitrary provider middleware
    ├── events.ts / types.ts              # typed runtime summary events without epoch requirement
    ├── workbench-server.ts               # one-load startup and aggregate cleanup
    └── index.ts                          # internal/public development type exports
packages/agent-bundle/tests/
├── runtime-provider.test.ts
├── runtime-generation-store.test.ts
├── runtime-mcp-registry.test.ts
├── runtime-client-surface-proxy.test.ts
├── runtime-routes.test.ts
├── dev-events.contract.test.ts
├── dev-coordinator.test.ts
└── dev-workbench.test.ts
examples/rsc-agent-runtime/
├── agent-bundle.config.ts                # opts into ./src/dev/provider.ts
├── rsbuild.config.ts                     # shared production/dev config factory
├── src/build/emit-artifacts.ts            # complete digested manifest inputs
├── src/dev/
│   ├── provider.ts                       # createDevRuntimeProvider export
│   ├── rsbuild-runtime-session.ts        # long-lived compiler/session owner
│   ├── definition-entry.ts               # fresh compiler-cohort catalog serializer
│   ├── generation-materializer.ts        # complete multi-environment cohort copier
│   ├── invocation-worker.ts              # generation-bundled Flight/decode/lower inspection entry
│   └── serialize-inspection.ts           # JSON tree/trace/result lowering
├── src/runtime/state-file.ts             # monotonic idempotent crash-tolerant JSONL state
└── tests/
    ├── app-fast-refresh.integration.test.ts
    ├── dev-provider.integration.test.ts
    ├── dev-invocation.integration.test.ts
    ├── generation-materializer.test.ts
    └── rsc-hmr.integration.test.ts
```

The MCP Apps/host-profiles plan consumes the stable registry/session contract and adds its transport/routes/sandbox. The Runtime Playground plan consumes `runtime-protocol.ts`; neither plan may redefine these wire types.

### Task 1: Freeze the optional config, wire protocol, and React-free provider contract

**Files:**
- Modify: `packages/agent-bundle/src/core/types.ts`
- Create: `packages/agent-bundle/src/dev/runtime-protocol.ts`
- Create: `packages/agent-bundle/src/dev/runtime-provider.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Modify: `packages/agent-bundle/src/api.ts`
- Modify: `packages/agent-bundle/src/config/index.ts`
- Test: `packages/agent-bundle/tests/public-api.test.ts`
- Test: `packages/agent-bundle/tests/runtime-provider.test.ts`

**Interfaces:**
- Consumes: existing `JsonObject`, `JsonValue`, `ArtifactStatus`, `ProjectEventHub`, and `Diagnostic`.
- Produces: the exact configuration, browser wire, stable MCP registry/per-operation vector, and asset interfaces used by every later task and the other three implementation plans.

- [ ] **Step 1: Write the failing public-contract tests**

Add compile-time `satisfies` fixtures and runtime literal assertions. The test must fail if `dev.runtime.provider` is unavailable, a run result can contain a `ReactNode`, a surface omits its declared targets, or an MCP binding omits its stable registry/session revisions and digests.

```ts
const config = defineConfig({
  dev: { runtime: { provider: './src/dev/provider.ts' } },
  plugin: { name: 'runtime-contract', version: '1.0.0' },
}) satisfies AgentBundleConfig;

const surface = {
  defaultTarget: 'claude',
  fixtures: [{ id: 'after-edit', label: 'After file edit' }],
  id: 'hook.after-edit',
  kind: 'hook',
  label: 'After file edit',
  readOnly: false,
  targets: ['claude', 'codex'],
} satisfies DevRuntimeSurface;

const binding = {
  definitionDigest: 'definition-a',
  providerSessionId: 'provider-a',
  registryRevision: 3,
  serverDigest: 'server-a',
  serverName: 'timeline',
  sessionId: 'mcp-a',
  sessionRevision: 2,
  stateStoreId: 'fixture-a',
  target: 'portable',
  transportDigest: 'transport-a',
} satisfies DevRuntimeMcpSessionBinding;

expect(config.dev?.runtime?.provider).toBe('./src/dev/provider.ts');
expect(surface.targets).toEqual(['claude', 'codex']);
expect(binding.sessionRevision).toBe(2);
```

- [ ] **Step 2: Run the tests and watch the missing exports fail**

Run: `npm test -- packages/agent-bundle/tests/public-api.test.ts packages/agent-bundle/tests/runtime-provider.test.ts`

Expected: FAIL because `AgentBundleDevConfig`, `DevRuntimeSurface`, `DevRuntimeMcpSessionBinding`, and the provider interfaces do not exist.

- [ ] **Step 3: Add the exact config and wire types**

Add these types to `core/types.ts` and the `dev` field to `AgentBundleConfig` without placing it in `NormalizedPlugin`:

```ts
export interface AgentBundleDevRuntimeConfig {
  readonly provider: string;
}

export interface AgentBundleDevConfig {
  readonly runtime?: AgentBundleDevRuntimeConfig;
}

export interface AgentBundleConfig {
  // existing fields stay unchanged
  dev?: AgentBundleDevConfig;
}
```

Create `runtime-protocol.ts` with these exact exported shapes:

```ts
import type { JsonObject, JsonValue } from './types.ts';

export interface RuntimeVector {
  readonly artifactEpochId?: string;
  readonly providerSessionId: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}

export interface DevRuntimeStateIdentity {
  readonly stateStoreId: string;
  readonly stateVersion: number;
}

export type DevRuntimeDiagnosticPhase =
  | 'source/build' | 'fixture-validation' | 'hook-wrapper' | 'rsc-render'
  | 'flight-decode' | 'lowering-contract' | 'mcp-protocol' | 'resource-selection'
  | 'sandbox/csp' | 'app-bridge' | 'provider-lifecycle';

export interface DevRuntimeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly phase: DevRuntimeDiagnosticPhase;
  readonly severity: 'error' | 'warning' | 'info';
}

export interface DevRuntimeDescriptor {
  readonly environmentVariables: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly schemaVersion: 1;
}

export interface DevRuntimeFixture {
  readonly id: string;
  readonly label: string;
  readonly seed?: JsonValue;
}

export interface DevRuntimeSurface {
  readonly defaultTarget?: string;
  readonly fixtures: readonly DevRuntimeFixture[];
  readonly id: string;
  readonly inputSchema?: JsonObject;
  readonly kind: 'hook' | 'mcp-tool' | 'mcp-resource' | 'mcp-app';
  readonly label: string;
  readonly readOnly: boolean;
  readonly targets: readonly string[];
}

export interface DevRuntimeTreeNode {
  readonly children: readonly DevRuntimeTreeNode[];
  readonly id: string;
  readonly kind: 'component' | 'element' | 'text' | 'value';
  readonly label: string;
  readonly props?: JsonObject;
}

export interface DevRuntimeTraceSpan {
  readonly details?: JsonObject;
  readonly durationMs?: number;
  readonly id: string;
  readonly parentId?: string;
  readonly phase: string;
  readonly startedAt: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}

export interface DevRuntimeInspectionEnvelope {
  readonly agentVisible?: JsonValue;
  readonly app?: Readonly<{
    readonly mcpBinding: DevRuntimeMcpAppRunBinding;
    readonly resourceUri: string;
    readonly surfaceId: string;
  }>;
  readonly flight?: Readonly<{
    readonly bytes: number;
    readonly downloadPath?: string;
    readonly preview: string;
    readonly truncated: boolean;
  }>;
  readonly modelVisible?: JsonValue;
  readonly native?: JsonValue;
  readonly protocol?: JsonValue;
  readonly state: Readonly<{
    readonly identity: DevRuntimeStateIdentity;
    readonly snapshot?: JsonValue;
  }>;
  readonly trace: readonly DevRuntimeTraceSpan[];
  readonly tree: readonly DevRuntimeTreeNode[];
}

interface DevRuntimeRunBase {
  readonly completedAt?: string;
  readonly fixtureId?: string;
  readonly id: string;
  readonly input: JsonValue;
  readonly startedAt: string;
  readonly surfaceId: string;
  readonly target: string;
  readonly vector: RuntimeVector;
}

export type DevRuntimeRun =
  | (DevRuntimeRunBase & Readonly<{ readonly diagnostics?: never; readonly result?: never; readonly status: 'running' }>)
  | (DevRuntimeRunBase & Readonly<{ readonly completedAt: string; readonly diagnostics?: never; readonly result: DevRuntimeInspectionEnvelope; readonly status: 'succeeded' }>)
  | (DevRuntimeRunBase & Readonly<{ readonly completedAt: string; readonly diagnostics: readonly DevRuntimeDiagnostic[]; readonly result?: never; readonly status: 'failed' }>);

export type DevRuntimeStatus = Readonly<{
  readonly activeVector?: RuntimeVector;
  readonly descriptor: DevRuntimeDescriptor;
  readonly diagnostics: readonly DevRuntimeDiagnostic[];
  /** The compiler endpoint can accept an HMR client; not proof that a browser is connected. */
  readonly hmrReady: boolean;
  readonly lastGoodVector?: RuntimeVector;
  readonly state: 'starting' | 'compiling' | 'active' | 'degraded' | 'failed' | 'closed';
}>;

export interface DevRuntimeInvocationRequest {
  readonly expectedGenerationId?: string;
  readonly fixtureId?: string;
  readonly input: JsonValue;
  readonly surfaceId: string;
  readonly target: string;
}

export interface DevRuntimeReplayRequest {
  readonly expectedGenerationId?: string;
  readonly mode: 'exact' | 'latest';
  readonly runId: string;
}

export interface DevRuntimeStateResetRequest {
  readonly expectedGenerationId?: string;
  readonly seed?: JsonValue;
  readonly stateStoreId: string;
}

export interface DevRuntimeAssetRequest {
  readonly path: readonly string[];
  readonly runtimeGenerationId: string;
  readonly surfaceId: string;
}

export interface DevRuntimeAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Server-only compiler endpoint. It is never returned by status/surfaces JSON. */
export interface DevRuntimeMcpSessionRequest {
  readonly expectedRegistryRevision?: number;
  readonly serverName: string;
  readonly target: string;
}

export interface DevRuntimeMcpSessionControlRequest {
  readonly expectedSessionRevision: number;
  readonly sessionId: string;
}

export interface DevRuntimeMcpSessionBinding {
  readonly definitionDigest: string;
  readonly providerSessionId: string;
  readonly registryRevision: number;
  readonly serverDigest: string;
  readonly serverName: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly stateStoreId: string;
  readonly target: string;
  readonly transportDigest: string;
}

export type DevRuntimeMcpAppRunBinding = Omit<
  DevRuntimeMcpSessionBinding,
  'providerSessionId' | 'stateStoreId'
>;

export interface DevRuntimeMcpServerDescriptor {
  readonly definitionDigest: string;
  readonly name: string;
  readonly resources: readonly JsonObject[];
  readonly serverDigest: string;
  readonly target: string;
  readonly tools: readonly JsonObject[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpRegistrySnapshot {
  readonly definitionDigest: string;
  readonly providerSessionId: string;
  readonly registryRevision: number;
  readonly runtimeGenerationId: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpConnectionState {
  readonly capabilities: JsonObject | undefined;
  readonly protocolEra: 'legacy' | 'modern' | undefined;
  readonly protocolVersion: string | undefined;
  readonly server: Readonly<{ readonly name: string; readonly version: string }> | undefined;
}

interface DevRuntimeMcpOperationBase {
  readonly expectedSessionRevision: number;
}

export type DevRuntimeMcpOperationRequest = DevRuntimeMcpOperationBase & (
  | Readonly<{ readonly kind: 'list-tools' }>
  | Readonly<{ readonly kind: 'call-tool'; readonly arguments: JsonObject; readonly name: string; readonly requestId?: string }>
  | Readonly<{ readonly kind: 'list-resources' }>
  | Readonly<{ readonly kind: 'read-resource'; readonly uri: string }>
);

export interface DevRuntimeMcpOperationResult {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly value: JsonValue;
  readonly vector: RuntimeVector;
}

export interface DevRuntimeMcpSessionSnapshot {
  readonly binding: DevRuntimeMcpSessionBinding;
  readonly connection: DevRuntimeMcpConnectionState;
  readonly state: 'connecting' | 'ready' | 'restarting' | 'failed' | 'closed';
}

export interface DevRuntimeMcpRegistryReconcileInput {
  readonly definitionDigest: string;
  readonly runtimeGenerationId: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly transportDigest: string;
}

export interface DevRuntimeMcpInvalidatedBinding {
  readonly sessionId: string;
  readonly sessionRevision: number;
}

export interface DevRuntimeMcpRegistryReconcileResult {
  readonly action: 'implementation-updated' | 'sessions-restarted' | 'restart-failed';
  readonly invalidatedBindings: readonly DevRuntimeMcpInvalidatedBinding[];
  readonly registryRevision: number;
  readonly restartedSessionIds: readonly string[];
  readonly runtimeGenerationId: string;
  readonly sequence: number;
}

export interface DevRuntimeMcpRegistryReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export interface DevRuntimeStatusResponse {
  readonly status: DevRuntimeStatus | null;
}

export interface DevRuntimeSurfacesResponse {
  readonly surfaces: readonly DevRuntimeSurface[];
}

export interface DevRuntimeRunResponse {
  readonly run: DevRuntimeRun;
}

export interface DevRuntimeRunsResponse {
  readonly providerSessionId: string;
  readonly runs: readonly DevRuntimeRun[];
}

export interface DevRuntimeStateResponse {
  readonly state: DevRuntimeStateIdentity;
}
```

- [ ] **Step 4: Add the provider contract without importing example dependencies**

Create `runtime-provider.ts` with the exact core contract. `emit` accepts only the typed summary event completed in Task 5; `environment` contains only values selected from the descriptor allowlist.

```ts
import type { ArtifactStatus, JsonObject } from './types.ts';
import type {
  DevRuntimeAsset, DevRuntimeAssetRequest, DevRuntimeDescriptor,
  DevRuntimeInvocationRequest, DevRuntimeMcpOperationRequest, DevRuntimeMcpOperationResult,
  DevRuntimeMcpRegistryReconcileInput, DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpRegistryReplayGap, DevRuntimeMcpRegistrySnapshot,
  DevRuntimeMcpSessionControlRequest, DevRuntimeMcpSessionRequest, DevRuntimeMcpSessionSnapshot,
  DevRuntimeReplayRequest, DevRuntimeRun, DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest, DevRuntimeStatus, DevRuntimeSurface,
} from './runtime-protocol.ts';

/** Trusted-process-only compiler endpoint; never serialize it into runtime JSON. */
export interface DevRuntimeClientSurfaceEndpoint {
  readonly entryPath: string;
  readonly httpOrigin: string;
  readonly httpPathPrefixes: readonly string[];
  readonly surfaceId: string;
  readonly webSocketOrigin: string;
  readonly webSocketPath: '/rsbuild-hmr';
}

/** Core-owned, server-only proxy handle; the host plan may embed only bootstrapUrl. */
export interface DevRuntimeClientSurfaceProxyBinding {
  readonly bootstrapUrl: string;
  readonly origin: string;
  readonly surfaceId: string;
  readonly webSocketPath: '/rsbuild-hmr';
  close(): Promise<void>;
}

/** Trusted normalized input from ProjectService; never serialize to the browser. */
export interface DevRuntimePreparedMcpServer {
  readonly args?: readonly string[];
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly name: string;
  readonly source?: string;
  readonly targets: readonly string[];
  readonly transport: 'stdio' | 'streamable-http' | 'sse';
  readonly url?: string;
}

export interface DevRuntimePreparedMcpApp {
  readonly _meta?: JsonObject;
  readonly id: string;
  readonly name: string;
  readonly resourceUri: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly source: string;
  readonly targets: readonly string[];
  readonly template?: string;
}

export interface DevRuntimePreparedProject {
  readonly apps: readonly DevRuntimePreparedMcpApp[];
  readonly provider: string;
  readonly servers: readonly DevRuntimePreparedMcpServer[];
  readonly sourceRevision: string;
}

export interface DevRuntimeEventInput {
  readonly correlationId?: string;
  readonly details?: JsonObject;
  readonly mcpRegistryRevision?: number;
  readonly mcpSessionId?: string;
  readonly mcpSessionRevision?: number;
  readonly runId?: string;
  readonly runtimeGenerationId?: string;
  readonly type:
    | 'runtime.status' | 'runtime.generation.compiling' | 'runtime.generation.activated'
    | 'runtime.generation.failed' | 'runtime.run.started' | 'runtime.run.completed'
    | 'runtime.run.failed' | 'runtime.mcp.restarting' | 'runtime.mcp.ready'
    | 'runtime.mcp.failed' | 'runtime.app.updated'
    | 'runtime.hmr.client-connected' | 'runtime.hmr.client-disconnected';
}

export interface DevRuntimeStartContext {
  readonly artifactStatus: () => ArtifactStatus;
  readonly emit: (event: DevRuntimeEventInput) => void;
  readonly environment: Readonly<Record<string, string>>;
  readonly projectRoot: string;
  readonly preparedRuntime: DevRuntimePreparedProject;
  readonly providerSessionId: string;
  readonly signal: AbortSignal;
  readonly storageRoot: string;
}

export type DevRuntimeMcpRegistryMessage =
  | DevRuntimeMcpRegistryReconcileResult
  | DevRuntimeMcpRegistryReplayGap;

export type DevRuntimeMcpRegistryListener = (message: DevRuntimeMcpRegistryMessage) => void;

export interface DevRuntimeMcpRegistrySubscription {
  unsubscribe(): void;
}

export interface DevRuntimeMcpSessionCloseObservation {
  readonly closed: boolean;
  unsubscribe(): void;
}

export interface DevRuntimeMcpSessionView {
  execute(request: DevRuntimeMcpOperationRequest): Promise<DevRuntimeMcpOperationResult>;
  snapshot(): DevRuntimeMcpSessionSnapshot;
  watchClosed(listener: (reason?: unknown) => Promise<void> | void): DevRuntimeMcpSessionCloseObservation;
}

export interface DevRuntimeMcpSession extends DevRuntimeMcpSessionView {
  close(): Promise<void>;
}

export interface DevRuntimeMcpRegistry {
  closeSession(request: DevRuntimeMcpSessionControlRequest): Promise<void>;
  close(): Promise<void>;
  open(request: DevRuntimeMcpSessionRequest): Promise<DevRuntimeMcpSession>;
  reconcile(input: DevRuntimeMcpRegistryReconcileInput): Promise<DevRuntimeMcpRegistryReconcileResult>;
  restart(request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult>;
  session(sessionId: string): DevRuntimeMcpSessionView | undefined;
  snapshot(): DevRuntimeMcpRegistrySnapshot | undefined;
  subscribe(
    options: Readonly<{ readonly afterSequence?: number }>,
    listener: DevRuntimeMcpRegistryListener,
  ): DevRuntimeMcpRegistrySubscription;
}

export interface DevRuntimeSession {
  readonly mcpRegistry: DevRuntimeMcpRegistry;
  clientSurface(surfaceId: string): DevRuntimeClientSurfaceEndpoint | undefined;
  close(): Promise<void>;
  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun>;
  readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined>;
  readRunFlight(runId: string): Promise<DevRuntimeAsset | undefined>;
  reconcilePreparedRuntime(prepared: DevRuntimePreparedProject): Promise<void>;
  replay(request: DevRuntimeReplayRequest): Promise<DevRuntimeRun>;
  resetState(request: DevRuntimeStateResetRequest): Promise<DevRuntimeStateIdentity>;
  run(runId: string): DevRuntimeRun | undefined;
  runs(limit: number): readonly DevRuntimeRun[];
  status(): DevRuntimeStatus;
  surfaces(): readonly DevRuntimeSurface[];
}

export interface DevRuntimeProvider {
  readonly descriptor: DevRuntimeDescriptor;
  start(context: DevRuntimeStartContext): Promise<DevRuntimeSession>;
}

export type CreateDevRuntimeProvider = () => DevRuntimeProvider | Promise<DevRuntimeProvider>;

export class DevRuntimeUnavailableError extends Error {
  readonly code = 'AB8201' as const;
  constructor(message = 'Development runtime is not available.') {
    super(message);
    this.name = 'DevRuntimeUnavailableError';
  }
}

export class DevRuntimeGenerationConflictError extends Error {
  readonly actualGenerationId?: string;
  readonly code = 'AB8204' as const;
  readonly expectedGenerationId: string;
  constructor(expectedGenerationId: string, actualGenerationId?: string) {
    super(`Expected runtime generation ${JSON.stringify(expectedGenerationId)} is not active.`);
    this.name = 'DevRuntimeGenerationConflictError';
    this.expectedGenerationId = expectedGenerationId;
    this.actualGenerationId = actualGenerationId;
  }
}
```

- [ ] **Step 5: Export the types through the existing public surfaces and run tests**

Export config types from `config/index.ts`; export protocol/provider types from `dev/index.ts`; export only the author-facing config and provider types (not controller/store internals) from `api.ts`.

Run: `npm test -- packages/agent-bundle/tests/public-api.test.ts packages/agent-bundle/tests/runtime-provider.test.ts && npm run typecheck`

Expected: PASS; `packages/agent-bundle/src/dev/runtime-provider.ts` has no import whose package name contains `react`, `rsc`, `rsbuild-plugin-rsc`, or `react-server-dom-rspack`.

- [ ] **Step 6: Commit the protocol boundary**

```bash
git add packages/agent-bundle/src/core/types.ts packages/agent-bundle/src/config/index.ts packages/agent-bundle/src/dev/runtime-protocol.ts packages/agent-bundle/src/dev/runtime-provider.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/src/api.ts packages/agent-bundle/tests/public-api.test.ts packages/agent-bundle/tests/runtime-provider.test.ts
git commit -m "feat(dev): define optional runtime provider contract"
```

### Task 2: Discover the provider once with realpath containment and no ordinary-project import

**Files:**
- Create: `packages/agent-bundle/src/dev/runtime-provider-loader.ts`
- Modify: `packages/agent-bundle/src/dev/project-service.ts`
- Test: `packages/agent-bundle/tests/runtime-provider.test.ts`
- Test: `packages/agent-bundle/tests/dev-services.test.ts`

**Interfaces:**
- Consumes: `AgentBundleDevRuntimeConfig`, `CreateDevRuntimeProvider`, existing `loadConfig`/`NormalizedPlugin` output, and normalized real project roots from the base branch.
- Produces: trusted `PreparedProject.devRuntime: DevRuntimePreparedProject`, `PreparedProject.devRuntimeDiagnostic`, `ResolvedDevRuntimeProvider`, and `resolveDevRuntimeProvider(root, declaration, importer?)` for `startDevServer`.

- [ ] **Step 1: Write failing behavior tests for extraction, loading, and containment**

Use real temporary directories and files. Test these literal behaviors:

```ts
expect((await new ProjectService({ includeDevRuntime: false, mode: 'development', root }).prepare('dev')).devRuntime).toBeUndefined();
expect((await new ProjectService({ includeDevRuntime: true, mode: 'development', root }).prepare('dev')).devRuntime).toEqual({
  apps: expect.any(Array),
  provider: './src/dev/provider.ts',
  servers: expect.any(Array),
  sourceRevision: expect.any(String),
});

await expect(resolveDevRuntimeProvider(root, { provider: './src/dev/provider.ts' }, importer))
  .resolves.toMatchObject({ descriptor: { id: 'fixture-runtime', schemaVersion: 1 } });
await expect(resolveDevRuntimeProvider(root, { provider: '../outside/provider.ts' }, importer))
  .rejects.toMatchObject({ code: 'AB8200' });
await expect(resolveDevRuntimeProvider(root, { provider: './linked/provider.ts' }, importer))
  .rejects.toMatchObject({ code: 'AB8200' });
```

Also write a sentinel provider module that writes a file at module evaluation and assert the sentinel remains absent when the config has no `dev.runtime` declaration.
For a configured MCP App, assert the prepared literal preserves `{id,name,serverId,serverName,resourceUri,source,targets,_meta}` with `_meta` deeply frozen, while provenance is absent. For malformed/nonfinite App metadata or a malformed runtime declaration, assert `prepared.source.state === 'ready'` and `prepared.devRuntimeDiagnostic?.code === 'AB8200'`: supplemental runtime configuration must not invalidate the artifact lane.

- [ ] **Step 2: Run the focused tests and confirm the APIs are missing**

Run: `npm test -- packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/dev-services.test.ts`

Expected: FAIL because `includeDevRuntime`, `PreparedProject.devRuntime`, and `resolveDevRuntimeProvider` do not exist.

- [ ] **Step 3: Extract a frozen declaration only for the dev caller**

Add `includeDevRuntime?: boolean` to `ProjectServiceOptions`, optional trusted `devRuntime: DevRuntimePreparedProject` to `PreparedProject`, and optional `devRuntimeDiagnostic` to `PreparedProject`. When `includeDevRuntime` is false, do not validate, copy, or otherwise consume `loaded.config.dev`. When true, accept exactly one nonempty string provider and record an `AB8200` supplemental diagnostic for every other shape. After normalization succeeds, deep-freeze a server-only snapshot containing the declaration, `source.revision`, and exact normalized `model.mcpServers`/`model.mcpApps`; retain server/app ids and names, serverName, resource URI, targets, resolved trusted source/template/cwd/command/url/header/environment fields, and canonical finite-JSON App `_meta`, dropping only provenance. Reject accessors/nonfinite/non-JSON `_meta` as a supplemental runtime diagnostic. Never place this object in a browser response or diagnostic.

```ts
const devRuntimeDeclaration = (
  include: boolean,
  loaded: LoadedConfig,
): { declaration?: AgentBundleDevRuntimeConfig; diagnostic?: Diagnostic } => {
  if (!include) return {};
  const dev = loaded.config.dev as unknown;
  if (dev === undefined) return {};
  if (typeof dev !== 'object' || dev === null || Array.isArray(dev)) {
    return { diagnostic: sourceDiagnostic('AB8200', 'Development configuration must be an object.', loaded.configPath) };
  }
  const runtime = (dev as Record<string, unknown>).runtime;
  if (runtime === undefined) return {};
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime) ||
      typeof runtime.provider !== 'string' || runtime.provider.trim().length === 0) {
    return { diagnostic: sourceDiagnostic('AB8200', 'Development runtime provider must be a nonempty project-relative module path.', loaded.configPath) };
  }
  return { declaration: Object.freeze({ provider: runtime.provider }) };
};
```

Use that small helper to validate the declaration, then assemble `DevRuntimePreparedProject` only after the normalized model/source revision exist. Attach the supplemental diagnostic to `PreparedProject` but do not fold it into `PreparedProject.diagnostics` or `SourceStatus`; the ordinary artifact build must remain available. Do not add the declaration to `NormalizedPlugin` or its digest.

- [ ] **Step 4: Implement contained named-export loading with Jiti**

Create `runtime-provider-loader.ts`. Resolve the lexical path, then `realpath` both project root and provider, reject non-files and escapes, and load only after containment succeeds. The production importer is exactly:

```ts
import { createJiti } from 'jiti';

type ProviderModule = Readonly<{ createDevRuntimeProvider?: unknown }>;
export type DevRuntimeModuleImporter = (path: string) => Promise<ProviderModule>;

const importProviderModule: DevRuntimeModuleImporter = async (path) => {
  const jiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: true });
  return jiti.import<ProviderModule>(path);
};
```

The exported resolver signature is:

```ts
export const resolveDevRuntimeProvider = async (
  projectRoot: string,
  declaration: AgentBundleDevRuntimeConfig,
  importer: DevRuntimeModuleImporter = importProviderModule,
): Promise<DevRuntimeProvider>;
```

Validate the named export is a function; call it once; validate descriptor id/label, `schemaVersion === 1`, a duplicate-free environment-variable list matching `/^[A-Z_][A-Z0-9_]*$/u`, and all session method-bearing provider members. Throw `DevRuntimeProviderLoadError` with code `AB8200` and a phase-safe message that contains no environment values.

Define the load error in the same file so callers do not inspect message text:

```ts
export class DevRuntimeProviderLoadError extends Error {
  readonly code = 'AB8200' as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DevRuntimeProviderLoadError';
  }
}
```

- [ ] **Step 5: Run containment and ordinary-isolation tests**

Run: `npm test -- packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/dev-services.test.ts`

Expected: PASS, including lexical `..`, symlink escape, directory, missing export, duplicate environment variable, malformed descriptor, and no-declaration sentinel cases.

- [ ] **Step 6: Commit discovery**

```bash
git add packages/agent-bundle/src/dev/runtime-provider-loader.ts packages/agent-bundle/src/dev/project-service.ts packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/dev-services.test.ts
git commit -m "feat(dev): load contained runtime providers"
```

### Task 3: Build the immutable runtime-generation store

**Files:**
- Create: `packages/agent-bundle/src/dev/runtime-generation-store.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Test: `packages/agent-bundle/tests/runtime-generation-store.test.ts`

**Interfaces:**
- Consumes: Node filesystem primitives and existing `digest()`.
- Produces: `RuntimeGenerationStore.begin()`, `prepare()`, synchronous `canCommit()`/`commit()`, `abort()`, `fail()`, `lease()`, `close()`, immutable `RuntimeGeneration`, and idempotent `RuntimeGenerationLease.release()`.

- [ ] **Step 1: Write failing store tests against real files**

The tests create arbitrary provider-neutral trees such as `server/main.bin` and `client/ref.json` with hand-derived SHA-256 literals. Cover:

1. Preparation of a complete opaque asset set and round-trip of frozen provider metadata through a supplied validator; a prepared generation is renamed/immutable but is neither active nor leaseable until synchronous `commit()`.
2. Rejection for a missing file, extra undeclared file, wrong bytes, wrong SHA-256, duplicate path, symlink, escape, malformed metadata, and validator rejection. Core tests do not mention RSC environments, entries, or chunks.
3. Candidate fencing: begin `g2`, begin `g3`, prepare/commit `g3`, then `g2` must become `superseded` and cannot replace active.
4. A failed candidate leaves `g1` active.
5. An explicit `lease('g1')` continues reading `g1` after `g2` activates; `lease()` without an id selects `g2`.
6. Releasing twice is harmless.
7. Pruning retains active plus five newest unreferenced inactive generations and defers removal of a leased sixth generation until release.
8. `close()` is idempotent, rejects new begins/leases, removes staging, and reports every cleanup failure structurally.
9. A two-phase guard whose `wait()` resolves and queues live state advancement before the store's await continuation must fail its immediately adjacent synchronous `check()`; that candidate is never active, leaseable, or retained on disk.

Use the contract literally:

```ts
const candidate2 = await store.begin({ id: 'g2', sourceRevision: 'source-2' });
const candidate3 = await store.begin({ id: 'g3', sourceRevision: 'source-3' });
await writeGeneration(candidate3.root, completeFixture('g3'));
const prepared3 = await store.prepare(candidate3, manifestFixture('g3'));
expect(store.active()).toBeUndefined();
await expect(store.lease('g3')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
expect(store.commit(prepared3)).toMatchObject({ id: 'g3' });
await writeGeneration(candidate2.root, completeFixture('g2'));
await expect(store.prepare(candidate2, manifestFixture('g2')))
  .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
expect(store.active()?.id).toBe('g3');
```

Exercise the microtask seam with a live value read only by synchronous `check()`:

```ts
let liveRevision = 2;
let waitedRevision = 0;
const guard: RuntimeGenerationActivationGuard<TestMetadata> = {
  wait: () => new Promise<void>((resolve) => {
    waitedRevision = liveRevision;
    resolve();
    queueMicrotask(() => { liveRevision = 3; });
  }),
  check: () => waitedRevision === liveRevision,
};
await expect(store.prepare(candidate2, manifestFixture('g2'), { guard }))
  .rejects.toMatchObject({ code: 'RUNTIME_GENERATION_SUPERSEDED' });
expect(store.active()?.id).not.toBe('g2');
await expect(store.lease('g2')).rejects.toMatchObject({ code: 'RUNTIME_GENERATION_NOT_FOUND' });
```

- [ ] **Step 2: Run the store test and confirm RED**

Run: `npm test -- packages/agent-bundle/tests/runtime-generation-store.test.ts`

Expected: FAIL because the store and manifest types do not exist.

- [ ] **Step 3: Implement the exact manifest and state machine**

Define:

```ts
export interface RuntimeGenerationAsset {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface RuntimeGenerationMetadataCodec<TMetadata> {
  decode(value: JsonValue): TMetadata;
  encode(value: TMetadata): JsonValue;
}

export interface RuntimeGenerationManifestInput<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
}

export interface RuntimeGenerationManifest<TMetadata = unknown> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly createdAt: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly metadata: TMetadata;
  readonly schemaVersion: 1;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationValidationInput<TMetadata> {
  readonly assets: readonly RuntimeGenerationAsset[];
  readonly metadata: TMetadata;
  readonly root: string;
}

export type RuntimeGenerationValidator<TMetadata> = (
  input: RuntimeGenerationValidationInput<TMetadata>,
) => Promise<TMetadata> | TMetadata;

export interface RuntimeGenerationActivationGuard<TMetadata> {
  wait(manifest: RuntimeGenerationManifest<TMetadata>): Promise<void>;
  check(manifest: RuntimeGenerationManifest<TMetadata>): boolean;
}

export interface RuntimeGenerationPrepareOptions<TMetadata> {
  readonly guard?: RuntimeGenerationActivationGuard<TMetadata>;
}

export interface RuntimeGenerationCandidate {
  readonly id: string;
  readonly root: string;
  readonly sequence: number;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationPreparedActivation<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  readonly sequence: number;
}

export interface RuntimeGeneration<TMetadata = unknown> {
  readonly id: string;
  readonly manifest: RuntimeGenerationManifest<TMetadata>;
  readonly root: string;
  readonly sourceRevision: string;
}

export interface RuntimeGenerationLease<TMetadata = unknown> {
  readonly generation: RuntimeGeneration<TMetadata>;
  release(): Promise<void>;
}

export class RuntimeGenerationStore<TMetadata = unknown> {
  prepare(
    candidate: RuntimeGenerationCandidate,
    input: RuntimeGenerationManifestInput<TMetadata>,
    options?: RuntimeGenerationPrepareOptions<TMetadata>,
  ): Promise<RuntimeGenerationPreparedActivation<TMetadata>>;
  canCommit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): boolean;
  commit(prepared: RuntimeGenerationPreparedActivation<TMetadata>): RuntimeGeneration<TMetadata>;
  abort(prepared: RuntimeGenerationPreparedActivation<TMetadata>): Promise<void>;
}
```

`RuntimeGenerationStore<TMetadata>` is unconstrained at the type level and receives exact `metadataCodec` plus `validateMetadata` constructor dependencies. `prepare(candidate,{assets,metadata},{guard})` first validates generic path/byte integrity, invokes the provider validator, encodes its frozen canonical return value to `JsonValue`, and writes only that JSON value. Renamed-root validation parses/freezes/decodes those exact bytes through the codec before constructing the typed in-memory prepared generation. Core never casts JSON to `TMetadata`, interprets a metadata key, or requires provider interfaces to carry unsafe string index signatures. Add a compile fixture using nested `readonly DevRuntimeMcpServerDescriptor[]` metadata to prove the codec contract type-checks.

Use roots `${storageRoot}/staging/<sequence>-<id>` and `${storageRoot}/generations/<id>`. Before metadata exists, `prepare()` walks the staging tree and compares exactly the regular-file paths to the input assets. It then creates the generic manifest with candidate id/source revision, injected/current timestamp, canonical metadata, and `manifestDigest = digest()` over all fields except `manifestDigest`; writes the sole reserved root metadata file `generation.manifest.json`; fsyncs it and staging; and renames within the same storage root. Renamed-root validation excludes exactly that root metadata file from the asset path set, then separately validates its canonical bytes/digest, rejecting every other extra path. Walk with `lstat`, reject every symlink and non-file/non-directory, and never follow a path outside the candidate root.

`prepare(candidate,input,{guard})` uses the optional provider guard while doing asynchronous filesystem work. After staging validation/fsync, call `await guard.wait(manifest)` and then `guard.check(manifest)` synchronously immediately before initiating rename. After rename and renamed-root validation, call `await guard.wait(manifest)` and `guard.check(manifest)` again. A false check yields `RUNTIME_GENERATION_SUPERSEDED` and deletes the never-public root. A successful prepare returns a store-branded `RuntimeGenerationPreparedActivation`; it is tracked separately from committed generations, so `active()`, implicit/explicit `lease()`, retention, reopen, and status cannot observe it.

`canCommit(prepared)` synchronously validates the store-owned token, open state, and newest candidate sequence without mutation. `commit(prepared)` repeats those checks and is deliberately synchronous/no-fail after a true `canCommit()` in the same call stack: insert the generation into the committed map; compare-and-set the active pointer; and enqueue (without awaiting) retention work on the store cleanup tail. It performs no filesystem I/O, Promise construction, event callback, registry call, or provider code. `abort(prepared)` removes the renamed but uncommitted root asynchronously. This store is scoped to one random provider-session storage root: on startup/reopen it treats every pre-existing root as abandoned session garbage and removes it before accepting work, never inferring active/committed state from directory presence. This split lets the provider prepare other subsystems, perform one final live guard/store check, and call `commit()` inside a no-yield multi-subsystem commit section.

Even an already resolved Promise resumes `await` in a later microtask, so the prepare guard retains its adjacent synchronous check. Tests use a guard whose `wait()` resolves and queues a revision advance ahead of the prepare continuation; `check()` observes false and proves the candidate is never `active()`, leaseable, or left as an orphan. Keep the deferred pre/post-rename prepare-guard tests, and separately test abort/reopen cleanup for a successfully prepared but never committed generation.

- [ ] **Step 4: Implement fencing, leases, retention, and structural cleanup**

`begin()` increments a candidate sequence. `prepare()` and synchronous `commit()` may proceed only when their sequence equals the newest begun sequence. `lease(id)` consults only the committed map, increments a refcount, and returns an idempotent release closure. After every commit/release, prune oldest unreferenced inactive roots until at most five remain. `close()` aborts every prepared token and drains the cleanup tail. Aggregate close failures as:

```ts
export interface RuntimeGenerationCloseFailure {
  readonly error: unknown;
  readonly path: string;
}

export class RuntimeGenerationStoreCloseError extends Error {
  readonly failures: readonly RuntimeGenerationCloseFailure[];
  constructor(failures: readonly RuntimeGenerationCloseFailure[]) {
    super('Runtime generation store could not release every path.');
    this.name = 'RuntimeGenerationStoreCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

export type RuntimeGenerationStoreErrorCode =
  | 'RUNTIME_GENERATION_CLOSED' | 'RUNTIME_GENERATION_CONFLICT'
  | 'RUNTIME_GENERATION_INVALID' | 'RUNTIME_GENERATION_NOT_FOUND'
  | 'RUNTIME_GENERATION_SUPERSEDED';

export class RuntimeGenerationStoreError extends Error {
  readonly code: RuntimeGenerationStoreErrorCode;
  constructor(code: RuntimeGenerationStoreErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeGenerationStoreError';
    this.code = code;
  }
}
```

- [ ] **Step 5: Run store tests and mutation-check the critical branches**

Run: `npm test -- packages/agent-bundle/tests/runtime-generation-store.test.ts`

Expected: PASS. Before committing, temporarily reason through these mutations: expose a prepared root to `active()`/`lease()`, remove either prepare/commit candidate-sequence check, infer active from directory presence on reopen, resolve `lease()` to active despite an explicit id, skip metadata validation, omit symlink rejection, decrement a lease twice, or prune a referenced generation. A named test above must fail for each mutation. RSC environment/pairing/entry/async-chunk mutations belong exclusively to Task 7's example tests.

- [ ] **Step 6: Commit the generation store**

```bash
git add packages/agent-bundle/src/dev/runtime-generation-store.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/tests/runtime-generation-store.test.ts
git commit -m "feat(dev): add immutable runtime generations"
```

### Task 4: Add the stable runtime MCP registry and per-operation generation leases

**Files:**
- Create: `packages/agent-bundle/src/dev/runtime-mcp-registry.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Test: `packages/agent-bundle/tests/runtime-mcp-registry.test.ts`

**Interfaces:**
- Consumes: provider-neutral `RuntimeGenerationStore`, the Task 1 registry/session protocol, explicit `reconcile()` inputs from the provider, and provider-injected connector/executor boundaries.
- Produces: `RuntimeMcpRegistry` implementing the stable `DevRuntimeMcpRegistry`, plus a server-only prepare/commit reconcile transaction used to linearize generation activation; sessions survive implementation-only generations, while every operation returns the exact leased `RuntimeVector` it executed.

- [ ] **Step 1: Write failing stable-session and reconciliation tests**

Use real `RuntimeGenerationStore` roots and a deterministic in-memory connector/executor. Each fake must mirror the complete connection/descriptor shape; assertions target registry behavior, not fake call existence. Cover:

1. `open()` binds one static server descriptor and rejects an absent server, target, or stale `expectedRegistryRevision`; the request has no provider path, transport, command, environment, digest, or generation field.
2. A blocked `call-tool` captures/leases `g1`; implementation-only reconcile to `g2` preserves `sessionId`, `sessionRevision`, `registryRevision`, connector instance, and connection, while a later call returns a `RuntimeVector` for `g2`. Releasing the blocked call permits `g1` pruning.
3. Every `list-tools`, `list-resources`, `read-resource`, and `call-tool` result is a `DevRuntimeMcpOperationResult` containing `operationId`, stable session identity/revision, value, and leased vector. Lists use the static descriptor that was registered before the session opened.
4. Public `reconcile()` changing only `definitionDigest` or `transportDigest` atomically increments `registryRevision` and each affected `sessionRevision`, records the old `{sessionId,sessionRevision}` in `invalidatedBindings`, immediately transitions through visible `restarting`, rejects new operations, drains/cancels old operations, closes the old connector, reconnects, relists capabilities, preserves `sessionId`, and emits restarting/ready. A failed restart remains on the already-incremented revision, so the old binding can never compare current again.
5. Changing only `runtimeGenerationId` or per-server `serverDigest` returns `implementation-updated`, changes no registry/session revision, and reports no invalidated binding.
6. Restart failure leaves the session `failed`, invalidates the old App binding, returns `restart-failed`, publishes `runtime.mcp.failed`, and never silently rebinds old definitions.
7. `subscribe({afterSequence}, listener)` atomically replays then delivers live results in sequence order. The registry retains 64 results and emits `DevRuntimeMcpRegistryReplayGap` for an older cursor.
8. `restart({sessionId,expectedSessionRevision})` manually performs the same controlled close/connect/relist for one development session, preserves `sessionId`/`registryRevision`, increments `sessionRevision`, and emits a sequenced `sessions-restarted` or `restart-failed` result. `closeSession(...)` revision-checks and closes one owned session. `session(id)` returns a non-owning `DevRuntimeMcpSessionView`; its atomic `watchClosed()` mirrors the existing App lease close-observation contract, so a host adapter can tear down Apps on explicit/session shutdown while closing an App preview cannot close the broker session.
9. Session and registry `close()` are idempotent, reject new work, abort/settle pending opens/operations, close every connector, release every generation lease, unsubscribe listeners, and aggregate all cleanup failures.
10. Private provider-only `prepareActivationReconcile()` reserves the mutation lane and builds/re-lists replacement connections without changing snapshots, execution generation, revisions, subscribers, or emitted events. Operations continue on the old generation while staged. Synchronous `commitActivationReconcile()` swaps descriptors/connections/execution pointer and returns buffered notifications without calling listeners; `abortActivationReconcile()` leaves the old registry exact. No public reconcile/manual restart/open/close-session mutation can pass the reservation. This test is distinct from case 4 and asserts that only the private activation path is zero-downtime/invisible before commit.

Use separate deferred connector seams to prove the admission difference. While public `reconcile(definitionChanged)` or manual `restart()` is blocked in connect/relist, assert `session.snapshot().state === 'restarting'`, the incremented revision is visible, `execute()` rejects with `Runtime MCP session is restarting.`, and `runtime.mcp.restarting` was emitted before the connector await. In a different test, block `prepareActivationReconcile(definitionChanged)` at the same connector stage and assert the public snapshot/revisions/events remain old/`ready`, an operation admitted during staging completes on the old vector, and only `commitActivationReconcile()` changes them. Never satisfy both tests through one mode flag on public `reconcile()`; the private methods are callable only by the provider activation coordinator.

The core generation behavior must read like this:

```ts
const session = await registry.open({
  expectedRegistryRevision: 1,
  serverName: 'timeline',
  target: 'portable',
});
const before = session.snapshot();
const first = session.execute({
  arguments: { limit: 10 },
  expectedSessionRevision: before.binding.sessionRevision,
  kind: 'call-tool',
  name: 'render_timeline',
});
await operationBlocked;

const reconciled = await registry.reconcile(registryInput({
  runtimeGenerationId: 'g2',
  serverDigest: 'implementation-g2',
}));
expect(reconciled.action).toBe('implementation-updated');
expect(session.snapshot().binding).toMatchObject({
  registryRevision: before.binding.registryRevision,
  sessionId: before.binding.sessionId,
  sessionRevision: before.binding.sessionRevision,
  serverDigest: 'implementation-g2',
});
expect((await first).vector.runtimeGenerationId).toBe('g1');
expect((await session.execute({
  expectedSessionRevision: before.binding.sessionRevision,
  kind: 'list-tools',
})).vector.runtimeGenerationId).toBe('g2');
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- packages/agent-bundle/tests/runtime-mcp-registry.test.ts`

Expected: FAIL because `RuntimeMcpRegistry` and its connector/executor contracts do not exist.

- [ ] **Step 3: Define the injected connector/executor boundaries**

Create these exact non-browser interfaces in `runtime-mcp-registry.ts`:

```ts
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
```

The concrete registry additionally exposes server-only `prepareActivationReconcile(input): Promise<RuntimeMcpPreparedActivationReconcile>`, synchronous `commitActivationReconcile(prepared): RuntimeMcpCommittedActivationReconcile`, and `abortActivationReconcile(prepared): Promise<void>`; these are not added to `DevRuntimeMcpRegistry`, browser routes, or manual session controls. The connector is provider-owned trusted code assembled from the static manifest. Neither connector nor executor accepts browser launch configuration. Reuse the current core `McpSessionConnectionState` negotiated-state shape, JSON canonicalization, abort composition, close-watcher, and `Promise.allSettled` lifecycle helpers where their semantics are generation-neutral. Do not wrap or instantiate `McpSessionService`: that concrete service owns artifact-epoch references and its `open({epochId,...})` contract cannot represent per-operation runtime-generation leases. Likewise, the host-profile plan adapts this registry into the already landed `McpAppSessionAuthority`/`McpAppBindingService`; the provider slice must not duplicate App binding, bridge, consent, or route controllers.

- [ ] **Step 4: Implement stable registry/session state and operation capture**

`RuntimeMcpRegistry` freezes initial descriptors when supplied; otherwise `snapshot()` is undefined and `open()` rejects until either a public `reconcile()` or private `commitActivationReconcile()` installs the first static registry. `open()` resolves only `(serverName,target)` against that registry, connects, relists, and creates session revision 1. `execute()` checks `expectedSessionRevision`, rejects states other than `ready`, reads the registry's current execution generation id once, calls `generationStore.lease(id)`, and constructs its vector from that immutable generation, current artifact id, provider/state ids, and executor-returned state version. It releases in `finally` and never rereads the active pointer.

`list-tools`/`list-resources` return the frozen descriptor values; `read-resource` and `call-tool` validate the requested URI/name against that descriptor before invoking the executor. JSX render output may implement a declared handler, but cannot alter the registered definitions.

- [ ] **Step 5: Implement digest classification and controlled restart/relist**

Use one pure internal classifier for aggregate `definitionDigest` and `transportDigest`:

```ts
const requiresRestart =
  input.definitionDigest !== current.definitionDigest ||
  input.transportDigest !== current.transportDigest;
```

The classifier shares validation/comparison only; public/manual and private activation reconciliation are separate state machines with deliberately different visibility/admission semantics.

Private provider-only `prepareActivationReconcile()` acquires an exclusive registry-mutation reservation. When restart is false, it stages a frozen next execution-generation/server-digest pointer without exposing it. When restart is true, it builds replacement descriptors/connections under the reservation, connects and relists them, and calculates next registry/session revisions plus invalidated bindings while the current registry remains `ready` and operations continue on its old connections/generation. Private staging emits no runtime event, subscriber result, snapshot change, admission block, or App invalidation. A staging failure closes only staged connections and leaves the current registry byte-for-byte observable; this lets the provider reject an unactivated generation without poisoning the last-good broker.

`commitActivationReconcile()` is synchronous, accepts only the live private reservation token, performs no connector work or listener callback, and cannot fail after a valid reservation. For implementation-only input it swaps only the execution generation/server digests and preserves sessions/connectors/revisions. For definition/transport input it atomically swaps already-ready descriptors/connections, increments registry revision once and each affected session revision once, and records each captured prior binding in `invalidatedBindings`. It returns `RuntimeMcpCommittedActivationReconcile`; `publish()` idempotently delivers only the already-committed `implementation-updated` or `sessions-restarted`/`runtime.mcp.ready` result with listener failure isolation—private staging never emits a fictitious visible `restarting` transition. `finalize()` drains/cancels operations remaining on retired connections at the existing 10 s bound and closes those connections. The private mutation reservation is released by synchronous commit or awaited abort; close aborts any outstanding staged activation.

Public `reconcile()` does **not** call or emulate the invisible activation-staging API when `requiresRestart` is true. After acquiring the public mutation lane it captures prior bindings, increments registry/session revisions, sets affected sessions to visible `restarting`, publishes `runtime.mcp.restarting`, and admission-blocks/rejects every new operation for those sessions before its first connector-close/connect/relist await. It drains/cancels bounded old operations, closes old connections, connects/re-lists replacements, then sets `ready` and publishes the sequenced `sessions-restarted`/`runtime.mcp.ready` result. On failure it stays at the incremented revision in visible `failed`, publishes `restart-failed`/`runtime.mcp.failed`, and invalidates prior App bindings. It never silently restores or rebinds an invalidated binding. When `requiresRestart` is false, public reconcile may atomically apply `implementation-updated` without entering `restarting`; generation activation itself never calls this public method.

Manual `restart()` reuses that visible public restart state machine for one explicitly selected session without changing registry definitions or `registryRevision`: it enters `restarting` and blocks new operations before closing/connecting. `closeSession()` and `restart()` both compare the supplied `expectedSessionRevision` before mutation. The manual development routes in the host-profiles plan may call `open()`, `restart()`, `closeSession()`, and `execute()`. App preview creation may only resolve the immutable run evidence through `session(id)` and must never call `open()` or supply launch/transport configuration.

- [ ] **Step 6: Implement atomic reconcile subscription and cleanup**

Assign strictly increasing sequences to public visible restart/results as they publish and to a private activation result at synchronous activation commit; retain the newest 64 and implement replay-plus-live subscription using the same boundary/pending-queue pattern as `ProjectEventHub`. Only the private activation result is buffered until `RuntimeMcpCommittedActivationReconcile.publish()`; by then generation and registry pointers are aligned. Public/manual `restarting`, `ready`, and `failed` notifications remain live at their documented transition boundaries. Listener failure removes only that listener. Implement `watchClosed()` with the existing atomic register/recheck pattern: it reports `closed:true` if closure already won, otherwise invokes each watcher once on explicit session or registry close; unsubscribe is idempotent. Registry close freezes new reconciliation, aborts any private activation reservation, invalidates subscriptions, aborts operations/opens, notifies close watchers, and uses `Promise.allSettled` to close staged/current/retired connections before reporting `RuntimeMcpRegistryCloseError` with resource-tagged failures.

- [ ] **Step 7: Run registry and generation tests**

Run: `npm test -- packages/agent-bundle/tests/runtime-mcp-registry.test.ts packages/agent-bundle/tests/runtime-generation-store.test.ts`

Expected: PASS. Mutation check: route public/manual restart through invisible activation staging, allow a public operation after `restarting`, expose a private staged execution pointer/connection, deliver a private buffered notification before commit, let another mutation pass the private reservation, pin a session instead of an operation, compare `serverDigest` for restart, omit revision validation, publish public ready before relist, reuse an invalidated App binding, or omit the result vector; at least one named test must fail for each mutation.

- [ ] **Step 8: Commit the stable runtime MCP registry**

```bash
git add packages/agent-bundle/src/dev/runtime-mcp-registry.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/tests/runtime-mcp-registry.test.ts
git commit -m "feat(dev): add stable runtime MCP registry"
```

### Task 5: Add typed runtime events and fixed authenticated foreground routes

**Files:**
- Modify: `packages/agent-bundle/package.json`
- Modify: `package-lock.json`
- Create: `packages/agent-bundle/src/dev/runtime-routes.ts`
- Create: `packages/agent-bundle/src/dev/runtime-client-surface-proxy.ts`
- Modify: `packages/agent-bundle/src/dev/types.ts`
- Modify: `packages/agent-bundle/src/dev/events.ts`
- Modify: `packages/agent-bundle/src/dev/foreground-server.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Test: `packages/agent-bundle/tests/runtime-routes.test.ts`
- Test: `packages/agent-bundle/tests/runtime-client-surface-proxy.test.ts`
- Test: `packages/agent-bundle/tests/dev-events.contract.test.ts`
- Test: `packages/agent-bundle/tests/dev-server.test.ts`

**Interfaces:**
- Consumes: `DevRuntimeSession`, a trusted `DevRuntimeClientSurfaceEndpoint`, the existing foreground `#assertMutationSession` guard, `ProjectEventHub`, and the existing 64 KiB request/body behavior.
- Produces: the stable browser routes/runtime event envelope consumed by `ProjectClient`, plus a provider-agnostic core-controlled loopback HTTP/WebSocket proxy primitive that Task 6 owns through the Workbench session lifecycle.

- [ ] **Step 1: Write route and event tests before adding dispatch**

Use a real `startForegroundServer` with a small in-memory `DevRuntimeSession`; assert response bodies exactly:

```ts
expect(await get('/api/runtime/status')).toEqual({ status: null });
expect(await get('/api/runtime/surfaces')).toEqual({ surfaces: [] });

expect(await authorizedPost('/api/runtime/runs', {
  expectedGenerationId: 'g1',
  fixtureId: 'after-edit',
  input: { path: 'src/a.ts' },
  surfaceId: 'hook.after-edit',
  target: 'claude',
})).toEqual({ run: expect.objectContaining({ surfaceId: 'hook.after-edit', target: 'claude' }) });

expect(await authorizedGet('/api/runtime/runs?limit=50')).toEqual({
  providerSessionId: 'provider-a',
  runs: expect.any(Array),
});
```

Cover wrong method (405), wrong content type (415), body over 64 KiB (413), absent/wrong Origin or token (403), malformed percent encoding/path segments (400), unknown run/surface/asset (404), target not declared by the surface (400), stale `expectedGenerationId` (409), and provider internal failure (phase-safe 500 diagnostic). GET run, run history, and asset downloads require the same Origin/token because they contain model inputs, Flight, state, and protocol traces. `GET /api/runtime/runs` defaults to 50; accepts only one decimal integer from 1 through 50; returns newest-first records from the active `providerSessionId`; and rejects zero, duplicates, non-integers, or values over 50 with 400. GET status/surfaces remain public capability summaries and expose no run payloads or compiler upstreams.

Test `runtime.event` without `epochId` and verify it replays through SSE with the exact provider/generation/run correlation fields. For a succeeded run, authenticated `GET /api/runtime/runs/:runId/flight` returns the exact bounded Flight bytes with `application/octet-stream`, `Cache-Control: no-store`, and no path-derived filesystem access. Running/failed/evicted/other-provider run ids return 404; absent/wrong auth returns 403; encoded slash, traversal, suffix, query duplication, and unknown artifacts return 400/404 without touching disk.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/dev-events.contract.test.ts packages/agent-bundle/tests/dev-server.test.ts`

Expected: FAIL because `RuntimeRoutes` is absent and `runtime.event` still requires `epochId`.

- [ ] **Step 3: Make runtime events generation-scoped rather than artifact-scoped**

Replace the weak `RuntimeEvent` shape with:

```ts
export interface RuntimeEvent {
  readonly correlationId?: string;
  readonly details?: JsonObject;
  readonly mcpRegistryRevision?: number;
  readonly mcpSessionId?: string;
  readonly mcpSessionRevision?: number;
  readonly providerSessionId: string;
  readonly runId?: string;
  readonly runtimeGenerationId?: string;
  readonly type: DevRuntimeEventInput['type'];
}
```

In `events.ts` and `types.ts`, only `artifact.available` remains epoch-required. `runtime.event` may carry optional `epochId` when an artifact was active, but it must be valid before any artifact exists. Preserve `freezeJsonValue()` validation and the existing replay queue limits.

- [ ] **Step 4: Implement the fixed route adapter**

Create `RuntimeRoutes` parallel to `McpSessionRoutes`, but accept only a `DevRuntimeSession` and these paths:

```text
GET    /api/runtime/status
GET    /api/runtime/surfaces
POST   /api/runtime/runs
GET    /api/runtime/runs?limit=50
GET    /api/runtime/runs/:runId
GET    /api/runtime/runs/:runId/flight
POST   /api/runtime/runs/:runId/replay
POST   /api/runtime/state/reset
GET    /api/runtime/assets/:surfaceId/*
```

Response wrappers are fixed:

```ts
type RuntimeStatusResponse = { readonly status: DevRuntimeStatus | null };
type RuntimeSurfacesResponse = { readonly surfaces: readonly DevRuntimeSurface[] };
type RuntimeRunResponse = { readonly run: DevRuntimeRun };
type RuntimeRunsResponse = {
  readonly providerSessionId: string;
  readonly runs: readonly DevRuntimeRun[];
};
type RuntimeStateResponse = { readonly state: DevRuntimeStateIdentity };
```

When no session exists, status is `{status:null}`, surfaces is `{surfaces:[]}`, and other runtime routes return 404 `AB8201`. Run history calls `session.runs(limit)`, asserts every returned vector has the controller's current `providerSessionId`, and never merges previous controller sessions. The flight route parses only one opaque run-id segment, resolves through `session.readRunFlight(runId)` (never a caller path), requires a succeeded immutable run owned by the current provider session, sets `no-store`, exact content length/type, and streams at most the existing 4 MiB bound. Parse JSON into a closed object with only the documented keys; reject accessors, arrays where objects are required, non-finite numbers, unknown surface targets, and non-JSON values. Map `DevRuntimeGenerationConflictError` to 409 `AB8204`. Generation asset requests require a `generation` query parameter and decode each path segment with the same traversal/NUL/backslash checks as Skill resources.

- [ ] **Step 5: Implement the core-controlled client-surface HTTP/WebSocket proxy**

Install the concrete WebSocket implementation and lock it:

```bash
npm install ws@8.21.3 --workspace agent-bundle
npm install --save-dev @types/ws@8.18.1 --workspace agent-bundle
```

This updates `packages/agent-bundle/package.json` and the root `package-lock.json`. Create `RuntimeClientSurfaceProxy`. It accepts a `DevRuntimeClientSurfaceEndpoint` only from the live trusted provider session. Validate both origins as literal loopback HTTP/WS origins with matching host/port, no user info/query/fragment, a containment-safe absolute `entryPath`, normalized declared HTTP prefixes, and the exact WebSocket path `/rsbuild-hmr`. It starts a dedicated loopback origin per binding and returns:

```ts
export interface DevRuntimeClientSurfaceProxyBinding {
  readonly bootstrapUrl: string;
  readonly origin: string;
  readonly surfaceId: string;
  readonly webSocketPath: '/rsbuild-hmr';
  close(): Promise<void>;
}
```

The primitive's server-only constructor is exact:

```ts
export interface RuntimeClientSurfaceConnectionEvent {
  readonly connectionCount: number;
  readonly surfaceId: string;
  readonly type: 'connected' | 'disconnected';
}

export class RuntimeClientSurfaceProxy {
  static open(
    endpoint: DevRuntimeClientSurfaceEndpoint,
    listener: (event: RuntimeClientSurfaceConnectionEvent) => void,
  ): Promise<DevRuntimeClientSurfaceProxyBinding>;
}
```

`bootstrapUrl` carries a one-use, 256-bit core-generated capability. The bootstrap response sets a host-only, HttpOnly, SameSite=Strict cookie and redirects to the fixed declared entry; every later GET/HEAD and WebSocket upgrade requires that cookie. Proxy GET/HEAD only to the fixed validated upstream and declared prefixes; reject other methods, redirects to a different origin, request bodies, path traversal, oversized headers, and response bodies over the configured App asset bound. Proxy WebSocket upgrades only for the exact `/rsbuild-hmr` path, preserve the Rsbuild HMR query string/token, cap frames, and close both sides together. The provider/browser cannot supply an upstream, register middleware, or select a proxy path. Closing the binding destroys its HTTP server, upgrade listener, and sockets.

Implement upgrades with `ws`: a `WebSocketServer({noServer:true,maxPayload:1_048_576})` accepts the authenticated downstream, and a `WebSocket` client with the same `maxPayload` connects only to the validated upstream URL. Preserve the requested subprotocol and Rsbuild query, forward only binary/text messages after `OPEN`, and terminate both sockets if `bufferedAmount` exceeds 2 MiB. `maxPayload` enforces the 1 MiB assembled-message bound even for fragmented frames; ping/pong and close are handled by `ws`, not a hand-rolled frame parser.

Tests use real `ws` loopback servers: initial bootstrap succeeds once; uncredentialed assets/upgrades fail; the built-in Rsbuild path/query/subprotocol are forwarded; a fragmented message over 1 MiB closes both sides; backpressure over 2 MiB terminates the pair; an undeclared path, non-loopback origin, mismatched WS origin, redirect escape, second bootstrap use, and browser-supplied URL all fail; `close()` leaves no listener/socket. On an authenticated upstream WS handshake, invoke the listener with `{type:'connected',surfaceId,connectionCount}`; on either-side close invoke it with `type:'disconnected'`. A listening upstream without a WS upgrade emits neither event. Task 6 maps these callbacks to `runtime.hmr.client-connected`/`runtime.hmr.client-disconnected` with the active provider-session envelope. The resulting proxy origin is the App iframe's origin, so its Rsbuild client, chunks, and HMR socket share one sandbox origin while remaining different-origin from the Workbench.

- [ ] **Step 6: Compose routes without allowing provider middleware**

Add `runtime?: DevRuntimeSession` to `ForegroundServerOptions`, instantiate `RuntimeRoutes` with `authorize: request => this.#assertMutationSession(request)`, dispatch it before the static Workbench fallback, and close only route subscriptions in `#releaseResources()`; the runtime session itself remains owned by the workbench lifecycle in Task 6. Export a provider-agnostic `RuntimeClientSurfaceProxy.open(endpoint, onConnectionEvent)` primitive that accepts only the validated trusted endpoint and returns `DevRuntimeClientSurfaceProxyBinding`. Task 5 does not add a `DevServerSession` accessor or own any Workbench lifecycle state; Task 6 composes and tracks this primitive after the runtime session exists.

- [ ] **Step 7: Run the route/event/proxy suite**

Run: `npm test -- packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/runtime-client-surface-proxy.test.ts packages/agent-bundle/tests/dev-events.contract.test.ts packages/agent-bundle/tests/dev-server.test.ts`

Expected: PASS with exact 200/400/403/404/405/409/413/415 branches and no arbitrary middleware/proxy API in `ForegroundServerOptions`.

- [ ] **Step 8: Commit routes, events, and the fixed proxy**

```bash
git add packages/agent-bundle/package.json package-lock.json packages/agent-bundle/src/dev/runtime-routes.ts packages/agent-bundle/src/dev/runtime-client-surface-proxy.ts packages/agent-bundle/src/dev/types.ts packages/agent-bundle/src/dev/events.ts packages/agent-bundle/src/dev/foreground-server.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/runtime-client-surface-proxy.test.ts packages/agent-bundle/tests/dev-events.contract.test.ts packages/agent-bundle/tests/dev-server.test.ts
git commit -m "feat(dev): expose fixed runtime workbench routes"
```

### Task 6: Integrate one-load startup, degraded runtime failure, and aggregate cleanup

**Files:**
- Create: `packages/agent-bundle/src/dev/runtime-controller.ts`
- Modify: `packages/agent-bundle/src/dev/coordinator.ts`
- Modify: `packages/agent-bundle/src/dev/project-service.ts`
- Modify: `packages/agent-bundle/src/dev/workbench-server.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Test: `packages/agent-bundle/tests/dev-coordinator.test.ts`
- Test: `packages/agent-bundle/tests/dev-workbench.test.ts`
- Test: `packages/agent-bundle/tests/runtime-provider.test.ts`

**Interfaces:**
- Consumes: `PreparedProject.devRuntime`, `resolveDevRuntimeProvider`, `DevRuntimeProvider`, `ProjectEventHub`, Task 5's `RuntimeClientSurfaceProxy`, fixed `.agent-bundle/runtime` storage/output root, existing `McpSessionService`, the existing MCP App lifecycle, `closeDevServerLifecycle`, and the landed `DevServerStartError` post-listener startup cleanup contract.
- Produces: `DevRuntimeController` implementing `DevRuntimeSession`, provider start after the first prepared artifact input is known, a server-only `DevServerSession.openRuntimeClientSurface()` accessor, and cleanup that reports `runtime-client-surfaces`, `mcp-apps`, `runtime`, `mcp-sessions`, and `coordinator` independently without losing the original startup failure.

- [ ] **Step 1: Write failing coordinator/lifecycle tests**

Test that the config factory executes once—not twice—during initial `startDevServer`, and its returned `PreparedProject` is the exact object passed to the initial artifact builder and provider start context. Test no runtime provider import without a declaration. Test provider start sees normalized root, trusted `preparedRuntime`, `.agent-bundle/runtime/<providerSessionId>` storage, only allowlisted environment keys, and current artifact status.

After startup, mutate only MCP args/environment in the config and rebuild. Assert exactly one later `prepare('dev')`, exactly one `session.reconcilePreparedRuntime()` before artifact work, controlled registry restart, and no provider reload/browser launch data. Concurrent rebuilds must deliver only monotonically newer source revisions through the coordinator's existing serialized rebuild queue. A reconcile failure marks runtime degraded/preserves its last-good generation but does not fail the independent artifact build. Close racing a rebuild settles/cancels reconcile before resources close. A provider-path edit yields a restart-required diagnostic rather than reconciling the new declaration into the old instance.

Test startup failure is supplemental. Add a deferred provider whose `start()` resolves only after the 30 s startup deadline: assert the controller aborts its supplied signal, returns degraded startup, closes the late session exactly once when it eventually resolves, and leaves no compiler, proxy listener, worker, or storage staging handle. Repeat with `server.close()` racing startup.

```ts
const server = await startDevServer({ root, port: 0 });
expect(server.status().artifact.state).toBe('active');
expect(await runtimeStatus(server)).toMatchObject({
  status: { diagnostics: [{ phase: 'provider-lifecycle' }], state: 'failed' },
});
```

Add Workbench-session tests for `openRuntimeClientSurface(surfaceId)`: no runtime or an unknown surface returns `undefined`; a declared endpoint is resolved only through `runtime.clientSurface(surfaceId)`, opened through the Task 5 proxy primitive, and returns only the core binding; a browser/request cannot supply an origin, endpoint, or WebSocket path; calls after close reject; and concurrent bindings are tracked independently. Make one binding close fail and assert `server.close()` still closes every binding once and attempts every later resource. Extend—do not replace—the existing three-argument lifecycle API with optional runtime resources, preserving old callers and relative MCP App/session/coordinator behavior. Assert structural failures in resource order `runtime-client-surfaces`, `mcp-apps`, `runtime`, `mcp-sessions`, `coordinator`.

Extend the landed post-listener startup regression using its existing `testing.startForegroundServer`/`testing.createSandboxProxy` seams. Make sandbox/browser startup fail, then make the foreground close delegate reject with the new aggregate `DevServerLifecycleCloseError`. Assert `DevServerStartError.failures` remains exactly `[{resource:'start',error:original},{resource:'cleanup',error:aggregateCloseError}]`; the nested close error retains every runtime-client-surface/MCP-App/runtime/MCP-session/coordinator failure in resource order. If cleanup succeeds, rethrow the original startup error unchanged. Keep `DevServerStartError`/`DevServerStartFailure` exported from `dev/index.ts`; do not flatten, replace, or drop either side of this error pair.

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- packages/agent-bundle/tests/dev-coordinator.test.ts packages/agent-bundle/tests/dev-workbench.test.ts packages/agent-bundle/tests/runtime-provider.test.ts`

Expected: FAIL because the coordinator cannot consume an initial prepared project and runtime lifecycle is absent.

- [ ] **Step 3: Add an exact development preparation context and consume one pre-prepared first build**

Extend the existing `ProjectCommand` union with `'dev'`. Ensure the config factory receives `{command:'dev',mode:'development'}` through the existing loader options; do not substitute the build preparation command. Add `prepareCommand?: 'build' | 'dev'` (default `'build'`), `initialPreparedProject?: PreparedProject`, and `onPreparedProject?: (prepared: PreparedProject) => Promise<void>` to `DevCoordinatorOptions`; store the initial object in `#nextPreparedProject`, and replace the preparation line with:

```ts
const prepared = this.#nextPreparedProject ?? await this.#projectService.prepare(this.#prepareCommand);
this.#nextPreparedProject = undefined;
```

Clear it before awaited lint/artifact work so a failed first build cannot reuse stale input. For every prepared object, await `onPreparedProject(prepared)` after source readiness and before lint/artifact work, inside the existing serialized rebuild/close lifecycle. The runtime callback records its own supplemental failure instead of rejecting the artifact lane. It ignores a source revision older than the last accepted revision and invokes the live session exactly once for each newer later preparation; the initial object is buffered for `start()` rather than double-reconciled. Add `.agent-bundle/runtime` to default `outputPaths` beside `dist`; it is a fixed core-owned root, not provider input. Tests assert initial and rebuild factory calls use the dev context, initial startup evaluates the config factory once, a second rebuild calls `ProjectService.prepare('dev')` exactly once, and existing build/package callers retain their build context.

- [ ] **Step 4: Implement `DevRuntimeController`**

The controller is constructed with the optional resolved provider or a load failure. It assigns `providerSessionId = randomUUID()`, selects environment values only by iterating `provider.descriptor.environmentVariables`, and publishes:

```ts
eventHub.publish({
  ...(artifactEpochId === undefined ? {} : { epochId: artifactEpochId }),
  payload: {
    ...event,
    providerSessionId,
  },
  type: 'runtime.event',
});
```

`start()` calls the provider once with a 30 s startup timeout and passes a controller-owned `AbortSignal` plus its buffered trusted prepared snapshot. Timeout or concurrent `close()` aborts that signal. Keep the original provider promise observed after the race: if it resolves late, immediately await `lateSession.close()` exactly once; if it rejects late, consume/report the rejection without an unhandled rejection. `close()` awaits late startup and the serialized reconcile chain, remains idempotent, and does not claim cleanup complete while a provider can still publish a compiler/socket. Controller `reconcilePreparedRuntime()` buffers before startup, then serializes live calls; it fences stale/equal source revisions, verifies the provider path is unchanged, delegates exactly once per accepted later revision, and converts errors into degraded provider-lifecycle diagnostics while retaining last good. It catches load/start errors into a serializable failed status and never rejects coordinator/foreground startup. Before delegation, status is `starting`; after a failed declaration, all operations except status/surfaces reject `DevRuntimeUnavailableError('AB8201')`.

- [ ] **Step 5: Compose preparation, provider, MCP service, coordinator, and foreground server**

In `startDevServer`:

1. Resolve the normalized root.
2. Construct `ProjectService({ includeDevRuntime: true, mode: 'development', root })`.
3. Call `prepare('dev')` once; the config factory sees `{command:'dev',mode:'development'}`.
4. Resolve a provider only when `prepared.devRuntime` exists; initialize a failed controller directly when `prepared.devRuntimeDiagnostic` exists, and construct `DevRuntimeController` with the initial trusted snapshot.
5. Construct `DevCoordinator({ initialPreparedProject: prepared, onPreparedProject: async next => { if (next.devRuntime !== undefined) await runtime?.reconcilePreparedRuntime(next.devRuntime); }, prepareCommand: 'dev', outputPaths: ['dist', '.agent-bundle/runtime'], ... })`; the callback is core-owned and receives no browser data.
6. Construct the existing `McpSessionService` with that same normalized root and preserve the existing deferred MCP App lifecycle/sandbox composition.
7. Pass the controller to `ForegroundServerOptions.runtime` only when a declaration exists or provider loading failed.
8. Construct the Workbench-owned client-surface binding registry around Task 5's `RuntimeClientSurfaceProxy`.
9. Wrap `ForegroundCoordinator.start()` as `await coordinator.start(); await runtime?.start();`.
10. Extend the existing close call compatibly as `closeDevServerLifecycle(mcpSessions, coordinator, mcpApps, { clientSurfaces, runtime })`; existing two/three-argument callers remain valid. The implementation settles resources in order `runtime-client-surfaces`, `mcp-apps`, `runtime`, `mcp-sessions`, `coordinator` and retains every failure.

Keep the landed post-listener startup `try`/`catch` around sandbox attach/browser open. Its catch must still settle `foreground.close()`; when that cleanup rejects, throw `DevServerStartError` with the original startup failure first and the complete (possibly nested aggregate) cleanup failure second. Runtime lifecycle additions flow through `foreground.close()` and must not move the original failure out of scope, throw only the cleanup error, or flatten its structured resource failures. Do not load the provider from build/package/eval/API operations.

The backward-compatible lifecycle extension is:

```ts
interface DevServerRuntimeLifecycleResources {
  readonly clientSurfaces?: Closeable;
  readonly runtime?: Closeable;
}

closeDevServerLifecycle(
  mcpSessions: Closeable,
  coordinator: Closeable,
  mcpApps?: Closeable,
  runtimeResources?: DevServerRuntimeLifecycleResources,
): Promise<void>;
```

Extend `DevServerLifecycleCloseFailure['resource']` with only `'runtime-client-surfaces' | 'runtime'`; retain its existing `'mcp-apps' | 'mcp-sessions' | 'coordinator'` members and `DevServerStartFailure` unchanged.

Implement the accessor in `workbench-server.ts`, where the live runtime and server close state are owned:

```ts
openRuntimeClientSurface(
  surfaceId: string,
): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>;
```

It rejects after close begins, asks only the live trusted session for `runtime.clientSurface(surfaceId)`, returns `undefined` when the runtime/endpoint is absent, and passes the returned endpoint directly to the Task 5 proxy primitive. Its listener maps only connection type, surface id, and count into the controller's `runtime.hmr.client-connected`/`runtime.hmr.client-disconnected` event envelope; it never accepts, emits, or returns an upstream origin. Register each opened binding before returning it; remove it only after its idempotent `close()` settles. Workbench close first prevents new open calls, then uses `Promise.allSettled` to close every tracked client-surface binding even when one fails, followed by the existing MCP App lifecycle, runtime, MCP sessions, and coordinator while preserving ordered aggregate diagnostics. Foreground routes and browser payloads receive no surface-endpoint or proxy-construction API.

- [ ] **Step 6: Run lifecycle and ordinary-project regression tests**

Run: `npm test -- packages/agent-bundle/tests/dev-coordinator.test.ts packages/agent-bundle/tests/dev-workbench.test.ts packages/agent-bundle/tests/runtime-client-surface-proxy.test.ts packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/cli.test.ts`

Expected: PASS. The no-runtime sentinel is absent; normal status/build output matches the pre-runtime fixture; provider failure leaves the foreground and artifact lane usable; all lifecycle resources are attempted; and post-listener startup plus cleanup failure still returns one `DevServerStartError` preserving both ordered causes and the nested close-resource diagnostics.

- [ ] **Step 7: Commit composition**

```bash
git add packages/agent-bundle/src/dev/runtime-controller.ts packages/agent-bundle/src/dev/coordinator.ts packages/agent-bundle/src/dev/project-service.ts packages/agent-bundle/src/dev/workbench-server.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/tests/dev-coordinator.test.ts packages/agent-bundle/tests/dev-workbench.test.ts packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/cli.test.ts
git commit -m "feat(dev): compose optional runtime lifecycle"
```

### Task 7: Refactor the example into a shared Rsbuild config and complete generation materializer

**Files:**
- Modify: `examples/rsc-agent-runtime/rsbuild.config.ts`
- Modify: `examples/rsc-agent-runtime/src/build/emit-artifacts.ts`
- Modify: `examples/rsc-agent-runtime/src/runtime/contracts.ts`
- Create: `examples/rsc-agent-runtime/src/dev/definition-entry.ts`
- Create: `examples/rsc-agent-runtime/src/dev/generation-materializer.ts`
- Create: `examples/rsc-agent-runtime/tests/generation-materializer.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/runtime-artifact-manifest.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/tsconfig-coverage.test.ts`

**Interfaces:**
- Consumes: the existing `rsc`/`widget`/`app` configuration, `emitRuntimeArtifacts`, and `RuntimeGenerationStore`.
- Produces: `createRscRuntimeRsbuildConfig(options)`, a development output rooted under the controller storage root, and `materializeRuntimeGeneration()` that copies/digests a complete compiler cohort.

- [ ] **Step 1: Write failing materializer/config tests**

Inspect the actual Rsbuild config through `createRsbuild(...).inspectConfig({ mode: 'development' })`; do not grep source text. Assert:

- environments are exactly `rsc`, `widget`, `app`;
- RSC plugin pairing is `rsc`/`widget`;
- `dev.writeToDisk` is true only for the dev factory result;
- Node outputs use `jsAsync: 'chunks'`;
- the scoped `request-render.ts` parser rule remains;
- the `app` environment remains a web HMR/Fast Refresh environment;
- development outputs are contained under the supplied compiler root.

For materialization, create real `compiler/rsc` and `compiler/widget` trees containing entries, client-reference data, `runtime-assets.json`, and an async chunk. Assert the generation manifest lists every file with literal byte length/digest and that removal or replacement of one paired file rejects activation.

- [ ] **Step 2: Run example tests and confirm RED**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- generation-materializer.test.ts runtime-artifact-manifest.test.ts tsconfig-coverage.test.ts`

Expected: FAIL because the config factory/materializer and digested assets do not exist.

- [ ] **Step 3: Extract a shared config factory without weakening production output**

Export:

```ts
export interface RscRuntimeRsbuildConfigOptions {
  readonly compilerRoot?: string;
  readonly mode: 'development' | 'production';
  readonly onCompile?: Readonly<{
    beforeAttempt(): string;
    capture(input: {
      readonly attemptId: string;
      readonly cohortChanged: boolean;
      readonly hasErrors: boolean;
      readonly sourceRevision: string;
    }): Promise<RscRuntimeCompileSnapshot | undefined>;
    enqueue(snapshot: RscRuntimeCompileSnapshot): void;
    failAttempt(attemptId: string, error: unknown): void;
  }>;
}

export interface RscRuntimeCompileSnapshot {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly preparedRevision: string;
  readonly rscCohortRevision: number;
  readonly sourceRevision: string;
}

const runtimeCompileObserverPlugin = (
  observer: NonNullable<RscRuntimeRsbuildConfigOptions['onCompile']>,
): RsbuildPlugin => {
  const pendingAttemptIds: string[] = [];
  let previousCapturedCohortHash: string | undefined;
  return {
    name: 'agent-bundle:rsc-runtime-compile-observer',
    setup(api) {
      api.onBeforeDevCompile(() => {
        pendingAttemptIds.push(observer.beforeAttempt());
      });
      api.onAfterDevCompile(async ({ stats }) => {
        const attemptId = pendingAttemptIds.shift();
        if (attemptId === undefined) {
          throw new Error('RSC runtime compile completed without a matching attempt.');
        }
        try {
          const json = stats.toJson({ all: false, children: true, hash: true });
          const hashes = (json.children ?? [])
            .filter((child) => child.name === 'rsc' || child.name === 'widget')
            .map((child) => [child.name, child.hash ?? ''] as const)
            .sort(([left], [right]) => left.localeCompare(right));
          const sourceRevision = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
          const snapshot = await observer.capture({
            attemptId,
            cohortChanged: sourceRevision !== previousCapturedCohortHash,
            hasErrors: stats.hasErrors(),
            sourceRevision,
          });
          if (snapshot !== undefined) {
            observer.enqueue(snapshot);
            previousCapturedCohortHash = sourceRevision;
          }
        } catch (error) {
          observer.failAttempt(attemptId, error);
        }
      });
    },
  };
};

export const createRscRuntimeRsbuildConfig = (
  options: RscRuntimeRsbuildConfigOptions,
): RsbuildConfig => {
  const development = options.mode === 'development';
  if (development && options.compilerRoot === undefined) {
    throw new TypeError('Development RSC runtime config requires compilerRoot.');
  }
  const root = (name: 'rsc' | 'widget' | 'app', productionRoot: string): string =>
    development ? join(options.compilerRoot as string, name) : productionRoot;

  return {
    ...(development ? {
      dev: { writeToDisk: true },
      server: { host: '127.0.0.1', port: 0, printUrls: false },
    } : {}),
    plugins: [
      pluginReact(),
      pluginRSC({ environments: { server: 'rsc', client: 'widget' } }),
      emitRuntimeManifest(),
      ...(options.onCompile === undefined ? [] : [runtimeCompileObserverPlugin(options.onCompile)]),
    ],
    environments: {
      rsc: {
        source: {
          entry: {
            ...(development ? { 'dev/definition': './src/dev/definition-entry.ts' } : {}),
            ...(development ? { 'dev/invoke': './src/dev/invocation-worker.ts' } : {}),
            'hook/index': './src/hook/cli.ts',
            'rsc/index': { import: './src/rsc/worker.tsx', layer: Layers.rsc },
            'mcp/stdio': './src/mcp/stdio.ts',
            'mcp/http': './src/mcp/http.ts',
          },
        },
        tools: {
          rspack: {
            module: {
              rules: [{
                parser: { importMeta: { url: false } },
                test: /[\\/]src[\\/]flight[\\/]request-render\.ts$/,
              }],
            },
          },
        },
        output: {
          cleanDistPath: false,
          distPath: { js: './', jsAsync: 'chunks', root: root('rsc', 'dist/runtime') },
          filename: { js: '[name].js' },
          manifest: 'runtime-assets.json',
          target: 'node',
        },
      },
      widget: {
        source: {
          entry: {
            ...(development ? { 'dev/definition': './src/rsc/client-anchor.ts' } : {}),
            ...(development ? { 'dev/invoke': './src/rsc/client-anchor.ts' } : {}),
            'hook/index': './src/rsc/client-anchor.ts',
            'rsc/index': './src/rsc/client-anchor.ts',
            'mcp/stdio': './src/rsc/client-anchor.ts',
            'mcp/http': './src/rsc/client-anchor.ts',
          },
        },
        output: {
          cleanDistPath: false,
          distPath: { root: root('widget', 'dist/widget') },
          filename: { js: '[name].js' },
          target: 'web',
        },
      },
      app: {
        html: { inject: 'body' },
        output: {
          cleanDistPath: false,
          distPath: { root: root('app', 'dist/app') },
          inlineScripts: true,
          inlineStyles: true,
          target: 'web',
        },
        source: {
          entry: {
            'edit-timeline-v1': './src/widget/index.tsx',
            standalone: './src/widget/index.tsx',
          },
        },
        tools: {
          rspack: {
            module: { parser: { javascript: { dynamicImportMode: 'eager' } } },
          },
        },
      },
    },
  };
};

export default defineConfig(createRscRuntimeRsbuildConfig({ mode: 'production' }));
```

Define FIFO `pendingAttemptIds` and `previousCapturedCohortHash` in the plugin closure. The implementation must preserve the current production roots and manifest emitter. In development, use `${compilerRoot}/rsc`, `${compilerRoot}/widget`, `${compilerRoot}/app`, set `dev.writeToDisk: true`, `server.host: '127.0.0.1'`, and `server.port: 0`. Every `onBeforeDevCompile` calls `beforeAttempt()`, which creates an unresolved provider activation barrier and returns its opaque id; enqueue every id so even a re-entrant invalidation cannot overwrite/leak an older barrier. It does not increment `rscCohortRevision` before the attempt is classified. The matching after hook dequeues the oldest id and hashes the named `rsc` and `widget` child compilations. `capture()` classifies the barrier synchronously before its first await: an unchanged/App-only cohort resolves it without changing the cohort revision, emitting generation events, or capturing; a changed cohort increments `rscCohortRevision`, resolves it as superseding older snapshots, and then captures only successful stats. Error stats or any hashing/capture/enqueue exception calls idempotent `failAttempt(attemptId,error)`, which settles that barrier, fails any candidate owned by it, and reports the failed attempt, so no activation tail can hang. Provider close likewise settles all queued/unresolved barriers before draining the tail.

Update `previousCapturedCohortHash` only after immutable capture succeeds and `enqueue()` accepts the snapshot; a capture failure therefore leaves the prior hash/revision checkpoint retryable on the next compile even when its cohort bytes/hash are identical. The hook awaits only classification and capture, never tail validation/reconciliation/activation. An App-only edit releases the activation barrier with the cohort revision unchanged and cannot supersede an already captured RSC generation. Do not replace or intercept `rsbuild-plugin-rsc`'s custom HMR message.

- [ ] **Step 4: Add the inspection entry only to development output**

When `development` is true, add `dev/invoke.js` and `dev/definition.js` as development-only executable assets plus paired source anchors. `definition-entry.ts` imports the runtime definition inside the RSC compilation and writes one bounded canonical serialized definition to stdout. During awaited capture, execute the newly emitted `rsc/dev/definition.js` in a fresh Node child (5 s, 1 MiB stdout, bounded/redacted stderr), validate its closed JSON schema, and exclusively write `rsc/runtime-definition.json` before copying the snapshot. Never import or re-require `definition.ts`/`serializeRuntimeDefinition()` from the long-lived provider process; its module cache is not generation state. Production may keep its one-shot build emitter, and production output remains free of the development entries.

Keep `runtime-assets.json` as the source of every transitive runtime asset. The development materializer reads canonical tool/resource metadata only from captured `runtime-definition.json`; `definitionDigest` covers those immutable bytes (names, schemas, annotations, `_meta`, resource URIs). `transportDigest` covers the snapshot's trusted prepared server transport, source/command, args, normalized cwd, URL/header/environment value digests (never raw secrets). `serverDigest` covers the executable RSC/widget implementation asset cohort.

- [ ] **Step 5: Capture immutable compiler output, then materialize outside the hook**

Define the example-owned metadata passed through the generic store:

```ts
export interface RscRuntimeGenerationMetadata {
  readonly definitionDigest: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly environmentHashes: Readonly<Record<'rsc' | 'widget', string>>;
  readonly preparedRevision: string;
  readonly serverDigest: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly stateStoreId: string;
  readonly surfaceAssets: Readonly<Record<string, readonly RscRuntimeSurfaceAsset[]>>;
  readonly transportDigest: string;
}

export interface RscRuntimeSurfaceAsset {
  readonly bytes: number;
  readonly contentType: 'application/javascript' | 'application/json' | 'text/css' | 'text/html';
  readonly generationPath: string;
  readonly requestPath: string;
  readonly sha256: string;
}
```

The example constructs `RuntimeGenerationStore<RscRuntimeGenerationMetadata>` with an explicit encode/decode codec and provider validator that enforce both environments, paired client references, required entries, `chunks/` coverage, captured definition schema/digest consistency, and canonical static server descriptors. Split ownership into `captureRuntimeGenerationSnapshot()` and `materializeRuntimeGeneration()`. While Rsbuild is awaiting `onAfterDevCompile`, `captureRuntimeGenerationSnapshot({attemptId,candidate,compilerRoot,preparedRuntime,rscCohortRevision,sourceRevision})` binds the classified attempt and one deep-frozen trusted prepared snapshot and must:

1. Run the new generation-contained definition executable, validate/write `runtime-definition.json`, then call the dev artifact emitter with that explicit serialized value after disk output is complete; the dev emitter never calls the host-cached serializer.
2. Recursively walk `rsc` and `widget` with `lstat`, rejecting symlinks.
3. Byte-copy every regular file with exclusive creation into `<candidate.root>/<environment>/<relativePath>` and fsync the captured directories. Do not hardlink: Rspack may overwrite an existing inode on the next compile.
4. Return a frozen snapshot token only after the entire paired cohort is owned by candidate staging. The compiler root is never read again for that snapshot.

The awaited hook ends at this capture boundary. `enqueue(snapshot)` appends work to one provider-owned Promise tail and returns `void`. On that tail, `materializeRuntimeGeneration({candidate,sourceRevision,store})` hashes and validates only candidate-owned bytes, verifies every `runtime-assets.json` path including chunks/client references, requires the example entries, derives per-surface asset allowlists from declared surfaces plus captured assets, computes static descriptors/digests, and builds generic manifest input. Build one two-phase activation guard per snapshot. `wait()` loops until attempt-classification quiescence after `snapshot.attemptId`, then records the current compile-attempt sequence it observed. `check()` is synchronous and returns true only when that observed attempt sequence is still the live sequence, no newer attempt barrier is unresolved, `snapshot.rscCohortRevision === latestRscCohortRevision`, `snapshot.preparedRevision === latestPreparedRuntime.sourceRevision`, and the provider is not closing.

Pass this guard to `store.prepare()`, which awaits `wait()` before rename and after renamed-root validation, then calls live `check()` synchronously adjacent to each prepare decision. A compile attempt that begins during materialization/rename or in the microtask gap after `wait()` resolves invalidates the observed attempt sequence before an older candidate can become prepared. An unchanged classification that was already visible to `wait()` releases without superseding; a changed classification advances the cohort revision and rejects the older candidate. A barrier created only after `wait()` resolved makes the synchronous check conservatively supersede that candidate rather than risk a stale preparation. `materializeRuntimeGeneration()` returns the store's prepared token to the provider transaction; it never calls `commit()`, changes `active()`, reconciles MCP, updates status, or publishes. When preparation fails, call `store.fail(candidate)` and report superseded/failed. On every later transaction error call `store.abort(prepared)`; the store's candidate-sequence fence remains a second defense.

Tests mutate/delete compiler-root files immediately after `capture()` resolves and prove candidate hashes remain unchanged. Edit `definition.ts` between real compiles and assert the fresh captured catalog bytes and `definitionDigest` change, then the stable registry performs controlled restart/relist rather than serving the host process's prior module value. A deferred tail test captures `g2`, blocks validation, starts an App-only attempt, then releases `g2` before after-stats classification: assert `g2` cannot activate while the barrier is unresolved; classify the App-only attempt with the same RSC/widget hash, then assert `g2` activates and the App attempt emits zero generation events. A second test fails capture, triggers another compile with the identical RSC/widget hash, and proves capture retries/enqueues/activates. For the supersession window, pause `g2`, call `beforeAttempt()` for an RSC-changing `g3`, hold its after-stats classification, release `g2`, and assert no activation or publication occurs; classify `g3` as changed, then assert `g2` is superseded and only captured `g3` activates. Add a microtask-seam fixture whose guard `wait()` resolves and queues a prepared/cohort revision advance before the store continuation; its synchronous `check()` must reject `g2`, which is never active, leaseable, published, or reconciled. A test that makes capture itself slow proves compiler output cannot be overwritten until immutable copying finishes.

- [ ] **Step 6: Run materializer/config tests**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- generation-materializer.test.ts runtime-artifact-manifest.test.ts tsconfig-coverage.test.ts`

Expected: PASS with actual config inspection and filesystem/digest behavior, not source-text assertions.

- [ ] **Step 7: Commit shared config and materialization**

```bash
git add examples/rsc-agent-runtime/rsbuild.config.ts examples/rsc-agent-runtime/src/build/emit-artifacts.ts examples/rsc-agent-runtime/src/runtime/contracts.ts examples/rsc-agent-runtime/src/dev/definition-entry.ts examples/rsc-agent-runtime/src/dev/generation-materializer.ts examples/rsc-agent-runtime/tests/generation-materializer.test.ts examples/rsc-agent-runtime/tests/runtime-artifact-manifest.test.ts examples/rsc-agent-runtime/tests/tsconfig-coverage.test.ts
git commit -m "feat(example): materialize coherent RSC generations"
```

### Task 8: Start the optional Rsbuild provider, App HMR endpoint, and stable MCP broker

**Files:**
- Create: `examples/rsc-agent-runtime/agent-bundle.config.ts`
- Modify: `examples/rsc-agent-runtime/package.json`
- Create: `examples/rsc-agent-runtime/src/dev/provider.ts`
- Create: `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts`
- Modify: `examples/rsc-agent-runtime/tsconfig.json`
- Create: `examples/rsc-agent-runtime/tests/dev-provider.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 6, and 7; the captured generation-contained definition artifact; the normalized project root/prepared snapshot; and the real Rsbuild dev-server result.
- Produces: a cancellable `createDevRuntimeProvider`, one long-lived compiler/session, a trusted App client-surface endpoint, and one stable `RuntimeMcpRegistry` reconciled after every RSC/widget activation.

- [ ] **Step 1: Write failing provider/bootstrap tests**

Start against a copied temporary example with workspace dependencies linked. Assert `ProjectService({includeDevRuntime:true,mode:'development'}).prepare('dev')` loads a source-ready project with the runtime declaration, trusted normalized launch snapshot, native hook, MCP server, and App; `ArtifactService.build()` remains ready for Claude and Codex. Start the provider and assert the declared hook/tool/resource/App surfaces and targets, active status, one Rsbuild server, and a non-public `clientSurface('mcp.edit-timeline')` whose entry is the real App output and whose WS path is `/rsbuild-hmr`.

Assert `mcpRegistry.snapshot()` contains the manifest's static server descriptors and three distinct canonical digests. Open a session, activate an implementation-only generation, and prove the same session/connection/revision executes the next call on the new vector. Edit `definition.ts` and prove the generation-contained catalog/digest changes despite the provider's warm module cache, causing controlled restart/relist. Change only prepared launch args/env, call `reconcilePreparedRuntime()`, and prove immediate controlled restart/relist against the active implementation plus use of the new prepared revision in the next manifest. Separately change only the App `_meta` finite-JSON value/name binding in config, perform no compiler pass, and assert `definitionDigest` changes plus restart/relist from the complete prepared App snapshot. No JSX render may alter `list-tools` or `list-resources`.

Use a deferred fake around real startup stages: abort before `createRsbuild`, while `startDevServer()` is pending, and immediately after it returns. In every case `start(context.signal)` rejects with the abort reason, closes any late server/compiler/store/registry exactly once, and leaves no loopback listener or staging root.

Exercise real `session.readAsset()`: read an allowlisted active-generation asset and a retained inactive-generation asset; hold a read while retention pruning runs and prove its lease prevents deletion. Assert a pruned id returns `undefined`; unknown surface/path, traversal/NUL/backslash segments, symlink/non-file, metadata path/digest/byte mismatch, and an asset over 8 MiB reject or return undefined without bytes. No request may fall back to compiler output or the current active generation when an explicit id is absent/missing.

- [ ] **Step 2: Run bootstrap tests and confirm RED**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- dev-provider.integration.test.ts`

Expected: FAIL because the project config, provider, and session do not exist.

- [ ] **Step 3: Add a complete, valid optional project config**

The example currently has no Agent Bundle config; add `"agent-bundle": "0.1.0"` to this private workspace's `devDependencies` and create the whole declaration rather than claiming to preserve one:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  dev: { runtime: { provider: './src/dev/provider.ts' } },
  hooks: {
    afterTool: {
      handler: './src/hook/cli.ts',
      targets: ['claude', 'codex'],
      tools: ['file.write'],
    },
  },
  mcp: {
    servers: {
      timeline: {
        apps: {
          timeline: {
            _meta: {
              'openai/widgetDescription': 'Interactive timeline of recorded file edits.',
            },
            entry: './src/widget/index.tsx',
            resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html',
            targets: ['portable', 'claude', 'codex'],
          },
        },
        entry: './src/mcp/stdio.ts',
        targets: ['portable', 'claude', 'codex'],
        transport: 'stdio',
      },
    },
  },
  plugin: {
    description: 'React Server Components agent runtime demonstration.',
    name: 'rsc-agent-runtime-demo',
    version: '1.0.0',
  },
  skills: [],
  targets: ['portable', 'claude', 'codex'],
});
```

The config test uses the real `ProjectService` and artifact lane, not only `defineConfig` typing. Export `createDevRuntimeProvider` with the Task 1 descriptor, empty environment allowlist, and `start: context => RsbuildRuntimeSession.start(context)`; never copy `process.env` into the descriptor or status.

- [ ] **Step 4: Implement cancellable long-lived Rsbuild startup and exact storage ownership**

`RsbuildRuntimeSession.start(context)` checks `context.signal.throwIfAborted()` before and after each awaited stage, deep-freezes `context.preparedRuntime` as the initial trusted launch snapshot, and rejects a mismatched project/provider declaration. Use:

- `RuntimeGenerationStore({ storageRoot: join(context.storageRoot, 'generation-store'), retainInactive: 5 })`; the store itself owns `generation-store/staging` and `generation-store/generations`, so do not append another `generations` segment;
- compiler roots under `join(context.storageRoot, 'compiler')`;
- run artifacts under `join(context.storageRoot, 'runs')`;
- state under `join(context.storageRoot, 'state', 'playground.jsonl')`;
- one `createRsbuild({callerName:'agent-bundle-rsc-runtime',config,cwd:context.projectRoot})` and one `await rsbuild.startDevServer()`.

Register the abort listener before the first resource is created. Each stage enters an owned-resource ledger immediately; abort closes partially created and late-returning server/compiler/store/registry resources with `Promise.allSettled`. Remove the listener only after ownership transfers into the live session. `hmrReady` becomes true only after `startDevServer()` returns and false before close begins; it means the compiler endpoint is available. Actual browser HMR connectivity comes only from Task 5's authenticated proxy upgrade lifecycle events.

The compile observer owns an ordered map of compile-attempt barriers. `beforeAttempt()` increments the diagnostic attempt counter, inserts an unresolved barrier, and returns its id; barrier creation immediately blocks every older snapshot's two-phase activation guard but does not yet advance `latestRscCohortRevision`. `capture()` receives that id and synchronously classifies it before its first await. An unchanged/App-only cohort resolves and removes the barrier without changing the cohort fence or emitting generation events. A changed cohort increments `latestRscCohortRevision`, resolves/removes the barrier as superseding, publishes compiling, begins one candidate tagged with that cohort revision and the current immutable prepared source revision, and exclusively byte-copies the paired output while Rsbuild awaits the hook. Idempotent `failAttempt()` is the common error/finalization path for stats hashing, capture, and enqueue; error stats use it directly. It settles/removes the barrier, publishes `runtime.generation.failed`, fails any candidate owned by that attempt, preserves last good, and leaves the plugin's last-captured hash unchanged, so the same cohort retries later.

`enqueue()` chains a successful snapshot onto `#providerTail`. Each item constructs the Task 3 two-phase guard with a private `waitedAttemptSequence`. `wait()` loops until every newer attempt barrier has been classified, then records the live attempt sequence. `check()` synchronously verifies that sequence is unchanged, no newer barrier is unresolved, both `snapshot.rscCohortRevision === latestRscCohortRevision` and `snapshot.preparedRevision === latestPreparedRuntime.sourceRevision`, and close has not begun. App-only classification visible during `wait()` releases without advancing the cohort revision; changed classification makes the older check false. Provider close rejects/settles outstanding barriers, prevents new ones, and observes the tail, so neither close nor activation can hang and mutable compiler output is never read there.

Treat activation as one provider transaction on `#providerTail`:

1. Materialize and `await generationStore.prepare(...,{guard})`; the immutable renamed generation remains absent from `active()` and all leases.
2. `await mcpRegistry.prepareActivationReconcile(...)` against that prepared manifest. This private provider path—not public/manual `reconcile()`—stages a next execution pointer or connects/re-lists replacement sessions while old sessions remain ready. Current store, broker, admission, status, Apps, and events remain unchanged throughout this await.
3. Call `await guard.wait()` once more after registry preparation. Then enter one synchronous final section with no `await`, Promise creation, connector/filesystem call, timer, event callback, or other user code between state mutations: require `guard.check()` and `generationStore.canCommit(preparedGeneration)`; call `generationStore.commit(preparedGeneration)`; call `mcpRegistry.commitActivationReconcile(preparedRegistry)`; and update the session's active/status vector. With all read surfaces aligned, synchronously record/publish `runtime.generation.activated` first, then call `committedRegistry.publish()` for its buffered MCP result. Both publishers isolate listener failures. No listener/user callback runs before the activated event has been recorded, so a re-entrant implicit lease cannot observe an unpublished `g2`.
4. After publication, `await committedRegistry.finalize()` to drain/close retired connections and await the generation-store cleanup tail as needed. These cleanups cannot roll back the irrevocably aligned commit. Listener/publish failure is isolated and reported without allowing newer provider-tail work to overtake the ordered activated event.

If any async preparation fails, or the final guard/store check is false, abort both prepared handles with `Promise.allSettled`, publish only `runtime.generation.failed`/superseded, and preserve the prior store active pointer, registry execution pointer/revisions, status, events, and implicit lease target. Neither prepared handle is browser-visible or leaseable. Because JavaScript cannot interleave external calls inside the synchronous final section, an implicit `lease()` observes either the fully old transaction or the fully committed new generation—never an unpublished generation with an old MCP pointer. Only a coherent pair may activate/reconcile/publish.

- [ ] **Step 5: Expose the declared App endpoint and reconcile the stable registry**

After `startDevServer()` returns, derive one internal `DevRuntimeClientSurfaceEndpoint` from its actual loopback URL: fixed `surfaceId`, declared App `entryPath`, `httpPathPrefixes:['/']`, matching `httpOrigin`/`webSocketOrigin`, and exact `/rsbuild-hmr`. It is available only through `session.clientSurface(surfaceId)` and never appears in status, surfaces, run JSON, or browser request input. Core's Task 5 proxy consumes it; the existing `McpAppBindingService`/`McpAppRoutes` from the current base consume the resulting core proxy binding in the host-profile plan. Do not create a second App route stack.

Construct one `RuntimeMcpRegistry` for the provider session and expose it as `session.mcpRegistry`. During each generation transaction, prepare the broker against the still-private generation:

```ts
const preparedRegistry = await mcpRegistry.prepareActivationReconcile({
  definitionDigest: manifest.metadata.definitionDigest,
  runtimeGenerationId: manifest.id,
  servers: manifest.metadata.servers,
  transportDigest: manifest.metadata.transportDigest,
});
```

Commit that token only inside Step 4's synchronous aligned section; abort it with `abortActivationReconcile()` whenever the generation token cannot commit. The connector initializes/re-lists static descriptors privately; the executor captures one committed generation lease per list/read/call and returns that operation's vector. An implementation/server asset digest change stages only the next execution pointer. Definition/transport changes use private zero-downtime staging for atomic generation activation; config-only and manual restarts still call the public visible `reconcile()`/`restart()` state machines. Provider close aborts any private activation transaction and calls `mcpRegistry.close()`; it never reuses the artifact-epoch `McpSessionService`.

Implement `session.reconcilePreparedRuntime(prepared)` as a trusted-process method sharing the exact `#providerTail` with activation/registry reconciliation. Before its first await, validate and deep-freeze the snapshot, reject stale/equal `sourceRevision`, project/provider mismatch, non-contained local source/cwd, or a call after close, then advance `latestPreparedRuntime` so any already-running candidate fails its prepared-revision fence. Append the registry work to `#providerTail` and await that item. If active RSC metadata exists, rebuild static descriptors by combining its captured catalog with the complete normalized App declarations (`_meta`, ids/names, server identity, resource URI, targets) and new launch configuration, recompute canonical definition/transport digests, and call public `await mcpRegistry.reconcile(...)` against the existing active generation/server implementation digest. Config-only App metadata/definition or transport changes therefore enter the visible `restarting`/admission-blocked state and restart/relist without a compiler pass; they never call the private activation-staging methods. If only implementation source inputs changed, update the prepared fence but do not move the registry execution pointer until a matching new generation activates. Every later capture binds that exact prepared snapshot; no manifest mixes launch config from a subsequent edit. On registry failure, keep active generation/last-good result, retain the validated newest prepared fence for the next compile, leave the registry failed per Task 4, mark runtime degraded, and remain supplemental to the artifact lane.

Integration tests pause a captured `g2/p2` provider-tail item after store preparation, deliver prepared revision `p3`, and prove the final guard aborts both prepared tokens before publication; the queued config reconcile runs next and a `g3/p3` transaction commits. Add both transactional seams: (a) advance prepared/cohort revision after the generation root is renamed/prepared but before registry preparation returns; (b) let registry preparation/relist resolve and queue the revision advance before the provider continuation enters final commit. In both cases assert `store.active()` and implicit `lease()` remain on `g1`, `lease('g2')` fails, registry snapshot/execution remains `g1`, status remains `g1`, no activated/registry-ready result for `g2` is published, and staged registry connections plus the prepared generation root are cleaned. Then allow a current `g3` and assert store active id, registry execution pointer, status vector, and implicit lease vector already agree when the recorded `runtime.generation.activated(g3)` callback runs; the buffered registry result publishes immediately afterward and also names `g3`. Separate config-only tests change tool/App definition metadata and transport args/env without touching RSC source, defer public reconnect/relist, call `reconcilePreparedRuntime()`, and assert the session visibly becomes `restarting`, rejects a new operation, and emitted restarting before it finally becomes ready/relisted on the current generation. An implementation-only source revision update asserts no registry execution-pointer change until its compiler generation commits. Close racing either queued operation aborts both prepared handles and drains/cancels the single tail without a late commit.

- [ ] **Step 6: Implement leased, manifest-allowlisted generation asset reads**

`readAsset(request)` requires the explicit `runtimeGenerationId` already present in `DevRuntimeAssetRequest`; it never substitutes active. Validate `surfaceId` against the provider's frozen surface table and every already-decoded path segment as nonempty, not `.`/`..`, and free of slash, backslash, NUL, or percent-encoded ambiguity. Join segments only into a canonical request key, then:

1. acquire `generationStore.lease(request.runtimeGenerationId)` and return `undefined` for not-found/pruned;
2. resolve the key only through `lease.generation.manifest.metadata.surfaceAssets[surfaceId]`;
3. resolve the descriptor's `generationPath` beneath the leased immutable root and recheck containment;
4. `lstat` a regular non-symlink file, require descriptor bytes at most 8 MiB and exact stat size;
5. read at most the declared bytes, recompute SHA-256, require the descriptor/manifest digest, and return only the descriptor's closed content-type union;
6. release the generation lease in `finally`, including unknown/tampered/read-error branches.

The example metadata codec/validator rejects duplicate request keys, a generation path absent from the generic asset manifest, disallowed MIME/extension pairs, digest/size disagreement, and surface ids not declared by `surfaces()`. App dev-server/Fast Refresh files remain on the trusted proxy lane; `readAsset` serves only immutable generation assets. Tests use real files and a deferred read to prove pruning waits for release, then removes the retained root and makes a later read undefined.

- [ ] **Step 7: Run bootstrap/registry/config/asset readiness tests**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- dev-provider.integration.test.ts && npm test -- packages/agent-bundle/tests/dev-services.test.ts packages/agent-bundle/tests/runtime-mcp-registry.test.ts`

Expected: PASS with one dev config evaluation, usable artifact outputs, stable implementation-only sessions, restart/relist on schema/transport change, real client-surface metadata, and abort-safe cleanup.

- [ ] **Step 8: Commit the provider bootstrap**

```bash
git add examples/rsc-agent-runtime/agent-bundle.config.ts examples/rsc-agent-runtime/package.json examples/rsc-agent-runtime/src/dev/provider.ts examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts examples/rsc-agent-runtime/tsconfig.json examples/rsc-agent-runtime/tests/dev-provider.integration.test.ts
git commit -m "feat(example): start optional RSC runtime provider"
```

### Task 9: Add bounded generation-contained invocation and durable external state

**Files:**
- Modify: `examples/rsc-agent-runtime/package.json`
- Modify: `package-lock.json`
- Create: `examples/rsc-agent-runtime/src/dev/invocation-worker.ts`
- Create: `examples/rsc-agent-runtime/src/dev/serialize-inspection.ts`
- Modify: `examples/rsc-agent-runtime/src/flight/request-render.ts`
- Modify: `examples/rsc-agent-runtime/src/hook/normalize.ts`
- Modify: `examples/rsc-agent-runtime/src/rsc/worker.tsx`
- Modify: `examples/rsc-agent-runtime/src/runtime/contracts.ts`
- Modify: `examples/rsc-agent-runtime/src/runtime/state-file.ts`
- Modify: `examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts`
- Create: `examples/rsc-agent-runtime/tests/dev-invocation.integration.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/mcp-transports.integration.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/rsc-hook.integration.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/state-and-definition.test.ts`

**Interfaces:**
- Consumes: the live Task 8 session, immutable generation leases, existing native hook/MCP lowering, Flight rendering, and the existing file kernel.
- Produces: bounded immutable run history, generation-contained inspection, monotonic crash-tolerant state, and idempotent mutations shared by hooks and runtime MCP calls.

- [ ] **Step 1: Write failing invocation and state tests**

Start one blocked invocation on `g1`, activate `g2`, invoke again, then unblock the first. Assert exact `g1`/`g2` result vectors and retention until release. A mismatched expected id starts no worker. Assert the fifth concurrent worker rejects, >4 MiB stdout/Flight is killed, >256 KiB stderr is truncated/redacted, a 10 s worker is killed, and close kills blocked workers/releases all leases.

Against a real state file, assert: versions remain monotonic across kernel recreation and reset; two concurrent identical writes with the same idempotency key append once and return the same version; reuse of a key with different canonical input rejects; different keys serialize to successive versions; a reader sees a valid prefix during an incomplete final append; a final unterminated JSON record is ignored/recoverable; malformed terminated final JSON, a malformed middle line, duplicate/decreasing versions, and an invalid record shape throw `RuntimeStateCorruptionError` rather than disappearing; reset appends a versioned reset record rather than truncating history. Spawn a child that acquires the cross-platform lease and reports ready; prove its heartbeat advances and a live second owner times out/aborts without stealing. SIGKILL the owner between acquire and append/release, wait for the injected 2 s test stale bound, then prove a fresh kernel atomically recovers the stale lock directory and writes successfully. Force `onCompromised` and assert the old kernel poisons itself and never appends after ownership loss. Run the same built Claude and Codex hook fixture twice with one `tool_use_id` and assert one durable edit/version; change the id and assert the next version. Keep the real MCP transport seed/call tests green with explicit deterministic keys.

- [ ] **Step 2: Run invocation/state tests and confirm RED**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- dev-invocation.integration.test.ts state-and-definition.test.ts rsc-hook.integration.test.ts mcp-transports.integration.test.ts`

Expected: FAIL because the generation-contained entry and durable state semantics do not exist.

- [ ] **Step 3: Implement an explicit append-only state record protocol**

Change `state-file.ts` and runtime contracts to use a discriminated JSONL record:

```ts
type RuntimeStateRecord =
  | Readonly<{ idempotencyKey: string; kind: 'edit'; stateVersion: number; event: EditEvent }>
  | Readonly<{ idempotencyKey: string; kind: 'reset'; seed?: JsonValue; stateVersion: number }>;
```

Add the declared pure-JavaScript cross-platform lease implementation and types:

```bash
npm install proper-lockfile@4.1.2 --workspace @agent-bundle/rsc-agent-runtime-demo
npm install --save-dev @types/proper-lockfile@4.1.4 --workspace @agent-bundle/rsc-agent-runtime-demo
```

This updates only the private example package and root lockfile; `proper-lockfile` and its dependency tree contain no native addon or platform-specific postinstall. Create the state file first, canonicalize its real path, and let `proper-lockfile` own exactly its default sibling `<stateFile>.lock` directory. Production options are `stale:30_000`, `update:5_000`, and `retries:0`; implement caller-controlled bounded retry around single attempts so `AbortSignal` cancels promptly. The 30 s stale lease is three times the enforced 10 s maximum mutation critical section and six missed heartbeats. Test-only kernel options may lower these to the library-supported `stale:2_000`/`update:1_000`; production callers cannot override them.

`recordEdit` requires the host tool/event idempotency key. Hold the returned release lease through one capped (16 MiB state file), watchdog-bounded snapshot validation, optional tail repair, append, and `fsync`, then release in `finally`. Configure `onCompromised` to abort the current mutation, mark that kernel instance poisoned, reject all later mutations, and report a structured state-lock diagnostic; it must never keep writing under uncertain ownership or unlink another owner's directory. A normally heartbeating live owner is never stale and every contender remains excluded. After SIGKILL, no heartbeat advances; only after the full stale bound may `proper-lockfile` recover the directory using its atomic mkdir/mtime algorithm. Under the lease, return the existing result only when a duplicate key has identical canonical kind/payload, reject conflicting reuse, otherwise append exactly one next-version record and fsync the parent on initial creation. If the locked snapshot ends in a nonempty unterminated tail, truncate only those tail bytes back to the last verified newline, fsync, and append; never recover by skipping/truncating a terminated or middle record. `resetState` uses the same lease and appends the next-version reset marker; it never truncates durable history or resets the counter. A lock-free snapshot reader uses one `readFile` byte snapshot and reports a consistent complete prefix.

Update every caller in the same task. Add `idempotencyKey` to `CanonicalPostToolUse` and the `RuntimeKernel.recordEdit` input. In `hook/normalize.ts`, preserve a nonempty native `tool_use_id`, falling back only to a nonempty host `event_id`, and normalize it as `${host}:tool:${id}` or `${host}:event:${id}`; reject a mutating hook with neither instead of inventing time/randomness. `rsc/worker.tsx` validates/passes the key into `recordEdit`. The dev invocation path uses that normalized native key, so replaying a hook request with the same host event deduplicates even when the Workbench run id differs. For any future mutating MCP fixture use `mcp:${sessionId}:${requestId}` and require a caller request id; the current demo MCP tools remain read-only. Direct state/MCP transport test seeds use fixed namespaced keys such as `test:mcp-transport:seed-1`.

The parser may ignore only a nonempty final record whose bytes are unterminated at EOF. Any invalid newline-terminated final record or invalid middle record throws `RuntimeStateCorruptionError` with line/offset and no partial success. Reads operate on one `readFile` byte snapshot, so they return a consistent valid prefix while a writer's final append is torn. Tests kill/recreate kernels around every boundary and verify lock cleanup.

- [ ] **Step 4: Build the generation-contained inspection executable**

The development-only `dev/invoke` reads one JSON request from stdin, normalizes the Claude/Codex fixture, spawns its sibling `rsc/index.js`, captures raw Flight, decodes through `react-server-dom-rspack/client.node`, lowers through existing hook/MCP lowerers, and emits one JSON object matching `DevRuntimeInspectionEnvelope` plus base64 raw Flight. `serialize-inspection.ts` assigns deterministic preorder ids, strips functions/symbols, applies existing JSON freezer rules, and emits ordered normalize/worker/Flight/decode/lower spans. Extend `request-render.ts` with a bounded helper returning decoded node plus raw bytes while preserving production `requestFlightRender()` compatibility.

- [ ] **Step 5: Pin every run and mutation to one operation lease**

Validate surface/target/fixture/JSON before `store.lease(expectedGenerationId)`. Create a running vector from the lease and pre-run state version, publish started, then spawn `<lease.root>/rsc/dev/invoke.js` with the normalized project cwd and only `{NODE_ENV:'development',AGENT_RUNTIME_STATE_FILE:stateFile,...context.environment}`. Apply the four-worker, 10 s, 4 MiB stdout, and 256 KiB redacted stderr bounds. Use the normalized host event id as the state idempotency key. Create `<context.storageRoot>/runs/<runId>` with exclusive contained ownership only after validation. Write Flight to its fixed `flight.bin`, return a 32 KiB preview and `downloadPath: /api/runtime/runs/<encoded-run-id>/flight`, read the durable final state version into the result vector, publish completion/failure, and release in `finally`.

Keep exactly the newest 50 immutable records for the current provider session. `runs(limit)` accepts only 1..50 and returns newest-first; `run(id)` never mutates. `readRunFlight(id)` first resolves that map, requires `status:'succeeded'` and matching `providerSessionId`, reads only the fixed contained file, enforces the 4 MiB invariant again, and returns an immutable asset. Failed/cancelled runs remove their partial directory immediately and expose no download path. On insertion of a 51st completed record, evict the oldest record and await removal of its run directory; concurrent reads already hold immutable bytes. State reset deliberately retains historical runs/artifacts until normal eviction because they record the pre-reset state identity. Provider close rejects new reads, settles readers/workers, then removes the entire provider-owned `runs` root; a fresh provider session cannot resolve old run ids. Exact replay retains/leases the historical generation or fails; latest replay reuses the historical input/surface/fixture/target against the active generation.

Tests cover 51 successful runs with no orphan directory, failed/timeout/cancel partial cleanup, reset retention followed by eviction, provider-close deletion, traversal-like run ids, stale prior-provider ids, and a route read racing eviction. Every filesystem assertion is rooted at the captured provider `context.storageRoot`.

- [ ] **Step 6: Run invocation/state and existing production tests**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- dev-invocation.integration.test.ts state-and-definition.test.ts rsc-hook.integration.test.ts mcp-transports.integration.test.ts mcp-lowering.test.tsx`

Expected: PASS with overlapping exact vectors, idempotent durable state, corrupt-middle detection, limits, 50-record history, and unchanged production lowering.

- [ ] **Step 7: Commit invocation and state**

```bash
git add examples/rsc-agent-runtime/package.json package-lock.json examples/rsc-agent-runtime/src/dev/invocation-worker.ts examples/rsc-agent-runtime/src/dev/serialize-inspection.ts examples/rsc-agent-runtime/src/dev/rsbuild-runtime-session.ts examples/rsc-agent-runtime/src/flight/request-render.ts examples/rsc-agent-runtime/src/hook/normalize.ts examples/rsc-agent-runtime/src/rsc/worker.tsx examples/rsc-agent-runtime/src/runtime/contracts.ts examples/rsc-agent-runtime/src/runtime/state-file.ts examples/rsc-agent-runtime/tests/dev-invocation.integration.test.ts examples/rsc-agent-runtime/tests/mcp-transports.integration.test.ts examples/rsc-agent-runtime/tests/rsc-hook.integration.test.ts examples/rsc-agent-runtime/tests/state-and-definition.test.ts
git commit -m "feat(example): add generation-contained runtime invocation"
```

### Task 10: Prove real RSC HMR, App Fast Refresh, last-good failure recovery, and generation coherence

**Files:**
- Create: `examples/rsc-agent-runtime/tests/rsc-hmr.integration.test.ts`
- Create: `examples/rsc-agent-runtime/tests/app-fast-refresh.integration.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/dev-provider.integration.test.ts`
- Modify: `examples/rsc-agent-runtime/README.md`
- Modify: `examples/rsc-agent-runtime/package.json`

**Interfaces:**
- Consumes: real `startDevServer`, real Rsbuild watch/HMR server, runtime SSE/events routes, Task 5's core client-surface proxy, and the example provider.
- Produces: end-to-end regressions proving source save -> coherent generation -> new Flight result and App edit -> built-in Rsbuild Fast Refresh without a runtime-generation activation, plus last-good recovery.

- [ ] **Step 1: Write the failing end-to-end HMR test**

Copy the example source into a temporary root, link only the workspace dependencies, and start real `startDevServer({ open:false, port:0, root })`. Authenticate through `/api/project/session`, subscribe to `/api/project/events`, and record the first active generation/run.

Edit a visible Server Component string in the copied `src/rsc/components.tsx`. Wait for ordered events:

```text
runtime.generation.compiling(g2)
runtime.generation.activated(g2)
runtime.run.started(g2)
runtime.run.completed(g2)
```

The test client performs the selected-fixture replay only after activated, matching the Workbench behavior. Assert the second Flight preview/native output contains the edited marker, the foreground URL is unchanged, `g1 !== g2`, and each run's manifest/assets all resolve beneath its own generation root.

Then introduce a syntax error. Wait for `runtime.generation.failed`; assert active/last-good remains `g2`, the prior visible run is unchanged, and a new run pinned to `g2` still succeeds. Repair the source, wait for `g3`, and assert recovery without restarting `startDevServer` or the Rsbuild server.

In `app-fast-refresh.integration.test.ts`, open the server-side `openRuntimeClientSurface('mcp.edit-timeline')` binding, navigate Playwright to its one-use `bootstrapUrl`, and record the runtime generation. Edit a visible client-only `src/widget/index.tsx` marker. Assert the same document receives the real Rsbuild `/rsbuild-hmr` update/Fast Refresh and displays the marker without a full reload, the proxy origin and Rsbuild process remain unchanged, and no `runtime.generation.compiling` or `runtime.generation.activated` event occurs because the `rsc`/`widget` cohort hash did not change. Close the binding and assert its HTTP/WS origin no longer accepts connections. This extends the existing `McpAppBindingService` preview lifecycle; it does not add another App HTTP API.

- [ ] **Step 2: Run the HMR test and watch the first missing behavior fail**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- rsc-hmr.integration.test.ts app-fast-refresh.integration.test.ts`

Expected: FAIL before the production callbacks/event ordering/replay boundary satisfy the test.

- [ ] **Step 3: Make only the minimal production corrections exposed by the real test**

Corrections must stay within these invariants:

- do not synthesize `rsc:update`; it comes from installed `rsbuild-plugin-rsc`;
- do not publish activated until the synchronous generation-store/MCP-registry/status transaction has committed;
- do not stop/recreate Rsbuild after a source edit or compilation error;
- do not clear active/run result on failure;
- do not manually invalidate the Rsbuild dependency graph from `ProjectWatcher`;
- do not copy assets after activation;
- do not rebind an expected generation silently.

If the real dev compiler exposes output ordering different from the unit fixture, fix the provider's readiness callback/materializer, not the test's ordered expectation.

- [ ] **Step 4: Add the observable rapid-invalidation fence regression**

Use the provider's test-only deferred validator (not a blocked Rsbuild hook) to pause `g2` after immutable capture. First begin an App-only `src/widget/index.tsx` compile and hold its after-stats classification; release the `g2` validator and assert the unresolved attempt barrier prevents generation/registry preparation from reaching the final commit and prevents publication. Complete the App-only classification, wait for Fast Refresh, and assert the RSC/widget cohort hash/revision remains unchanged, zero generation events occur, and the coherent `g2` transaction now commits.

Repeat with paused `g2`, then begin a real RSC `g3` compile and stop between `onBeforeDevCompile` and after-stats classification. Release `g2` and assert it remains blocked with no activation/publication while the `g3` barrier is unresolved. Complete the changed-cohort classification/capture; assert it advances the cohort revision, supersedes `g2`, and only `g3` activates. Finally force one capture failure and trigger an otherwise identical compile; because the last-captured hash/revision checkpoint was not advanced, the identical cohort must retry, capture, and activate. Hold a `g1` run across the changed-cohort saves and assert its imports/chunks remain exclusively `g1`. Read every activated manifest and verify no `(path,sha256)` tuple from another cohort appears in a run.

- [ ] **Step 5: Run HMR and provider tests repeatedly**

Run: `npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- rsc-hmr.integration.test.ts app-fast-refresh.integration.test.ts dev-provider.integration.test.ts --repeat=3`

If Rstest does not accept `--repeat`, run the same command three times explicitly. Expected: all iterations PASS without leaked provider/proxy ports, workers, state lock files, `<context.storageRoot>/generation-store/staging/*` candidates, `<context.storageRoot>/compiler` watchers, or open handles. The assertion uses the captured `context.storageRoot`; it must not append another `generations` segment or scan an unrelated provider session.

- [ ] **Step 6: Document the exact development flow**

Update the example README with:

- `npm run dev --workspace @agent-bundle/rsc-agent-runtime-demo` (add script `agent-bundle dev --root . --no-open`);
- explicit optional config snippet;
- artifact epoch vs runtime generation vs state version;
- raw `rsc:update` invalidation vs `runtime.generation.activated` readiness;
- external state rather than require/ESM cache memory;
- production `npm run build` still owned by Rsbuild/Rslib packaging paths, not the dev generation store;
- MCP definitions are static, the provider's stable broker survives implementation-only generations, and schema/transport changes trigger controlled restart/relist; the MCP Apps plan adapts that broker into the existing App/host controllers.

- [ ] **Step 7: Commit HMR proof**

```bash
git add examples/rsc-agent-runtime/tests/rsc-hmr.integration.test.ts examples/rsc-agent-runtime/tests/app-fast-refresh.integration.test.ts examples/rsc-agent-runtime/tests/dev-provider.integration.test.ts examples/rsc-agent-runtime/README.md examples/rsc-agent-runtime/package.json
git commit -m "test(example): prove generation-safe RSC HMR"
```

### Task 11: Verify optional isolation, packaging boundaries, and the provider slice

**Files:**
- Modify: `packages/agent-bundle/tests/dev-workbench-packaging.test.ts`
- Modify: `packages/agent-bundle/tests/dev-workbench.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/runtime-artifact-manifest.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release-gate evidence that ordinary Agent Bundle behavior and published dependency boundaries remain intact.

- [ ] **Step 1: Add failing regression assertions before the final implementation adjustments**

Pack/install Agent Bundle into the existing temporary consumer and start a normal no-runtime project. Assert:

- `/api/runtime/status` is 200 `{status:null}` and `/api/runtime/surfaces` is 200 `{surfaces:[]}`;
- the sentinel provider module is never evaluated;
- no `react`, `react-dom`, `react-server-dom-rspack`, or `rsbuild-plugin-rsc` package is required or resolved by the ordinary process;
- normal artifact rebuild, Skills, existing `/api/mcp/sessions`, close, and packaged Workbench assets still work;
- the packed `agent-bundle` manifest does not acquire any RSC example dependency.

Build the example for production and assert every `agent-runtime.manifest.json` asset, including `chunks/`, exists in the packaged host outputs and every self-contained App HTML remains valid.

- [ ] **Step 2: Run regression tests and confirm any missing boundary fails**

Run: `npm test -- packages/agent-bundle/tests/dev-workbench-packaging.test.ts packages/agent-bundle/tests/dev-workbench.test.ts && npm test --workspace @agent-bundle/rsc-agent-runtime-demo -- runtime-artifact-manifest.test.ts host-artifacts.test.ts`

Expected: FAIL only for boundary assertions not yet satisfied; existing artifact/MCP behavior must already remain green.

- [ ] **Step 3: Correct boundary leaks without moving RSC dependencies into core**

Allowed corrections are export/packaging filters, lazy type-only imports, example dependency placement, and no-runtime route behavior. Do not add React/RSC packages to `packages/agent-bundle/package.json`; do not import example provider code from core; do not make runtime config part of normalized build digests.

- [ ] **Step 4: Run the complete provider-slice verification**

Run in order:

```bash
npm test -- packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/runtime-generation-store.test.ts packages/agent-bundle/tests/runtime-mcp-registry.test.ts packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/runtime-client-surface-proxy.test.ts packages/agent-bundle/tests/dev-events.contract.test.ts packages/agent-bundle/tests/dev-coordinator.test.ts packages/agent-bundle/tests/dev-server.test.ts packages/agent-bundle/tests/dev-workbench.test.ts packages/agent-bundle/tests/dev-workbench-packaging.test.ts
npm run check --workspace @agent-bundle/rsc-agent-runtime-demo
npm run check
git diff --check
```

Expected: every command PASS. Record exact test counts and duration in the SDD task ledger. Confirm `git status --short` contains only intentional changes before commit.

- [ ] **Step 5: Commit provider-slice regression evidence**

```bash
git add packages/agent-bundle/tests/dev-workbench-packaging.test.ts packages/agent-bundle/tests/dev-workbench.test.ts examples/rsc-agent-runtime/tests/runtime-artifact-manifest.test.ts
git commit -m "test(dev): preserve optional runtime isolation"
```

## Cross-Plan Contract Handoff

The Runtime Playground plan imports `DevRuntimeStatus`, `DevRuntimeSurface`, `DevRuntimeRun`, `DevRuntimeRunsResponse`, `DevRuntimeInspectionEnvelope`, `DevRuntimeTreeNode`, `DevRuntimeTraceSpan`, and request/response types from `runtime-protocol.ts`. No-runtime capability responses are exactly 200 `{status:null}` and `{surfaces:[]}`. Protected `GET /api/runtime/runs?limit=50` returns `{providerSessionId,runs}` for only the active provider session, newest-first, hard capped at 50. `runtime.event` remains inside `ProjectEventHub`'s single outer project sequence/FIFO; after an outer replay gap the Playground refetches status, surfaces, and runs before accepting live events. It never reruns on raw `rsc:update`, only after a coherent `runtime.generation.activated`.

The MCP Apps/host-profiles plan consumes `DevRuntimeMcpRegistry`; it does not extend or instantiate the artifact-epoch `McpSessionService`. Stable `DevRuntimeMcpSessionBinding` identity is exactly `providerSessionId`, `sessionId`, `sessionRevision`, `registryRevision`, `definitionDigest`, `transportDigest`, `serverDigest`, `serverName`, `stateStoreId`, and `target`—never `runtimeGenerationId` or `stateVersion`. Each `DevRuntimeMcpOperationResult` separately carries its leased `RuntimeVector`. `DevRuntimeInspectionEnvelope.app.mcpBinding` stores the immutable session/revision/digest evidence for that run, while the enclosing run vector stores its generation/state evidence.

Manual development controls occupy only `POST /api/runtime/mcp/sessions`, `POST /api/runtime/mcp/sessions/:sessionId/restart`, `DELETE /api/runtime/mcp/sessions/:sessionId`, and `POST /api/runtime/mcp/sessions/:sessionId/rpc`. They call `open`, `restart`, `closeSession`, and `execute` with closed request unions and revision checks. App preview creation receives only `{runId,profileId,expectedGenerationId}`, resolves the stored run binding server-side through non-owning `mcpRegistry.session(sessionId)`, and never calls `open()`, launches a server, or accepts digests/transport/cwd/environment from the browser.

Reuse the current `McpAppSessionAuthority`, `McpAppBindingService`, bridge, sandbox, consent, and authenticated `McpAppRoutes` by adding a runtime-registry authority adapter in the host plan. Do not create a parallel App controller/route stack. Registry `subscribe()` invalidates those existing bindings on `sessions-restarted` or `restart-failed`; closing an App releases only its App access lease, not the stable broker session. The host plan also consumes only `DevServerSession.openRuntimeClientSurface(surfaceId)` and the returned core proxy `bootstrapUrl`; upstream Rsbuild origins remain server-only.

## Self-Review Checklist

- Spec coverage: Tasks 1-2 cover optional config/discovery/containment; Tasks 3-4 cover immutable generations and the stable per-operation-leased MCP registry; Tasks 5-6 cover routes/events, fixed App HMR proxy, cancellable lifecycle, and dev config preparation; Tasks 7-9 cover real Rsbuild cohort materialization, provider/registry startup, bounded invocation, and durable external state; Task 10 proves real RSC HMR, App Fast Refresh, fencing, and recovery; Task 11 proves optional isolation and packaging.
- Intentionally deferred: visual Playground rendering belongs to the Runtime Playground plan; the runtime-registry adapter into the existing App binding/bridge/sandbox controllers, official SDK/Inspector transport, and ChatGPT/Claude profiles belong to the MCP Apps/host-profiles plan; final topology/audit belongs to the integration plan. The generic broker/restart/relist policy itself is delivered here in Task 4.
- Placeholder scan: every implementation step names its concrete behavior, code shape, failure observation, and verification command; no deferred marker or undefined neighboring interface remains.
- Type consistency: every browser wrapper and nested inspection name is declared once in `runtime-protocol.ts`; session identity never contains runtime generation/state fields, every operation result carries one `RuntimeVector`, and `definitionDigest`, `transportDigest`, and `serverDigest` retain distinct meanings.
- Test quality: expectations are literal or hand-derived; framework mechanics are inspected only where Agent Bundle relies on a specific Rsbuild boundary; filesystem, HTTP, process, and real compiler behaviors are preferred over mocks; every mutation listed in Task 3/7 has a named behavioral test.
