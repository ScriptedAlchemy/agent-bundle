import { createServer as createNodeServer, get as httpGet } from 'node:http';

import { expect, it } from '@rstest/core';

import type { HookPlaygroundRouteService } from '../src/dev/hook-playground-routes.ts';
import type {
  HookPlaygroundHook,
  HookPlaygroundReplay,
  HookPlaygroundSimulationOptions,
} from '../src/dev/hook-playground-service.ts';
import {
  ForegroundServer,
  ProjectEventHub,
  startForegroundServer,
  type Invalidation,
  type ProjectStatus,
} from '../src/dev/index.ts';
import { ArtifactInspectionServiceError } from '../src/dev/artifact-inspection-service.ts';
import type { EvalRouteService } from '../src/dev/eval-routes.ts';
import type { McpSessionService } from '../src/dev/mcp-session-service.ts';

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

class DelayedCoordinator extends RecordingCoordinator {
  readonly #startGate: Promise<void>;

  constructor(startGate: Promise<void>) {
    super();
    this.#startGate = startGate;
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
    await this.#startGate;
  }
}

class FailingStartCoordinator extends RecordingCoordinator {
  override async close(): Promise<void> {
    this.closeCalls += 1;
    throw new Error('cleanup failure');
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
    throw new Error('startup failure');
  }
}

const foregroundCookie = async (url: string): Promise<string> => {
  const response = await fetch(`${url}/api/project/session`, { headers: { origin: url } });
  if (!response.ok) throw new Error(`Foreground session bootstrap failed with HTTP ${response.status}.`);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie === undefined || cookie.length === 0) throw new Error('Foreground session bootstrap did not return a cookie.');
  return cookie;
};

const readReplay = async (url: string, lastEventId: string, expectedSequence = 2): Promise<string> => {
  const cookie = await foregroundCookie(url);
  return new Promise((resolvePromise, rejectPromise) => {
  const request = httpGet(`${url}/api/project/events`, { headers: { cookie, 'last-event-id': lastEventId, origin: url } }, (response) => {
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes(`id: ${expectedSequence}\n`)) {
        response.destroy();
        resolvePromise(received);
      }
    });
    response.on('error', rejectPromise);
  });
  request.on('error', rejectPromise);
  });
};

const readRaw = (
  url: string,
  path: string,
  headers?: Readonly<Record<string, string>>,
): Promise<Readonly<{ readonly body: string; readonly headers: import('node:http').IncomingHttpHeaders; readonly status: number }>> => {
  const address = new URL(url);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpGet({ headers, host: address.hostname, path, port: address.port }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.once('end', () => resolvePromise({ body, headers: response.headers, status: response.statusCode ?? 0 }));
      response.once('error', rejectPromise);
    });
    request.once('error', rejectPromise);
  });
};

const eventually = async (predicate: () => boolean, milliseconds: number): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
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
  let request: import('node:http').ClientRequest | undefined;
  void foregroundCookie(url).then((cookie) => {
    request = httpGet(`${url}/api/project/events`, { headers: { cookie, origin: url } }, (stream) => {
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
  }, (error: unknown) => {
    const failure = error instanceof Error ? error : new Error('Foreground session bootstrap failed.');
    rejectOpened(failure);
    rejectMatch?.(failure);
  });
  return Object.freeze({
    close: () => {
      response?.destroy();
      request?.destroy();
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

const readToEnd = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return output;
    output += decoder.decode(next.value, { stream: true });
  }
};

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

it('delivers a large replay to a healthy client and reconnects after its acknowledged cursor', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  eventHub.publish({
    payload: {
      occurredAt: '2026-08-14T12:00:00.000Z',
      paths: ['large.ts', 'x'.repeat(128 * 1024)],
      reason: 'source-change',
    },
    type: 'invalidation',
  });
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0 });

  try {
    const first = await within(readReplay(server.url, '0', 1), 500);
    expect(first).toContain('id: 1\n');
    expect(first).toContain('"paths":["large.ts"');

    eventHub.publish({
      payload: { occurredAt: '2026-08-14T12:00:01.000Z', paths: ['next.ts'], reason: 'source-change' },
      type: 'invalidation',
    });
    const next = await within(readReplay(server.url, '1', 2), 500);
    expect(next).toContain('"paths":["next.ts"]');
    expect(next).not.toContain('"paths":["large.ts"');
  } finally {
    await server.close();
  }
});

it('replays many ordinary retained events to a healthy client in order', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  for (const sequence of Array.from({ length: 20 }, (_, index) => index + 1)) {
    eventHub.publish({
      payload: {
        occurredAt: '2026-08-14T12:00:00.000Z',
        paths: ['replay-' + sequence + '.ts', 'x'.repeat(8 * 1024)],
        reason: 'source-change',
      },
      type: 'invalidation',
    });
  }
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0 });

  try {
    const replay = await within(readReplay(server.url, '0', 20), 500);
    expect(Array.from(replay.matchAll(/^id: (\d+)$/gmu), (match) => Number(match[1]))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );

    eventHub.publish({
      payload: { occurredAt: '2026-08-14T12:00:01.000Z', paths: ['after-cursor.ts'], reason: 'source-change' },
      type: 'invalidation',
    });
    const next = await within(readReplay(server.url, '20', 21), 500);
    expect(next).toContain('"paths":["after-cursor.ts"]');
    expect(next).not.toContain('"paths":["replay-20.ts"');
  } finally {
    await server.close();
  }
});

