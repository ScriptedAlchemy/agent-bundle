import { expect, it } from '@rstest/core';

import {
  PlaygroundRoutes,
  type PlaygroundOperationRequest,
  type PlaygroundRun,
  type PlaygroundRouteService,
} from '../src/dev/playground/playground-routes.ts';
import type {
  DraftEvalCase,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundReplayCursor,
  PlaygroundSession,
  PlaygroundSubscribeOptions,
  PlaygroundSubscription,
  PlaygroundTraceEvent,
} from '../src/dev/playground/playground-store.ts';
import {
  authorizeSession as authorize,
  sessionHeaders as headers,
  startRoutes as startRouteServer,
  type StartedRoutes,
} from './support/route-harness.ts';

const startRoutes = async (service?: PlaygroundRouteService): Promise<StartedRoutes<PlaygroundRoutes>> =>
  startRouteServer(new PlaygroundRoutes({ authorize, ...(service === undefined ? {} : { service }) }));

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
    expect(service.calls[0]).toMatchObject({ signal: undefined });
  } finally {
    await started.close();
  }
});

it('lists a server-owned native catalog and admits only its opaque native prompt selection', async () => {
  const service = new RecordingService() as RecordingService & {
    catalog(options?: { readonly epochId?: string }): Promise<unknown>;
  };
  service.catalog = async (options) => {
    service.calls.push({ kind: 'catalog', options });
    return Object.freeze({
      cases: Object.freeze([Object.freeze({ id: 'case-opaque-a', label: 'Review fixture' })]),
      epochId: 'epoch-server-owned',
      fixtures: Object.freeze([Object.freeze({ id: 'fixture-opaque-a', label: 'Review fixture' })]),
      modelPins: Object.freeze([Object.freeze({ host: 'claude', id: 'model-opaque-a', label: 'Pinned Claude model' })]),
    });
  };
  const started = await startRoutes(service as unknown as PlaygroundRouteService);
  try {
    const catalog = await fetch(`${started.url}/api/playground/catalog?epochId=epoch-server-owned`, { headers: headers() });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toEqual({ catalog: {
      cases: [{ id: 'case-opaque-a', label: 'Review fixture' }],
      epochId: 'epoch-server-owned',
      fixtures: [{ id: 'fixture-opaque-a', label: 'Review fixture' }],
      modelPins: [{ host: 'claude', id: 'model-opaque-a', label: 'Pinned Claude model' }],
    } });

    const response = await post(`${started.url}/api/playground/runs`, {
      caseId: 'case-opaque-a',
      epochId: 'epoch-server-owned',
      fixtureId: 'fixture-opaque-a',
      host: 'claude',
      modelPinId: 'model-opaque-a',
      operation: 'native.prompt',
      prompt: 'Review this fixture.',
      target: 'claude',
    });
    expect(response.status).toBe(200);
    expect(service.calls).toEqual([
      { kind: 'catalog', options: { epochId: 'epoch-server-owned' } },
      expect.objectContaining({
        input: {
          caseId: 'case-opaque-a',
          epochId: 'epoch-server-owned',
          fixtureId: 'fixture-opaque-a',
          host: 'claude',
          modelPinId: 'model-opaque-a',
          operation: 'native.prompt',
          prompt: 'Review this fixture.',
          target: 'claude',
        },
        kind: 'run',
      }),
    ]);
  } finally { await started.close(); }
});

it('rejects native prompt smuggling and duplicate browser fields before service admission', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  const valid = {
    caseId: 'case-opaque-a',
    fixtureId: 'fixture-opaque-a',
    host: 'codex',
    modelPinId: 'model-opaque-a',
    operation: 'native.prompt',
    prompt: 'Review this fixture.',
    target: 'codex',
  };
  try {
    for (const body of [
      { ...valid, command: 'codex exec --dangerous' },
      { ...valid, cwd: '/private/secret' },
      { ...valid, env: { API_KEY: 'secret' } },
      { ...valid, evidence: { outcome: 'passed' } },
      { ...valid, model: 'browser-picked-model' },
      { ...valid, outcome: 'passed' },
      { ...valid, path: '../../fixture' },
      '{"operation":"native.prompt","prompt":"Review this fixture.","caseId":"case-opaque-a","caseId":"case-opaque-b","fixtureId":"fixture-opaque-a","target":"codex","host":"codex","modelPinId":"model-opaque-a"}',
    ]) {
      const response = typeof body === 'string'
        ? await fetch(`${started.url}/api/playground/runs`, { body, headers: jsonHeaders(), method: 'POST' })
        : await post(`${started.url}/api/playground/runs`, body);
      expect(response.status).toBe(400);
    }
    expect(service.calls).toEqual([]);
  } finally { await started.close(); }
});

it('rejects forged epochs, browser evidence, outcomes, and executable fields before orchestration', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const body of [
      { epochId: 'another-epoch', operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' },
      { operation: 'skill.inspect', raw: { forged: true }, skillId: 'skill:review', target: 'codex' },
      { operation: 'skill.inspect', outcome: { status: 'passed' }, skillId: 'skill:review', target: 'codex' },
      { command: '/bin/sh', operation: 'script.run', scriptId: 'script:review', target: 'codex' },
      { cwd: '/tmp', operation: 'script.run', scriptId: 'script:review', target: 'codex' },
      { env: { PATH: '/tmp' }, operation: 'script.run', scriptId: 'script:review', target: 'codex' },
      { operation: 'script.run', path: '../../escape.sh', scriptId: 'script:review', target: 'codex' },
      { args: ['--unsafe'], operation: 'script.run', scriptId: 'script:review', target: 'codex' },
      { operation: 'script.run', script: 'review.mjs', scriptId: 'script:review', target: 'codex' },
    ]) {
      const response = await post(`${started.url}/api/playground/runs`, body);
      expect(response.status).toBe(400);
    }
    expect(service.calls).toEqual([]);
  } finally {
    await started.close();
  }
});

it('admits only a target-scoped script id and never forwards a raw script path', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await post(`${started.url}/api/playground/runs`, {
      operation: 'script.run', scriptId: 'script:review', target: 'codex',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { id: 'run-server-owned', session: sessionFixture } });
    expect(service.calls).toEqual([expect.objectContaining({
      input: { operation: 'script.run', scriptId: 'script:review', target: 'codex' },
      kind: 'run',
      signal: undefined,
    })]);
  } finally { await started.close(); }
});

it('rejects a legacy raw script field before it can alter the selected script id', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    const response = await post(`${started.url}/api/playground/runs`, {
      operation: 'script.run', script: 'review.mjs', scriptId: 'script:review', target: 'codex',
    });
    expect(response.status).toBe(400);
    expect(service.calls).toEqual([]);
  } finally { await started.close(); }
});

it('rejects duplicate operation, target, and nested JSON keys before admission', async () => {
  const service = new RecordingService();
  const started = await startRoutes(service);
  try {
    for (const body of [
      '{"operation":"skill.inspect","operation":"script.run","skillId":"skill:review","target":"codex"}',
      '{"operation":"skill.inspect","skillId":"skill:review","target":"codex","target":"other"}',
      '{"operation":"hook.simulate","hook":"session-start","input":{"value":1,"value":2},"target":"codex"}',
    ]) {
      const response = await fetch(`${started.url}/api/playground/runs`, { body, headers: jsonHeaders(), method: 'POST' });
      expect(response.status).toBe(400);
    }
    expect(service.calls).toEqual([]);
  } finally { await started.close(); }
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
