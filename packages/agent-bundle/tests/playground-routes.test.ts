import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  PlaygroundRoutes,
  type PlaygroundRouteService,
} from '../src/dev/playground-routes.ts';
import {
  PlaygroundServiceError,
  type DraftEvalCase,
  type PlaygroundDurableOutcome,
  type PlaygroundEventInput,
  type PlaygroundExport,
  type PlaygroundReplay,
  type PlaygroundReplayCursor,
  type PlaygroundSelectedAssertion,
  type PlaygroundSession,
  type PlaygroundSessionInput,
  type PlaygroundSubscribeOptions,
  type PlaygroundSubscription,
  type PlaygroundTraceEvent,
} from '../src/services/playground-service.ts';

interface StartedRoutes {
  readonly close: () => Promise<void>;
  readonly routes: PlaygroundRoutes;
  readonly url: string;
}

const routeError = (code: string, message: string, status: number): Error & {
  readonly code: string;
  readonly message: string;
  readonly status: number;
} => Object.assign(new Error(message), { code, message, status });

const authorize = (request: IncomingMessage): void => {
  if (request.headers['x-agent-bundle-session'] !== 'test-session-token') {
    throw routeError('AB8004', 'A valid same-session token is required.', 403);
  }
};

const startRoutes = async (service?: PlaygroundRouteService): Promise<StartedRoutes> => {
  const routes = new PlaygroundRoutes({ authorize, ...(service === undefined ? {} : { service }) });
  const server = createServer((request, response) => {
    void routes.handle(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    }).catch((error: unknown) => {
      const diagnostic = error as Partial<{ code: string; message: string; status: number }>;
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.writeHead(diagnostic.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ diagnostic: {
        code: diagnostic.code ?? 'AB8007',
        message: diagnostic.message ?? 'Request could not be completed.',
      } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise));
  const address = server.address() as AddressInfo;
  return Object.freeze({
    close: async () => {
      routes.close();
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      }));
    },
    routes,
    url: `http://127.0.0.1:${address.port}`,
  });
};

const identity = Object.freeze({
  epoch: Object.freeze({ digest: 'sha256-epoch', id: 'epoch-a' }),
  fixture: Object.freeze({ digest: 'sha256-fixture', id: 'fixture-a' }),
  invocation: Object.freeze({ intent: Object.freeze({ hook: 'hook-a' }), kind: 'hook' }),
  target: Object.freeze({ digest: 'sha256-target', name: 'claude' }),
  task: Object.freeze({ id: 'task-a', text: 'Run the session start hook.' }),
});

const sessionFixture: PlaygroundSession = Object.freeze({
  cleanupFailures: Object.freeze([]),
  createdAt: '2026-08-15T00:00:00.000Z',
  id: 'session-a',
  identity,
  state: 'open',
});

const eventFixture: PlaygroundTraceEvent = Object.freeze({
  kind: 'hook.simulated',
  raw: Object.freeze({ outcome: 'continue' }),
  rawEventRef: 'session-a/1',
  sequence: 1,
  source: 'hook',
  summary: 'Simulated the session start hook.',
  timestamp: '2026-08-15T00:00:01.000Z',
});

const outcomeFixture: PlaygroundDurableOutcome = Object.freeze({
  response: 'continued',
  status: 'passed',
});

const finalizedFixture: PlaygroundSession = Object.freeze({
  ...sessionFixture,
  outcome: outcomeFixture,
  state: 'finalized',
});

const replayFixture: PlaygroundReplay = Object.freeze({
  cursor: Object.freeze({ afterSequence: 1 }),
  events: Object.freeze([eventFixture]),
  session: sessionFixture,
});

const exportFixture: PlaygroundExport = Object.freeze({
  events: Object.freeze([eventFixture]),
  schemaVersion: 1,
  session: finalizedFixture,
});

const draftFixture: DraftEvalCase = Object.freeze({
  assertions: Object.freeze([Object.freeze({
    evidence: 'session-a/1',
    expectation: 'continue',
    id: 'assertion-a',
    kind: 'hook-outcome',
  })]),
  epoch: identity.epoch,
  fixture: identity.fixture,
  invocation: identity.invocation,
  outcome: outcomeFixture,
  schemaVersion: 1,
  target: identity.target,
  task: identity.task,
});

class RecordingService implements PlaygroundRouteService {
  readonly calls: unknown[] = [];
  readonly listeners = new Set<(event: PlaygroundTraceEvent) => void | Promise<void>>();
  failure: Error | undefined;
  missing = false;
  subscriptionsClosed = 0;

  async openSession(input: PlaygroundSessionInput): Promise<PlaygroundSession> {
    this.calls.push({ input, kind: 'openSession' });
    if (this.failure !== undefined) throw this.failure;
    return sessionFixture;
  }