it('drains queued replay events in sequence after a healthy client clears backpressure', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  eventHub.publish({
    payload: {
      occurredAt: '2026-08-14T12:00:00.000Z',
      paths: ['first-large.ts', 'x'.repeat(128 * 1024)],
      reason: 'source-change',
    },
    type: 'invalidation',
  });
  eventHub.publish({
    payload: { occurredAt: '2026-08-14T12:00:01.000Z', paths: ['queued-next.ts'], reason: 'source-change' },
    type: 'invalidation',
  });
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0 });

  try {
    const replay = await within(readReplay(server.url, '0', 2), 500);
    expect(replay.indexOf('id: 1\n')).toBeLessThan(replay.indexOf('id: 2\n'));
    expect(replay).toContain('"paths":["queued-next.ts"]');
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

it('publishes runtime App shutdown invalidation before tearing down authenticated SSE streams', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-15T00:00:00.000Z') });
  const prepared: string[] = [];
  const previews = {
    prepareClose: async () => {
      prepared.push('runtime-apps');
      eventHub.publish({
        payload: { occurredAt: '2026-08-15T00:00:00.000Z', paths: ['runtime-shutdown'], reason: 'source-change' },
        type: 'invalidation',
      });
    },
  } as never;
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(), eventHub, mcpAppPreviews: previews, port: 0,
  });
  const stream = openLiveStream(server.url);
  try {
    await expect(within(stream.opened, 250)).resolves.toBeUndefined();
    const published = stream.until('runtime-shutdown');
    await expect(within(server.close(), 250)).resolves.toBeUndefined();
    await expect(within(published, 250)).resolves.toContain('runtime-shutdown');
    expect(prepared).toEqual(['runtime-apps']);
  } finally {
    stream.close();
    await server.close().catch(() => undefined);
  }
});

it('authenticates project events before it parses a cursor or subscribes to the hub', async () => {
  const eventHub = new ProjectEventHub();
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0, sessionToken: 'event-token' });
  try {
    const missingCookie = await readRaw(server.url, '/api/project/events?after=not-a-cursor', { origin: server.url });
    expect(missingCookie.status).toBe(403);
    expect(missingCookie.headers['cache-control']).toBe('no-store');
    const wrongOrigin = await readRaw(server.url, '/api/project/events?after=not-a-cursor', {
      cookie: await foregroundCookie(server.url), origin: 'http://invalid.example',
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongCookie = await readRaw(server.url, '/api/project/events?after=not-a-cursor', {
      cookie: `${(await foregroundCookie(server.url)).split('=', 1)[0]}=wrong`, origin: server.url,
    });
    expect(wrongCookie.status).toBe(403);
    expect(eventHub.subscriptionCount).toBe(0);

    const cookie = await foregroundCookie(server.url);
    const headers = await new Promise<import('node:http').IncomingHttpHeaders>((resolvePromise, rejectPromise) => {
      const request = httpGet(`${server.url}/api/project/events`, {
        headers: { cookie, origin: server.url },
      }, (response) => {
        response.destroy();
        resolvePromise(response.headers);
      });
      request.once('error', rejectPromise);
    });
    expect(headers['cache-control']).toBe('no-store');
  } finally {
    await server.close();
  }
});

