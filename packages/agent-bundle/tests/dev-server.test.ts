import { get as httpGet } from 'node:http';

import { expect, it } from '@rstest/core';

import {
  ProjectEventHub,
  startForegroundServer,
  type Invalidation,
  type ProjectStatus,
} from '../src/dev/index.ts';

const status = (): ProjectStatus => ({
  artifact: { state: 'missing' },
  build: { state: 'idle' },
  source: { diagnostics: [], state: 'unknown' },
});

class RecordingCoordinator {
  readonly invalidations: Invalidation[] = [];
  closeCalls = 0;
  failClose = false;
  startCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failClose) throw new Error('coordinator close failure');
  }

  async rebuild(invalidation: Invalidation): Promise<{ readonly diagnostics: readonly []; readonly outcome: 'failed' }> {
    this.invalidations.push(invalidation);
    return { diagnostics: [], outcome: 'failed' };
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  status(): ProjectStatus {
    return status();
  }
}

const readReplay = (url: string, lastEventId: string): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  const request = httpGet(`${url}/api/project/events`, { headers: { 'last-event-id': lastEventId } }, (response) => {
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes('id: 2\n')) {
        response.destroy();
        resolvePromise(received);
      }
    });
    response.on('error', rejectPromise);
  });
  request.on('error', rejectPromise);
});

const readRaw = (url: string, path: string): Promise<Readonly<{ readonly body: string; readonly status: number }>> => {
  const address = new URL(url);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpGet({ host: address.hostname, path, port: address.port }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.once('end', () => resolvePromise({ body, status: response.statusCode ?? 0 }));
      response.once('error', rejectPromise);
    });
    request.once('error', rejectPromise);
  });
};

const openLiveStream = (url: string): Readonly<{
  readonly close: () => void;
  readonly opened: Promise<void>;
  readonly pause: () => void;
  readonly until: (marker: string) => Promise<string>;
}> => {
  let received = '';
  let response: import('node:http').IncomingMessage | undefined;
  let resolveMatch: ((value: string) => void) | undefined;
  let matched: string | undefined;
  let rejectMatch: ((error: Error) => void) | undefined;
  let resolveOpened: () => void = () => undefined;
  let rejectOpened: (error: Error) => void = () => undefined;
  const opened = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveOpened = resolvePromise;
    rejectOpened = rejectPromise;
  });
  const request = httpGet(`${url}/api/project/events`, (stream) => {
    response = stream;
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      received += chunk;
      if (matched !== undefined && received.includes(matched)) resolveMatch?.(received);
    });
    stream.once('error', (error: Error) => rejectMatch?.(error));
    resolveOpened();
  });
  request.once('error', (error: Error) => {
    rejectOpened(error);
    rejectMatch?.(error);
  });
  return Object.freeze({
    close: () => {
      response?.destroy();
      request.destroy();
    },
    opened,
    pause: () => response?.pause(),
    until: (marker) => {
      if (received.includes(marker)) return Promise.resolve(received);
      matched = marker;
      return new Promise<string>((resolvePromise, rejectPromise) => {
        resolveMatch = resolvePromise;
        rejectMatch = rejectPromise;
      });
    },
  });
};

const within = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => Promise.race([
  promise,
  new Promise<T>((_resolvePromise, rejectPromise) => {
    setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
  }),
]);

it('serves typed project status and supplied prebuilt assets after starting the coordinator', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    assets: {
      read: async (path) => path === 'index.html'
        ? { body: '<!doctype html><title>workbench</title>', contentType: 'text/html; charset=utf-8' }
        : undefined,
    },
    coordinator,
    eventHub: new ProjectEventHub(),
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    expect(coordinator.startCalls).toBe(1);

    const [statusResponse, assetResponse] = await Promise.all([
      fetch(`${server.url}/api/project/status`),
      fetch(`${server.url}/`),
    ]);

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({ status: status() });
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    expect(assetResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    await expect(assetResponse.text()).resolves.toContain('workbench');
  } finally {
    await server.close();
  }
});

it('replays project events after Last-Event-ID without re-sending the acknowledged event', async () => {
  const coordinator = new RecordingCoordinator();
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  eventHub.publish({
    payload: { occurredAt: '2026-08-14T12:00:00.000Z', paths: ['first.ts'], reason: 'source-change' },
    type: 'invalidation',
  });
  eventHub.publish({
    payload: { occurredAt: '2026-08-14T12:00:01.000Z', paths: ['second.ts'], reason: 'source-change' },
    type: 'invalidation',
  });
  const server = await startForegroundServer({ coordinator, eventHub, port: 0, sessionToken: 'test-session-token' });

  try {
    const replay = await readReplay(server.url, '1');

    expect(replay).toContain('id: 2\n');
    expect(replay).toContain('"paths":["second.ts"]');
    expect(replay).not.toContain('"paths":["first.ts"]');
  } finally {
    await server.close();
  }
});

it('opens a live event stream before a later project event is published', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0 });
  const stream = openLiveStream(server.url);

  try {
    await expect(within(stream.opened, 250)).resolves.toBeUndefined();
    expect(eventHub.subscriptionCount).toBe(1);

    eventHub.publish({
      payload: { occurredAt: '2026-08-14T12:00:00.000Z', paths: ['live.ts'], reason: 'source-change' },
      type: 'invalidation',
    });

    await expect(within(stream.until('"paths":["live.ts"]'), 250)).resolves.toContain('id: 1\n');
  } finally {
    stream.close();
    await server.close();
  }
});

