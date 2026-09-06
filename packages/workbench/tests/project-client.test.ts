import { expect, it } from '@rstest/core';

import {
  projectFailureText,
  ProjectClient,
  ProjectClientError,
  type EventSourceFactory,
  type EventSourceLike,
} from '../src/project-client.ts';
import { ArtifactClient } from '../src/artifacts/artifact-client.ts';
import { HookClient } from '../src/hooks/hook-client.ts';
import { LogClient } from '../src/logs/log-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { EvalClient } from '../src/evals/eval-client.ts';
import { withBrowserOrigin } from './support/browser-origin.ts';

interface Listener {
  readonly listener: (event: { readonly data: string; readonly lastEventId: string }) => void;
  readonly type: string;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason: unknown): void;
  resolve(value: Value): void;
}

class RecordingEventSource implements EventSourceLike {
  readonly listeners: Listener[] = [];
  closed = false;

  addEventListener(type: string, listener: Listener['listener']): void {
    this.listeners.push({ listener, type });
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { readonly data: string; readonly lastEventId: string }): void {
    for (const listener of this.listeners.filter((candidate) => candidate.type === type)) listener.listener(event);
  }
}

const status = (state: 'active' | 'missing' | 'stale' = 'active') => ({
  artifact: state === 'missing'
    ? { state }
    : {
        activeEpoch: {
          configDigest: 'config',
          createdAt: '2026-08-14T12:00:00.000Z',
          diagnostics: { errors: 0, infos: 0, warnings: 0 },
          id: 'epoch-1',
          manifestPath: 'agent-bundle.manifest.json',
          modelDigest: 'model',
          projectRevision: 'revision-1',
          targetDigests: { claude: 'claude-digest', codex: 'codex-digest' },
        },
        currentSourceRevision: 'revision-1',
        state,
      },
  build: { state: 'idle' },
  source: { diagnostics: [], revision: 'revision-1', state: 'ready' },
});

const foregroundSession = Object.freeze({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
  instanceId: 'foreground-instance-a',
  origin: 'http://127.0.0.1:3100',
  token: 'foreground-token',
});

const withForegroundSession = (
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => async (input, init) => String(input) === '/api/project/session'
  ? Response.json(foregroundSession)
  : handler(input, init);

const deferred = <Value>(): Deferred<Value> => {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const runtimeEvent = (sequence: number): { readonly data: string; readonly lastEventId: string } => ({
  data: JSON.stringify({
    occurredAt: '2026-08-14T12:00:00.000Z',
    payload: {
      providerSessionId: 'provider-session-1',
      runtimeGenerationId: `generation-${sequence}`,
      type: 'runtime.generation.activated',
    },
    sequence,
    type: 'runtime.event',
  }),
  lastEventId: String(sequence),
});

const flushEvents = async (): Promise<void> => {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
};

/** What the route client says when a contributor dev origin reaches a foreground server that was not started with the flag. */
const noFlagRefusal = 'Origin http://localhost:3000 is not allowed by the foreground server at http://127.0.0.1:3100. '
  + 'Open http://127.0.0.1:3100 instead, or start agent-bundle dev with --workbench-dev-origin http://localhost:3000 to allow this origin.';

it('calls the default browser fetch with its global receiver', async () => {
  const originalFetch = globalThis.fetch;
  const browserFetch = async function (this: typeof globalThis, input: RequestInfo | URL): Promise<Response> {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    expect(String(input)).toBe('/api/project/status');
    return Response.json({ status: status() });
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: browserFetch });
  try {
    await expect(new ProjectClient().refresh()).resolves.toMatchObject({ artifact: { state: 'active' } });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  }
});

it('rejects noncanonical project status envelopes and nested status DTOs', async () => {
  const invalidResponses = [
    { schemaVersion: 1, status: status() },
    { status: { ...status(), version: '1' } },
    {
      status: {
        ...status(),
        source: {
          ...status().source,
          diagnostics: [{ code: 'AB8001', message: 'Invalid source.', severity: 'error', version: '1' }],
        },
      },
    },
    { status: { ...status(), build: { state: 'building' } } },
  ];

  for (const response of invalidResponses) {
    const client = new ProjectClient({ fetch: async () => Response.json(response) });
    await expect(client.refresh()).rejects.toBeInstanceOf(ProjectClientError);
  }
});

it('does not publish initial status or retain an event stream when closed during the initial fetch', async () => {
  const response = deferred<Response>();
  const stream = new RecordingEventSource();
  const observed: string[] = [];
  let eventStreams = 0;
  const client = new ProjectClient({
    events: () => {
      eventStreams += 1;
      return stream;
    },
    fetch: withForegroundSession(async () => response.promise),
  });

  const connecting = client.connect((next) => observed.push(next.artifact.state));
  client.close();
  response.resolve(Response.json({ status: status() }));

  await expect(connecting).rejects.toThrow();
  expect(observed).toEqual([]);
  expect(eventStreams).toBe(0);
  expect(stream.closed).toBe(false);
});

it('closes an event stream constructed concurrently with client shutdown', async () => {
  const stream = new RecordingEventSource();
  const client = new ProjectClient({
    events: () => {
      client.close();
      return stream;
    },
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });

  await expect(client.connect(() => undefined)).resolves.toMatchObject({ artifact: { state: 'active' } });
  expect(stream.closed).toBe(true);
});

it('completes the shared foreground session bootstrap before constructing its sole EventSource', async () => {
  const session = deferred<Response>();
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const originalEventSource = globalThis.EventSource;
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    addEventListener = stream.addEventListener.bind(stream);
    close = stream.close.bind(stream);
  } });
  try {
    const client = new ProjectClient({
    fetch: async (input) => {
      requests.push(String(input));
      return String(input) === '/api/project/session' ? session.promise : Response.json({ status: status() });
    },
    });

    const connecting = client.connect(() => undefined);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(requests).toEqual(['/api/project/session']);
    expect(stream.listeners).toEqual([]);
    session.resolve(Response.json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:3100', token: 'token-1' }));

    await expect(connecting).resolves.toMatchObject({ artifact: { state: 'active' } });
    expect(requests).toEqual(['/api/project/session', '/api/project/status']);
    expect(stream.listeners).not.toEqual([]);
  } finally {
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: originalEventSource });
  }
});

