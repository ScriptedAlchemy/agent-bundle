import { expect, it } from '@rstest/core';

import type { AgentRenderEvent } from '@agent-bundle/runtime';

import { MAX_RETAINED_RENDER_EVENTS, type RouteInvocationStreamMessage } from '../src/dev/routes/route-invocation-result.ts';
import {
  RouteInvocationService,
  type RouteInvocationChildRequest,
  type RouteInvocationChildResult,
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

const document = { root: { kind: 'text', text: 'ok' }, status: 'success', version: 1 } as const;
const streamLength = MAX_RETAINED_RENDER_EVENTS * 4;

const longRender = async (
  request: RouteInvocationChildRequest,
  _signal: AbortSignal,
  _publishKernelEvent: unknown,
  publishRender: (event: AgentRenderEvent) => void,
): Promise<RouteInvocationChildResult> => {
  const events: AgentRenderEvent[] = [];
  for (let sequence = 0; sequence < streamLength; sequence += 1) {
    const event: AgentRenderEvent = sequence === streamLength - 1
      ? { document, sequence, type: 'complete' }
      : { document, sequence, type: 'shell' };
    events.push(event);
    publishRender(event);
  }
  return { document, events, input: request.input, mcp: {}, renderDurationMs: 1 };
};

const service = (historyLimit: number): RouteInvocationService => new RouteInvocationService({
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
  renderChild: longRender,
});

it('bounds a long render stream in the live replay and the completed envelope, keeping the outcome and correlation', async () => {
  const invocations = service(2);
  const started = invocations.start({ correlationId: 'browser-1', input: {}, routeId: echoRoute.id });
  const invocation = await started.result;
  const messages: RouteInvocationStreamMessage[] = [];
  invocations.subscribe(invocation.id, (message) => messages.push(message));

  expect(invocation.events).toHaveLength(MAX_RETAINED_RENDER_EVENTS);
  expect(invocation.events[0]?.sequence).toBe(streamLength - MAX_RETAINED_RENDER_EVENTS);
  expect(invocation.events.at(-1)).toMatchObject({ sequence: streamLength - 1, type: 'complete' });
  expect(invocation).toMatchObject({
    correlationId: 'browser-1',
    document,
    outcome: { kind: 'success' },
    routeId: echoRoute.id,
    status: 'succeeded',
  });
  expect(invocations.read(invocation.id)?.events).toHaveLength(MAX_RETAINED_RENDER_EVENTS);

  expect(messages.filter((message) => message.type === 'render')).toHaveLength(MAX_RETAINED_RENDER_EVENTS);
  expect(messages.filter((message) => message.type === 'truncated')).toHaveLength(1);
  const final = messages.at(-1);
  expect(final?.type).toBe('final');
  if (final?.type !== 'final') throw new Error('The stream did not end with the final envelope.');
  expect(final.invocation.events).toHaveLength(MAX_RETAINED_RENDER_EVENTS);
  expect(final.invocation.id).toBe(invocation.id);

  const second = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  const third = await invocations.invoke({ input: {}, routeId: echoRoute.id });
  expect(invocations.read(invocation.id)).toBeUndefined();
  expect(() => invocations.subscribe(invocation.id, () => undefined)).toThrow(/was not found/);
  expect(invocations.list().map((entry) => entry.id)).toEqual([third.id, second.id]);
  expect(invocations.read(second.id)?.events).toHaveLength(MAX_RETAINED_RENDER_EVENTS);
});
