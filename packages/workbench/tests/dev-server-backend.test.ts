import { expect, it } from '@rstest/core';

import type { RouteInvocation } from '../../agent-bundle/src/contracts/invocations.ts';
import type { ProjectEventMessage } from '../../agent-bundle/src/contracts/project.ts';
import type { ApplicationLeaf } from '../src/application/application-tree-model.ts';
import { createDevServerBackend } from '../src/application/dev-server-backend.ts';
import { InvocationClient } from '../src/application/invocation-client.ts';
import type { ForegroundRequestAuthority } from '../src/mcp/mcp-route-client.ts';

const invocation = Object.freeze({
  completedAt: '2026-09-05T07:00:01.000Z',
  context: Object.freeze({
    actor: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    host: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    invocation: Object.freeze({ kind: 'workbench' as const }),
    lineage: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    session: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
    workspace: Object.freeze({ reason: 'not-provided' as const, state: 'unavailable' as const }),
  }),
  diagnostics: Object.freeze([]),
  events: Object.freeze([]),
  id: 'invocation-a',
  input: Object.freeze({ title: 'Dune' }),
  kind: 'tool' as const,
  manifestDigest: 'manifest-a',
  projection: Object.freeze({}),
  providers: Object.freeze([]),
  routeId: 'tool:curator/search_audible',
  source: 'src/search.tsx',
  sourceRevision: 'source-a',
  startedAt: '2026-09-05T07:00:00.000Z',
  status: 'succeeded' as const,
  timings: Object.freeze([]),
}) satisfies RouteInvocation;

const summary = ({
  completedAt: invocation.completedAt,
  diagnostics: invocation.diagnostics,
  id: invocation.id,
  input: invocation.input,
  kind: invocation.kind,
  manifestDigest: invocation.manifestDigest,
  routeId: invocation.routeId,
  source: invocation.source,
  sourceRevision: invocation.sourceRevision,
  startedAt: invocation.startedAt,
  status: invocation.status,
  timings: invocation.timings,
});

const leaf = Object.freeze({
  config: Object.freeze([]),
  execution: 'invoke' as const,
  key: '/routes/mcp/curator/tool/search_audible',
  label: 'Search Audible',
  ref: Object.freeze({ kind: 'tool' as const, name: 'search_audible', server: 'curator' }),
  routeId: invocation.routeId,
}) satisfies ApplicationLeaf;

it('delegates invocation reads and filters global history to the selected route', async () => {
  const paths: string[] = [];
  const foreground = {
    protectedRequest: async (path: string, init: RequestInit = {}) => {
      paths.push(path);
      if (path.includes('?limit=')) {
        return Response.json({ invocations: [summary, { ...summary, id: 'other', routeId: 'script:sync' }] });
      }
      return Response.json({ invocation });
    },
  } as ForegroundRequestAuthority;
  const backend = createDevServerBackend({
    client: new InvocationClient({ foreground }),
    events: { subscribe: () => () => undefined },
  });

  expect(backend.accepts(leaf)).toBe(true);
  expect(backend.accepts({ ...leaf, execution: 'document' })).toBe(false);
  await expect(backend.invoke(leaf, { input: invocation.input, routeId: invocation.routeId })).resolves.toEqual(invocation);
  await expect(backend.history(leaf)).resolves.toEqual([summary]);
  await expect(backend.read(invocation.id)).resolves.toEqual(invocation);
  expect(paths).toEqual([
    '/api/routes/invocations',
    '/api/routes/invocations?limit=50',
    '/api/routes/invocations/invocation-a',
  ]);
});

it('forwards only route invocation project events', () => {
  let eventListener: ((event: ProjectEventMessage) => void) | undefined;
  let unsubscribed = false;
  const backend = createDevServerBackend({
    client: new InvocationClient({
      foreground: { protectedRequest: async () => Response.json({ invocation }) } as ForegroundRequestAuthority,
    }),
    events: {
      subscribe: (listener) => {
        eventListener = listener;
        return () => { unsubscribed = true; };
      },
    },
  });
  const received: unknown[] = [];
  const unsubscribe = backend.subscribe((entry) => received.push(entry));

  eventListener?.({ type: 'source.status' } as ProjectEventMessage);
  eventListener?.({
    occurredAt: invocation.completedAt,
    payload: { invocation: summary },
    sequence: 4,
    type: 'route.invocation',
  } as unknown as ProjectEventMessage);
  expect(received).toEqual([summary]);
  unsubscribe();
  expect(unsubscribed).toBe(true);
});