it('bootstraps an injected EventSource factory before status and leaves no stream when closed during bootstrap', async () => {
  const session = deferred<Response>();
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  let streams = 0;
  const client = new ProjectClient({
    events: () => {
      streams += 1;
      return stream;
    },
    fetch: async (input) => {
      requests.push(String(input));
      return String(input) === '/api/project/session' ? session.promise : Response.json({ status: status() });
    },
  });
  const connecting = client.connect(() => undefined);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  expect(requests).toEqual(['/api/project/session']);
  expect(streams).toBe(0);
  session.resolve(Response.json(foregroundSession));
  await expect(connecting).resolves.toMatchObject({ artifact: { state: 'active' } });
  expect(requests).toEqual(['/api/project/session', '/api/project/status']);
  expect(streams).toBe(1);

  const pending = deferred<Response>();
  let lateStreams = 0;
  const closed = new ProjectClient({
    events: () => {
      lateStreams += 1;
      return new RecordingEventSource();
    },
    fetch: async (input) => String(input) === '/api/project/session' ? pending.promise : Response.json({ status: status() }),
  });
  const closing = closed.connect(() => undefined);
  closed.close();
  pending.resolve(Response.json(foregroundSession));
  await expect(closing).rejects.toThrow();
  expect(lateStreams).toBe(0);
});

it('refreshes Overview state after live named events and keeps the browser EventSource transport open', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  let sequence = 0;
  const client = new ProjectClient({
    events: (() => stream) satisfies EventSourceFactory,
    fetch: withForegroundSession(async (input) => {
      requests.push(String(input));
      sequence += 1;
      return Response.json({ status: status(sequence === 1 ? 'missing' : 'active') });
    }),
  });
  const observed: string[] = [];

  await client.connect((next) => observed.push(next.artifact.state));
  stream.emit('artifact.status', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: status('active').artifact,
      sequence: 7,
      type: 'artifact.status',
    }),
    lastEventId: '7',
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  expect(observed).toEqual(['missing', 'active']);
  expect(requests).toEqual(['/api/project/status', '/api/project/status']);
  expect(client.lastEventId).toBe(7);
  expect(stream.closed).toBe(false);
  client.close();
  expect(stream.closed).toBe(true);
});

it('drains the old instance before adopting a recovered foreground and opening a fresh event stream', async () => {
  const firstStream = new RecordingEventSource();
  const secondStream = new RecordingEventSource();
  const streams = [firstStream, secondStream];
  const errors: unknown[] = [];
  const connections: string[] = [];
  const releaseBarrier = deferred<void>();
  let sessionRequests = 0;
  let statusRequests = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        sessionRequests += 1;
        return Response.json({
          cookieName: `agent-bundle-foreground-session-${sessionRequests === 1 ? 'a'.repeat(32) : 'b'.repeat(32)}`,
          instanceId: `foreground-instance-${sessionRequests === 1 ? 'a' : 'b'}`,
          origin: 'http://127.0.0.1:3100',
          token: `token-${sessionRequests === 1 ? 'a' : 'b'}`,
        });
      }
      statusRequests += 1;
      return Response.json({ status: status() });
    },
  });
  const client = new ProjectClient({
    beforeInstanceChange: async () => releaseBarrier.promise,
    events: () => streams.shift()!,
    foreground,
    retryDelay: async () => undefined,
  });
  client.onConnection((connection) => connections.push(`${connection.state}:${connection.instanceId ?? 'none'}`));

  await client.connect(
    () => undefined,
    (reason) => errors.push(reason),
  );
  firstStream.emit('error', { data: '', lastEventId: '' });
  await flushEvents();
  expect(firstStream.closed).toBe(true);
  expect(sessionRequests).toBe(2);
  expect(statusRequests).toBe(1);
  expect(connections.at(-1)).toBe('unavailable:foreground-instance-a');

  releaseBarrier.resolve();
  await flushEvents();
  await flushEvents();
  secondStream.emit('open', { data: '', lastEventId: '' });
  await flushEvents();

  expect(errors).toHaveLength(1);
  expect(statusRequests).toBe(3);
  expect(connections.at(-1)).toBe('connected:foreground-instance-b');

  client.close();
  expect(secondStream.closed).toBe(true);
});

it('seeds a same-instance replacement event stream from the last acknowledged cursor', async () => {
  const firstStream = new RecordingEventSource();
  const secondStream = new RecordingEventSource();
  const streams = [firstStream, secondStream];
  const eventUrls: string[] = [];
  let sessionRequests = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        sessionRequests += 1;
        return Response.json({
          ...foregroundSession,
          token: `foreground-token-${String(sessionRequests)}`,
        });
      }
      return Response.json({ status: status() });
    },
  });
  const client = new ProjectClient({
    events: (url) => {
      eventUrls.push(url);
      return streams.shift()!;
    },
    foreground,
    retryDelay: async () => undefined,
  });

  await client.connect(() => undefined);
  firstStream.emit('runtime.event', runtimeEvent(7));
  await flushEvents();
  expect(client.lastEventId).toBe(7);

  firstStream.emit('error', { data: '', lastEventId: '' });
  await flushEvents();
  await flushEvents();

  expect(eventUrls).toEqual(['/api/project/events', '/api/project/events?after=7']);
  client.close();
});