  async reopen(sessionId: string): Promise<PlaygroundSession> {
    this.calls.push({ kind: 'reopen', sessionId });
    if (this.failure !== undefined) throw this.failure;
    return sessionFixture;
  }

  session(sessionId: string): PlaygroundSession | undefined {
    this.calls.push({ kind: 'session', sessionId });
    return this.missing ? undefined : sessionFixture;
  }

  async append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent> {
    this.calls.push({ input, kind: 'append', sessionId });
    if (this.failure !== undefined) throw this.failure;
    return eventFixture;
  }

  async finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession> {
    this.calls.push({ kind: 'finalize', outcome, sessionId });
    if (this.failure !== undefined) throw this.failure;
    return finalizedFixture;
  }

  async replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    this.calls.push({ cursor, kind: 'replay', sessionId });
    if (this.failure !== undefined) throw this.failure;
    return replayFixture;
  }

  async subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription> {
    this.calls.push({ afterSequence: options.afterSequence, kind: 'subscribe', sessionId });
    if (this.failure !== undefined) throw this.failure;
    this.listeners.add(options.onEvent);
    const record = { closed: false };
    return Object.freeze({
      close: async () => {
        record.closed = true;
        this.subscriptionsClosed += 1;
        this.listeners.delete(options.onEvent);
      },
      get closed(): boolean {
        return record.closed;
      },
    });
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    this.calls.push({ kind: 'export', sessionId });
    if (this.failure !== undefined) throw this.failure;
    return exportFixture;
  }

  async promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase> {
    this.calls.push({ kind: 'promoteToDraftEval', selectedAssertions, sessionId });
    if (this.failure !== undefined) throw this.failure;
    return draftFixture;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.calls.push({ kind: 'closeSession', sessionId });
    if (this.failure !== undefined) throw this.failure;
  }

  emit(event: PlaygroundTraceEvent): void {
    for (const listener of this.listeners) void listener(event);
  }
}

const headers = (): Readonly<Record<string, string>> => ({ 'x-agent-bundle-session': 'test-session-token' });

const jsonHeaders = (): Readonly<Record<string, string>> => ({ ...headers(), 'content-type': 'application/json' });

const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
  body: JSON.stringify(body),
  headers: jsonHeaders(),
  method: 'POST',
});

const sessionBody = () => ({
  epoch: { digest: 'sha256-epoch', id: 'epoch-a' },
  fixture: { digest: 'sha256-fixture', id: 'fixture-a' },
  invocation: { intent: { hook: 'hook-a' }, kind: 'hook' },
  target: { digest: 'sha256-target', name: 'claude' },
  task: { id: 'task-a', text: 'Run the session start hook.' },
});

const readLines = async (response: Response, count: number): Promise<readonly unknown[]> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Expected a playground stream body.');
  const decoder = new TextDecoder();
  let buffered = '';
  const lines: unknown[] = [];
  while (lines.length < count) {
    const next = await reader.read();
    if (next.done) break;
    buffered += decoder.decode(next.value, { stream: true });
    const split = buffered.split('\n');
    buffered = split.pop() ?? '';
    for (const line of split) if (line.length > 0) lines.push(JSON.parse(line));
  }
  await reader.cancel();
  return lines;
};

const eventually = async (predicate: () => boolean, milliseconds: number): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
};

it('opens, reads, reopens, and closes a playground session', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const opened = await post(`${started.url}/api/playground/sessions`, sessionBody());
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toEqual({ session: sessionFixture });

    const read = await fetch(`${started.url}/api/playground/sessions/session-a`, { headers: headers() });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({ session: sessionFixture });

    const reopened = await post(`${started.url}/api/playground/sessions/session-a/reopen`, {});
    expect(reopened.status).toBe(200);
    await expect(reopened.json()).resolves.toEqual({ session: sessionFixture });

    const closed = await fetch(`${started.url}/api/playground/sessions/session-a`, {
      headers: headers(),
      method: 'DELETE',
    });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toEqual({ closed: true });

    expect(service.calls).toEqual([
      { input: sessionBody(), kind: 'openSession' },
      { kind: 'session', sessionId: 'session-a' },
      { kind: 'reopen', sessionId: 'session-a' },
      { kind: 'closeSession', sessionId: 'session-a' },
    ]);
  } finally {
    await started.close();
  }
});

