import { expect, it } from '@rstest/core';

import {
  ProjectClient,
  ProjectClientError,
  type ProjectClientOptions,
  type EventSourceFactory,
  type EventSourceLike,
} from '../src/project-client.ts';
import { ForegroundSessionAuthority } from '../src/foreground-session.ts';

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

const foregroundAuthority = (): ForegroundSessionAuthority => new ForegroundSessionAuthority({
  fetch: async () => Response.json({
    instanceId: 'foreground-instance-a',
    origin: 'http://foreground.test',
    token: 'foreground-token',
  }),
});

const projectClient = (options: ProjectClientOptions = {}): ProjectClient => new ProjectClient({
  authority: foregroundAuthority(),
  ...options,
});

it('calls the default browser fetch with its global receiver', async () => {
  const originalFetch = globalThis.fetch;
  const browserFetch = async function (this: typeof globalThis, input: RequestInfo | URL): Promise<Response> {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    expect(String(input)).toBe('/api/project/status');
    return Response.json({ status: status() });
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: browserFetch });
  try {
    await expect(projectClient().refresh()).resolves.toMatchObject({ artifact: { state: 'active' } });
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
    const client = projectClient({ fetch: async () => Response.json(response) });
    await expect(client.refresh()).rejects.toBeInstanceOf(ProjectClientError);
  }
});

it('does not publish initial status or retain an event stream when closed during the initial fetch', async () => {
  const response = deferred<Response>();
  const stream = new RecordingEventSource();
  const observed: string[] = [];
  let eventStreams = 0;
  const client = projectClient({
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
  const client = projectClient({
    events: () => {
      client.close();
      return stream;
    },
    fetch: async () => Response.json({ status: status() }),
  });

  await expect(client.connect(() => undefined)).resolves.toMatchObject({ artifact: { state: 'active' } });
  expect(stream.closed).toBe(true);
});

it('refreshes Overview state after live named events and keeps the browser EventSource transport open', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  let sequence = 0;
  const client = projectClient({
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
    data: JSON.stringify({ occurredAt: '2026-08-16T12:00:00.000Z', payload: status('active').artifact, sequence: 7, type: 'artifact.status' }),
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

it('reports an EventSource outage and clears it after reconnection refreshes project status', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  let connection: 'connected' | 'unavailable' = 'connected';
  let requests = 0;
  const client = projectClient({
    events: () => stream,
    fetch: async () => {
      requests += 1;
      return Response.json({ status: status() });
    },
  });

  await client.connect(
    () => { connection = 'connected'; },
    (reason) => {
      errors.push(reason);
      connection = 'unavailable';
    },
  );
  stream.emit('error', { data: '', lastEventId: '' });

  expect(connection).toBe('unavailable');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ message: 'Foreground project event stream disconnected.' });

  stream.emit('open', { data: '', lastEventId: '' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(connection).toBe('connected');
  expect(requests).toBe(2);
});

it('recovers a replaced foreground authority through a new event source without accepting stale source callbacks', async () => {
  const streams: RecordingEventSource[] = [];
  const sessions = [
    { instanceId: 'foreground-a', origin: 'http://foreground.test', token: 'token-a' },
    { instanceId: 'foreground-b', origin: 'http://foreground.test', token: 'token-b' },
  ];
  const authority = new ForegroundSessionAuthority({
    fetch: async () => Response.json(sessions.shift()),
  });
  const errors: unknown[] = [];
  const observed: string[] = [];
  const client = new ProjectClient({
    authority,
    events: () => {
      const stream = new RecordingEventSource();
      streams.push(stream);
      return stream;
    },
    fetch: async () => Response.json({ status: status() }),
  });

  await client.connect((next) => observed.push(next.artifact.state), (reason) => errors.push(reason));
  const first = streams[0];
  if (first === undefined) throw new Error('Expected the initial foreground event source.');
  first.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:00:00.000Z',
      payload: { occurredAt: '2026-08-16T12:00:00.000Z', paths: ['src/stale.ts'], reason: 'source-change' },
      sequence: 999,
      type: 'source.changed',
    }),
    lastEventId: '999',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  first.emit('error', { data: '', lastEventId: '' });

  expect(first.closed).toBe(true);
  expect(errors).toHaveLength(1);
  expect(client.connection).toEqual({ generation: 0, instanceId: 'foreground-a', state: 'unavailable' });

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = streams[1];
  if (second === undefined) throw new Error('Expected a replacement foreground event source.');
  expect(client.activity.changedFiles).toEqual([]);
  expect(client.lastEventId).toBe(0);

  first.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:01:00.000Z',
      payload: { occurredAt: '2026-08-16T12:01:00.000Z', paths: ['src/late.ts'], reason: 'source-change' },
      sequence: 1_000,
      type: 'source.changed',
    }),
    lastEventId: '1000',
  });
  second.emit('open', { data: '', lastEventId: '' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(client.activity.changedFiles).toEqual([]);
  expect(client.connection).toEqual({ generation: 1, instanceId: 'foreground-b', state: 'connected' });
  expect(observed).toEqual(['active', 'active', 'active', 'active']);
});