it('reports and retries a failed initial foreground bootstrap', async () => {
  const stream = new RecordingEventSource();
  const connections: string[] = [];
  const errors: unknown[] = [];
  let sessionRequests = 0;
  let streams = 0;
  const client = new ProjectClient({
    events: () => {
      streams += 1;
      return stream;
    },
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        sessionRequests += 1;
        return sessionRequests === 1
          ? Response.json({ code: 'AB8019', message: 'Foreground unavailable.' }, { status: 503 })
          : Response.json(foregroundSession);
      }
      return Response.json({ status: status() });
    },
    retryDelay: async () => undefined,
  });
  client.onConnection((connection) => connections.push(`${connection.state}:${connection.instanceId ?? 'none'}`));

  await expect(client.connect(() => undefined, (reason) => errors.push(reason))).rejects.toBeInstanceOf(ProjectClientError);
  await flushEvents();
  await flushEvents();

  expect(errors).toHaveLength(1);
  expect(connections).toContain('unavailable:none');
  expect(sessionRequests).toBe(2);
  expect(streams).toBe(1);
  stream.emit('open', { data: '', lastEventId: '' });
  await flushEvents();
  expect(connections.at(-1)).toBe('connected:foreground-instance-a');
  client.close();
});

it('retries recovery when the replacement stream status probe fails', async () => {
  const firstStream = new RecordingEventSource();
  const secondStream = new RecordingEventSource();
  const thirdStream = new RecordingEventSource();
  const streams = [firstStream, secondStream, thirdStream];
  const connections: string[] = [];
  const errors: unknown[] = [];
  let sessionRequests = 0;
  let statusRequests = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        sessionRequests += 1;
        return Response.json({ ...foregroundSession, token: `foreground-token-${String(sessionRequests)}` });
      }
      statusRequests += 1;
      return statusRequests === 3
        ? Response.json({ code: 'AB8019', message: 'Status unavailable.' }, { status: 503 })
        : Response.json({ status: status() });
    },
  });
  const client = new ProjectClient({
    events: () => streams.shift()!,
    foreground,
    retryDelay: async () => undefined,
  });
  client.onConnection((connection) => connections.push(`${connection.state}:${connection.instanceId ?? 'none'}`));

  await client.connect(() => undefined, (reason) => errors.push(reason));
  firstStream.emit('error', { data: '', lastEventId: '' });
  await flushEvents();
  await flushEvents();
  secondStream.emit('open', { data: '', lastEventId: '' });
  await flushEvents();
  await flushEvents();

  expect(secondStream.closed).toBe(true);
  expect(streams).toHaveLength(0);
  expect(connections).toContain('unavailable:foreground-instance-a');
  expect(connections.at(-1)).toBe('connecting:foreground-instance-a');
  expect(errors).toHaveLength(2);
  thirdStream.emit('open', { data: '', lastEventId: '' });
  await flushEvents();
  expect(connections.at(-1)).toBe('connected:foreground-instance-a');
  expect(statusRequests).toBe(5);
  client.close();
});

it('delivers synchronous runtime events once in FIFO order and refreshes after an unexplained sequence gap', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const errors: unknown[] = [];
  const received: number[] = [];
  const frozen: boolean[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    }),
  });

  await client.connect(
    () => undefined,
    (reason) => errors.push(reason),
    (event) => {
      if (event.type !== 'runtime.event') return;
      received.push(event.sequence);
      frozen.push(Object.isFrozen(event) && Object.isFrozen(event.payload));
    },
  );
  stream.emit('runtime.event', runtimeEvent(8));
  stream.emit('runtime.event', runtimeEvent(9));
  stream.emit('runtime.event', runtimeEvent(10));
  await flushEvents();

  expect(received).toEqual([8, 9, 10]);
  expect(frozen).toEqual([true, true, true]);
  expect(client.lastEventId).toBe(10);
  expect(requests).toEqual(['/api/project/status', '/api/project/status']);

  stream.emit('runtime.event', runtimeEvent(9));
  stream.emit('runtime.event', runtimeEvent(7));
  stream.emit('runtime.event', {
    data: JSON.stringify({ occurredAt: '2026-08-14T12:00:00.000Z', sequence: 11, type: 'runtime.event' }),
    lastEventId: '11',
  });
  await flushEvents();

  expect(received).toEqual([8, 9, 10]);
  expect(errors).toHaveLength(1);
  expect(client.lastEventId).toBe(11);
  expect(requests).toEqual(['/api/project/status', '/api/project/status', '/api/project/status']);
});