it('accepts an explicit session id but never an unknown identity field', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const opened = await post(`${started.url}/api/playground/sessions`, { ...sessionBody(), sessionId: 'session-a' });
    expect(opened.status).toBe(200);
    expect(service.calls).toEqual([{ input: { ...sessionBody(), sessionId: 'session-a' }, kind: 'openSession' }]);

    const smuggled = [
      { ...sessionBody(), command: '/tmp/untrusted' },
      { ...sessionBody(), storageRoot: '/tmp/untrusted' },
      { ...sessionBody(), projectId: 'other-project' },
      { ...sessionBody(), target: { command: '/tmp/untrusted', name: 'claude' } },
      { ...sessionBody(), invocation: { intent: { hook: 'hook-a' }, kind: 'hook', command: '/tmp/untrusted' } },
    ];
    for (const body of smuggled) {
      const rejected = await post(`${started.url}/api/playground/sessions`, body);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8042', message: 'Playground request has an invalid shape.' },
      });
    }
    expect(service.calls).toHaveLength(1);
  } finally {
    await started.close();
  }
});

it('appends trace events and finalizes a durable outcome', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const appended = await post(`${started.url}/api/playground/sessions/session-a/events`, {
      kind: 'hook.simulated',
      raw: { outcome: 'continue' },
      source: 'hook',
      summary: 'Simulated the session start hook.',
    });
    expect(appended.status).toBe(200);
    await expect(appended.json()).resolves.toEqual({ event: eventFixture });

    const finalized = await post(`${started.url}/api/playground/sessions/session-a/finalize`, {
      response: 'continued',
      status: 'passed',
    });
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toEqual({ session: finalizedFixture });

    expect(service.calls).toEqual([
      {
        input: {
          kind: 'hook.simulated',
          raw: { outcome: 'continue' },
          source: 'hook',
          summary: 'Simulated the session start hook.',
        },
        kind: 'append',
        sessionId: 'session-a',
      },
      { kind: 'finalize', outcome: { response: 'continued', status: 'passed' }, sessionId: 'session-a' },
    ]);
  } finally {
    await started.close();
  }
});

it('rejects trace events with an unknown source or a non-JSON payload', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const bodies = [
      { kind: 'hook.simulated', raw: {}, source: 'shell', summary: 'ok' },
      { kind: 'hook.simulated', raw: {}, summary: 'ok' },
      { kind: 'hook.simulated', source: 'hook', summary: 'ok' },
      { kind: '', raw: {}, source: 'hook', summary: 'ok' },
      { kind: 'hook.simulated', path: '/tmp/untrusted', raw: {}, source: 'hook', summary: 'ok' },
    ];
    for (const body of bodies) {
      const rejected = await post(`${started.url}/api/playground/sessions/session-a/events`, body);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toEqual({
        diagnostic: { code: 'AB8042', message: 'Playground request has an invalid shape.' },
      });
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('replays from a cursor and exports the ordered trace', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const replayed = await fetch(`${started.url}/api/playground/sessions/session-a/replay?after=0`, { headers: headers() });
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ replay: replayFixture });

    const exported = await fetch(`${started.url}/api/playground/sessions/session-a/export`, { headers: headers() });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toEqual({ export: exportFixture });

    const invalidCursor = await fetch(`${started.url}/api/playground/sessions/session-a/replay?after=-1`, { headers: headers() });
    expect(invalidCursor.status).toBe(400);

    expect(service.calls).toEqual([
      { cursor: { afterSequence: 0 }, kind: 'replay', sessionId: 'session-a' },
      { kind: 'export', sessionId: 'session-a' },
    ]);
  } finally {
    await started.close();
  }
});

it('streams appended events and releases the subscription when the reader leaves', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const stream = await fetch(`${started.url}/api/playground/sessions/session-a/stream?after=0`, { headers: headers() });
    expect(stream.status).toBe(200);
    await eventually(() => service.listeners.size === 1, 1_000);
    service.emit(eventFixture);
    await expect(readLines(stream, 1)).resolves.toEqual([eventFixture]);
    await eventually(() => service.subscriptionsClosed === 1, 1_000);
    expect(service.calls).toEqual([{ afterSequence: 0, kind: 'subscribe', sessionId: 'session-a' }]);
  } finally {
    await started.close();
  }
});

it('promotes a finalized session into the frozen draft eval shape', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const promoted = await post(`${started.url}/api/playground/sessions/session-a/draft-eval`, {
      assertions: [{ evidence: 'session-a/1', expectation: 'continue', id: 'assertion-a', kind: 'hook-outcome' }],
    });
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toEqual({ draftEvalCase: draftFixture });
    expect(service.calls).toEqual([{
      kind: 'promoteToDraftEval',
      selectedAssertions: [{ evidence: 'session-a/1', expectation: 'continue', id: 'assertion-a', kind: 'hook-outcome' }],
      sessionId: 'session-a',
    }]);

    const rejected = await post(`${started.url}/api/playground/sessions/session-a/draft-eval`, {
      assertions: [{ expectation: 'continue', id: 'assertion-a', kind: 'hook-outcome' }],
    });
    expect(rejected.status).toBe(400);
  } finally {
    await started.close();
  }
});

