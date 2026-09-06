import { createServer } from 'node:http';
import { once } from 'node:events';

import { expect, it } from '@rstest/core';

import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import {
  emptyRetainedRenderEvents,
  retainedLatestDocument,
  retainedRenderEvents,
  retainRenderEvent,
  routeInvocationRenderHistoryLimits,
} from '../src/dev/routes/route-invocation-render-history.ts';
import { RouteInvocationRoutes, type RouteInvocationRouteService } from '../src/dev/routes/route-invocation-routes.ts';
import {
  RouteInvocationService,
  type RouteInvocationChildRequest,
  type RouteInvocationChildResult,
  type RouteInvocationServiceOptions,
} from '../src/dev/routes/route-invocation-service.ts';
import type { RouteManifest } from '../src/dev/routes/route-manifest.ts';

const echoRoute = {
  config: [],
  id: 'tool:fixture/echo',
  kind: 'tool',
  provenance: { kind: 'conventional' },
  serverId: 'mcp:fixture',
  source: 'src/mcp/fixture/tools/echo.tsx',
} as const;

const manifest: RouteManifest = {
  diagnostics: [],
  digest: 'digest',
  events: [],
  providers: [],
  scripts: [],
  servers: [{ id: 'mcp:fixture', mode: 'generated', name: 'fixture', routes: [echoRoute] }],
  sourceRevision: 'revision',
};

const documentOf = (text: string): AgentDocument => ({ root: { kind: 'text', text }, status: 'success', version: 1 });
const finalDocument = documentOf('final');

/** A shell, then `replace` snapshots, then `complete`; `bytes` pads every snapshot's text. */
const stream = (length: number, bytes = 0): readonly AgentRenderEvent[] => Array.from({ length }, (_, sequence): AgentRenderEvent =>
  sequence === 0
    ? { document: documentOf('shell'), sequence, type: 'shell' }
    : sequence === length - 1
      ? { document: finalDocument, sequence, type: 'complete' }
      : { boundaryId: 'b', document: documentOf(`${String(sequence)}:`.padEnd(bytes, 'x')), sequence, type: 'replace' });

const service = (
  renderChild: NonNullable<RouteInvocationServiceOptions['renderChild']>,
  historyLimit = 2,
): RouteInvocationService => new RouteInvocationService({
  historyLimit,
  manifest: { manifest: () => manifest },
  prepared: async () => ({
    project: {
      manifest: { projectRoot: '/project' } as never,
      stateRoot: '/project/.agent-bundle/state',
      targets: ['claude'],
    },
    release: () => undefined,
  }),
  renderChild,
});

const childResult = (request: RouteInvocationChildRequest): RouteInvocationChildResult => ({
  document: finalDocument,
  input: request.input,
  mcp: {},
  renderDurationMs: 1,
});

const publishing = (events: readonly AgentRenderEvent[]): NonNullable<RouteInvocationServiceOptions['renderChild']> =>
  async (request, _signal, _kernel, publishRender) => {
    for (const event of events) publishRender(event);
    return childResult(request);
  };

it('never evicts the newest event or the pinned document, however large', () => {
  const oversized = stream(4, routeInvocationRenderHistoryLimits.maxBytes);
  let retained = emptyRetainedRenderEvents;
  for (const event of oversized.slice(0, 3)) retained = retainRenderEvent(retained, event).retained;
  expect(retainedRenderEvents(retained)).toEqual([oversized[2]]);
  expect(retained.evictedEvents).toBe(2);

  // A progress event newer than the last snapshot keeps that snapshot pinned beside it.
  const progress: AgentRenderEvent = { completed: 1, sequence: 3, type: 'progress' };
  retained = retainRenderEvent(retained, progress).retained;
  expect(retainedRenderEvents(retained)).toEqual([oversized[2], progress]);
  expect(retainedLatestDocument(retained)).toEqual(documentOf('2:'.padEnd(routeInvocationRenderHistoryLimits.maxBytes, 'x')));
});

it('drops an evicted run\'s replay with its history record', async () => {
  const events = stream(routeInvocationRenderHistoryLimits.maxEvents + 8);
  const invocations = service(publishing(events));
  const first = await invocations.invoke({ correlationId: 'browser-1', input: {}, routeId: echoRoute.id });
  expect(first).toMatchObject({
    correlationId: 'browser-1',
    document: finalDocument,
    outcome: { kind: 'success' },
    retention: { evictedEvents: 8, producedEvents: events.length },
    status: 'succeeded',
  });
  expect(invocations.read(first.id)).toBe(first);

  const second = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  const third = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  expect(invocations.read(first.id)).toBeUndefined();
  expect(() => invocations.subscribe(first.id, () => undefined)).toThrow(/was not found/);
  expect(invocations.list().map((entry) => entry.id)).toEqual([third.id, second.id]);
});

it('serves a full count-bounded replay over the stream route without tripping the live-consumer queue', async () => {
  const events = stream(routeInvocationRenderHistoryLimits.maxEvents * 2);
  const invocations = service(publishing(events));
  const invocation = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  const routes = new RouteInvocationRoutes({
    authorize: () => undefined,
    eventHub: { publish: () => undefined } as never,
    service: invocations as RouteInvocationRouteService,
  });
  const server = createServer((request, response) => void routes.handle(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The test server did not bind a port.');
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/routes/invocations/${invocation.id}/stream`);
    expect(response.status).toBe(200);
    const body = await response.text();
    const types = body.split('\n\n').filter((frame) => frame.startsWith('event: ')).map((frame) => frame.slice('event: '.length, frame.indexOf('\n')));
    expect(types[0]).toBe('truncated');
    expect(types.filter((type) => type === 'render')).toHaveLength(invocation.events.length);
    expect(types.at(-1)).toBe('final');
  } finally {
    server.close();
  }
});
