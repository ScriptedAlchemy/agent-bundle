import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  PlaygroundRoutes,
  type PlaygroundOperationRequest,
  type PlaygroundRun,
  type PlaygroundRouteService,
} from '../src/dev/playground-routes.ts';
import type {
  DraftEvalCase,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundReplayCursor,
  PlaygroundSession,
  PlaygroundSubscribeOptions,
  PlaygroundSubscription,
  PlaygroundTraceEvent,
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

const sessionFixture: PlaygroundSession = Object.freeze({
  cleanupFailures: Object.freeze([]),
  createdAt: '2026-08-18T00:00:00.000Z',
  id: 'session-server-owned',
  identity: Object.freeze({
    epoch: Object.freeze({ digest: 'epoch-sha256', id: 'epoch-server-owned' }),
    fixture: Object.freeze({ digest: 'fixture-sha256', id: 'workspace-server-owned' }),
    invocation: Object.freeze({ intent: Object.freeze({ skillId: 'skill:review' }), kind: 'skill.inspect' }),
    target: Object.freeze({ digest: 'target-sha256', name: 'codex' }),
    task: Object.freeze({ id: 'run-server-owned', text: 'Inspect an emitted Skill.' }),
  }),
  state: 'finalized',
});

const eventFixture: PlaygroundTraceEvent = Object.freeze({
  kind: 'skill.inspected',
  raw: Object.freeze({ skillId: 'skill:review' }),
  rawEventRef: 'events.jsonl#1',
  sequence: 1,
  source: 'skill-evidence',
  summary: 'Inspected emitted Skill.',
  timestamp: '2026-08-18T00:00:01.000Z',
});

const replayFixture: PlaygroundReplay = Object.freeze({
  cursor: Object.freeze({ afterSequence: 1 }),
  events: Object.freeze([eventFixture]),
  session: sessionFixture,
});

const exportFixture: PlaygroundExport = Object.freeze({
  events: Object.freeze([eventFixture]),
  schemaVersion: 1,
  session: sessionFixture,
});

const draftFixture: DraftEvalCase = Object.freeze({
  assertions: Object.freeze([Object.freeze({
    evidence: Object.freeze({ rawEventRef: 'events.jsonl#1' }),
    expectation: Object.freeze({ kind: 'skill.inspected', source: 'skill-evidence' }),
    id: 'events.jsonl#1',
    kind: 'playground-event',
  })]),
  epoch: sessionFixture.identity.epoch,
  fixture: sessionFixture.identity.fixture,
  invocation: sessionFixture.identity.invocation,
  outcome: Object.freeze({ status: 'passed' }),
  schemaVersion: 1,
  target: sessionFixture.identity.target,
  task: sessionFixture.identity.task,
});

class RecordingService implements PlaygroundRouteService {
  readonly calls: unknown[] = [];
  readonly listeners = new Set<(event: PlaygroundTraceEvent) => void | Promise<void>>();

  async run(input: PlaygroundOperationRequest, options?: { readonly signal?: AbortSignal }): Promise<PlaygroundRun> {
    this.calls.push({ input, kind: 'run', signal: options?.signal });
    return Object.freeze({ id: 'run-server-owned', session: sessionFixture });
  }

  async cancel(runId: string): Promise<boolean> {
    this.calls.push({ kind: 'cancel', runId });
    return runId === 'run-server-owned';
  }

  session(sessionId: string): PlaygroundSession | undefined {
    this.calls.push({ kind: 'session', sessionId });
    return sessionId === sessionFixture.id ? sessionFixture : undefined;
  }

  async replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    this.calls.push({ cursor, kind: 'replay', sessionId });
    return replayFixture;
  }

  async subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription> {
    this.calls.push({ afterSequence: options.afterSequence, kind: 'subscribe', sessionId });
    this.listeners.add(options.onEvent);
    let closed = false;
    return Object.freeze({
      close: async () => { closed = true; this.listeners.delete(options.onEvent); },
      get closed(): boolean { return closed; },
    });
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    this.calls.push({ kind: 'export', sessionId });
    return exportFixture;
  }

  async promoteToDraftEval(sessionId: string, rawEventRefs: readonly string[]): Promise<DraftEvalCase> {
    this.calls.push({ kind: 'promoteToDraftEval', rawEventRefs, sessionId });
    return draftFixture;
  }
}

