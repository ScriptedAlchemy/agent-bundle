import { expect, it } from '@rstest/core';

import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import {
  RENDER_EVENT_RETENTION,
  renderEventBytes,
  retainRenderEvents,
  type RouteInvocationStreamMessage,
} from '../src/dev/routes/route-invocation-result.ts';
import {
  RouteInvocationService,
  type RouteInvocationChildRequest,
  type RouteInvocationChildResult,
  type RouteInvocationServiceOptions,
} from '../src/dev/routes/route-invocation-service.ts';
import type { RouteManifest } from '../src/dev/routes/route-manifest.ts';
import { deferred } from './support/eventually.ts';

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

/** A shell, then progress snapshots, then `complete`; `bytes` pads every snapshot's text. */
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

const childResult = (request: RouteInvocationChildRequest, events: readonly AgentRenderEvent[]): RouteInvocationChildResult => ({
  document: finalDocument,
  events,
  input: request.input,
  mcp: {},
  renderDurationMs: 1,
});

const collect = (invocations: RouteInvocationService, id: string): RouteInvocationStreamMessage[] => {
  const messages: RouteInvocationStreamMessage[] = [];
  invocations.subscribe(id, (message) => messages.push(message));
  return messages;
};

const bytesOf = (events: readonly AgentRenderEvent[]): number => events.reduce((sum, event) => sum + renderEventBytes(event), 0);

it('bounds a long stream by count in the replay, the envelope, and history while keeping outcome and correlation', async () => {
  const events = stream(RENDER_EVENT_RETENTION.maxEvents * 4);
  const invocations = service(async (request, _signal, _kernel, publishRender) => {
    for (const event of events) publishRender(event);
    return childResult(request, events);
  });
  const invocation = await invocations.invoke({ correlationId: 'browser-1', input: {}, routeId: echoRoute.id });

  expect(invocation.events).toHaveLength(RENDER_EVENT_RETENTION.maxEvents);
  expect(invocation.evictedEvents).toBe(events.length - RENDER_EVENT_RETENTION.maxEvents);
  expect(invocation.events[0]?.sequence).toBe(invocation.evictedEvents);
  expect(invocation.events.at(-1)).toMatchObject({ sequence: events.length - 1, type: 'complete' });
  expect(invocation).toMatchObject({
    correlationId: 'browser-1',
    document: finalDocument,
    outcome: { kind: 'success' },
    routeId: echoRoute.id,
    status: 'succeeded',
  });
  expect(invocations.read(invocation.id)).toBe(invocation);

  const messages = collect(invocations, invocation.id);
  expect(messages[0]).toEqual({ type: 'truncated' });
  expect(messages.filter((message) => message.type === 'render')).toHaveLength(RENDER_EVENT_RETENTION.maxEvents);
  expect(messages.at(-1)).toMatchObject({ invocation: { evictedEvents: invocation.evictedEvents, id: invocation.id }, type: 'final' });

  const second = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  const third = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  expect(invocations.read(invocation.id)).toBeUndefined();
  expect(() => invocations.subscribe(invocation.id, () => undefined)).toThrow(/was not found/);
  expect(invocations.list().map((entry) => entry.id)).toEqual([third.id, second.id]);
});

it('bounds large intermediate snapshots by bytes without touching the final document', async () => {
  const events = stream(64, 128 * 1024);
  expect(bytesOf(events)).toBeGreaterThan(RENDER_EVENT_RETENTION.maxBytes);
  const invocations = service(async (request, _signal, _kernel, publishRender) => {
    for (const event of events) publishRender(event);
    return childResult(request, events);
  });
  const invocation = await invocations.invoke({ input: {}, routeId: echoRoute.id });

  expect(invocation.events.length).toBeLessThan(events.length);
  expect(bytesOf(invocation.events)).toBeLessThanOrEqual(RENDER_EVENT_RETENTION.maxBytes);
  expect(invocation.evictedEvents).toBe(events.length - invocation.events.length);
  expect(invocation.events.at(-1)).toMatchObject({ sequence: events.length - 1, type: 'complete' });
  expect(invocation.document).toEqual(finalDocument);
  const replayed = collect(invocations, invocation.id);
  expect(replayed[0]).toEqual({ type: 'truncated' });
  expect(replayed.filter((message) => message.type === 'render')).toHaveLength(invocation.events.length);
});

it('never evicts the newest event, however large', () => {
  const oversized = stream(3, RENDER_EVENT_RETENTION.maxBytes);
  const retained = retainRenderEvents(oversized);
  expect(retained.events).toEqual([oversized[2]]);
  expect(retained.evicted).toBe(2);
});

it('reconnects with an explicit replay limitation and cancels with the latest document after the shell was evicted', async () => {
  const rendered = deferred();
  // Shell plus replaces, never completing: the run stays cancellable.
  const events = stream(RENDER_EVENT_RETENTION.maxEvents + 11).slice(0, -1);
  const evicted = events.length - RENDER_EVENT_RETENTION.maxEvents;
  const invocations = service((_request, signal, _kernel, publishRender) => new Promise((_resolve, reject) => {
    for (const event of events) publishRender(event);
    rendered.resolve();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const started = invocations.start({ correlationId: 'browser-2', input: {}, routeId: echoRoute.id });
  const live = collect(invocations, started.invocation.id);
  await rendered.promise;
  expect(live.filter((message) => message.type === 'render')).toHaveLength(events.length);
  expect(live.filter((message) => message.type === 'truncated')).toHaveLength(1);

  const reconnected = collect(invocations, started.invocation.id);
  expect(reconnected[0]).toEqual({ type: 'truncated' });
  expect(reconnected.filter((message) => message.type === 'render')).toHaveLength(RENDER_EVENT_RETENTION.maxEvents);
  expect(reconnected.find((message) => message.type === 'render')).toMatchObject({ event: { sequence: evicted, type: 'replace' } });
  expect(reconnected.some((message) => message.type === 'final')).toBe(false);

  const cancelled = await invocations.cancel(started.invocation.id);
  expect(cancelled).toMatchObject({ correlationId: 'browser-2', evictedEvents: evicted, status: 'cancelled' });
  expect(cancelled).not.toHaveProperty('outcome');
  expect(cancelled.events).toHaveLength(RENDER_EVENT_RETENTION.maxEvents);
  expect(cancelled.document).toEqual(documentOf(`${String(events.length - 1)}:`));
  expect(reconnected.at(-1)).toMatchObject({ invocation: { id: started.invocation.id, status: 'cancelled' }, type: 'final' });
});
