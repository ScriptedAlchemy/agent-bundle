/**
 * Shared fixtures for the route workspace tests: application leaves of every
 * execution kind, a canned invocation envelope, a fake `InvocationBackend`
 * that resolves it, and the workspace clients built over a fetch that never
 * runs (server rendering runs no effects).
 */
import type { ProjectStatus } from '../../../agent-bundle/src/contracts/project.ts';
import type { RouteInvocation, RouteInvocationRequest, RouteInvocationSummary } from '../../../agent-bundle/src/contracts/invocations.ts';
import type { ApplicationLeaf, ApplicationTree } from '../../src/application/application-tree-model.ts';
import type { InvocationBackend } from '../../src/application/invocation-backend.ts';
import type { WorkspaceClients } from '../../src/application/workspace-contracts.ts';
import { EvalClient } from '../../src/evals/eval-client.ts';
import { HookClient } from '../../src/hooks/hook-client.ts';
import { LifecycleClient } from '../../src/lifecycles/lifecycle-client.ts';
import { McpAppClient } from '../../src/mcp/mcp-app-client.ts';
import { ForegroundRouteClient, McpRouteClient } from '../../src/mcp/mcp-route-client.ts';
import { ProjectClient } from '../../src/project-client.ts';
import { SkillClient } from '../../src/skill-client.ts';

export const neverFetch: typeof fetch = async () => { throw new Error('Effects do not run during server rendering.'); };

export const toolLeaf: ApplicationLeaf = Object.freeze({
  config: Object.freeze([{ key: 'description', kind: 'string' as const, value: 'Search Audible regions.' }]),
  description: 'Search Audible regions and return ranked identity evidence.',
  execution: 'invoke',
  inputSchema: Object.freeze({
    additionalProperties: false as const,
    properties: Object.freeze({
      author: Object.freeze({ type: 'string' as const }),
      limit: Object.freeze({ default: 5, type: 'number' as const }),
      regions: Object.freeze({ items: Object.freeze({ type: 'string' as const }), type: 'array' as const }),
      title: Object.freeze({ description: 'The title to search for.', type: 'string' as const }),
    }),
    required: Object.freeze(['title']),
    type: 'object' as const,
  }),
  key: '/routes/mcp/curator/tool/search_audible',
  label: 'search_audible',
  ref: Object.freeze({ kind: 'tool' as const, name: 'search_audible', server: 'curator' }),
  routeId: 'tool:curator/search_audible',
  source: 'src/mcp/curator/tools/search_audible.tsx',
});

export const cliLeaf: ApplicationLeaf = Object.freeze({
  command: Object.freeze({
    aliases: Object.freeze([]),
    exitCode: 'zero' as const,
    options: Object.freeze([
      Object.freeze({ key: 'title', kind: 'string' as const, option: 'title', positional: 0, repeated: false, required: true }),
      Object.freeze({ key: 'region', kind: 'string' as const, option: 'region', repeated: true, required: false }),
      Object.freeze({ key: 'verbose', kind: 'boolean' as const, option: 'verbose', repeated: false, required: false }),
    ]),
    path: Object.freeze(['audible', 'search']),
    routeId: 'cli:audible/search',
  }),
  config: Object.freeze([]),
  execution: 'invoke',
  inputSchema: Object.freeze({
    additionalProperties: false as const,
    properties: Object.freeze({
      region: Object.freeze({ items: Object.freeze({ type: 'string' as const }), type: 'array' as const }),
      title: Object.freeze({ type: 'string' as const }),
      verbose: Object.freeze({ type: 'boolean' as const }),
    }),
    required: Object.freeze(['title']),
    type: 'object' as const,
  }),
  key: '/routes/cli/audible/search',
  label: 'audible search',
  ref: Object.freeze({ kind: 'cli' as const, path: Object.freeze(['audible', 'search']) }),
  routeId: 'cli:audible/search',
  source: 'src/cli/audible/search.tsx',
});

export const eventLeaf: ApplicationLeaf = Object.freeze({
  config: Object.freeze([]),
  event: 'tool/before',
  execution: 'invoke',
  key: '/routes/events/tool/before',
  label: 'tool/before',
  ref: Object.freeze({ event: 'tool/before', kind: 'event' as const }),
  routeId: 'event:tool/before',
  source: 'src/events/tool/before.tsx',
});

export const appLeaf: ApplicationLeaf = Object.freeze({
  config: Object.freeze([{ key: 'resourceUri', kind: 'string' as const, value: 'ui://curator/library.html' }]),
  execution: 'preview',
  key: '/routes/mcp/curator/app/library',
  label: 'library',
  ref: Object.freeze({ kind: 'app' as const, name: 'library', server: 'curator' }),
  routeId: 'app:curator/library',
  source: 'src/mcp/curator/apps/library.tsx',
});

export const skillLeaf: ApplicationLeaf = Object.freeze({
  config: Object.freeze([]),
  execution: 'document',
  key: '/routes/skills/skill%3Areview',
  label: 'review',
  ref: Object.freeze({ id: 'skill:review', kind: 'skill' as const }),
  source: 'skills/review/SKILL.md',
});