it('delivers route.invocation events to subscribers without refreshing project status', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const received: string[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    }),
  });
  await client.connect(() => undefined, undefined, (event) => received.push(`legacy:${event.type}`));
  client.subscribeEvents((event) => {
    if (event.type !== 'route.invocation') return;
    received.push(`${event.type}:${String(event.sequence)}:${event.payload.invocation.id}:${String(Object.isFrozen(event.payload.invocation))}`);
  });
  expect(stream.listeners.some((listener) => listener.type === 'route.invocation')).toBe(true);

  const invocation = (sequence: number): { readonly data: string; readonly lastEventId: string } => ({
    data: JSON.stringify({
      occurredAt: '2026-09-05T07:00:01.000Z',
      payload: {
        invocation: {
          completedAt: '2026-09-05T07:00:01.000Z',
          correlationId: 'corr-1',
          diagnostics: [],
          id: `inv_${String(sequence)}`,
          input: {},
          kind: 'tool',
          manifestDigest: 'a'.repeat(64),
          routeId: 'tool:curator/search',
          source: 'src/mcp/curator/tools/search.tsx',
          sourceRevision: 'r',
          startedAt: '2026-09-05T07:00:00.000Z',
          status: 'succeeded',
          timings: [],
        },
      },
      sequence,
      type: 'route.invocation',
    }),
    lastEventId: String(sequence),
  });
  stream.emit('route.invocation', invocation(1));
  stream.emit('route.invocation', invocation(2));
  await flushEvents();

  expect(received).toEqual([
    'legacy:route.invocation', 'route.invocation:1:inv_1:true',
    'legacy:route.invocation', 'route.invocation:2:inv_2:true',
  ]);
  expect(client.lastEventId).toBe(2);
  expect(requests).toEqual(['/api/project/status']);
  client.close();
});

it('preserves a synchronous runtime event after replay gap delivery', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const received: string[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    }),
  });

  await client.connect(
    () => undefined,
    undefined,
    (event) => received.push(event.type === 'replay.gap' ? event.type : `${event.type}:${event.sequence}`),
  );
  stream.emit('replay.gap', {
    data: JSON.stringify({
      earliestAvailableSequence: 14,
      latestDroppedSequence: 13,
      requestedAfterSequence: 10,
      type: 'replay.gap',
    }),
    lastEventId: '',
  });
  stream.emit('runtime.event', runtimeEvent(14));
  await flushEvents();

  expect(received).toEqual(['replay.gap', 'runtime.event:14']);
  expect(client.lastEventId).toBe(14);
  expect(requests).toEqual(['/api/project/status', '/api/project/status']);
});

it('reports a runtime listener exception and still delivers later queued runtime events', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  const received: number[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });

  await client.connect(
    () => undefined,
    (reason) => errors.push(reason),
    (event) => {
      if (event.type !== 'runtime.event') return;
      received.push(event.sequence);
      if (event.sequence === 8) throw new Error('listener failure');
    },
  );
  stream.emit('runtime.event', runtimeEvent(8));
  stream.emit('runtime.event', runtimeEvent(9));
  await flushEvents();

  expect(received).toEqual([8, 9]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ message: 'listener failure' });
  expect(client.lastEventId).toBe(9);
});

it('clears queued runtime delivery and ignores late callbacks after close', async () => {
  const stream = new RecordingEventSource();
  const received: number[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });

  await client.connect(
    () => undefined,
    undefined,
    (event) => {
      if (event.type === 'runtime.event') received.push(event.sequence);
    },
  );
  stream.emit('runtime.event', runtimeEvent(8));
  client.close();
  stream.emit('runtime.event', runtimeEvent(9));
  await flushEvents();

  expect(received).toEqual([]);
  expect(client.lastEventId).toBe(0);
  expect(stream.closed).toBe(true);
});

it('rejects project SSE records whose payload and EventSource sequence identities do not match', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });
  await client.connect(() => undefined, (reason) => errors.push(reason));
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: { occurredAt: '2026-08-16T12:00:00.000Z', paths: ['src/kept.ts'], reason: 'source-change' },
      sequence: 7,
      type: 'source.changed',
    }),
    lastEventId: '7',
  });
  stream.emit('artifact.status', {
    data: JSON.stringify({ occurredAt: '2026-08-16T12:01:00.000Z', payload: status().artifact, type: 'artifact.status' }),
    lastEventId: '8',
  });
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:01:00.000Z',
      payload: { occurredAt: '2026-08-16T12:01:00.000Z', paths: ['src/missing-id.ts'], reason: 'source-change' },
      sequence: 9,
      type: 'source.changed',
    }),
    lastEventId: '',
  });
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:02:00.000Z',
      payload: { occurredAt: '2026-08-16T12:02:00.000Z', paths: ['src/mismatch.ts'], reason: 'source-change' },
      sequence: 12,
      type: 'source.changed',
    }),
    lastEventId: '11',
  });
  stream.emit('artifact.status', {
    data: JSON.stringify({ occurredAt: '2026-08-16T12:04:00.000Z', payload: status().artifact, sequence: 13.5, type: 'artifact.status' }),
    lastEventId: '13',
  });
  await flushEvents();

  expect(client.activity.changedFiles).toEqual(['src/kept.ts']);
  expect(client.lastEventId).toBe(13);
  expect(errors).toHaveLength(4);
});

it('rejects versioned, extra, and malformed SSE project event messages', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const errors: unknown[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    }),
  });
  await client.connect(() => undefined, (reason) => errors.push(reason));

  for (const [lastEventId, data] of [
    ['7', {
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: { occurredAt: '2026-08-16T12:00:00.000Z', paths: ['src/versioned.ts'], reason: 'source-change' },
      schemaVersion: 1,
      sequence: 7,
      type: 'source.changed',
    }],
    ['8', {
      occurredAt: '2026-08-16T12:01:00.000Z',
      payload: { occurredAt: '2026-08-16T12:01:00.000Z', paths: ['src/aliased.ts'], reason: 'source-change' },
      sequence: 8,
      type: 'source.changed',
      version: '1',
    }],
    ['9', {
      occurredAt: '2026-08-16T12:02:00.000Z',
      payload: { occurredAt: '2026-08-16T12:02:00.000Z', paths: ['src/extra.ts'], reason: 'source-change', version: '1' },
      sequence: 9,
      type: 'source.changed',
    }],
    ['10', {
      occurredAt: '2026-08-16T12:03:00.000Z',
      payload: { occurredAt: '2026-08-16T12:03:00.000Z', paths: [10], reason: 'source-change' },
      sequence: 10,
      type: 'source.changed',
    }],
  ] as const) {
    stream.emit('source.changed', { data: JSON.stringify(data), lastEventId });
  }

  await flushEvents();
  expect(client.lastEventId).toBe(10);
  expect(client.activity.changedFiles).toEqual([]);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.every((path) => path === '/api/project/status')).toBe(true);
  expect(errors).toHaveLength(4);
});