it('coalesces repeated stream errors while retrying a failed authoritative bootstrap', async () => {
  const retry = deferred<void>();
  const streams: RecordingEventSource[] = [];
  let bootstraps = 0;
  const authority = new ForegroundSessionAuthority({
    fetch: async () => {
      bootstraps += 1;
      if (bootstraps === 2) throw new Error('Foreground server is still restarting.');
      return Response.json({
        instanceId: bootstraps === 1 ? 'foreground-a' : 'foreground-b',
        origin: 'http://foreground.test',
        token: `token-${bootstraps}`,
      });
    },
  });
  const errors: unknown[] = [];
  let retryCount = 0;
  const client = new ProjectClient({
    authority,
    events: () => {
      const stream = new RecordingEventSource();
      streams.push(stream);
      return stream;
    },
    fetch: async () => Response.json({ status: status() }),
    retryDelay: () => {
      retryCount += 1;
      return retry.promise;
    },
  });

  await client.connect(() => undefined, (reason) => errors.push(reason));
  const first = streams[0];
  if (first === undefined) throw new Error('Expected the initial foreground event source.');
  first.emit('error', { data: '', lastEventId: '' });
  first.emit('error', { data: '', lastEventId: '' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(first.closed).toBe(true);
  expect(errors).toHaveLength(1);
  expect(retryCount).toBe(1);
  expect(streams).toHaveLength(1);

  retry.resolve();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(streams).toHaveLength(2);
  expect(client.connection).toEqual({ generation: 1, instanceId: 'foreground-b', state: 'unavailable' });
  const second = streams[1];
  if (second === undefined) throw new Error('Expected the recovered foreground event source.');
  second.emit('open', { data: '', lastEventId: '' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  expect(client.connection).toEqual({ generation: 1, instanceId: 'foreground-b', state: 'connected' });
});

it('ignores a late old-stream refresh without blocking the recovered source open refresh', async () => {
  const lateStatus = deferred<Response>();
  const streams: RecordingEventSource[] = [];
  const sessions = [
    { instanceId: 'foreground-a', origin: 'http://foreground.test', token: 'token-a' },
    { instanceId: 'foreground-b', origin: 'http://foreground.test', token: 'token-b' },
  ];
  const authority = new ForegroundSessionAuthority({ fetch: async () => Response.json(sessions.shift()) });
  const observed: string[] = [];
  let requests = 0;
  const client = projectClient({
    authority,
    events: () => {
      const stream = new RecordingEventSource();
      streams.push(stream);
      return stream;
    },
    fetch: async () => {
      requests += 1;
      return requests === 2 ? lateStatus.promise : Response.json({ status: status() });
    },
  });

  await client.connect((next) => observed.push(next.artifact.state));
  const first = streams[0];
  if (first === undefined) throw new Error('Expected the initial foreground event source.');
  first.emit('artifact.status', {
    data: JSON.stringify({ occurredAt: '2026-08-16T12:00:00.000Z', payload: status().artifact, sequence: 7, type: 'artifact.status' }),
    lastEventId: '7',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  first.emit('error', { data: '', lastEventId: '' });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = streams[1];
  if (second === undefined) throw new Error('Expected a replacement foreground event source.');
  second.emit('open', { data: '', lastEventId: '' });
  lateStatus.resolve(Response.json({ status: status('missing') }));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  expect(observed).toEqual(['active', 'active', 'active']);
  expect(client.connection).toEqual({ generation: 1, instanceId: 'foreground-b', state: 'connected' });
});

it('rejects project SSE records with missing, invalid, or mismatched sequence identities', async () => {
  const stream = new RecordingEventSource();
  const client = projectClient({
    events: () => stream,
    fetch: async () => Response.json({ status: status() }),
  });
  await client.connect(() => undefined);
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
      payload: { occurredAt: '2026-08-16T12:02:00.000Z', paths: ['src/invalid-id.ts'], reason: 'source-change' },
      sequence: 10,
      type: 'source.changed',
    }),
    lastEventId: 'not-a-sequence',
  });
  stream.emit('source.changed', {
    data: JSON.stringify({
      occurredAt: '2026-08-16T12:03:00.000Z',
      payload: { occurredAt: '2026-08-16T12:03:00.000Z', paths: ['src/mismatch.ts'], reason: 'source-change' },
      sequence: 12,
      type: 'source.changed',
    }),
    lastEventId: '11',
  });
  stream.emit('artifact.status', {
    data: JSON.stringify({ occurredAt: '2026-08-16T12:04:00.000Z', payload: status().artifact, sequence: 13.5, type: 'artifact.status' }),
    lastEventId: '13',
  });

  expect(client.lastEventId).toBe(7);
  expect(client.activity.changedFiles).toEqual(['src/kept.ts']);
});

it('rejects versioned, extra, and malformed SSE project event messages', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  const client = projectClient({
    events: () => stream,
    fetch: async (input) => {
      requests.push(String(input));
      return Response.json({ status: status() });
    },
  });
  await client.connect(() => undefined);

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

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  expect(client.lastEventId).toBe(0);
  expect(client.activity.changedFiles).toEqual([]);
  expect(requests).toEqual(['/api/project/status']);
});

it('captures the latest valid source-change paths in an immutable browser activity snapshot', async () => {
  const stream = new RecordingEventSource();
  const client = projectClient({
    events: () => stream,
    fetch: async () => Response.json({ status: status() }),
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
  const client = projectClient({
    events: () => stream,
    fetch: async () => Response.json({ status: status() }),
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

  expect(client.activity.changedFiles).toEqual(['src/new.ts']);
  expect(client.lastEventId).toBe(20);
});

it('retains the latest changed-file activity when a source-change envelope is malformed', async () => {
  const stream = new RecordingEventSource();
  const client = projectClient({
    events: () => stream,
    fetch: async () => Response.json({ status: status() }),
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

  expect(client.activity.changedFiles).toEqual(['src/kept.ts']);
});

it('retains activity across a failed event refresh and ignores post-close event delivery', async () => {
  const stream = new RecordingEventSource();
  const errors: unknown[] = [];
  let requests = 0;
  const client = projectClient({
    events: () => stream,
    fetch: async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ status: status() })
        : new Response(null, { status: 500 });
      },
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
    const client = projectClient({
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
      data: JSON.stringify({ occurredAt: '2026-08-16T12:00:00.000Z', payload: status().artifact, sequence: 7, type: 'artifact.status' }),
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
    const client = projectClient({
      events: () => stream,
      fetch: async () => {
        requests += 1;
        return requests === 1 ? Response.json({ status: status() }) : response.promise;
      },
    });

    await client.connect(() => undefined, (reason) => errors.push(reason));
    stream.emit('artifact.status', {
      data: JSON.stringify({ occurredAt: '2026-08-16T12:00:00.000Z', payload: status().artifact, sequence: 7, type: 'artifact.status' }),
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
      if (String(input) === '/api/project/session') {
        return Response.json({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:3100', token: 'token-1' });
      }
      return Response.json({ status: status('stale') });
    },
  });

  await expect(client.rebuild(['skills/review/SKILL.md'])).resolves.toMatchObject({ artifact: { state: 'stale' } });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.input).toBe('/api/project/session');
  expect(requests[1]).toMatchObject({ body: '{"paths":["skills/review/SKILL.md"]}', input: '/api/project/rebuild' });
  expect(new Headers(requests[1]?.headers).get('x-agent-bundle-session')).toBe('token-1');
});