export const ruleLeaf: ApplicationLeaf = Object.freeze({
  config: Object.freeze([{ key: 'alwaysApply', kind: 'boolean' as const, value: 'true' }]),
  execution: 'document',
  key: '/routes/rules/style',
  label: 'style',
  ref: Object.freeze({ id: 'style', kind: 'rule' as const }),
  source: 'rules/style.md',
});

export const tree: ApplicationTree = Object.freeze({
  diagnostics: Object.freeze([]),
  groups: Object.freeze([]),
  leafCount: 6,
  state: 'current',
});

export const status: ProjectStatus = {
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
};

export const invocation: RouteInvocation = {
  completedAt: '2026-09-05T08:00:00.432Z',
  context: {
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { source: 'derived', state: 'available', value: { name: 'workbench' } },
    invocation: { kind: 'tool', operationId: 'op-1', surface: 'tool:curator/search_audible' },
    lineage: { reason: 'no-shared-runtime', state: 'unavailable' },
    session: { reason: 'not-provided', state: 'unavailable' },
    workspace: { source: 'derived', state: 'available', value: { root: '/home/me/library' } },
  },
  correlationId: 'corr-1',
  diagnostics: [],
  document: {
    root: {
      children: [
        { kind: 'text', text: 'Found 8 candidates for Dune.' },
        { kind: 'markdown', text: '## Rank 1 · score 0.94\n\n**Dune** · Frank Herbert' },
      ],
      kind: 'result',
    },
    status: 'success',
    value: { candidates: 8, query: 'Dune' },
    version: 1,
  },
  events: [
    { document: { root: { children: [{ completed: 0, kind: 'progress', message: 'Searching', total: 2 }], kind: 'result' }, status: 'success', version: 1 }, sequence: 0, type: 'shell' },
    { completed: 1, message: 'Searching us', sequence: 1, total: 2, type: 'progress' },
    {
      document: {
        root: {
          children: [
            { kind: 'text', text: 'Found 8 candidates for Dune.' },
            { kind: 'markdown', text: '## Rank 1 · score 0.94\n\n**Dune** · Frank Herbert' },
          ],
          kind: 'result',
        },
        status: 'success',
        value: { candidates: 8, query: 'Dune' },
        version: 1,
      },
      sequence: 2,
      type: 'complete',
    },
  ],
  id: 'inv-1',
  input: { title: 'Dune' },
  kind: 'tool',
  manifestDigest: 'digest-1',
  projection: {
    mcp: { content: [{ text: 'Found 8 candidates for Dune.', type: 'text' }], structuredContent: { candidates: 8 } },
  },
  providers: [{ durationMs: 2, id: 'provider:library', name: 'library', status: 'mounted' }],
  result: { candidates: 8, query: 'Dune' },
  routeId: 'tool:curator/search_audible',
  source: 'src/mcp/curator/tools/search_audible.tsx',
  sourceRevision: 'rev-1',
  startedAt: '2026-09-05T08:00:00.000Z',
  status: 'succeeded',
  timings: [
    { durationMs: 2, phase: 'providers', startedAt: '2026-09-05T08:00:00.000Z' },
    { durationMs: 400, phase: 'handler', startedAt: '2026-09-05T08:00:00.002Z' },
    { durationMs: 5, phase: 'render', startedAt: '2026-09-05T08:00:00.402Z' },
  ],
};

export const summaryOf = (envelope: RouteInvocation): RouteInvocationSummary => {
  const { context: _context, document: _document, events: _events, projection: _projection, providers: _providers, result: _result, ...summary } = envelope;
  return Object.freeze(summary);
};

export interface FakeBackend extends InvocationBackend {
  readonly requests: RouteInvocationRequest[];
}

/** Resolves every invoke with the canned envelope and remembers the requests it saw. */
export const fakeBackend = (envelope: RouteInvocation = invocation, kind: InvocationBackend['kind'] = 'dev-server'): FakeBackend => {
  const requests: RouteInvocationRequest[] = [];
  return {
    accepts: (leaf) => leaf.execution === 'invoke',
    history: async () => [summaryOf(envelope)],
    invoke: async (_leaf, request) => {
      requests.push(request);
      return { ...envelope, correlationId: request.correlationId };
    },
    kind,
    read: async (id) => ({ ...envelope, id }),
    requests,
    subscribe: () => () => undefined,
  };
};

export const clients = (): WorkspaceClients => {
  const foreground = new ForegroundRouteClient({ fetch: neverFetch });
  return {
    appClient: new McpAppClient({ foreground, projectClient: new ProjectClient({ fetch: neverFetch }) }),
    evalClient: new EvalClient({ foreground }),
    foreground,
    hookClient: new HookClient({ foreground }),
    lifecycleClient: new LifecycleClient({ foreground }),
    mcpRoutes: new McpRouteClient({ fetch: neverFetch, foreground }),
    skillClient: new SkillClient({ fetch: neverFetch }),
  };
};
