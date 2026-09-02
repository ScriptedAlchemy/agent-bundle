import { expect, it } from '@rstest/core';

import type { AgentRouteModule } from '../src/test/types.ts';
import { LifecycleReplayService } from '../src/dev/playground/lifecycle-replay-service.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import type { RenderRouteContext } from '../src/test/render.ts';

const graph = Object.freeze({
  diagnostics: Object.freeze([]),
  digest: 'manifest-a',
  events: Object.freeze([{
    config: Object.freeze({}),
    event: 'tool/after',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: Object.freeze({ kind: 'conventional', relativePath: 'src/events/tool/after.tsx' }),
    source: '/project/src/events/tool/after.tsx',
  }]),
  providers: Object.freeze([]),
  scripts: Object.freeze([]),
  servers: Object.freeze([]),
} satisfies CompiledRouteGraph);

const service = (): LifecycleReplayService => new LifecycleReplayService({
  prepared: () => ({
    graph,
    targets: ['plugin', 'cursor', 'portable'],
  }),
  loadRouteModule: async () => ({ default: async () => undefined }) as AgentRouteModule,
  render: async () => {
    throw new Error('render must not run in validation tests');
  },
});

it('projects event routes across concrete hosts and diagnoses excluded targets', () => {
  const listed = service().list();

  expect(listed.manifestDigest).toBe('manifest-a');
  expect(listed.lifecycles).toHaveLength(1);
  expect(listed.lifecycles[0]).toMatchObject({
    event: 'tool/after',
    routeId: 'event:tool/after',
    routePath: 'src/events/tool/after.tsx',
    targets: [
      { nativeEvent: 'PostToolUse', target: 'claude' },
      { nativeEvent: 'PostToolUse', target: 'codex' },
      { nativeEvent: 'postToolUse', target: 'cursor' },
    ],
  });
  expect(listed.lifecycles[0]?.targets.every((target) => target.target !== 'plugin')).toBe(true);
  expect(listed.lifecycles[0]?.diagnostics).toContainEqual({
    code: 'lifecycle.target.unsupported',
    message: 'Lifecycle replay target "portable" cannot map canonical event "tool/after".',
    severity: 'error',
    target: 'portable',
  });
});

it('fails closed before loading a route when the manifest binding is stale', async () => {
  await expect(service().replay({
    binding: { manifestDigest: 'manifest-old', routeId: 'event:tool/after', target: 'claude' },
    native: {},
    source: 'observed',
  })).rejects.toMatchObject({
    code: 'AB8213',
    message: 'Lifecycle replay manifest binding is stale.',
    status: 409,
  });
});

it('surfaces the real native envelope validator message as a malformed request', async () => {
  await expect(service().replay({
    binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
    native: {
      cwd: '/tmp/lifecycle-replay',
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      tool_input: {},
      tool_name: 'Write',
      tool_response: 'invalid',
      tool_use_id: 'tool-1',
      transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
    },
    source: 'observed',
  })).rejects.toMatchObject({
    code: 'AB8211',
    message: 'Agent Bundle event route error: native tool_response must be an object',
    status: 400,
  });
});

it('mounts and reports honest receipt provenance for a Workbench replay', async () => {
  let renderedContext: RenderRouteContext | undefined;
  const replayService = new LifecycleReplayService({
    prepared: () => ({
      graph,
      targets: ['claude'],
    }),
    loadRouteModule: async () => ({ default: async () => undefined }) as AgentRouteModule,
    render: async (_target, options = {}) => {
      renderedContext = options.context;
      return {
        document: {
          root: { children: [], kind: 'result' },
          status: 'success',
          version: 1,
        },
        events: [],
      } as never;
    },
  });

  const result = await replayService.replay({
    binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
    native: {
      cwd: '/tmp/lifecycle-replay',
      hook_event_name: 'PostToolUse',
      session_id: 'session-1',
      tool_input: { file_path: 'README.md' },
      tool_name: 'Write',
      tool_response: { success: true },
      tool_use_id: 'tool-1',
      transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
    },
    source: 'observed',
  });
  if ('diagnostics' in result) throw new Error('Expected a lifecycle replay.');

  const requestContext = {
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { source: 'receipt', state: 'available', value: { name: 'claude' } },
    invocation: {
      hostContractRevision: '2.1.250',
      kind: 'event',
      operationId: 'event:tool/after',
      surface: 'tool/after',
    },
    session: { source: 'receipt', state: 'available', value: { sessionId: 'session-1' } },
    workspace: { source: 'receipt', state: 'available', value: { root: '/tmp/lifecycle-replay' } },
  };
  expect(result.requestContext).toEqual(requestContext);
  expect(renderedContext).toEqual({
    actor: requestContext.actor,
    host: requestContext.host,
    invocation: { hostContractRevision: '2.1.250' },
    session: requestContext.session,
    workspace: requestContext.workspace,
  });
});