it('isolates foreground event cookies across simultaneous loopback listeners', async () => {
  const first = await startForegroundServer({
    coordinator: new RecordingCoordinator(), eventHub: new ProjectEventHub(), port: 0, sessionToken: 'first-token',
  });
  const second = await startForegroundServer({
    coordinator: new RecordingCoordinator(), eventHub: new ProjectEventHub(), port: 0, sessionToken: 'second-token',
  });
  const eventStatus = async (url: string, cookie: string): Promise<number> => new Promise((resolvePromise, rejectPromise) => {
    const request = httpGet(`${url}/api/project/events`, { headers: { cookie, origin: url } }, (response) => {
      response.destroy();
      resolvePromise(response.statusCode ?? 0);
    });
    request.once('error', rejectPromise);
  });
  try {
    const firstBootstrap = await fetch(`${first.url}/api/project/session`, { headers: { origin: first.url } });
    const secondBootstrap = await fetch(`${second.url}/api/project/session`, { headers: { origin: second.url } });
    const firstBody = await firstBootstrap.json() as Readonly<{ readonly cookieName?: unknown }>;
    const secondBody = await secondBootstrap.json() as Readonly<{ readonly cookieName?: unknown }>;
    const firstCookie = firstBootstrap.headers.get('set-cookie')?.split(';', 1)[0];
    const secondCookie = secondBootstrap.headers.get('set-cookie')?.split(';', 1)[0];
    expect(typeof firstBody.cookieName).toBe('string');
    expect(typeof secondBody.cookieName).toBe('string');
    expect(firstBody.cookieName).not.toBe(secondBody.cookieName);
    expect(firstCookie).toContain(`${firstBody.cookieName}=`);
    expect(secondCookie).toContain(`${secondBody.cookieName}=`);
    const browserCookieJar = `${firstCookie}; ${secondCookie}`;
    await expect(eventStatus(first.url, browserCookieJar)).resolves.toBe(200);
    await expect(eventStatus(second.url, browserCookieJar)).resolves.toBe(200);
  } finally {
    await Promise.all([first.close(), second.close()]);
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

it('allows a same-origin browser to bootstrap its instance identity and token but never sends them to a foreign origin', async () => {
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    instanceId: 'test-instance-id',
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
    await expect(browser.json()).resolves.toMatchObject({
      cookieName: expect.stringMatching(/^agent-bundle-foreground-session-[a-f0-9]{32}$/u), instanceId: 'test-instance-id', origin: server.url, token: 'test-session-token',
    });

    const browserWithoutOrigin = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(browserWithoutOrigin.status).toBe(200);
    await expect(browserWithoutOrigin.json()).resolves.toMatchObject({
      cookieName: expect.stringMatching(/^agent-bundle-foreground-session-[a-f0-9]{32}$/u), instanceId: 'test-instance-id', origin: server.url, token: 'test-session-token',
    });

    const noBrowserProof = await fetch(`${server.url}/api/project/session`);
    expect(noBrowserProof.status).toBe(403);
    await expect(noBrowserProof.json()).resolves.toEqual({
      diagnostic: { code: 'AB8003', message: 'Request origin is not this foreground server.' },
    });
  } finally {
    await server.close();
  }
});

for (const [description, instanceId] of [
  ['empty', ''], ['blank', '   '], ['leading-whitespace', ' instance-id'],
  ['trailing-whitespace', 'instance-id '], ['overlong', 'x'.repeat(129)],
] as const) {
  it(`refuses a ${description} injected foreground instance ID before starting a coordinator`, async () => {
    const coordinator = new RecordingCoordinator();
    await expect(startForegroundServer({ coordinator, eventHub: new ProjectEventHub(), instanceId }))
      .rejects.toMatchObject({
        code: 'AB8000',
        message: 'Foreground server instance ID must be a trimmed string between 1 and 128 characters.',
      });
    expect(coordinator.startCalls).toBe(0);
  });
}

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

it('applies the established foreground origin and token guard to MCP session creation', async () => {
  const opens: unknown[] = [];
  const mcpSessions = {
    open: async (options: unknown) => {
      opens.push(options);
      return {
        binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
        connection: { capabilities: {}, protocolEra: 'modern', protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } },
        id: 'session-a',
      };
    },
  } as unknown as McpSessionService;
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    mcpSessions,
    port: 0,
    sessionToken: 'test-session-token',
  });
  const body = JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' });

  try {
    const denied = await fetch(`${server.url}/api/mcp/sessions`, {
      body,
      headers: { 'content-type': 'application/json', origin: server.url },
      method: 'POST',
    });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });
    expect(opens).toEqual([]);

    const accepted = await fetch(`${server.url}/api/mcp/sessions`, {
      body,
      headers: {
        'content-type': 'application/json',
        origin: server.url,
        'x-agent-bundle-session': server.sessionToken,
      },
      method: 'POST',
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      session: {
        binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
        connection: { capabilities: {}, protocolEra: 'modern', protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } },
        id: 'session-a',
      },
    });
    expect(opens).toEqual([{ epochId: 'epoch-a', serverName: 'weather', target: 'portable' }]);
  } finally {
    await server.close();
  }
});

it('accepts headerless browser same-origin fetch provenance with the exact token for rebuild and MCP reads, streams, and creation', async () => {
  const coordinator = new RecordingCoordinator();
  let streamSubscriptions = 0;
  const session = {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
    connection: { capabilities: {}, protocolEra: 'modern', protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } },
    id: 'session-a',
    subscribeTrace: () => {
      streamSubscriptions += 1;
      return { unsubscribe: () => { streamSubscriptions -= 1; } };
    },
    trace: () => ({ entries: [] }),
  };
  const mcpSessions = {
    get: (id: string) => id === session.id ? session : undefined,
    open: async () => session,
  } as unknown as McpSessionService;
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    mcpSessions,
    port: 0,
    sessionToken: 'test-session-token',
  });
  const headers = { 'sec-fetch-site': 'same-origin', 'x-agent-bundle-session': server.sessionToken };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const rebuild = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{}',
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(rebuild.status).toBe(200);
    expect(coordinator.invalidations).toHaveLength(1);

    const created = await fetch(`${server.url}/api/mcp/sessions`, {
      body: JSON.stringify({ epochId: 'epoch-a', serverName: 'weather', target: 'portable' }),
      headers: { ...headers, 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({ session: { id: 'session-a' } });

    const read = await fetch(`${server.url}/api/mcp/sessions/session-a`, { headers });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ session: { id: 'session-a' } });

    const stream = await fetch(`${server.url}/api/mcp/sessions/session-a/stream?after=0`, { headers });
    expect(stream.status).toBe(200);
    reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected MCP stream body.');
    expect(streamSubscriptions).toBe(1);
  } finally {
    await reader?.cancel();
    await server.close();
  }
});

