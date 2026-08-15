import { expect, it } from '@rstest/core';

import {
  ProjectClient,
  type EventSourceFactory,
  type EventSourceLike,
} from '../src/project-client.ts';

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
    fetch: async () => response.promise,
  });

  const connecting = client.connect((next) => observed.push(next.artifact.state));
  client.close();
  response.resolve(Response.json({ status: status() }));

  await expect(connecting).resolves.toMatchObject({ artifact: { state: 'active' } });
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
    fetch: async () => Response.json({ status: status() }),
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
    session.resolve(Response.json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', origin: 'http://127.0.0.1:3100', token: 'token-1' }));

    await expect(connecting).resolves.toMatchObject({ artifact: { state: 'active' } });
    expect(requests).toEqual(['/api/project/session', '/api/project/status']);
    expect(stream.listeners).not.toEqual([]);
  } finally {
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: originalEventSource });
  }
});

it('refreshes Overview state after live named events and keeps the browser EventSource transport open', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  let sequence = 0;
  const client = new ProjectClient({
    events: (() => stream) satisfies EventSourceFactory,
    fetch: async (input) => {
      requests.push(String(input));
      sequence += 1;
      return Response.json({ status: status(sequence === 1 ? 'missing' : 'active') });
    },
  });
  const observed: string[] = [];

  await client.connect((next) => observed.push(next.artifact.state));
  stream.emit('artifact.status', {
    data: JSON.stringify({
      occurredAt: '2026-08-14T12:00:00.000Z',
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

it('delivers synchronous runtime events once in FIFO order without refreshing project status', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const errors: unknown[] = [];
  const received: number[] = [];
  const frozen: boolean[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    },
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
  expect(requests).toEqual(['/api/project/status']);

  stream.emit('runtime.event', runtimeEvent(9));
  stream.emit('runtime.event', runtimeEvent(7));
  stream.emit('runtime.event', {
    data: JSON.stringify({ occurredAt: '2026-08-14T12:00:00.000Z', sequence: 11, type: 'runtime.event' }),
    lastEventId: '11',
  });
  await flushEvents();

  expect(received).toEqual([8, 9, 10]);
  expect(errors).toHaveLength(1);
  expect(client.lastEventId).toBe(10);
  expect(requests).toEqual(['/api/project/status']);
});

it('preserves a synchronous runtime event after replay gap delivery', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const received: string[] = [];
  const client = new ProjectClient({
    events: () => stream,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    },
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
    fetch: async () => Response.json({ status: status() }),
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
    fetch: async () => Response.json({ status: status() }),
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
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ status: status() })
          : new Response(JSON.stringify({ diagnostic: { code: 'AB8007', message: 'Request could not be completed.' } }), { status: 500 });
      },
    });

    await client.connect((next) => observed.push(next.artifact.state), (reason) => errors.push(reason));
    stream.emit('artifact.status', {
      data: JSON.stringify({
        occurredAt: '2026-08-14T12:00:00.000Z',
        payload: status().artifact,
        sequence: 7,
        type: 'artifact.status',
      }),
      lastEventId: '7',
    });
    stream.emit('source.changed', {
      data: JSON.stringify({
        occurredAt: '2026-08-14T12:00:00.000Z',
        payload: status().source,
        sequence: 8,
        type: 'source.changed',
      }),
      lastEventId: '8',
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(observed).toEqual(['active']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'Workbench request failed with HTTP 500.' });
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
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
      fetch: async () => {
        requests += 1;
        return requests === 1 ? Response.json({ status: status() }) : response.promise;
      },
    });

    await client.connect(() => undefined, (reason) => errors.push(reason));
    stream.emit('artifact.status', {
      data: JSON.stringify({
        occurredAt: '2026-08-14T12:00:00.000Z',
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
      if (String(input) === '/api/project/session') return Response.json({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', origin: 'http://127.0.0.1:3100', token: 'token-1' });
      return Response.json({ status: status('stale') });
    },
  });

  await expect(client.rebuild(['skills/review/SKILL.md'])).resolves.toMatchObject({ artifact: { state: 'stale' } });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.input).toBe('/api/project/session');
  expect(requests[1]).toMatchObject({ body: '{"paths":["skills/review/SKILL.md"]}', input: '/api/project/rebuild' });
  expect(new Headers(requests[1]?.headers).get('x-agent-bundle-session')).toBe('token-1');
});