it('maps every playground service failure to its own actionable diagnostic', async () => {
  const cases = [
    { code: 'PLAYGROUND_SESSION_NOT_FOUND', diagnostic: 'AB8044', status: 404 },
    { code: 'PLAYGROUND_SESSION_CONFLICT', diagnostic: 'AB8045', status: 409 },
    { code: 'PLAYGROUND_SESSION_FINALIZED', diagnostic: 'AB8046', status: 409 },
    { code: 'PLAYGROUND_SESSION_OWNED', diagnostic: 'AB8047', status: 409 },
    { code: 'PLAYGROUND_CURSOR_AHEAD', diagnostic: 'AB8048', status: 409 },
    { code: 'PLAYGROUND_CURSOR_INVALID', diagnostic: 'AB8049', status: 400 },
    { code: 'PLAYGROUND_VALUE_INVALID', diagnostic: 'AB8050', status: 400 },
    { code: 'PLAYGROUND_SESSION_ID_INVALID', diagnostic: 'AB8051', status: 400 },
    { code: 'PLAYGROUND_OUTCOME_REQUIRED', diagnostic: 'AB8052', status: 400 },
    { code: 'PLAYGROUND_CREDENTIAL_REJECTED', diagnostic: 'AB8053', status: 400 },
    { code: 'PLAYGROUND_SERVICE_CLOSED', diagnostic: 'AB8054', status: 503 },
    { code: 'PLAYGROUND_STORE_CORRUPT', diagnostic: 'AB8055', status: 500 },
    { code: 'PLAYGROUND_ROOT_INVALID', diagnostic: 'AB8056', status: 500 },
    { code: 'PLAYGROUND_PROJECT_MISMATCH', diagnostic: 'AB8057', status: 409 },
  ] as const;

  for (const entry of cases) {
    const service = new RecordingService();
    service.failure = new PlaygroundServiceError(entry.code, `/private/store/path leaked ${entry.code}`);
    const started = await startRoutes(service);
    try {
      const failed = await post(`${started.url}/api/playground/sessions`, sessionBody());
      expect(failed.status).toBe(entry.status);
      const body = await failed.json() as { readonly diagnostic: { readonly code: string; readonly message: string } };
      expect(body.diagnostic.code).toBe(entry.diagnostic);
      expect(body.diagnostic.message).not.toContain('/private/store/path');
    } finally {
      await started.close();
    }
  }
});

it('reports an unknown session, an absent service, and a closed route group', async () => {
  const absent = await startRoutes();
  try {
    const unavailable = await fetch(`${absent.url}/api/playground/sessions/session-a`, { headers: headers() });
    expect(unavailable.status).toBe(404);
    await expect(unavailable.json()).resolves.toEqual({
      diagnostic: { code: 'AB8041', message: 'Playground routes are not available.' },
    });
  } finally {
    await absent.close();
  }

  const service = new RecordingService();
  service.missing = true;
  const started = await startRoutes(service);
  try {
    const unknown = await fetch(`${started.url}/api/playground/sessions/session-a`, { headers: headers() });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      diagnostic: { code: 'AB8044', message: 'Playground session was not found.' },
    });

    started.routes.close();
    const closed = await fetch(`${started.url}/api/playground/sessions/session-a`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8041', message: 'Playground routes are not available.' },
    });
  } finally {
    await started.close();
  }
});

it('rejects unsupported playground methods, media types, and paths', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const method = await fetch(`${started.url}/api/playground/sessions`, { headers: headers() });
    expect(method.status).toBe(405);

    const media = await fetch(`${started.url}/api/playground/sessions`, {
      body: 'epochId=epoch-a',
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });
    expect(media.status).toBe(415);

    const unknownPath = await fetch(`${started.url}/api/playground/sessions/session-a/unknown`, { headers: headers() });
    expect(unknownPath.status).toBe(400);
    await expect(unknownPath.json()).resolves.toEqual({
      diagnostic: { code: 'AB8040', message: 'Playground route path is not valid.' },
    });

    const traversal = await fetch(`${started.url}/api/playground/sessions/..%2Fescape`, { headers: headers() });
    expect(traversal.status).toBe(400);

    const unauthorized = await fetch(`${started.url}/api/playground/sessions/session-a`);
    expect(unauthorized.status).toBe(403);

    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('closes every open stream when the route group closes', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const stream = await fetch(`${started.url}/api/playground/sessions/session-a/stream?after=0`, { headers: headers() });
    expect(stream.status).toBe(200);
    await eventually(() => service.listeners.size === 1, 1_000);

    started.routes.close();
    await eventually(() => service.subscriptionsClosed === 1, 1_000);
    await stream.body?.cancel();
  } finally {
    await started.close();
  }
});
