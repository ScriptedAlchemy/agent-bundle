import { resolve } from 'node:path';

import { expect, it } from '@rstest/core';

import { compileRouteGraph, emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { routeManifestFor, type RouteManifest } from '../src/dev/routes/route-manifest.ts';
import { RouteManifestRoutes, type RouteManifestRouteService } from '../src/dev/routes/route-manifest-routes.ts';
import type { NormalizedStateDefinition } from '../src/core/types.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import {
  authorize,
  originHeaders as headers,
  routeError,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';

const revision = 'r'.repeat(64);

const stateDefinition = (
  budgets?: NormalizedStateDefinition['budgets'],
  lifetime: NormalizedStateDefinition['lifetime'] = 'workspace-durable',
): NormalizedStateDefinition => ({
  ...(budgets === undefined ? {} : { budgets }),
  id: 'fixture/catalog-state',
  lifetime,
  provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
  source: '/project/src/state.ts',
});

class RecordingService implements RouteManifestRouteService {
  readonly calls: string[] = [];
  failure: Error | undefined;
  value: RouteManifest = routeManifestFor(emptyCompiledRouteGraph, revision);

  manifest(): RouteManifest {
    this.calls.push('manifest');
    if (this.failure !== undefined) throw this.failure;
    return this.value;
  }
}

const startRoutes = async (service?: RouteManifestRouteService): Promise<StartedRoutes<RouteManifestRoutes>> =>
  startRouteServer(new RouteManifestRoutes({
    authorize,
    ...(service === undefined ? {} : { service }),
  }), { closeMode: 'awaited' });

it('serves the compiled manifest without recompiling the graph', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const read = await fetch(`${started.url}/api/routes/manifest`, { headers: headers() });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      manifest: {
        diagnostics: [],
        digest: emptyCompiledRouteGraph.digest,
        events: [],
        providers: [],
        scripts: [],
        servers: [],
        sourceRevision: revision,
      },
    });
    expect(service.calls).toEqual(['manifest']);
  } finally {
    await started.close();
  }
});

it('serves the normalized state catalog on the manifest wire', async () => {
  const service = new RecordingService();
  service.value = routeManifestFor(
    emptyCompiledRouteGraph,
    revision,
    stateDefinition({ declared: { maxStateBytes: 2_048 } }),
  );
  const started = await startRoutes(service);

  try {
    const read = await fetch(`${started.url}/api/routes/manifest`, { headers: headers() });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      manifest: {
        state: {
          budgets: {
            resolved: {
              maxCommitMs: 5_000,
              maxEventBytes: 262_144,
              maxRevisions: 100_000,
              maxStateBytes: 2_048,
            },
            source: 'declared',
          },
          driver: 'sqlite',
          durableLocation: '$AGENT_BUNDLE_PLUGIN_ROOT/state (falls back to the artifact root or ./.agent-bundle/state for CLI bins)',
          id: 'fixture/catalog-state',
          lifetime: 'workspace-durable',
          noticeRetention: {
            resolved: { maxJournalBytes: 16_777_216, maxTerminal: 500, terminalTtlMs: 604_800_000 },
            source: 'defaults',
          },
          notices: [
            expect.stringContaining('@agent-bundle/runtime/agent-notice-ledger/v1'),
            expect.stringContaining('Notice retention'),
          ],
          source: 'src/state.ts',
        },
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects invalid manifest paths, queries, and methods', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    for (const path of ['/api/routes', '/api/routes/', '/api/routes/manifest/extra', '/api/routes/unknown']) {
      const rejected = await fetch(`${started.url}${path}`, { headers: headers() });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8120', message: 'Route manifest path is not valid.' },
      });
    }

    const query = await fetch(`${started.url}/api/routes/manifest?focus=cli`, { headers: headers() });
    expect(query.status).toBe(400);
    await expect(query.json()).resolves.toEqual({
      diagnostic: { code: 'AB8122', message: 'Route manifest request has an invalid shape.' },
    });

    const post = await fetch(`${started.url}/api/routes/manifest`, { headers: headers(), method: 'POST' });
    expect(post.status).toBe(405);
    await expect(post.json()).resolves.toEqual({
      diagnostic: { code: 'AB8007', message: 'Route does not accept this method.' },
    });

    const unrelated = await fetch(`${started.url}/api/other`, { headers: headers() });
    expect(unrelated.status).toBe(404);

    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('requires the same-session guard before reading the manifest', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const unauthorized = await fetch(`${started.url}/api/routes/manifest`, {
      headers: { origin: 'http://127.0.0.1:4567' },
    });
    expect(unauthorized.status).toBe(403);
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('reports an absent, unprepared, or closed manifest without leaking internals', async () => {
  const absent = await startRoutes();
  try {
    const unavailable = await fetch(`${absent.url}/api/routes/manifest`, { headers: headers() });
    expect(unavailable.status).toBe(404);
    await expect(unavailable.json()).resolves.toEqual({
      diagnostic: { code: 'AB8121', message: 'Route manifest is not available.' },
    });
  } finally {
    await absent.close();
  }

  const service = new RecordingService();
  service.failure = new Error('/private/project/path has no valid prepared project');
  const started = await startRoutes(service);
  try {
    const unprepared = await fetch(`${started.url}/api/routes/manifest`, { headers: headers() });
    expect(unprepared.status).toBe(409);
    await expect(unprepared.json()).resolves.toEqual({
      diagnostic: { code: 'AB8121', message: 'Route manifest is not available.' },
    });

    started.routes.close();
    const closed = await fetch(`${started.url}/api/routes/manifest`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8121', message: 'Route manifest is not available.' },
    });
  } finally {
    await started.close();
  }
});

it('preserves a request diagnostic raised by the manifest service', async () => {
  const service = new RecordingService();
  service.failure = routeError('AB8004', 'A valid same-session token is required.', 403);
  const started = await startRoutes(service);

  try {
    const refused = await fetch(`${started.url}/api/routes/manifest`, { headers: headers() });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });
  } finally {
    await started.close();
  }
});