it('forwards structured artifact validation diagnostics through the foreground error boundary', async () => {
  const diagnostics = Object.freeze([Object.freeze({
    code: 'AB4300',
    generatedPath: 'claude/hooks/guard.mjs',
    message: 'Emitted hook wrapper is not executable.',
    severity: 'error' as const,
  })]);
  const server = await startForegroundServer({
    artifacts: {
      diff: () => Promise.reject(new Error('unused')),
      inspect: () => Promise.reject(new ArtifactInspectionServiceError(
        'ARTIFACT_INSPECTION_INVALID',
        '/private/epochs/epoch-a failed validation',
        diagnostics,
      )),
    },
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const headers = { origin: server.url, 'x-agent-bundle-session': server.sessionToken };
    const failed = await fetch(`${server.url}/api/artifacts/epochs/epoch-a`, { headers });
    expect(failed.status).toBe(422);
    const body = await failed.json() as {
      readonly diagnostic: { readonly code: string; readonly message: string };
      readonly diagnostics?: readonly unknown[];
    };
    expect(body.diagnostic).toEqual({ code: 'AB8064', message: 'Artifact epoch failed validation.' });
    expect(body.diagnostics).toEqual(diagnostics);
    expect(JSON.stringify(body)).not.toContain('/private/epochs');

    const opaque = await fetch(`${server.url}/api/artifacts/diff?base=epoch-a&candidate=epoch-b`, { headers });
    expect(opaque.status).toBe(502);
    await expect(opaque.json()).resolves.toEqual({
      diagnostic: { code: 'AB8063', message: 'Artifact inspection could not be completed.' },
    });
  } finally {
    await server.close();
  }
});

it('rejects non-browser provenance and wrong tokens even when a canonical Host targets the foreground server', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });
  const request = (headers: Readonly<Record<string, string>>) => fetch(`${server.url}/api/project/rebuild`, {
    body: '{}',
    headers: { ...headers, 'content-type': 'application/json' },
    method: 'POST',
  });

  try {
    const rejectedHeaders: readonly Readonly<Record<string, string>>[] = [
      { 'sec-fetch-site': 'cross-site', 'x-agent-bundle-session': server.sessionToken },
      { 'sec-fetch-site': 'none', 'x-agent-bundle-session': server.sessionToken },
      { 'x-agent-bundle-session': server.sessionToken },
      { 'sec-fetch-site': 'same-origin', 'x-agent-bundle-session': 'wrong-token' },
      { origin: 'http://invalid.example', 'sec-fetch-site': 'same-origin', 'x-agent-bundle-session': server.sessionToken },
    ];
    for (const headers of rejectedHeaders) {
      const response = await request(headers);
      expect(response.status).toBe(403);
    }
    expect(coordinator.invalidations).toEqual([]);
  } finally {
    await server.close();
  }
});

it('ends active authenticated MCP trace readers before foreground shutdown destroys remaining sockets', async () => {
  let subscriptions = 0;
  const session = {
    binding: { epochId: 'epoch-a', serverName: 'weather', target: 'portable' },
    connection: { capabilities: {}, protocolEra: 'modern', protocolVersion: '2025-11-25', server: { name: 'fixture', version: '1.0.0' } },
    id: 'session-a',
    subscribeTrace: () => {
      subscriptions += 1;
      return { unsubscribe: () => { subscriptions -= 1; } };
    },
    trace: () => ({ entries: [] }),
  };
  const mcpSessions = {
    get: (id: string) => id === 'session-a' ? session : undefined,
  } as unknown as McpSessionService;
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    mcpSessions,
    port: 0,
    sessionToken: 'test-session-token',
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const stream = await fetch(`${server.url}/api/mcp/sessions/session-a/stream?after=0`, {
      headers: { origin: server.url, 'x-agent-bundle-session': server.sessionToken },
    });
    reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected MCP trace stream body.');
    expect(subscriptions).toBe(1);

    const closing = server.close();
    await expect(within(readToEnd(reader), 250)).resolves.toBe('');
    await expect(closing).resolves.toBeUndefined();
    expect(subscriptions).toBe(0);
  } finally {
    await reader?.cancel();
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

it('never discloses a session token when Host does not identify this bound server', async () => {
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });

  try {
    const spoofed = await readRaw(server.url, '/api/project/session', {
      host: 'attacker.example',
      'sec-fetch-site': 'same-origin',
    });
    expect(spoofed.status).toBe(400);
    expect(JSON.parse(spoofed.body)).toEqual({
      diagnostic: { code: 'AB8008', message: 'Request host is not this foreground server.' },
    });
    expect(spoofed.body).not.toContain('test-session-token');

    const sameServer = await readRaw(server.url, '/api/project/session', {
      host: new URL(server.url).host,
      'sec-fetch-site': 'same-origin',
    });
    expect(sameServer.status).toBe(200);
    expect(JSON.parse(sameServer.body)).toMatchObject({
      cookieName: expect.stringMatching(/^agent-bundle-foreground-session-[a-f0-9]{32}$/u), origin: server.url, token: 'test-session-token',
    });
  } finally {
    await server.close();
  }
});