const headers = (): Readonly<Record<string, string>> => ({ 'x-agent-bundle-session': 'test-session-token' });
const jsonHeaders = (): Readonly<Record<string, string>> => ({ ...headers(), 'content-type': 'application/json' });
const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
  body: JSON.stringify(body),
  headers: jsonHeaders(),
  method: 'POST',
});

it('admits only a typed server-owned operation and mints its run identity', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await post(`${started.url}/api/playground/runs`, {
      operation: 'skill.inspect',
      skillId: 'skill:review',
      target: 'codex',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { id: 'run-server-owned', session: sessionFixture } });
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toMatchObject({
      input: { operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' },
      kind: 'run',
    });
  } finally {
    await started.close();
  }
});

it('rejects forged epochs, browser evidence, outcomes, and executable fields before orchestration', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const body of [
      { epochId: 'another-epoch', operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' },
      { operation: 'skill.inspect', raw: { forged: true }, skillId: 'skill:review', target: 'codex' },
      { operation: 'skill.inspect', outcome: { status: 'passed' }, skillId: 'skill:review', target: 'codex' },
      { command: '/bin/sh', operation: 'script.run', script: 'review.sh', target: 'codex' },
      { cwd: '/tmp', operation: 'script.run', script: 'review.sh', target: 'codex' },
      { env: { PATH: '/tmp' }, operation: 'script.run', script: 'review.sh', target: 'codex' },
      { operation: 'script.run', path: '../../escape.sh', script: 'review.sh', target: 'codex' },
    ]) {
      const response = await post(`${started.url}/api/playground/runs`, body);
      expect(response.status).toBe(400);
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('rejects retired browser-authored event, finalize, reopen, and session creation endpoints', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const [url, body] of [
      [`${started.url}/api/playground/sessions`, { epoch: {}, fixture: {}, invocation: {}, target: {}, task: {} }],
      [`${started.url}/api/playground/sessions/session-server-owned/events`, { kind: 'forged', raw: {}, source: 'response', summary: 'forged' }],
      [`${started.url}/api/playground/sessions/session-server-owned/finalize`, { response: 'forged', status: 'passed' }],
      [`${started.url}/api/playground/sessions/session-server-owned/reopen`, {}],
    ] as const) {
      const response = await post(url, body);
      expect(response.status).toBe(404);
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('cancels the real server-owned run and only promotes persisted raw event references', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const cancelled = await post(`${started.url}/api/playground/runs/run-server-owned/cancel`, {});
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toEqual({ cancelled: true });

    const promoted = await post(`${started.url}/api/playground/sessions/session-server-owned/draft-eval`, {
      rawEventRefs: ['events.jsonl#1'],
    });
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toEqual({ draftEvalCase: draftFixture });

    const forged = await post(`${started.url}/api/playground/sessions/session-server-owned/draft-eval`, {
      assertions: [{ evidence: 'forged', expectation: 'passed', id: 'forged', kind: 'forged' }],
    });
    expect(forged.status).toBe(400);
    expect(service.calls).toEqual([
      { kind: 'cancel', runId: 'run-server-owned' },
      { kind: 'promoteToDraftEval', rawEventRefs: ['events.jsonl#1'], sessionId: 'session-server-owned' },
    ]);
  } finally {
    await started.close();
  }
});

it('replays, exports, and streams only server-owned trace evidence', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const replay = await fetch(`${started.url}/api/playground/sessions/session-server-owned/replay?after=0`, { headers: headers() });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ replay: replayFixture });

    const exported = await fetch(`${started.url}/api/playground/sessions/session-server-owned/export`, { headers: headers() });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toEqual({ export: exportFixture });

    const stream = await fetch(`${started.url}/api/playground/sessions/session-server-owned/stream?after=0`, { headers: headers() });
    expect(stream.status).toBe(200);
    const listener = [...service.listeners][0];
    if (listener === undefined) throw new Error('Expected the route to register a trace listener.');
    await listener(eventFixture);
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected a trace stream body.');
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toBe(`${JSON.stringify(eventFixture)}\n`);
    await reader.cancel();
  } finally {
    await started.close();
  }
});

it('reports its own larger body limit rather than reusing the 64 KiB wire code', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);

  try {
    const oversized = await post(`${started.url}/api/playground/runs`, {
      hook: 'session-start',
      input: { padding: 'x'.repeat(1024 * 1024 + 16) },
      operation: 'hook.simulate',
      target: 'codex',
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      diagnostic: { code: 'AB8085', message: 'Request body exceeds 1 MiB.' },
    });
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});
