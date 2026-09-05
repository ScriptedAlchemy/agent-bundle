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
  outcome: Object.freeze({ kind: 'success' as const }),
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
  trace: Object.freeze([{
    at: 1,
    execution: Object.freeze({
      event: 'tool/after' as const,
      executionId: 'event-execution-a',
      host: 'claude',
      nativeEvent: 'PostToolUse',
    }),
    kind: 'preflight.start' as const,
    phase: 'preflight' as const,
    sequence: 0,
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
      ? { invocations: [{ ...invocation, context: undefined, document: undefined, events: undefined, projection: undefined, providers: undefined, result: undefined, trace: undefined }] }
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
    outcome: { kind: 'success' },
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

it('decodes unobserved providers without a duration', async () => {
  const unobserved = {
    ...invocation,
    providers: Object.freeze([{
      id: 'catalog',
      name: 'Catalog',
      status: 'unobserved' as const,
    }]),
  } satisfies RouteInvocation;
  const client = new InvocationClient({ foreground: foreground(() => Response.json({ invocation: unobserved })) });

  await expect(client.invoke({ routeId: invocation.routeId })).resolves.toEqual(unobserved);
});

it('decodes represented-error and process-exit outcomes on completed runs', async () => {
  const represented = {
    ...invocation,
    document: { ...invocation.document, status: 'represented-error' as const },
    outcome: Object.freeze({ kind: 'represented-error' as const, summary: '[refused] Refused: policy' }),
    projection: Object.freeze({ mcp: Object.freeze({ content: Object.freeze([]), isError: true }) }),
  } satisfies RouteInvocation;
  const exited = {
    ...invocation,
    kind: 'cli' as const,
    outcome: Object.freeze({ exitCode: 3 as const, kind: 'process-exit' as const }),
    projection: Object.freeze({ cli: Object.freeze({ exitCode: 3, text: 'Exiting 3.' }) }),
  } satisfies RouteInvocation;
  for (const expected of [represented, exited]) {
    const client = new InvocationClient({ foreground: foreground(() => Response.json({ invocation: expected })) });
    await expect(client.invoke({ routeId: invocation.routeId })).resolves.toEqual(expected);
    const summaries = new InvocationClient({ foreground: foreground(() => Response.json({
      invocations: [{ ...expected, context: undefined, document: undefined, events: undefined, projection: undefined, providers: undefined, result: undefined, trace: undefined }],
    })) });
    await expect(summaries.list(1)).resolves.toMatchObject([{ outcome: expected.outcome, status: 'succeeded' }]);
  }
});

it('rejects a completed run without an outcome, a failed run with one, and unknown outcome kinds', async () => {
  const { outcome: _omitted, ...withoutOutcome } = invocation;
  const failedWithOutcome = {
    ...invocation,
    diagnostics: [{ code: 'AB8250', message: 'Render worker exited.' }],
    outcome: { kind: 'success' },
    status: 'failed',
  };
  const unknownKind = { ...invocation, outcome: { kind: 'partial' } };
  for (const payload of [withoutOutcome, failedWithOutcome, unknownKind]) {
    const client = new InvocationClient({ foreground: foreground(() => Response.json({ invocation: payload })) });
    await expect(client.invoke({ routeId: invocation.routeId })).rejects.toMatchObject({ code: 'AB8230' });
    const summaries = new InvocationClient({ foreground: foreground(() => Response.json({
      invocations: [{ ...payload, context: undefined, document: undefined, events: undefined, projection: undefined, providers: undefined, result: undefined, trace: undefined }],
    })) });
    await expect(summaries.list(1)).rejects.toMatchObject({ code: 'AB8230' });
  }
});

it('rejects malformed success payloads and unsafe invocation ids', async () => {
  const client = new InvocationClient({ foreground: foreground(() => Response.json({
    invocation: { ...invocation, unexpected: true },
  })) });

  await expect(client.invoke({ routeId: invocation.routeId })).rejects.toBeInstanceOf(InvocationClientError);
  await expect(client.invoke({ routeId: invocation.routeId })).rejects.toMatchObject({ code: 'AB8230' });
  await expect(client.read('../other')).rejects.toMatchObject({ code: 'AB8230' });
});