it('rejects non-JSON and over-limit rebuild bodies with stable drained diagnostics', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });
  const headers = {
    origin: server.url,
    'x-agent-bundle-session': server.sessionToken,
  };

  try {
    const plain = await fetch(`${server.url}/api/project/rebuild`, {
      body: '{}',
      headers: { ...headers, 'content-type': 'text/plain' },
      method: 'POST',
    });
    expect(plain.status).toBe(415);
    await expect(plain.json()).resolves.toEqual({
      diagnostic: { code: 'AB8009', message: 'Request body must use application/json.' },
    });

    const tooLarge = await fetch(`${server.url}/api/project/rebuild`, {
      body: JSON.stringify({ paths: ['x'.repeat(64 * 1024)] }),
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
      method: 'POST',
    });
    const body = await tooLarge.text();
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(body)).toEqual({
      diagnostic: { code: 'AB8010', message: 'Request body exceeds 64 KiB.' },
    });
    expect(body).not.toContain('Error:');
    expect(coordinator.invalidations).toEqual([]);
  } finally {
    await server.close();
  }
});

it('accepts only application/json with an optional UTF-8 charset parameter', async () => {
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    port: 0,
    sessionToken: 'test-session-token',
  });
  const headers = { origin: server.url, 'x-agent-bundle-session': server.sessionToken };

  try {
    for (const contentType of [
      'application/json',
      'Application/Json; Charset=UTF-8',
      'application/json; charset="utf-8"',
    ]) {
      const response = await fetch(`${server.url}/api/project/rebuild`, {
        body: '{}',
        headers: { ...headers, 'content-type': contentType },
        method: 'POST',
      });
      expect(response.status).toBe(200);
    }

    for (const contentType of [
      'application/json; charset=iso-8859-1',
      'application/json; profile=workbench',
      'application/json; charset=utf-8; charset=utf-8',
      'application/json; charset=',
    ]) {
      const response = await fetch(`${server.url}/api/project/rebuild`, {
        body: '{}',
        headers: { ...headers, 'content-type': contentType },
        method: 'POST',
      });
      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        diagnostic: { code: 'AB8009', message: 'Request body must use application/json.' },
      });
    }
    expect(coordinator.invalidations).toHaveLength(3);
  } finally {
    await server.close();
  }
});