it('closes an unconsumed live event stream without retaining its subscription', async () => {
  const coordinator = new RecordingCoordinator();
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  const server = await startForegroundServer({ coordinator, eventHub, port: 0 });
  const stream = openLiveStream(server.url);

  try {
    await expect(within(stream.opened, 250)).resolves.toBeUndefined();
    stream.pause();
    eventHub.publish({
      payload: {
        occurredAt: '2026-08-14T12:00:00.000Z',
        paths: ['backpressure.ts', 'x'.repeat(128 * 1024)],
        reason: 'source-change',
      },
      type: 'invalidation',
    });

    await expect(within(server.close(), 250)).resolves.toBeUndefined();
    expect(eventHub.subscriptionCount).toBe(0);
    expect(coordinator.closeCalls).toBe(1);
  } finally {
    stream.close();
  }
});

it('rejects malformed rebuild input as a stable diagnostic without exposing an error stack', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const response = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'x-agent-bundle-session': server.sessionToken,
      },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      diagnostic: {
        code: 'AB8001',
        message: 'Request body must be valid JSON.',
      },
    });
    expect(body).not.toContain('Error:');
    expect(coordinator.invalidations).toEqual([]);
  } finally {
    await server.close();
  }
});

it('allows a same-origin browser to bootstrap its token but never sends it to a foreign origin', async () => {
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const foreign = await fetch(`${server.url}/api/project/session`, {
      headers: { origin: 'http://invalid.example' },
    });
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual({
      diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' },
    });

    const browser = await fetch(`${server.url}/api/project/session`, {
      headers: { origin: server.url },
    });
    expect(browser.status).toBe(200);
    await expect(browser.json()).resolves.toEqual({ origin: server.url, token: 'test-session-token' });

    const browserWithoutOrigin = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(browserWithoutOrigin.status).toBe(200);
    await expect(browserWithoutOrigin.json()).resolves.toEqual({ origin: server.url, token: 'test-session-token' });

    const noBrowserProof = await fetch(`${server.url}/api/project/session`);
    expect(noBrowserProof.status).toBe(403);
    await expect(noBrowserProof.json()).resolves.toEqual({
      diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' },
    });
  } finally {
    await server.close();
  }
});

it('requires the same origin and session token before a browser can request a rebuild', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const missingToken = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{}',
      headers: { 'content-type': 'application/json', origin: server.url },
      method: 'POST',
    });
    expect(missingToken.status).toBe(403);
    await expect(missingToken.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });

    const wrongOrigin = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        origin: 'http://invalid.example',
        'x-agent-bundle-session': server.sessionToken,
      },
      method: 'POST',
    });
    expect(wrongOrigin.status).toBe(403);
    await expect(wrongOrigin.json()).resolves.toEqual({
      diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' },
    });

    const accepted = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{"paths":["skills/review/SKILL.md"]}',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'x-agent-bundle-session': server.sessionToken,
      },
      method: 'POST',
    });
    expect(accepted.status).toBe(200);
    expect(coordinator.invalidations).toEqual([expect.objectContaining({
      paths: ['skills/review/SKILL.md'],
      reason: 'manual',
    })]);
  } finally {
    await server.close();
  }
});

it('rejects arbitrary browser command fields before delegation', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const response = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{"command":"/tmp/untrusted"}',
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'x-agent-bundle-session': server.sessionToken,
      },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8002',
        message: 'Request body may contain only an optional paths array.',
      },
    });
    expect(coordinator.invalidations).toEqual([]);
  } finally {
    await server.close();
  }
});

it('rejects decoded asset traversal before consulting the asset provider', async () => {
  const requested: string[] = [];
  const server = await startForegroundServer({
    assets: {
      read: async (path) => {
        requested.push(path);
        return { body: 'unexpected', contentType: 'text/plain; charset=utf-8' };
      },
    },
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    port: 0,
  });

  try {
    const response = await readRaw(server.url, '/%2e%2e/secrets.txt');

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      diagnostic: { code: 'AB8005', message: 'Asset path is not valid.' },
    });
    expect(response.body).not.toContain('Error:');
    expect(requested).toEqual([]);
  } finally {
    await server.close();
  }
});

it('refuses every non-loopback bind address before starting a coordinator', async () => {
  const coordinator = new RecordingCoordinator();

  await expect(startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    host: '0.0.0.0',
  })).rejects.toMatchObject({
    code: 'AB8000',
    message: 'Foreground servers may bind only to 127.0.0.1 or ::1.',
  });
  expect(coordinator.startCalls).toBe(0);
});

it('closes the HTTP server and coordinator once while retaining both release failures structurally', async () => {
  const coordinator = new RecordingCoordinator();
  coordinator.failClose = true;
  const server = await startForegroundServer({ coordinator, eventHub: new ProjectEventHub(), port: 0 });

  await expect(server.close()).rejects.toMatchObject({
    failures: [expect.objectContaining({ resource: 'coordinator' })],
  });
  await expect(server.close()).rejects.toMatchObject({
    failures: [expect.objectContaining({ resource: 'coordinator' })],
  });
  expect(coordinator.closeCalls).toBe(1);
});
