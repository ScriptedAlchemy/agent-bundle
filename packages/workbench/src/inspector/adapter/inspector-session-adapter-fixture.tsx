import { createRoot } from 'react-dom/client';

import type { McpBrowserSessionModel } from '../../mcp/mcp-session-model.ts';

import { InspectorSessionAdapter } from './inspector-session-adapter-entry.ts';

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
      { kind: 'logging', occurredAt: 1_700_000_000_003, payload: { data: 'Fixture connected', level: 'info' }, sequence: 3 },
    ],
    lastSequence: 3,
  },
} as unknown as McpBrowserSessionModel;

const controller = {
  cancel: () => false,
  invoke: async () => ({ content: [] }),
};

createRoot(document.getElementById('root')!).render(<InspectorSessionAdapter controller={controller} model={model} />);