it('does not bind after close races a delayed startup', async () => {
  const blocker = createNodeServer();
  await new Promise<void>((resolvePromise) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const blockerAddress = blocker.address();
  if (blockerAddress === null || typeof blockerAddress === 'string') throw new Error('Expected TCP blocker address.');
  let releaseStart: () => void = () => undefined;
  const startGate = new Promise<void>((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  const coordinator = new DelayedCoordinator(startGate);
  const server = new ForegroundServer({ coordinator, eventHub: new ProjectEventHub(), port: blockerAddress.port });

  try {
    const starting = server.start();
    await eventually(() => coordinator.startCalls === 1, 250);
    const closing = server.close();
    releaseStart();

    await expect(starting).rejects.toThrow('Foreground server is closed.');
    await expect(closing).resolves.toBeUndefined();
    expect(coordinator.closeCalls).toBe(1);
    expect(() => server.url).toThrow('Foreground server has not started.');
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => blocker.close((error) => error === undefined ? resolvePromise() : rejectPromise(error)));
  }
});

it('closes and releases a paused SSE client after its outstanding bytes exceed the cap', async () => {
  const eventHub = new ProjectEventHub({ now: () => new Date('2026-08-14T12:00:00.000Z') });
  const server = await startForegroundServer({ coordinator: new RecordingCoordinator(), eventHub, port: 0 });
  const stream = openLiveStream(server.url);

  try {
    await expect(within(stream.opened, 250)).resolves.toBeUndefined();
    stream.pause();
    eventHub.publish({
      payload: {
        occurredAt: '2026-08-14T12:00:00.000Z',
        paths: ['current-buffer.ts', 'x'.repeat(200 * 1024)],
        reason: 'source-change',
      },
      type: 'invalidation',
    });
    eventHub.publish({
      payload: {
        occurredAt: '2026-08-14T12:00:00.000Z',
        paths: ['queued-frame.ts', 'x'.repeat(100 * 1024)],
        reason: 'source-change',
      },
      type: 'invalidation',
    });

    await expect(eventually(() => eventHub.subscriptionCount === 0, 250)).resolves.toBeUndefined();
  } finally {
    stream.close();
    await server.close();
  }
});

it('test-only event stream handles disconnect only their current foreground SSE subscription', async () => {
  const eventHub = new ProjectEventHub();
  const handles: Array<Readonly<{ readonly disconnect: () => void }>> = [];
  const server = await startForegroundServer({
    coordinator: new RecordingCoordinator(),
    eventHub,
    port: 0,
    testing: { onProjectEventStream: (handle) => handles.push(handle) },
  });
  const first = openLiveStream(server.url);

  try {
    await expect(within(first.opened, 250)).resolves.toBeUndefined();
    await expect(eventually(() => handles.length === 1, 250)).resolves.toBeUndefined();
    const stale = handles[0];
    if (stale === undefined) throw new Error('Expected first stream handle.');
    stale.disconnect();
    stale.disconnect();
    await expect(eventually(() => eventHub.subscriptionCount === 0, 250)).resolves.toBeUndefined();

    const replacement = openLiveStream(server.url);
    await expect(within(replacement.opened, 250)).resolves.toBeUndefined();
    await expect(eventually(() => handles.length === 2 && eventHub.subscriptionCount === 1, 250)).resolves.toBeUndefined();
    stale.disconnect();
    expect(eventHub.subscriptionCount).toBe(1);
    handles[1]?.disconnect();
    await expect(eventually(() => eventHub.subscriptionCount === 0, 250)).resolves.toBeUndefined();
    replacement.close();
  } finally {
    first.close();
    await server.close();
  }
});

it('retains both startup and cleanup failures structurally', async () => {
  const coordinator = new FailingStartCoordinator();
  const server = new ForegroundServer({ coordinator, eventHub: new ProjectEventHub(), port: 0 });

  await expect(server.start()).rejects.toMatchObject({
    failures: [
      expect.objectContaining({ resource: 'start' }),
      expect.objectContaining({ resource: 'cleanup' }),
    ],
  });
  expect(coordinator.closeCalls).toBe(1);
});

/** Holds one hook simulation open until the test releases its shutdown settlement. */
class GatedHookPlayground implements HookPlaygroundRouteService {
  readonly settlements: string[] = [];
  failure: Error | undefined;
  readonly #admitted: Promise<void>;
  #admit!: () => void;
  #release: (() => void) | undefined;

  constructor() {
    this.#admitted = new Promise<void>((resolvePromise) => { this.#admit = resolvePromise; });
  }

  get admitted(): Promise<void> {
    return this.#admitted;
  }

  async list(): Promise<readonly HookPlaygroundHook[]> {
    return Object.freeze([]);
  }

  async replay(_replay: HookPlaygroundReplay, options?: { readonly signal?: AbortSignal }): Promise<never> {
    return this.#run(options?.signal);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<never> {
    return this.#run(options.signal);
  }

  release(): void {
    this.#release?.();
  }

  async #run(signal: AbortSignal | undefined): Promise<never> {
    this.#admit();
    return new Promise<never>((_resolvePromise, rejectPromise) => {
      signal?.addEventListener('abort', () => {
        this.#release = () => {
          this.settlements.push('simulation');
          rejectPromise(this.failure ?? signal?.reason);
        };
      });
    });
  }
}

const startSimulation = (server: ForegroundServer): Promise<unknown> => fetch(`${server.url}/api/hooks/simulations`, {
  body: JSON.stringify({ epochId: 'epoch-a', hook: 'hook-a', input: { inline: {} }, target: 'claude' }),
  headers: {
    'content-type': 'application/json',
    origin: server.url,
    'x-agent-bundle-session': server.sessionToken,
  },
  method: 'POST',
}).catch(() => undefined);

it('keeps the foreground close pending until every hook simulation has drained', async () => {
  const coordinator = new RecordingCoordinator();
  const hookPlayground = new GatedHookPlayground();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    hookPlayground,
    port: 0,
  });
  const simulation = startSimulation(server);
  await hookPlayground.admitted;

  const closed = server.close();
  const settled = await Promise.race([
    closed.then(() => 'closed'),
    new Promise<string>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 50); }),
  ]);
  expect(settled).toBe('pending');

  hookPlayground.release();
  await closed;
  expect(hookPlayground.settlements).toEqual(['simulation']);
  expect(coordinator.closeCalls).toBe(1);
  await simulation;
});