it('captures the latest valid source-change paths in an immutable browser activity snapshot', async () => {
  const stream = new RecordingEventSource();
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });

  const observed: Array<readonly string[]> = [];
  const unsubscribe = client.onActivity((activity) => observed.push(activity.changedFiles));
  await client.connect(() => undefined);
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: {
        occurredAt: '2026-08-16T12:00:00.000Z',
        paths: ['src/z.ts', 'src/a.ts', 'src/a.ts'],
        reason: 'source-change',
      },
      sequence: 12,
      type: 'source.changed',
    }),
    lastEventId: '12',
  });
  await flushEvents();

  const activity = client.activity;
  expect(activity.changedFiles).toEqual(['src/a.ts', 'src/z.ts']);
  expect(observed).toEqual([['src/a.ts', 'src/z.ts']]);
  expect(Object.isFrozen(activity)).toBe(true);
  expect(Object.isFrozen(activity.changedFiles)).toBe(true);
  expect(() => (activity.changedFiles as string[]).push('src/other.ts')).toThrow(TypeError);
  unsubscribe();
});

it('replaces changed-file activity only when a higher valid source-change sequence arrives', async () => {
  const stream = new RecordingEventSource();
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });
  await client.connect(() => undefined);

  for (const [sequence, paths] of [[18, ['src/old.ts']], [20, ['src/new.ts']], [19, ['src/stale.ts']]] as const) {
    stream.emit('source.changed', {
      data: JSON.stringify({
        occurredAt: `2026-08-16T12:00:${sequence}.000Z`,
        payload: {
          occurredAt: `2026-08-16T12:00:${sequence}.000Z`,
          paths,
          reason: 'source-change',
        },
        sequence,
        type: 'source.changed',
      }),
      lastEventId: String(sequence),
    });
  }
  await flushEvents();

  expect(client.activity.changedFiles).toEqual(['src/new.ts']);
  expect(client.lastEventId).toBe(20);
});

it('retains the latest changed-file activity when a source-change envelope is malformed', async () => {
  const stream = new RecordingEventSource();
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });
  await client.connect(() => undefined);
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: {
        occurredAt: '2026-08-16T12:00:00.000Z',
        paths: ['src/kept.ts'],
        reason: 'source-change',
      },
      sequence: 22,
      type: 'source.changed',
    }),
    lastEventId: '22',
  });
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:01:00.000Z',
      payload: { occurredAt: '2026-08-16T12:01:00.000Z', paths: ['src/lost.ts'], reason: 'manual-change' },
      sequence: 23,
      type: 'source.changed',
    }),
    lastEventId: '23',
  });
  await flushEvents();

  expect(client.activity.changedFiles).toEqual(['src/kept.ts']);
});

it('retains activity across a failed event refresh and ignores post-close event delivery', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  let requests = 0;
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ status: status() })
        : new Response(null, { status: 500 });
      }),
  });
  await client.connect(() => undefined, (reason) => errors.push(reason));
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: {
        occurredAt: '2026-08-16T12:00:00.000Z',
        paths: ['src/persisted.ts'],
        reason: 'source-change',
      },
      sequence: 24,
      type: 'source.changed',
    }),
    lastEventId: '24',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  client.close();
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:01:00.000Z',
      payload: {
        occurredAt: '2026-08-16T12:01:00.000Z',
        paths: ['src/ignored.ts'],
        reason: 'source-change',
      },
      sequence: 25,
      type: 'source.changed',
    }),
    lastEventId: '25',
  });

  expect(errors).toHaveLength(1);
  expect(client.activity.changedFiles).toEqual(['src/persisted.ts']);
});

it('reports one failed event refresh without an unhandled rejection and retains the last status', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  const observed: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let requests = 0;
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = new ProjectClient({
      events: () => stream,
      fetch: withForegroundSession(async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ status: status() })
          : new Response(JSON.stringify({ diagnostic: { code: 'AB8007', message: 'Request could not be completed.' } }), { status: 500 });
      }),
    });

    await client.connect((next) => observed.push(next.artifact.state), (reason) => errors.push(reason));
    stream.emit('artifact.status', {
      data: JSON.stringify({
        occurredAt: '2026-08-16T12:00:00.000Z',
        payload: status().artifact,
        sequence: 7,
        type: 'artifact.status',
      }),
      lastEventId: '7',
    });
    stream.emit('source.changed', {
      data: JSON.stringify({
        occurredAt: '2026-08-16T12:00:01.000Z',
        payload: { occurredAt: '2026-08-16T12:00:01.000Z', paths: [], reason: 'source-change' },
        sequence: 8,
        type: 'source.changed',
      }),
      lastEventId: '8',
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(observed).toEqual(['active']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'AB8007', message: 'Request could not be completed.', status: 500 });
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it('does not report a successful rebuild as a recovered foreground refresh', async () => {
  const stream = new RecordingEventSource();
  const rebuildResponse = deferred<Response>();
  const errors: unknown[] = [];
  const statuses: string[] = [];
  let statusRequests = 0;
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async (input) => {
      const route = String(input);
      if (route === '/api/project/rebuild') return rebuildResponse.promise;
      if (route === '/api/project/status') {
        statusRequests += 1;
        return statusRequests === 1
          ? Response.json({ status: status() })
          : new Response(null, { status: 500 });
      }
      throw new Error(`Unexpected project route ${JSON.stringify(route)}.`);
    }),
  });
  await client.connect(() => statuses.push('status'), (reason) => errors.push(reason));
  const rebuilding = client.rebuild();
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: { occurredAt: '2026-08-16T12:00:00.000Z', paths: ['src/rebuilt.ts'], reason: 'source-change' },
      sequence: 26,
      type: 'source.changed',
    }),
    lastEventId: '26',
  });
  await flushEvents();
  expect(errors).toHaveLength(1);
  expect(statuses).toEqual(['status']);

  rebuildResponse.resolve(Response.json({ status: status('stale') }));
  await expect(rebuilding).resolves.toMatchObject({ artifact: { state: 'stale' } });
  expect(statuses).toEqual(['status']);
  client.close();
});

