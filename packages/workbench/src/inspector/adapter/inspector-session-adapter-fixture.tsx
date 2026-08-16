import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { McpBrowserSessionModel } from '../../mcp/mcp-session-model.ts';
import type { McpSessionControllerRequest } from '../../mcp/mcp-session-controller.ts';

import { InspectorRuntimeEvidence, InspectorSessionAdapter } from './inspector-session-adapter-entry.ts';

const model = {
  activeRequests: {},
  binding: { epochId: 'fixture-epoch', serverName: 'fixture', target: 'codex' },
  catalogs: {
    prompts: [{ description: 'Fixture prompt', name: 'fixture-prompt' }],
    resourceTemplates: [],
    resources: [{ description: 'Fixture resource', mimeType: 'text/plain', name: 'fixture-resource', uri: 'fixture://resource' }],
    tools: [{ description: 'Fixture tool', inputSchema: { properties: {}, type: 'object' }, name: 'fixture-tool' }],
  },
  conciseTrace: [],
  connection: { protocolVersion: '2026-06-01' },
  diagnostics: [],
  logs: [],
  phase: 'ready',
  progress: [],
  sessionId: 'fixture-session',
  timeline: {
    droppedThroughSequence: 0,
    entries: [
      { direction: 'client', kind: 'frame', message: { id: 1, jsonrpc: '2.0', method: 'initialize' }, occurredAt: 1_700_000_000_001, sequence: 1 },
      { direction: 'server', kind: 'frame', message: { id: 1, jsonrpc: '2.0', result: { protocolVersion: '2026-06-01' } }, occurredAt: 1_700_000_000_002, sequence: 2 },
      { direction: 'client', kind: 'frame', message: { id: 2, jsonrpc: '2.0', method: 'tools/call', params: { name: 'fixture-tool' } }, occurredAt: 1_700_000_000_003, sequence: 3 },
      { direction: 'server', kind: 'frame', message: { id: 2, jsonrpc: '2.0', result: { content: [] } }, occurredAt: 1_700_000_000_004, sequence: 4 },
      { kind: 'logging', occurredAt: 1_700_000_000_005, payload: { data: 'Fixture connected', level: 'info' }, sequence: 5 },
    ],
    lastSequence: 5,
  },
} as unknown as McpBrowserSessionModel;

interface FixtureDeferred {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
}

interface InspectorSessionAdapterFixtureHarness {
  readonly resolveNextTool: (text: string) => void;
  readonly setRuntimeBinding: (revision: number, definitionDigest: string) => void;
}

declare global {
  interface Window {
    __inspectorSessionAdapterFixture?: InspectorSessionAdapterFixtureHarness;
  }
}

const deferred = (): FixtureDeferred => {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((next) => { resolve = next; });
  return Object.freeze({ promise, resolve });
};

const runtimeModel = (sessionRevision: number, definitionDigest: string): McpBrowserSessionModel => ({
  ...model,
  binding: {
    binding: {
      definitionDigest,
      registryRevision: 1,
      serverDigest: 'fixture-server-digest',
      serverName: 'fixture',
      sessionId: 'fixture-runtime-session',
      sessionRevision,
      target: 'portable',
      transportDigest: 'fixture-transport-digest',
    },
    kind: 'runtime',
  },
} as McpBrowserSessionModel);

const pendingTools: FixtureDeferred[] = [];

const controller = {
  cancel: () => false,
  invoke: (request: McpSessionControllerRequest): Promise<unknown> => {
    if (request.operation !== 'callTool') return Promise.resolve({ content: [] });
    const next = deferred();
    pendingTools.push(next);
    return next.promise;
  },
};

let currentModel = model;
const root = createRoot(document.getElementById('root')!);

const render = (): void => root.render(<StrictMode>
  <InspectorSessionAdapter controller={controller} model={currentModel} />
  <InspectorRuntimeEvidence evidence={{
    kind: 'trace',
    trace: [
      { id: 'fixture-render', phase: 'rsc-render', startedAt: '2026-08-15T12:00:00.000Z', status: 'succeeded' },
      { id: 'fixture-decode', parentId: 'fixture-render', phase: 'flight-decode', startedAt: '2026-08-15T12:00:01.000Z', status: 'succeeded' },
    ],
  }} />
</StrictMode>);

window.__inspectorSessionAdapterFixture = Object.freeze({
  resolveNextTool: (text: string): void => {
    pendingTools.shift()?.resolve({ content: [{ text, type: 'text' }] });
  },
  setRuntimeBinding: (revision: number, definitionDigest: string): void => {
    currentModel = runtimeModel(revision, definitionDigest);
    render();
  },
} satisfies InspectorSessionAdapterFixtureHarness);

render();
