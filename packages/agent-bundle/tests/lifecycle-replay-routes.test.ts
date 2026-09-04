import { expect, it } from '@rstest/core';

import type {
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayDiagnosticResult,
  LifecycleReplayRequest,
} from '../src/contracts/lifecycles.ts';
import {
  LifecycleReplayRoutes,
  type LifecycleReplayRouteService,
} from '../src/dev/playground/lifecycle-replay-routes.ts';
import { LifecycleReplayService } from '../src/dev/playground/lifecycle-replay-service.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';
import {
  authorize,
  originHeaders,
  startRoutes as startRouteServer,
} from './support/route-harness.ts';

const graph = Object.freeze({
  diagnostics: Object.freeze([]),
  digest: 'manifest-a',
  events: Object.freeze([
    {
      config: Object.freeze({}),
      event: 'prompt/submit',
      id: 'event:prompt/submit',
      kind: 'event-route',
      provenance: Object.freeze({ kind: 'conventional', relativePath: 'src/events/prompt/submit.tsx' }),
      source: '/project/src/events/prompt/submit.tsx',
    },
    {
      config: Object.freeze({}),
      event: 'tool/after',
      id: 'event:tool/after',
      kind: 'event-route',
      provenance: Object.freeze({ kind: 'conventional', relativePath: 'src/events/tool/after.tsx' }),
      source: '/project/src/events/tool/after.tsx',
    },
    {
      config: Object.freeze({}),
      event: 'tool/failure',
      id: 'event:tool/failure',
      kind: 'event-route',
      provenance: Object.freeze({ kind: 'conventional', relativePath: 'src/events/tool/failure.tsx' }),
      source: '/project/src/events/tool/failure.tsx',
    },
  ]),
  providers: Object.freeze([]),
  scripts: Object.freeze([]),
  servers: Object.freeze([]),
} satisfies CompiledRouteGraph);

const list: LifecycleListResponse = Object.freeze({
  lifecycles: Object.freeze([]),
  manifestDigest: 'manifest-a',
});

class RecordingService implements LifecycleReplayRouteService {
  result: LifecycleReplay | LifecycleReplayDiagnosticResult = Object.freeze({
    binding: Object.freeze({ manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' }),
    canonical: Object.freeze({
      event: 'tool/after',
      idempotencyKey: 'key',
      observedAt: '2026-09-02T00:00:00.000Z',
      payload: Object.freeze({ toolName: Object.freeze({ nativeKey: 'tool_name', value: 'Write' }) }),
      provenance: Object.freeze({
        host: 'claude',
        hostContractRevision: '2.1.250',
        nativeEvent: 'PostToolUse',
        source: 'native',
      }),
      sequence: 1,
    }),
    events: Object.freeze([]),
    nativeInput: Object.freeze({}),
    requestContext: Object.freeze({
      actor: Object.freeze({ reason: 'not-provided', state: 'unavailable' }),
      host: Object.freeze({
        source: 'receipt',
        state: 'available',
        value: Object.freeze({ name: 'claude' }),
      }),
      invocation: Object.freeze({
        hostContractRevision: '2.1.250',
        kind: 'event',
        operationId: 'event:tool/after',
        surface: 'tool/after',
      }),
      lineage: Object.freeze({ reason: 'not-provided', state: 'unavailable' }),
      session: Object.freeze({ reason: 'not-provided', state: 'unavailable' }),
      workspace: Object.freeze({ reason: 'not-provided', state: 'unavailable' }),
    }),
    source: 'observed',
  });

  list(): LifecycleListResponse {
    return list;
  }

  async replay(_request: LifecycleReplayRequest): Promise<LifecycleReplay | LifecycleReplayDiagnosticResult> {
    return this.result;
  }
}

const startRoutes = async (
  service: LifecycleReplayRouteService,
  responseByteLimit?: number,
) => startRouteServer(new LifecycleReplayRoutes({
  authorize,
  ...(responseByteLimit === undefined ? {} : { responseByteLimit }),
  service,
}), { closeMode: 'awaited' });

const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
  body: JSON.stringify(body),
  headers: { ...originHeaders(), 'content-type': 'application/json' },
  method: 'POST',
});

it('serves the lifecycle wire contract behind the same-session guard', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const unauthorized = await fetch(`${started.url}/api/lifecycles`);
    expect(unauthorized.status).toBe(403);

    const listed = await fetch(`${started.url}/api/lifecycles`, { headers: originHeaders() });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual(list);

    const replayed = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
      native: {},
      source: 'observed',
    });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ replay: service.result });
  } finally {
    await started.close();
  }
});

it('preserves stale and real native-envelope diagnostics at the HTTP boundary', async () => {
  const service = new LifecycleReplayService({
    prepared: () => ({ graph, targets: ['claude'] }),
    render: async () => { throw new Error('render must not run'); },
  });
  const started = await startRoutes(service);
  try {
    const stale = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-old', routeId: 'event:tool/after', target: 'claude' },
      native: {},
      source: 'observed',
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      diagnostic: { code: 'AB8213', message: 'Lifecycle replay manifest binding is stale.' },
    });

    const malformed = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
      native: {
        cwd: '/tmp/lifecycle-replay',
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: {},
        tool_name: 'Write',
        tool_use_id: 'tool-1',
        transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
      },
      source: 'observed',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8211',
        message: 'Agent Bundle event route error: native tool_response is required',
      },
    });

    const malformedPrompt = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:prompt/submit', target: 'claude' },
      native: {
        cwd: '/tmp/lifecycle-replay',
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-1',
        transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
      },
      source: 'observed',
    });
    expect(malformedPrompt.status).toBe(400);
    await expect(malformedPrompt.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8211',
        message: 'Agent Bundle event route error: native prompt must be a string',
      },
    });

    const malformedFailure = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/failure', target: 'claude' },
      native: {
        cwd: '/tmp/lifecycle-replay',
        hook_event_name: 'PostToolUseFailure',
        session_id: 'session-1',
        tool_input: {},
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        transcript_path: '/tmp/lifecycle-replay/transcript.jsonl',
      },
      source: 'observed',
    });
    expect(malformedFailure.status).toBe(400);
    await expect(malformedFailure.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8211',
        message: 'Agent Bundle event route error: native error must be a string',
      },
    });
  } finally {
    await started.close();
  }
});

it('rejects malformed bodies and aggregate replay responses over the named budget', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service, 256);
  try {
    const malformed = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
      native: [],
      source: 'capture',
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8211', message: 'Lifecycle replay request has an invalid shape.' },
    });

    service.result = Object.freeze({
      ...service.result,
      nativeResponse: Object.freeze({ context: 'x'.repeat(512) }),
    }) as LifecycleReplay;
    const oversized = await post(`${started.url}/api/lifecycles/replays`, {
      binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
      native: {},
      source: 'fixture',
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      diagnostic: { code: 'AB8214', message: 'Lifecycle replay exceeds the 16 MiB response limit.' },
    });
  } finally {
    await started.close();
  }
});