it('suppresses a late event-refresh error after close', async () => {
  const stream = new RecordingEventSource();
  const response = deferred<Response>();
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let requests = 0;
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = new ProjectClient({
      events: () => stream,
      fetch: withForegroundSession(async () => {
        requests += 1;
        return requests === 1 ? Response.json({ status: status() }) : response.promise;
      }),
    });

    await client.connect(() => undefined, (reason) => errors.push(reason));
    stream.emit('artifact.status', {
      data: JSON.stringify({
        occurredAt: '2026-08-16T12:00:00.000Z',
        payload: status().artifact,
        sequence: 7,
        type: 'artifact.status',
      }),
      lastEventId: '7',
    });
    client.close();
    response.resolve(new Response(null, { status: 500 }));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it('bootstraps a same-session token before posting an explicit rebuild through the shared typed route', async () => {
  const requests: Array<{ readonly body?: string; readonly headers?: HeadersInit; readonly input: string }> = [];
  const client = new ProjectClient({
    fetch: async (input, init) => {
      requests.push({ body: init?.body?.toString(), headers: init?.headers, input: String(input) });
      if (String(input) === '/api/project/session') return Response.json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:3100', token: 'token-1' });
      return Response.json({ status: status('stale') });
    },
  });

  await expect(client.rebuild(['src/skills/review/SKILL.md'])).resolves.toMatchObject({ artifact: { state: 'stale' } });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.input).toBe('/api/project/session');
  expect(requests[1]).toMatchObject({ body: '{"paths":["src/skills/review/SKILL.md"]}', input: '/api/project/rebuild' });
  expect(new Headers(requests[1]?.headers).get('x-agent-bundle-session')).toBe('token-1');
});

it('delivers subscribed replay and live events FIFO, exposing gaps before refresh without blocking peers', async () => {
  const stream = new RecordingEventSource();
  const received: string[] = [];
  const errors: unknown[] = [];
  const statuses: string[] = [];
  let streamCount = 0;
  let statusRequests = 0;
  const client = new ProjectClient({
    events: () => {
      streamCount += 1;
      return stream;
    },
    fetch: withForegroundSession(async () => {
      statusRequests += 1;
      return Response.json({ status: status() });
    }),
  });
  const subscribed = client as ProjectClient & {
    subscribeEvents(listener: (event: { readonly sequence?: number; readonly type: string }) => void): () => void;
  };
  const eventName = (event: { readonly sequence?: number; readonly type: string }): string =>
    event.type === 'replay.gap' ? `gap:${event.sequence ?? 'none'}` : `${event.type}:${event.sequence}`;

  subscribed.subscribeEvents((event) => received.push(`first:${eventName(event)}`));
  subscribed.subscribeEvents((event) => {
    if (event.type === 'runtime.event' && event.sequence === 1) throw new Error('subscriber failure');
  });
  subscribed.subscribeEvents((event) => received.push(`third:${eventName(event)}`));
  await client.connect(
    () => statuses.push('status'),
    (error) => errors.push(error),
    (event) => received.push(`legacy:${eventName(event)}`),
  );
  received.length = 0;
  statuses.length = 0;

  stream.emit('runtime.event', runtimeEvent(1));
  stream.emit('runtime.event', runtimeEvent(3));
  stream.emit('runtime.event', runtimeEvent(3));
  await flushEvents();

  expect(received).toEqual([
    'legacy:runtime.event:1', 'first:runtime.event:1', 'third:runtime.event:1',
    'legacy:gap:none', 'first:gap:none', 'third:gap:none',
    'legacy:runtime.event:3', 'first:runtime.event:3', 'third:runtime.event:3',
  ]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ message: 'subscriber failure' });
  expect(statuses).toEqual(['status']);
  expect(statusRequests).toBe(2);
  expect(streamCount).toBe(1);
  expect(client.lastEventId).toBe(3);
});

it('advances its replay cursor, unsubscribes snapshot listeners, and blocks late event delivery after close', async () => {
  const stream = new RecordingEventSource();
  const received: string[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: withForegroundSession(async () => Response.json({ status: status() })),
  });
  const subscribed = client as ProjectClient & {
    subscribeEvents(listener: (event: { readonly sequence?: number; readonly type: string }) => void): () => void;
  };
  const unsubscribe = subscribed.subscribeEvents((event) => received.push(event.type === 'replay.gap' ? 'gap' : `${event.type}:${event.sequence}`));
  await client.connect(() => undefined);

  stream.emit('replay.gap', {
    data: JSON.stringify({
      earliestAvailableSequence: 4,
      latestDroppedSequence: 3,
      requestedAfterSequence: 0,
      type: 'replay.gap',
    }),
    lastEventId: '',
  });
  stream.emit('runtime.event', runtimeEvent(3));
  stream.emit('runtime.event', runtimeEvent(4));
  await flushEvents();
  unsubscribe();
  stream.emit('runtime.event', runtimeEvent(5));
  await flushEvents();
  client.close();
  stream.emit('runtime.event', runtimeEvent(6));
  await flushEvents();

  expect(received).toEqual(['gap', 'runtime.event:4']);
  expect(client.lastEventId).toBe(5);
  expect(stream.closed).toBe(true);
});

