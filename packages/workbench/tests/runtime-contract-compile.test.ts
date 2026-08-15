import { expect, it } from '@rstest/core';

import type {
  DevRuntimeAssetRequest,
  DevRuntimeDiagnostic,
  DevRuntimeInspectionEnvelope,
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeRunResponse,
  DevRuntimeRunsResponse,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStateResponse,
  DevRuntimeStatus,
  DevRuntimeStatusResponse,
  DevRuntimeSurface,
  DevRuntimeSurfacesResponse,
  DevRuntimeTreeNode,
  DevRuntimeTraceSpan,
  RuntimeVector,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { RuntimeClient, RuntimeClientError, type RuntimeBootstrap } from '../src/runtime-client.ts';

const vector = {
  artifactEpochId: 'epoch-a',
  providerSessionId: 'provider-a',
  runtimeGenerationId: 'generation-a',
  sourceRevision: 'source-a',
  stateStoreId: 'state-a',
  stateVersion: 1,
} satisfies RuntimeVector;

const diagnostic = {
  code: 'RUNTIME_NOTICE',
  message: 'Runtime is ready.',
  phase: 'provider-lifecycle',
  severity: 'info',
} satisfies DevRuntimeDiagnostic;

const surface = {
  defaultTarget: 'portable',
  fixtures: [{ id: 'fixture-a', label: 'Fixture A', seed: { city: 'London' } }],
  id: 'app/weather',
  inputSchema: { type: 'object' },
  kind: 'mcp-app',
  label: 'Weather App',
  readOnly: false,
  targets: ['portable'],
} satisfies DevRuntimeSurface;

const tree = {
  children: [],
  id: 'root',
  kind: 'component',
  label: 'Weather',
  props: { city: 'London' },
} satisfies DevRuntimeTreeNode;

const trace = {
  details: { target: 'portable' },
  durationMs: 4,
  id: 'render',
  phase: 'rsc-render',
  startedAt: '2026-08-15T12:00:00.000Z',
  status: 'succeeded',
} satisfies DevRuntimeTraceSpan;

const state = { stateStoreId: 'state-a', stateVersion: 1 } satisfies DevRuntimeStateIdentity;

const inspection = {
  agentVisible: { summary: 'Sunny' },
  app: {
    mcpBinding: {
      definitionDigest: 'definition-a',
      registryRevision: 1,
      serverDigest: 'server-a',
      serverName: 'weather',
      sessionId: 'session-a',
      sessionRevision: 1,
      target: 'portable',
      transportDigest: 'transport-a',
    },
    resourceUri: 'ui://weather/app.html',
    surfaceId: 'app/weather',
  },
  modelVisible: { summary: 'Sunny' },
  native: { status: 200 },
  protocol: { jsonrpc: '2.0' },
  state: { identity: state, snapshot: { city: 'London' } },
  trace: [trace],
  tree: [tree],
} satisfies DevRuntimeInspectionEnvelope;

const run = {
  completedAt: '2026-08-15T12:00:01.000Z',
  fixtureId: 'fixture-a',
  id: 'run-a',
  input: { city: 'London' },
  result: inspection,
  startedAt: '2026-08-15T12:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'app/weather',
  target: 'portable',
  vector,
} satisfies DevRuntimeRun;

const status = {
  activeVector: vector,
  descriptor: { environmentVariables: ['NODE_ENV'], id: 'rsc', label: 'RSC Runtime', schemaVersion: 1 },
  diagnostics: [diagnostic],
  hmrReady: true,
  lastGoodVector: vector,
  state: 'active',
} satisfies DevRuntimeStatus;

const invocation = {
  expectedGenerationId: 'generation-a',
  fixtureId: 'fixture-a',
  input: { city: 'London' },
  surfaceId: 'app/weather',
  target: 'portable',
} satisfies DevRuntimeInvocationRequest;

const replay = {
  expectedGenerationId: 'generation-a',
  mode: 'exact',
  runId: 'run-a',
} satisfies DevRuntimeReplayRequest;

const reset = {
  expectedGenerationId: 'generation-a',
  seed: { city: 'London' },
  stateStoreId: 'state-a',
} satisfies DevRuntimeStateResetRequest;

const asset = {
  path: ['assets', 'weather.js'],
  runtimeGenerationId: 'generation-a',
  surfaceId: 'app/weather',
} satisfies DevRuntimeAssetRequest;

const statusResponse = { status } satisfies DevRuntimeStatusResponse;
const surfacesResponse = { surfaces: [surface] } satisfies DevRuntimeSurfacesResponse;
const runResponse = { run } satisfies DevRuntimeRunResponse;
const runsResponse = { providerSessionId: 'provider-a', runs: [run] } satisfies DevRuntimeRunsResponse;
const stateResponse = { state } satisfies DevRuntimeStateResponse;

it('compiles RuntimeClient against the exact provider wire contract', () => {
  const foreground = new ForegroundRouteClient({ fetch: async () => Response.json(statusResponse) });
  const client: RuntimeClient = new RuntimeClient(foreground);
  const bootstrap: Promise<RuntimeBootstrap> = client.bootstrap();
  const error: RuntimeClientError = new RuntimeClientError({ code: 'AB8204', message: 'Generation changed.', phase: 'provider-lifecycle' });

  expect({
    asset,
    bootstrap,
    error,
    invocation,
    replay,
    reset,
    runResponse,
    runsResponse,
    stateResponse,
    statusResponse,
    surfacesResponse,
  }).toBeDefined();
});