it('projects a compiled graph into the browser manifest with project-relative sources', async () => {
  const graph = await compileRouteGraph(resolve(import.meta.dirname, '../fixtures/route-harness'), {
    routes: { mcpCommands: { include: ['harness:echo'] } },
    targets: ['claude'],
  } as never);
  const manifest = routeManifestFor(graph, revision);

  expect(manifest.digest).toBe(graph.digest);
  expect(manifest.sourceRevision).toBe(revision);
  expect(manifest.servers.map((server) => server.id)).toEqual(graph.servers.map((server) => server.id));
  const routes = [...manifest.events, ...manifest.scripts, ...manifest.servers.flatMap((server) => server.routes)];
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(route.source.startsWith('/')).toBe(false);
    expect(route.provenance).toEqual({ kind: 'conventional' });
  }
  expect(manifest.cli?.commands).toContainEqual(expect.objectContaining({
    mcp: { confirm: false, server: 'harness', tool: 'echo' },
    routeId: 'tool:harness/echo',
  }));
  expect(Object.isFrozen(manifest)).toBe(true);
});

it('projects declared, default, and dynamic state budgets without fabricating absent state', () => {
  const declared = routeManifestFor(
    emptyCompiledRouteGraph,
    revision,
    stateDefinition({ declared: { maxCommitMs: 25 } }, 'process'),
  );
  expect(declared.state).toMatchObject({
    budgets: {
      resolved: {
        maxCommitMs: 25,
        maxEventBytes: 262_144,
        maxRevisions: 100_000,
        maxStateBytes: 1_048_576,
      },
      source: 'declared',
    },
    driver: 'memory',
    id: 'fixture/catalog-state',
    lifetime: 'process',
    source: 'src/state.ts',
  });
  expect(declared.state).not.toHaveProperty('durableLocation');

  const defaults = routeManifestFor(
    emptyCompiledRouteGraph,
    revision,
    stateDefinition(undefined, 'request'),
  );
  expect(defaults.state?.budgets).toEqual({
    resolved: {
      maxCommitMs: 5_000,
      maxEventBytes: 262_144,
      maxRevisions: 100_000,
      maxStateBytes: 1_048_576,
    },
    source: 'defaults',
  });

  const dynamic = routeManifestFor(
    emptyCompiledRouteGraph,
    revision,
    stateDefinition('dynamic'),
  );
  expect(dynamic.state?.budgets).toEqual({ source: 'dynamic' });

  const absent = routeManifestFor(emptyCompiledRouteGraph, revision);
  expect(absent).not.toHaveProperty('state');
});