it('shares one foreground bootstrap and EventSource across project, artifact, hook, eval, and log requests', async () => {
  const stream = new RecordingEventSource();
  let eventSources = 0;
  let sessionBootstraps = 0;
  const protectedTokens: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === '/api/project/session') {
      sessionBootstraps += 1;
      return Response.json(foregroundSession);
    }
    protectedTokens.push(new Headers(init?.headers).get('x-agent-bundle-session') ?? '');
    if (path === '/api/project/status') return Response.json({ status: status() });
    if (path.startsWith('/api/artifacts/diff?')) {
      return Response.json({ diff: { added: [], baseEpochId: 'epoch-1', candidateEpochId: 'epoch-2', changed: [], removed: [], unchanged: [] } });
    }
    if (path.startsWith('/api/hooks?')) return Response.json({ hooks: [] });
    if (path === '/api/logs/replay?after=0') {
      return Response.json({ replay: { cursor: { afterSequence: 0 }, records: [] } });
    }
    if (path === '/api/evals/runs') return Response.json({ runs: [] });
    throw new Error(`Unexpected foreground route ${path}`);
  };
  const foreground = new ForegroundRouteClient({ fetch });
  const project = new ProjectClient({
    events: () => { eventSources += 1; return stream; },
    foreground,
  });
  const artifact = new ArtifactClient({ foreground });
  const hooks = new HookClient({ foreground });
  const logs = new LogClient({ foreground });
  const evals = new EvalClient({ foreground });

  await Promise.all([
    project.connect(() => undefined),
    artifact.diff('epoch-1', 'epoch-2'),
    hooks.list({ epochId: 'epoch-1' }),
    logs.replay(),
    evals.runs(),
  ]);

  expect(sessionBootstraps).toBe(1);
  expect(eventSources).toBe(1);
  expect(protectedTokens.filter((token) => token === 'foreground-token')).toHaveLength(4);
  expect(protectedTokens.filter((token) => token === '')).toHaveLength(1);
});

it('invalidates every shared foreground admission when ProjectClient closes during the held bootstrap', async () => {
  const session = deferred<Response>();
  const stream = new RecordingEventSource();
  let eventSources = 0;
  let protectedRequests = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    if (String(input) === '/api/project/session') return session.promise;
    protectedRequests += 1;
    return Response.json({ status: status() });
  };
  const foreground = new ForegroundRouteClient({ fetch });
  const project = new ProjectClient({
    events: () => { eventSources += 1; return stream; },
    foreground,
  });
  const artifact = new ArtifactClient({ foreground });
  const hooks = new HookClient({ foreground });
  const logs = new LogClient({ foreground });
  const evals = new EvalClient({ foreground });

  const operations = [
    project.connect(() => undefined),
    artifact.diff('epoch-1', 'epoch-2'),
    hooks.list({ epochId: 'epoch-1' }),
    logs.replay(),
    evals.runs(),
  ];
  await new Promise<void>((resolve) => setImmediate(resolve));
  project.close();
  foreground.forgetAuthentication();
  session.resolve(Response.json(foregroundSession));

  const settled = await Promise.allSettled(operations);
  expect(settled).toHaveLength(5);
  for (const result of settled) {
    expect(result).toMatchObject({ reason: { code: 'AB8019' }, status: 'rejected' });
  }
  expect(protectedRequests).toBe(0);
  expect(eventSources).toBe(0);
  expect(stream.closed).toBe(false);
});

it('surfaces the client-side refusal of an HTTP 200 bootstrap with its code and message but no status', async () => {
  await withBrowserOrigin('http://localhost:3000', async () => {
    const errors: unknown[] = [];
    const client = new ProjectClient({
      events: () => new RecordingEventSource(),
      fetch: withForegroundSession(async () => Response.json({ status: status() })),
      retryDelay: () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise)),
    });
    try {
      const rejection: unknown = await client.connect(() => undefined, (reason) => errors.push(reason))
        .then(() => undefined, (reason: unknown) => reason);

      expect(rejection).toBeInstanceOf(ProjectClientError);
      if (!(rejection instanceof ProjectClientError)) return;
      expect(rejection.code).toBe('AB8003');
      expect(rejection.status).toBeUndefined();
      expect(rejection.message).toBe(noFlagRefusal);
      expect(errors).toEqual([rejection]);
      expect(client.connection.state).toBe('unavailable');
    } finally {
      client.close();
    }
  });
});

