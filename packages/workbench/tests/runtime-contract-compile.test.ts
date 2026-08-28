import { createElement } from 'react';
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
import { McpAppPreview, type McpAppPreviewClient, type McpAppPreviewProps } from '../src/mcp/mcp-app-preview.tsx';
import type { McpJsonInputProps } from '../src/mcp/mcp-json-input.tsx';
import { McpProtocolEvidence, type McpProtocolEvidenceProps } from '../src/mcp/mcp-page.tsx';
import type { InspectorRuntimeEvidenceProps } from '../src/inspector/adapter/inspector-session-adapter-entry.ts';
import { RuntimeClient, RuntimeClientError, type RuntimeBootstrap } from '../src/runtime-client.ts';
import type { RuntimeInspectorProps } from '../src/runtime-inspector.tsx';
import { createRuntimePlaygroundController, type RuntimePlaygroundProps } from '../src/runtime-playground.tsx';
import {
  createRuntimeModel,
  effectFor,
  reduceRuntimeModel,
  type RuntimeModel,
  type RuntimePendingEffect,
  type RuntimeProfileOption,
} from '../src/runtime-model.ts';
import type { RuntimeAppPreviewRenderer, RuntimeStageProps } from '../src/runtime-stage.tsx';

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

const profiles = [{
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable',
  version: '1',
}] satisfies readonly RuntimeProfileOption[];

const appClient = {
  close: async () => ({ lifecycle: 'closed' as const }),
  create: async () => ({ bindingId: 'binding-a', profile: { kind: 'apps', profile: 'portable', resourceUri: 'ui://weather/app.html' }, resource: { html: '<main>Weather</main>', kind: 'resource' } }),
  forceClose: async () => true,
  message: async () => ({ accepted: true, lifecycle: 'initialized' as const, messages: [] }),
} satisfies McpAppPreviewClient;

const appPreviewFixture = Object.freeze({
  client: appClient,
  host: {
    availableDisplayModes: ['inline'], containerDimensions: { height: 0, width: 0 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light' as const, timeZone: 'UTC', userAgent: 'contract-test',
  },
  input: Object.freeze({ city: 'London' }),
  previewProfile: 'portable' as const,
  result: Object.freeze({ content: [] }),
  sessionId: 'session-a',
  toolName: 'weather',
}) satisfies McpAppPreviewProps;

const appPreviewRenderer: RuntimeAppPreviewRenderer = () => createElement(McpAppPreview, appPreviewFixture);
const controlledInput: McpJsonInputProps = {
  id: 'runtime-input', label: 'Runtime input', onChange: () => undefined, onRawDraftChange: () => undefined, onSubmit: () => undefined, rawDraft: '{"city":', value: { city: 'London' },
};
const protocolEvidence: McpProtocolEvidenceProps = { ariaLabel: 'Provider protocol', protocol: inspection.protocol, trace: [trace] };
const inspectorEvidence: InspectorRuntimeEvidenceProps = { evidence: { kind: 'protocol', protocol: inspection.protocol, trace: [trace] } };
const stageProps: RuntimeStageProps = { profile: profiles[0], profileId: 'portable', renderAppPreview: appPreviewRenderer, run, surface };
const inspectorProps: RuntimeInspectorProps = { run, surface, tab: 'tree' };

const runtimeBootstrap = {
  history: [run],
  kind: 'available',
  providerSessionId: 'provider-a',
  status,
  surfaces: [surface],
} satisfies RuntimeBootstrap;

const runtimePlaygroundController = createRuntimePlaygroundController({
  bootstrap: runtimeBootstrap,
  client: {
    bootstrap: async () => runtimeBootstrap,
    createRun: async () => run,
    readRun: async () => run,
    readRunFlight: async () => new Blob(['flight'], { type: 'application/octet-stream' }),
    replayRun: async () => run,
    resetState: async () => state,
  },
  profiles,
});
const runtimePlaygroundProps: RuntimePlaygroundProps = { controller: runtimePlaygroundController };

it('compiles RuntimeClient against the exact provider wire contract', () => {
  const foreground = new ForegroundRouteClient({ fetch: async () => Response.json(statusResponse) });
  const client: RuntimeClient = new RuntimeClient(foreground);
  const bootstrap: Promise<RuntimeBootstrap> = client.bootstrap();
  const error: RuntimeClientError = new RuntimeClientError({ code: 'AB8204', message: 'Generation changed.', phase: 'provider-lifecycle' });
  const runtimeModel: RuntimeModel = createRuntimeModel({ bootstrap: runtimeBootstrap, profiles });
  const requested = reduceRuntimeModel(runtimeModel, { type: 'run.request' });
  const confirmed = reduceRuntimeModel(requested, { type: 'confirmation.confirm' });
  const effect: RuntimePendingEffect | undefined = effectFor(confirmed);

  expect({
    asset,
    appPreviewFixture,
    appPreviewRenderer,
    bootstrap,
    controlledInput,
    error,
    invocation,
    inspectorEvidence,
    inspectorProps,
    McpProtocolEvidence,
    protocolEvidence,
    replay,
    reset,
    runtimeModel,
    runtimePlaygroundController,
    runtimePlaygroundProps,
    runResponse,
    runsResponse,
    stateResponse,
    statusResponse,
    stageProps,
    surfacesResponse,
    effect,
  }).toBeDefined();
});