it('passes the bounded input schema through as the optional manifest wire field', () => {
  const inputSchema = Object.freeze({
    additionalProperties: false as const,
    properties: Object.freeze({
      root: Object.freeze({ description: 'Project root.', type: 'string' as const }),
    }),
    required: Object.freeze(['root']),
    type: 'object' as const,
  });
  const graph: CompiledRouteGraph = {
    ...emptyCompiledRouteGraph,
    digest: 's'.repeat(64),
    scripts: [{
      config: {},
      id: 'script:inspect',
      inputSchema,
      kind: 'script',
      provenance: { kind: 'conventional', relativePath: 'src/scripts/inspect.ts' },
      source: '/project/src/scripts/inspect.ts',
    }],
  };

  const manifest = routeManifestFor(graph, revision);

  expect(manifest.scripts[0]?.inputSchema).toEqual(inputSchema);
  expect(Object.isFrozen(manifest.scripts[0]?.inputSchema)).toBe(true);
});

it('projects shared route contracts and omits them from contract-free graphs', () => {
  const input = Object.freeze({
    additionalProperties: false as const,
    properties: Object.freeze({
      statuses: Object.freeze({
        items: Object.freeze({ enum: Object.freeze(['queued', 'running']), type: 'string' as const }),
        type: 'array' as const,
      }),
    }),
    type: 'object' as const,
  });
  const contractId = 'contract:src/lib/protocol-schemas.ts#statusInputSchema';
  const cliRoute = {
    config: {},
    contract: contractId,
    id: 'cli:status',
    inputSchema: input,
    kind: 'cli' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/cli/status.ts' },
    source: '/project/src/cli/status.ts',
  };
  const toolRoute = {
    config: {},
    contract: contractId,
    id: 'tool:hauler/hauler_status',
    inputSchema: input,
    kind: 'tool' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/mcp/hauler/tools/hauler_status.ts' },
    serverId: 'mcp:hauler',
    source: '/project/src/mcp/hauler/tools/hauler_status.ts',
  };
  const graph: CompiledRouteGraph = {
    ...emptyCompiledRouteGraph,
    cli: { mode: 'generated', routes: [cliRoute] },
    contracts: [{
      id: contractId,
      input,
      origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
      routes: ['cli:status', 'tool:hauler/hauler_status'],
    }],
    digest: 'c'.repeat(64),
    servers: [{
      id: 'mcp:hauler',
      mode: 'generated',
      name: 'hauler',
      routes: [toolRoute],
    }],
  };

  const manifest = routeManifestFor(graph, revision);

  expect(manifest.contracts).toEqual([{
    id: contractId,
    input,
    origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
    routes: ['cli:status', 'tool:hauler/hauler_status'],
  }]);
  expect(manifest.cli?.routes[0]?.contract).toBe(contractId);
  expect(manifest.servers[0]?.routes[0]?.contract).toBe(contractId);
  expect(Object.isFrozen(manifest.contracts)).toBe(true);
  expect(routeManifestFor(emptyCompiledRouteGraph, revision)).not.toHaveProperty('contracts');
});

it('summarizes an extracted route config without leaking non-scalar shapes', async () => {
  const graph = await compileRouteGraph(resolve(import.meta.dirname, '../fixtures/route-harness'), { targets: ['claude'] } as never);
  const manifest = routeManifestFor(graph, revision);
  const summarized = manifest.servers.flatMap((server) => server.routes).flatMap((route) => route.config);

  expect(summarized.length).toBeGreaterThan(0);
  for (const field of summarized) {
    expect(typeof field.value).toBe('string');
    if (field.kind === 'object') expect(field.value).toMatch(/^\d+ (?:key|keys)$/u);
    if (field.kind === 'array') expect(field.value).toMatch(/^\d+ (?:entry|entries)$/u);
  }
});