it('rejects a refused rebuild with the foreground diagnostic code, message, and HTTP status', async () => {
  const client = new ProjectClient({
    events: () => new RecordingEventSource(),
    fetch: withForegroundSession(async (input) => String(input) === '/api/project/rebuild'
      ? Response.json({ diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' } }, { status: 403 })
      : Response.json({ status: status() })),
  });
  try {
    await client.connect(() => undefined);
    const rejection: unknown = await client.rebuild().then(() => undefined, (reason: unknown) => reason);

    expect(rejection).toBeInstanceOf(ProjectClientError);
    if (!(rejection instanceof ProjectClientError)) return;
    expect(rejection.code).toBe('AB8003');
    expect(rejection.status).toBe(403);
    expect(rejection.message).toBe('Request origin is not this foreground server.');
    expect(projectFailureText(rejection, 'Rebuild request could not be completed.'))
      .toBe('AB8003 — Request origin is not this foreground server. (HTTP 403)');
  } finally {
    client.close();
  }
});

it('reports a refused session bootstrap during recovered-source refresh as a ProjectClientError with code and status', async () => {
  const firstStream = new RecordingEventSource();
  const secondStream = new RecordingEventSource();
  const thirdStream = new RecordingEventSource();
  const streams = [firstStream, secondStream, thirdStream];
  const errors: unknown[] = [];
  let sessionRequests = 0;
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      if (String(input) !== '/api/project/session') return Response.json({ status: status() });
      sessionRequests += 1;
      return sessionRequests === 3
        ? Response.json({ diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' } }, { status: 403 })
        : Response.json(foregroundSession);
    },
  });
  const client = new ProjectClient({
    events: () => streams.shift()!,
    foreground,
    retryDelay: () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise)),
  });
  try {
    await client.connect(() => undefined, (reason) => errors.push(reason));
    firstStream.emit('error', { data: '', lastEventId: '' });
    await flushEvents();
    await flushEvents();
    expect(errors).toHaveLength(1);
    expect(sessionRequests).toBe(2);

    // The recovered stream opens while the session is forgotten, so the status
    // read succeeds and the snapshot re-bootstrap is what the foreground refuses.
    foreground.forgetAuthentication();
    secondStream.emit('open', { data: '', lastEventId: '' });
    await flushEvents();
    await flushEvents();

    expect(sessionRequests).toBeGreaterThanOrEqual(3);
    const refusal = errors[1];
    expect(refusal).toBeInstanceOf(ProjectClientError);
    if (!(refusal instanceof ProjectClientError)) return;
    expect(refusal.code).toBe('AB8003');
    expect(refusal.status).toBe(403);
    expect(refusal.message).toBe('Request origin is not this foreground server.');
  } finally {
    client.close();
  }
});

it('carries no HTTP status for a session the client itself invalidated mid-bootstrap', async () => {
  const session = deferred<Response>();
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => String(input) === '/api/project/session' ? session.promise : Response.json({ status: status() }),
  });
  const client = new ProjectClient({ events: () => new RecordingEventSource(), foreground, retryDelay: async () => undefined });
  try {
    const connecting = client.connect(() => undefined);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    client.close();
    foreground.forgetAuthentication();
    session.resolve(Response.json(foregroundSession));
    const rejection: unknown = await connecting.then(() => undefined, (reason: unknown) => reason);

    expect(rejection).toBeInstanceOf(ProjectClientError);
    if (!(rejection instanceof ProjectClientError)) return;
    expect(rejection.code).toBe('AB8019');
    expect(rejection.status).toBeUndefined();
    expect(projectFailureText(rejection, 'fallback')).toBe(`AB8019 — ${rejection.message}`);
  } finally {
    client.close();
  }
});

it('reports a recovery attempt the foreground keeps refusing once, then the line that replaces it', async () => {
  const firstStream = new RecordingEventSource();
  const secondStream = new RecordingEventSource();
  const streams = [firstStream, secondStream];
  const errors: unknown[] = [];
  const fourthSession = deferred<void>();
  let sessionRequests = 0;
  const client = new ProjectClient({
    events: () => streams.shift()!,
    fetch: async (input) => {
      if (String(input) !== '/api/project/session') return Response.json({ status: status() });
      sessionRequests += 1;
      if (sessionRequests === 4) fourthSession.resolve();
      return sessionRequests === 2 || sessionRequests === 3
        ? Response.json({ diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' } }, { status: 403 })
        : Response.json(foregroundSession);
    },
    retryDelay: () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise)),
  });
  try {
    await client.connect(() => undefined, (reason) => errors.push(reason));
    firstStream.emit('error', { data: '', lastEventId: '' });
    await fourthSession.promise;
    await flushEvents();

    // Two identical refusals produce one report after the disconnect line; the
    // successful fourth bootstrap ends recovery without a further report.
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ message: 'Foreground project event stream disconnected.' });
    expect(errors[1]).toBeInstanceOf(ProjectClientError);
    expect(errors[1]).toMatchObject({ code: 'AB8003', message: 'Request origin is not this foreground server.', status: 403 });
    expect(client.connection.state).toBe('connecting');

    secondStream.emit('open', { data: '', lastEventId: '' });
    await flushEvents();
    expect(client.connection.state).toBe('connected');
    expect(errors).toHaveLength(2);
  } finally {
    client.close();
  }
});

it('formats a project client failure as its code, message, and HTTP status, omitting the parts it lacks', () => {
  expect(projectFailureText(new ProjectClientError('Request origin is not this foreground server.', 'AB8003', 403), 'fallback'))
    .toBe('AB8003 — Request origin is not this foreground server. (HTTP 403)');
  expect(projectFailureText(new ProjectClientError(noFlagRefusal, 'AB8003'), 'fallback')).toBe(`AB8003 — ${noFlagRefusal}`);
  expect(projectFailureText(new ProjectClientError('Foreground project event stream disconnected.'), 'fallback'))
    .toBe('Foreground project event stream disconnected.');
  expect(projectFailureText(new Error('x'), 'fallback')).toBe('x');
  expect(projectFailureText({ get message(): string { throw new Error('hostile'); } }, 'fallback')).toBe('fallback');
  expect(projectFailureText(Object.defineProperty(new Error('x'), 'message', { get(): string { throw new Error('hostile'); } }), 'fallback'))
    .toBe('fallback');
  expect(projectFailureText('not an error', 'fallback')).toBe('fallback');
  expect(projectFailureText(undefined, 'fallback')).toBe('fallback');
});
