import { resolve } from 'node:path';

import { expect, it } from '@rstest/core';

import { compileRouteGraph, emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { routeManifestFor, type RouteManifest } from '../src/dev/routes/route-manifest.ts';
import { RouteManifestRoutes, type RouteManifestRouteService } from '../src/dev/routes/route-manifest-routes.ts';
import {
  authorize,
  originHeaders as headers,
  routeError,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';

const revision = 'r'.repeat(64);

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
  const graph = await compileRouteGraph(resolve(import.meta.dirname, '../fixtures/route-harness'), { targets: ['claude'] } as never);
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
  expect(Object.isFrozen(manifest)).toBe(true);
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