it('keeps foreground close pending until its admitted Eval service durably settles', async () => {
  let admitRun!: () => void;
  let beginEvalClose!: () => void;
  let releaseRun!: () => void;
  const admitted = new Promise<void>((resolvePromise) => { admitRun = resolvePromise; });
  const evalCloseStarted = new Promise<void>((resolvePromise) => { beginEvalClose = resolvePromise; });
  const released = new Promise<void>((resolvePromise) => { releaseRun = resolvePromise; });
  const evals: EvalRouteService = {
    async cancel() { throw new Error('Unexpected cancellation.'); },
    async compare() { throw new Error('Unexpected comparison.'); },
    async events() { throw new Error('Unexpected event replay.'); },
    async list() { throw new Error('Unexpected run listing.'); },
    async openArtifact() { throw new Error('Unexpected artifact read.'); },
    async read() { throw new Error('Unexpected run read.'); },
    async start() {
      admitRun();
      return Object.freeze({ run: undefined as never });
    },
    async subscribeEvents() { throw new Error('Unexpected event subscription.'); },
    async suites() { throw new Error('Unexpected suite listing.'); },
  };
  const evalLifecycle = {
    close: async (): Promise<void> => {
      beginEvalClose();
      await released;
    },
  };
  const coordinator = new RecordingCoordinator();
  const server = await startForegroundServer({ coordinator, evalLifecycle, evals, eventHub: new ProjectEventHub(), port: 0 });
  const run = await fetch(`${server.url}/api/evals/runs`, {
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': server.sessionToken,
    },
    method: 'POST',
  });

  try {
    await admitted;
    expect(run.status).toBe(202);
    const closing = server.close();
    await evalCloseStarted;
    const state = await Promise.race([
      closing.then(() => 'closed'),
      new Promise<string>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 50); }),
    ]);
    expect(state).toBe('pending');

    releaseRun();
    await closing;
    expect(coordinator.closeCalls).toBe(1);
  } finally {
    releaseRun();
    await server.close().catch(() => undefined);
  }
});

it('retains an Eval service drain failure while still releasing the foreground coordinator', async () => {
  const coordinator = new RecordingCoordinator();
  const evalFailure = new Error('eval cancellation cleanup failed');
  let evalCloseCalls = 0;
  const server = await startForegroundServer({
    coordinator,
    evalLifecycle: {
      close: async () => {
        evalCloseCalls += 1;
        throw evalFailure;
      },
    },
    eventHub: new ProjectEventHub(),
    port: 0,
  });

  try {
    await expect(server.close()).rejects.toMatchObject({
      failures: [{ error: evalFailure, resource: 'eval-service' }],
      name: 'ForegroundServerCloseError',
    });
    expect(evalCloseCalls).toBe(1);
    expect(coordinator.closeCalls).toBe(1);
  } finally {
    await server.close().catch(() => undefined);
  }
});

