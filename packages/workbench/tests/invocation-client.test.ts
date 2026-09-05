import { expect, it } from '@rstest/core';

import type { RouteInvocation } from '../../agent-bundle/src/contracts/invocations.ts';
import { InvocationClient, InvocationClientError } from '../src/application/invocation-client.ts';
import type { ForegroundRequestAuthority } from '../src/mcp/mcp-route-client.ts';

const unavailable = () => Object.freeze({
  reason: 'not-provided' as const,
  state: 'unavailable' as const,
});

const invocation = Object.freeze({
  completedAt: '2026-09-05T07:00:01.000Z',
  context: Object.freeze({
    actor: unavailable(),
    host: unavailable(),
    invocation: Object.freeze({ kind: 'workbench' as const, surface: 'search_audible' }),
    lineage: unavailable(),
    session: unavailable(),
    workspace: unavailable(),
  }),
  diagnostics: Object.freeze([]),
  document: Object.freeze({
    root: Object.freeze({
      children: Object.freeze([{ kind: 'text' as const, text: 'Found Dune' }]),
      kind: 'result' as const,
    }),
    status: 'success' as const,
    version: 1 as const,
  }),
  events: Object.freeze([{
    document: Object.freeze({
      root: Object.freeze({ kind: 'text' as const, text: 'Found Dune' }),
      status: 'success' as const,
      version: 1 as const,
    }),
    sequence: 0,
    type: 'complete' as const,
  }]),
  id: 'invocation-a',
  input: Object.freeze({ title: 'Dune' }),
  kind: 'tool' as const,
  manifestDigest: 'manifest-a',
  projection: Object.freeze({ mcp: Object.freeze({ content: Object.freeze([]) }) }),
  providers: Object.freeze([{
    durationMs: 1,
    id: 'catalog',
    name: 'Catalog',
    status: 'mounted' as const,
  }]),
  result: Object.freeze({ count: 1 }),
  routeId: 'tool:curator/search_audible',
  source: 'src/mcp/curator/tools/search_audible.tsx',
  sourceRevision: 'source-a',
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded' as const,
  timings: Object.freeze([{
    durationMs: 1,
    phase: 'render',
    startedAt: '2026-09-05T07:00:00.000Z',
  }]),
}) satisfies RouteInvocation;

const foreground = (handler: (path: string, init: RequestInit) => Response | Promise<Response>): ForegroundRequestAuthority => ({
  protectedRequest: async (path, init = {}) => handler(path, init),
});

it('strictly decodes invoke, list, and read responses', async () => {
  const requests: Array<readonly [string, RequestInit]> = [];
  const client = new InvocationClient({ foreground: foreground((path, init) => {
    requests.push([path, init]);
    return Response.json(path.includes('?limit=')
      ? { invocations: [{ ...invocation, context: undefined, document: undefined, events: undefined, projection: undefined, providers: undefined, result: undefined }] }
      : { invocation });
  }) });

  await expect(client.invoke({ input: { title: 'Dune' }, routeId: invocation.routeId })).resolves.toEqual(invocation);
  await expect(client.list(7)).resolves.toEqual([{
    completedAt: invocation.completedAt,
    diagnostics: [],
    id: invocation.id,
    input: { title: 'Dune' },
    kind: 'tool',
    manifestDigest: 'manifest-a',
    routeId: invocation.routeId,
    source: invocation.source,
    sourceRevision: 'source-a',
    startedAt: invocation.startedAt,
    status: 'succeeded',
    timings: invocation.timings,
  }]);
  await expect(client.read('invocation a')).resolves.toEqual(invocation);
  expect(requests.map(([path]) => path)).toEqual([
    '/api/routes/invocations',
    '/api/routes/invocations?limit=7',
    '/api/routes/invocations/invocation%20a',
  ]);
  expect(requests[0]?.[1]).toMatchObject({
    body: JSON.stringify({ input: { title: 'Dune' }, routeId: invocation.routeId }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
});

it('preserves coded HTTP diagnostics', async () => {
  const client = new InvocationClient({ foreground: foreground(() => Response.json({
    diagnostic: { code: 'AB8232', message: 'No published build.' },
  }, { status: 409 })) });

  await expect(client.invoke({ routeId: invocation.routeId })).rejects.toMatchObject({
    code: 'AB8232',
    message: 'No published build.',
    status: 409,
  });
});

it('rejects malformed success payloads and unsafe invocation ids', async () => {
  const client = new InvocationClient({ foreground: foreground(() => Response.json({
    invocation: { ...invocation, unexpected: true },
  })) });

  await expect(client.invoke({ routeId: invocation.routeId })).rejects.toBeInstanceOf(InvocationClientError);
  await expect(client.invoke({ routeId: invocation.routeId })).rejects.toMatchObject({ code: 'AB8230' });
  await expect(client.read('../other')).rejects.toMatchObject({ code: 'AB8230' });
});