it('drains Eval routes, Agent API, and the Eval service before coordinator shutdown', async () => {
  let releaseRouteAdmission!: () => void;
  let releaseAgentClose!: () => void;
  let releaseEvalClose!: () => void;
  let signalRouteAdmission!: () => void;
  let signalAgentClose!: () => void;
  let signalEvalClose!: () => void;
  let agentClosed = false;
  let evalClosed = false;
  let evalCloseCalls = 0;
  let evalObservedAgentClosed = false;
  let coordinatorCloseCalls = 0;
  let coordinatorObservedEvalClosed = false;
  const routeAdmissionStarted = new Promise<void>((resolvePromise) => { signalRouteAdmission = resolvePromise; });
  const agentCloseStarted = new Promise<void>((resolvePromise) => { signalAgentClose = resolvePromise; });
  const evalCloseStarted = new Promise<void>((resolvePromise) => { signalEvalClose = resolvePromise; });
  const routeAdmissionRelease = new Promise<void>((resolvePromise) => { releaseRouteAdmission = resolvePromise; });
  const agentCloseRelease = new Promise<void>((resolvePromise) => { releaseAgentClose = resolvePromise; });
  const evalCloseRelease = new Promise<void>((resolvePromise) => { releaseEvalClose = resolvePromise; });
  const evals: EvalRouteService = {
    async cancel() { throw new Error('Unexpected cancellation.'); },
    async compare() { throw new Error('Unexpected comparison.'); },
    async events() { throw new Error('Unexpected event replay.'); },
    async list() { throw new Error('Unexpected run listing.'); },
    async openArtifact() { throw new Error('Unexpected artifact read.'); },
    async read() { throw new Error('Unexpected run read.'); },
    async start() { throw new Error('Unexpected run start.'); },
    async subscribeEvents() {
      signalRouteAdmission();
      await routeAdmissionRelease;
      return Object.freeze({
        activate: (): void => undefined,
        close: (): void => undefined,
        replay: Object.freeze({ cursor: Object.freeze({ afterSequence: 0 }), events: Object.freeze([]) }),
      });
    },
    async suites() { throw new Error('Unexpected suite listing.'); },
  };
  const coordinator = {
    close: async (): Promise<void> => {
      coordinatorCloseCalls += 1;
      coordinatorObservedEvalClosed = evalClosed;
    },
    rebuild: async (): Promise<unknown> => undefined,
    start: async (): Promise<void> => undefined,
    status,
  };
  const server = await startForegroundServer({
    agentApi: {
      close: async (): Promise<void> => {
        signalAgentClose();
        await agentCloseRelease;
        agentClosed = true;
      },
    } as never,
    coordinator,
    evals,
    evalLifecycle: {
      close: async (): Promise<void> => {
        evalCloseCalls += 1;
        evalObservedAgentClosed = agentClosed;
        signalEvalClose();
        await evalCloseRelease;
        evalClosed = true;
      },
    },
    eventHub: new ProjectEventHub(),
    port: 0,
  });
  const stream = fetch(`${server.url}/api/evals/runs/run-a/stream`, {
    headers: { origin: server.url, 'x-agent-bundle-session': server.sessionToken },
  });
  try {
    await routeAdmissionStarted;
    const closing = server.close();
    await expect(within(agentCloseStarted, 250)).resolves.toBeUndefined();
    expect(evalCloseCalls).toBe(0);
    expect(coordinatorCloseCalls).toBe(0);

    releaseRouteAdmission();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(evalCloseCalls).toBe(0);

    releaseAgentClose();
    await evalCloseStarted;
    expect(evalObservedAgentClosed).toBe(true);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(coordinatorCloseCalls).toBe(0);

    releaseEvalClose();
    await expect(closing).resolves.toBeUndefined();
    expect(coordinatorCloseCalls).toBe(1);
    expect(coordinatorObservedEvalClosed).toBe(true);
  } finally {
    releaseRouteAdmission();
    releaseAgentClose();
    releaseEvalClose();
    await stream.catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

it('aggregates a hook playground drain failure while still releasing the server and coordinator', async () => {
  const coordinator = new RecordingCoordinator();
  const hookPlayground = new GatedHookPlayground();
  hookPlayground.failure = new Error('simulation clone could not be removed');
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    hookPlayground,
    port: 0,
  });
  const simulation = startSimulation(server);
  await hookPlayground.admitted;

  const closed = server.close();
  hookPlayground.release();
  await expect(closed).rejects.toMatchObject({
    failures: [{
      error: expect.objectContaining({ failures: [{ error: hookPlayground.failure, operation: 'simulation' }] }),
      resource: 'hook-playground',
    }],
    name: 'ForegroundServerCloseError',
  });
  await expect(server.close()).rejects.toMatchObject({
    failures: [expect.objectContaining({ resource: 'hook-playground' })],
  });
  expect(coordinator.closeCalls).toBe(1);
  await simulation;
});

it('drains the Eval service after routes close and retains its shutdown failure', async () => {
  const coordinator = new RecordingCoordinator();
  const evalFailure = new Error('eval cancellation cleanup failed');
  let evalCloseCalls = 0;
  const server = await startForegroundServer({
    coordinator,
    evalLifecycle: {
      close: async () => {
        evalCloseCalls += 1;
        throw evalFailure;
      },
    },
    eventHub: new ProjectEventHub(),
    port: 0,
  });
  try {
    await expect(server.close()).rejects.toMatchObject({
      failures: [{ error: evalFailure, resource: 'eval-service' }],
      name: 'ForegroundServerCloseError',
    });
    expect(evalCloseCalls).toBe(1);
    expect(coordinator.closeCalls).toBe(1);
  } finally {
    await server.close().catch(() => undefined);
  }
});

/** Re-enters the foreground close from its own abort callback, as a cleanup listener would. */
class ReentrantHookPlayground implements HookPlaygroundRouteService {
  nested: Promise<void> | undefined;
  server: ForegroundServer | undefined;
  readonly #admitted: Promise<void>;
  #admit!: () => void;

  constructor() {
    this.#admitted = new Promise<void>((resolvePromise) => { this.#admit = resolvePromise; });
  }

  get admitted(): Promise<void> {
    return this.#admitted;
  }

  async list(): Promise<readonly HookPlaygroundHook[]> {
    return Object.freeze([]);
  }

  async replay(_replay: HookPlaygroundReplay, options?: { readonly signal?: AbortSignal }): Promise<never> {
    return this.#run(options?.signal);
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<never> {
    return this.#run(options.signal);
  }

  #run(signal: AbortSignal | undefined): Promise<never> {
    this.#admit();
    return new Promise<never>((_resolvePromise, rejectPromise) => {
      const cancel = (): void => {
        this.nested = this.server?.close();
        rejectPromise(signal?.reason);
      };
      if (signal === undefined || signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }
}

it('publishes one foreground shutdown outcome before any abort callback can re-enter close', async () => {
  const coordinator = new RecordingCoordinator();
  coordinator.failClose = true;
  const hookPlayground = new ReentrantHookPlayground();
  const server = await startForegroundServer({
    coordinator,
    eventHub: new ProjectEventHub(),
    hookPlayground,
    port: 0,
  });
  hookPlayground.server = server;
  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on('unhandledRejection', recordUnhandled);

  try {
    const simulation = startSimulation(server);
    await hookPlayground.admitted;

    const closing = server.close();
    expect(hookPlayground.nested).toBe(closing);
    expect(server.close()).toBe(closing);

    await expect(closing).rejects.toMatchObject({
      failures: [{ error: expect.objectContaining({ message: 'coordinator close failure' }), resource: 'coordinator' }],
      name: 'ForegroundServerCloseError',
    });
    expect(coordinator.closeCalls).toBe(1);
    await simulation;

    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 20); });
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
    await hookPlayground.nested?.catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});
