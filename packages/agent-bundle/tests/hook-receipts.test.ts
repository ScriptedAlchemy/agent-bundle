import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, it } from '@rstest/core';

import { DEV_INSTALL_MARKER } from '../src/dev/host-install-manager.ts';
import { attachHookReceipts, HookReceiptRoutes } from '../src/dev/hooks/hook-receipt-endpoint.ts';
import {
  decodeHookReceipt,
  HOOK_RECEIPT_MALFORMED_CODE,
  HOOK_RECEIPT_SESSION_CODE,
  HOOK_RECEIPT_TOO_LARGE_CODE,
  HOOK_RECEIPT_UNAUTHORIZED_CODE,
  HookReceiptDecodeError,
  HookReceiptSessionError,
  lowerHookReceipt,
} from '../src/dev/hooks/hook-receipts.ts';
import { diagnostic, isRequestDiagnostic, responseDiagnostic } from '../src/dev/http.ts';
import type { TraceEntry, TraceEntryInput } from '../src/dev/trace/trace-entry.ts';
import { TraceHub } from '../src/dev/trace/trace-hub.ts';
import {
  DEV_INSTALL_MARKER_FILE,
  EVENT_TRACE_RECEIPT_PATH,
  EVENT_TRACE_RECEIPT_SESSION_ENV,
  EVENT_TRACE_RECEIPT_TOKEN_ENV,
  EVENT_TRACE_RECEIPT_URL_ENV,
  eventTraceReceiptEndpointPath,
  eventTraceReceiptIdentity,
  eventTraceReceiptLineage,
  openEventTraceReceipt,
  resolveEventTraceReceiptEndpoint,
  type EventTraceReceipt,
} from '../src/events/trace-receipt.ts';
import { createEventTracer, eventTraceExecution } from '../src/events/trace.ts';
import { isLoopbackHttpOrigin } from '../src/core/loopback-origin.ts';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const execution = Object.freeze({
  event: 'tool/before',
  executionId: 'exec-1',
  host: 'claude',
  nativeEvent: 'PreToolUse',
} as const);

const receipt = (overrides: Partial<EventTraceReceipt> = {}): EventTraceReceipt => ({
  events: [
    { at: 100, kind: 'execute.start', phase: 'execute', runtime: 'standalone', sequence: 0 },
    { at: 101, kind: 'render.start', phase: 'render', sequence: 1 },
    { at: 106.5, durationMs: 5.5, kind: 'render.finish', phase: 'render', sequence: 2 },
  ],
  execution,
  identity: { conversationId: 'agent-7', requestId: 'toolu_1', sessionId: 'session-1' },
  lineage: {
    source: 'native',
    state: 'available',
    value: { conversation: 'session-1', depth: 1, parent: 'session-1', resolution: 'native', root: 'session-1', subagent: { id: 'agent-7', type: 'Explore' } },
  },
  startedAt: '2026-09-05T15:00:00.000Z',
  version: 1,
  ...overrides,
});

class FakePublisher {
  readonly entries: TraceEntryInput[] = [];

  publish(input: TraceEntryInput): TraceEntry {
    this.entries.push(input);
    return { ...input, id: `trc_${this.entries.length}`, occurredAt: input.occurredAt ?? 'now', sequence: this.entries.length };
  }
}

it('pins the wrapper-side marker name to the dev host installer', () => {
  expect(DEV_INSTALL_MARKER_FILE).toBe(DEV_INSTALL_MARKER);
});

it('accepts only serialized loopback HTTP origins', () => {
  expect(isLoopbackHttpOrigin('http://127.0.0.1:4321')).toBe(true);
  expect(isLoopbackHttpOrigin('http://[::1]:4321')).toBe(true);
  for (const rejected of [
    'http://127.0.0.1:4321/',
    'http://localhost:4321',
    'https://127.0.0.1:4321',
    'http://10.0.0.1:4321',
    'http://127.0.0.1:4321?x=1',
    'http://user@127.0.0.1:4321',
    'not a url',
    4321,
    undefined,
  ]) {
    expect(isLoopbackHttpOrigin(rejected)).toBe(false);
  }
});

it('projects host ids from the native payload without carrying the payload', () => {
  expect(eventTraceReceiptIdentity('claude', {
    agent_id: 'agent-7',
    session_id: 'session-1',
    tool_input: { command: 'rm -rf /' },
    tool_use_id: 'toolu_1',
  })).toEqual({ conversationId: 'agent-7', requestId: 'toolu_1', sessionId: 'session-1' });
  expect(eventTraceReceiptIdentity('claude', { session_id: 'session-1' }))
    .toEqual({ conversationId: 'session-1', sessionId: 'session-1' });
  expect(eventTraceReceiptIdentity('codex', { session_id: 'thread-1', tool_call_id: 'call-1', turn_id: 'turn-1' }))
    .toEqual({ conversationId: 'thread-1', requestId: 'call-1', sessionId: 'thread-1' });
  expect(eventTraceReceiptIdentity('cursor', { conversation_id: 'conv-1', generation_id: 'gen-1' }))
    .toEqual({ conversationId: 'conv-1', sessionId: 'conv-1' });
  expect(eventTraceReceiptIdentity('cursor', { session_id: '   ' })).toEqual({});
});

const hostSessionId = 'hs_0123456789abcdef';

it('accepts a valid top-level devSession and rejects a malformed one with AB8266', () => {
  expect(decodeHookReceipt({ ...receipt(), devSession: hostSessionId })).toEqual({
    ...receipt(),
    devSession: hostSessionId,
  });
  expect(lowerHookReceipt({ ...receipt(), devSession: hostSessionId })[0]?.correlation.sessionId).toBe('session-1');
  let caught: unknown;
  try {
    decodeHookReceipt({ ...receipt(), devSession: 'hs_nope' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HookReceiptSessionError);
  expect((caught as HookReceiptSessionError).code).toBe(HOOK_RECEIPT_SESSION_CODE);
  expect((caught as HookReceiptSessionError).path).toBe('devSession');
});

it('projects the lineage axis without the live tree', () => {
  expect(eventTraceReceiptLineage({ reason: 'no-subagent-events', state: 'unavailable' }))
    .toEqual({ reason: 'no-subagent-events', state: 'unavailable' });
  const projected = eventTraceReceiptLineage({
    source: 'native',
    state: 'available',
    value: {
      conversation: 'c',
      depth: 2,
      parent: 'p',
      resolution: 'registry',
      root: 'r',
      subagent: { id: 's', isParallelWorker: true, toolCallId: 't' },
      tree: { children: [], id: 'r', parents: [] },
    } as never,
  });
  expect(projected).toEqual({
    source: 'native',
    state: 'available',
    value: { conversation: 'c', depth: 2, parent: 'p', resolution: 'registry', root: 'r', subagent: { id: 's', isParallelWorker: true, toolCallId: 't' } },
  });
  expect(JSON.stringify(projected)).not.toContain('tree');
});

it('decodes a well-formed receipt and rejects unknown keys, bad enums, and unbounded fields', () => {
  const wire = JSON.parse(JSON.stringify(receipt())) as unknown;
  expect(decodeHookReceipt(wire)).toEqual(receipt());
  const rejects = (mutate: (value: Record<string, unknown>) => void, path: string): void => {
    const value = JSON.parse(JSON.stringify(receipt())) as Record<string, unknown>;
    mutate(value);
    let caught: unknown;
    try {
      decodeHookReceipt(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HookReceiptDecodeError);
    expect((caught as HookReceiptDecodeError).path).toBe(path);
  };
  rejects((value) => { value.version = 2; }, 'version');
  rejects((value) => { value.native = { tool_input: {} }; }, 'receipt');
  rejects((value) => { (value.execution as Record<string, unknown>).event = 'tool/whatever'; }, 'execution.event');
  rejects((value) => { (value.execution as Record<string, unknown>).executionId = 'x'.repeat(129); }, 'execution.executionId');
  rejects((value) => { (value.identity as Record<string, unknown>).cwd = '/home/me'; }, 'identity');
  rejects((value) => { value.lineage = { state: 'available', value: {} }; }, 'lineage.source');
  rejects((value) => { value.lineage = { reason: 'because', state: 'unavailable' }; }, 'lineage.reason');
  rejects((value) => { ((value.lineage as Record<string, unknown>).value as Record<string, unknown>).depth = -1; }, 'lineage.value.depth');
  rejects((value) => { value.startedAt = 'yesterday'; }, 'startedAt');
  rejects((value) => { value.events = new Array(33).fill({ at: 0, kind: 'render.start', phase: 'render', sequence: 0 }); }, 'events');
  rejects((value) => { (value.events as unknown[])[0] = { at: 0, kind: 'execute.start', phase: 'execute', runtime: 'cloud', sequence: 0 }; }, 'events[0].runtime');
  rejects((value) => { (value.events as unknown[])[1] = { at: 0, kind: 'render.start', phase: 'execute', sequence: 1 }; }, 'events[1].phase');
  rejects((value) => { (value.events as unknown[])[1] = { at: 0, kind: 'render.start', payload: {}, phase: 'render', sequence: 1 }; }, 'events[1]');
  rejects((value) => { (value.events as unknown[])[2] = { at: 0, kind: 'render.finish', phase: 'render', sequence: 1 }; }, 'events[2].sequence');
  rejects((value) => {
    (value.events as unknown[])[2] = { at: 1, error: { message: 'boom', name: 'Error', stack: 'at …' }, kind: 'failure', phase: 'render', sequence: 2 };
  }, 'events[2].error');
});

it('lowers a completed receipt to hook.received and hook.completed with the event route href', () => {
  const publisher = new FakePublisher();
  for (const entry of lowerHookReceipt(receipt())) publisher.publish(entry);
  const entries = publisher.entries;
  expect(entries.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.completed']);
  const correlation = {
    conversationId: 'agent-7',
    executionId: 'exec-1',
    host: 'claude',
    requestId: 'toolu_1',
    routeId: 'event:tool/before',
    sessionId: 'session-1',
  };
  expect(entries[0]).toMatchObject({
    correlation,
    href: '/routes/events/tool/before',
    occurredAt: '2026-09-05T15:00:00.000Z',
    source: 'hook',
    status: 'ok',
    summary: 'claude PreToolUse → tool/before received',
  });
  expect(entries[1]).toMatchObject({
    correlation,
    details: {
      events: [
        { atMs: 0, kind: 'execute.start', phase: 'execute', runtime: 'standalone' },
        { atMs: 1, kind: 'render.start', phase: 'render' },
        { atMs: 6.5, durationMs: 5.5, kind: 'render.finish', phase: 'render' },
      ],
      lineage: { source: 'native', state: 'available', value: { conversation: 'session-1', depth: 1, root: 'session-1' } },
      runtime: 'standalone',
    },
    durationMs: 6.5,
    href: '/routes/events/tool/before',
    occurredAt: '2026-09-05T15:00:00.006Z',
    status: 'ok',
    summary: 'claude PreToolUse → tool/before completed',
  });
  expect(entries.every((entry) => !entry.href?.includes('invocation='))).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('tool_input');
});

it('lowers a failure to hook.failed with the kernel error summary, and a gate outcome to a completed entry', () => {
  const failed = lowerHookReceipt(receipt({
    events: [
      { at: 10, kind: 'execute.start', phase: 'execute', runtime: 'shared', sequence: 0 },
      { at: 12, durationMs: 2, error: { code: 'runtime-failed', message: 'render exploded', name: 'EventRuntimeTransportError' }, kind: 'failure', phase: 'execute', sequence: 1 },
    ],
  }));
  expect(failed.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.failed']);
  expect(failed[1]).toMatchObject({
    details: { error: { code: 'runtime-failed', message: 'render exploded', name: 'EventRuntimeTransportError' }, failedPhase: 'execute', runtime: 'shared' },
    durationMs: 2,
    status: 'error',
    summary: 'claude PreToolUse → tool/before failed in execute: EventRuntimeTransportError: render exploded',
  });
  const denied = receipt({
    events: [
      { at: 0, kind: 'preflight.start', phase: 'preflight', sequence: 0 },
      { at: 3, durationMs: 3, kind: 'preflight.outcome', outcome: 'deny', phase: 'preflight', sequence: 1 },
    ],
  });
  const gated = lowerHookReceipt(denied);
  expect(gated[1]).toMatchObject({
    details: { gate: 'deny' },
    kind: 'hook.completed',
    status: 'ok',
    summary: 'claude PreToolUse → tool/before denied by preflight',
  });
  expect(gated[1]!.details).not.toHaveProperty('runtime');
});

it('adds session.started and session.ended around session lifecycle receipts', () => {
  const started = lowerHookReceipt(receipt({
    execution: { ...execution, event: 'session/start', nativeEvent: 'SessionStart' },
    identity: { conversationId: 'session-1', sessionId: 'session-1' },
  }));
  expect(started.map((entry) => entry.kind)).toEqual(['hook.received', 'session.started', 'hook.completed']);
  expect(started[1]).toMatchObject({
    correlation: { sessionId: 'session-1' },
    href: '/routes/events/session/start',
    summary: 'claude session started (session-1)',
  });
  const ended = lowerHookReceipt(receipt({
    events: [
      { at: 0, kind: 'execute.start', phase: 'execute', runtime: 'standalone', sequence: 0 },
      { at: 4, durationMs: 4, error: { message: 'no', name: 'Error' }, kind: 'failure', phase: 'render', sequence: 1 },
    ],
    execution: { ...execution, event: 'session/end', nativeEvent: 'SessionEnd' },
  }));
  expect(ended.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.failed', 'session.ended']);
  expect(ended[2]).toMatchObject({ status: 'error', summary: 'claude session ended (session-1)' });
});

it('falls back to the runtime lineage conversation when the payload named none', () => {
  const [received] = lowerHookReceipt(receipt({ identity: { sessionId: 'session-1' } }));
  expect(received!.correlation).toEqual({
    conversationId: 'session-1',
    executionId: 'exec-1',
    host: 'claude',
    routeId: 'event:tool/before',
    sessionId: 'session-1',
  });
  const [bare] = lowerHookReceipt(receipt({ identity: {}, lineage: { reason: 'not-provided', state: 'unavailable' } }));
  expect(bare!.correlation).toEqual({ executionId: 'exec-1', host: 'claude', routeId: 'event:tool/before' });
});

const listen = async (
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
): Promise<{ readonly server: Server; readonly url: string }> => {
  const server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (!handled) responseDiagnostic(response, diagnostic('AB8005', 'Not found.', 404));
    }).catch((error: unknown) => {
      responseDiagnostic(response, isRequestDiagnostic(error) ? error : diagnostic('AB8007', 'Request could not be completed.', 500));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const post = async (url: string, body: string, headers: Record<string, string>): Promise<Response> =>
  fetch(new URL(EVENT_TRACE_RECEIPT_PATH, url), { body, headers, method: 'POST' });

const jsonHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

it('accepts a bearer-authenticated loopback receipt and publishes its lowering to the trace hub', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const routes = new HookReceiptRoutes({ token: 'secret-token', trace: hub });
  const { url } = await listen((request, response) => routes.handle(request, response));
  const accepted = await post(url, JSON.stringify(receipt()), jsonHeaders('secret-token'));
  expect(accepted.status).toBe(204);
  expect(hub.replay().entries.map((entry) => entry.kind)).toEqual(['hook.received', 'hook.completed']);
  expect(hub.replay().entries[1]).toMatchObject({ correlation: { executionId: 'exec-1' }, id: 'trc_2', source: 'hook' });

  const other = await fetch(`${url}/api/trace`, { method: 'GET' });
  expect(other.status).toBe(404);
});

it('refuses receipts without the token, with an Origin header, over the size cap, or malformed', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const routes = new HookReceiptRoutes({ token: 'secret-token', trace: hub });
  const { url } = await listen((request, response) => routes.handle(request, response));
  const body = JSON.stringify(receipt());
  const code = async (response: Response): Promise<{ status: number; code: string }> => ({
    code: ((await response.json()) as { diagnostic: { code: string } }).diagnostic.code,
    status: response.status,
  });

  await expect(code(await post(url, body, { 'content-type': 'application/json' })))
    .resolves.toEqual({ code: HOOK_RECEIPT_UNAUTHORIZED_CODE, status: 403 });
  await expect(code(await post(url, body, jsonHeaders('wrong-token'))))
    .resolves.toEqual({ code: HOOK_RECEIPT_UNAUTHORIZED_CODE, status: 403 });
  await expect(code(await post(url, body, { ...jsonHeaders('secret-token'), origin: url })))
    .resolves.toEqual({ code: HOOK_RECEIPT_UNAUTHORIZED_CODE, status: 403 });
  await expect(code(await post(url, body, { 'content-type': 'application/json', cookie: 'agent-bundle-foreground-session-x=secret-token', 'x-agent-bundle-session': 'secret-token' })))
    .resolves.toEqual({ code: HOOK_RECEIPT_UNAUTHORIZED_CODE, status: 403 });
  await expect(code(await fetch(new URL(EVENT_TRACE_RECEIPT_PATH, url), { headers: jsonHeaders('secret-token'), method: 'GET' })))
    .resolves.toEqual({ code: 'AB8007', status: 405 });
  await expect(code(await post(url, body, { authorization: 'Bearer secret-token', 'content-type': 'text/plain' })))
    .resolves.toEqual({ code: 'AB8009', status: 415 });
  await expect(code(await post(url, '{"version":1,', jsonHeaders('secret-token'))))
    .resolves.toEqual({ code: 'AB8001', status: 400 });
  await expect(code(await post(url, JSON.stringify({ ...receipt(), native: { tool_input: {} } }), jsonHeaders('secret-token'))))
    .resolves.toEqual({ code: HOOK_RECEIPT_MALFORMED_CODE, status: 400 });
  await expect(code(await post(url, JSON.stringify(receipt({ identity: { sessionId: 'x'.repeat(17_000) } })), jsonHeaders('secret-token'))))
    .resolves.toEqual({ code: HOOK_RECEIPT_TOO_LARGE_CODE, status: 413 });
  await expect(code(await fetch(`${new URL(EVENT_TRACE_RECEIPT_PATH, url).href}?replay=1`, { body, headers: jsonHeaders('secret-token'), method: 'POST' })))
    .resolves.toEqual({ code: HOOK_RECEIPT_MALFORMED_CODE, status: 400 });
  await expect(code(await post(url, JSON.stringify({ ...receipt(), devSession: 'hs_nope' }), jsonHeaders('secret-token'))))
    .resolves.toEqual({ code: HOOK_RECEIPT_SESSION_CODE, status: 400 });
  expect(hub.latestSequence).toBe(0);

  routes.close();
  await expect(code(await post(url, body, jsonHeaders('secret-token'))))
    .resolves.toEqual({ code: HOOK_RECEIPT_UNAUTHORIZED_CODE, status: 409 });
});

it('publishes an owner-only endpoint record under the project and removes it on close', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-receipts-'));
  cleanups.push(() => rm(projectRoot, { force: true, recursive: true }));
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const attachment = attachHookReceipts({ projectRoot, trace: hub });
  expect(attachment.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(attachment.routes).toBeInstanceOf(HookReceiptRoutes);
  expect(() => attachment.environment('http://localhost:4321')).toThrow(/loopback/u);
  expect(attachment.environment('http://127.0.0.1:4321')).toEqual({
    [EVENT_TRACE_RECEIPT_TOKEN_ENV]: attachment.token,
    [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:4321',
  });

  const recordPath = eventTraceReceiptEndpointPath(projectRoot);
  await attachment.publishEndpoint('http://127.0.0.1:4321');
  expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual({
    pid: process.pid,
    token: attachment.token,
    url: 'http://127.0.0.1:4321',
  });
  if (process.platform !== 'win32') expect((await stat(recordPath)).mode & 0o777).toBe(0o600);

  await attachment.publishEndpoint('http://127.0.0.1:4322');
  expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ url: 'http://127.0.0.1:4322' });

  await attachment.close();
  await expect(stat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('resolves the wrapper endpoint from the environment, else the dev install marker beside the wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-receipt-resolve-'));
  cleanups.push(() => rm(root, { force: true, recursive: true }));
  const anchor = pathToFileURL(join(root, 'bundle', 'hooks', 'before-tool.claude.mjs')).href;
  const fromEnv = await resolveEventTraceReceiptEndpoint({
    anchor,
    env: { [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 'env-token', [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:5000' },
  });
  expect(fromEnv).toEqual({ token: 'env-token', url: 'http://127.0.0.1:5000' });
  await expect(resolveEventTraceReceiptEndpoint({
    anchor,
    env: { [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 'env-token', [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://evil.example:5000' },
  })).resolves.toBeUndefined();
  await expect(resolveEventTraceReceiptEndpoint({ anchor, env: {} })).resolves.toBeUndefined();

  const projectRoot = join(root, 'project');
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const attachment = attachHookReceipts({ projectRoot, trace: hub });
  await attachment.publishEndpoint('http://127.0.0.1:5001');
  await mkdir(join(root, 'bundle', 'hooks'), { recursive: true });
  await writeFile(join(root, 'bundle', DEV_INSTALL_MARKER_FILE), JSON.stringify({ epochId: 'e1', host: 'claude', projectRoot, schemaVersion: 1 }));
  await expect(resolveEventTraceReceiptEndpoint({ anchor, env: {} }))
    .resolves.toEqual({ token: attachment.token, url: 'http://127.0.0.1:5001' });
  await writeFile(eventTraceReceiptEndpointPath(projectRoot), JSON.stringify({
    pid: 2_147_483_647,
    token: attachment.token,
    url: 'http://127.0.0.1:5001',
  }));
  await expect(resolveEventTraceReceiptEndpoint({ anchor, env: {} })).resolves.toBeUndefined();
  await attachment.close();
  await expect(resolveEventTraceReceiptEndpoint({ anchor, env: {} })).resolves.toBeUndefined();
});

it('records kernel events through the tracer and posts one bounded receipt that never throws', async () => {
  const posted: { url: string; init: RequestInit }[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    posted.push({ init: init!, url: String(input) });
    throw new TypeError('connection refused');
  };
  const traced = eventTraceExecution({ event: 'tool/before', host: 'claude', nativeEvent: 'PreToolUse' });
  const recorder = await openEventTraceReceipt({
    anchor: 'file:///nowhere/hooks/x.mjs',
    env: { [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 't', [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:6000' },
    execution: traced,
    fetch: fetchStub,
  });
  expect(recorder).toBeDefined();
  let clock = 50;
  const tracer = createEventTracer({ execution: traced, now: () => clock, observer: recorder!.observer });
  recorder!.identity({ session_id: 's', tool_input: { secret: true }, tool_use_id: 'u' });
  recorder!.lineage({ reason: 'no-subagent-events', state: 'unavailable' });
  tracer.executeStart('standalone');
  clock = 52;
  tracer.renderStart();
  clock = 60;
  tracer.renderFinish();
  await recorder!.send();
  await recorder!.send();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.url).toBe('http://127.0.0.1:6000/api/trace/receipts');
  expect(posted[0]!.init.headers).toEqual({ authorization: 'Bearer t', 'content-type': 'application/json' });
  const body = JSON.parse(posted[0]!.init.body as string) as EventTraceReceipt;
  expect(body.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(body).toEqual({
    events: [
      { at: 50, kind: 'execute.start', phase: 'execute', runtime: 'standalone', sequence: 0 },
      { at: 52, kind: 'render.start', phase: 'render', sequence: 1 },
      { at: 60, durationMs: 8, kind: 'render.finish', phase: 'render', sequence: 2 },
    ],
    execution: traced,
    identity: { conversationId: 's', requestId: 'u', sessionId: 's' },
    lineage: { reason: 'no-subagent-events', state: 'unavailable' },
    startedAt: body.startedAt,
    version: 1,
  });
  expect(posted[0]!.init.body).not.toContain('secret');
  expect(decodeHookReceipt(body)).toEqual(body);

  const silent = await openEventTraceReceipt({ anchor: 'file:///nowhere/hooks/x.mjs', env: {}, execution: traced, fetch: fetchStub });
  expect(silent).toBeUndefined();
});

it('posts a top-level devSession when AGENT_BUNDLE_DEV_SESSION is set and keeps the host identity', async () => {
  const posted: EventTraceReceipt[] = [];
  const traced = eventTraceExecution({ event: 'tool/before', host: 'claude', nativeEvent: 'PreToolUse' });
  const recorder = await openEventTraceReceipt({
    anchor: 'file:///nowhere/hooks/x.mjs',
    env: {
      [EVENT_TRACE_RECEIPT_SESSION_ENV]: hostSessionId,
      [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 't',
      [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:6000',
    },
    execution: traced,
    fetch: async (_input, init) => {
      posted.push(JSON.parse(init!.body as string) as EventTraceReceipt);
      return new Response(null, { status: 204 });
    },
  });
  recorder!.identity({ session_id: 'host-session', tool_use_id: 'u' });
  createEventTracer({ execution: traced, now: () => 1, observer: recorder!.observer }).executeStart('standalone');
  await recorder!.send();
  expect(posted[0]!.devSession).toBe(hostSessionId);
  expect(posted[0]!.identity).toEqual({ conversationId: 'host-session', requestId: 'u', sessionId: 'host-session' });

  const stray = await openEventTraceReceipt({
    anchor: 'file:///nowhere/hooks/x.mjs',
    env: {
      [EVENT_TRACE_RECEIPT_SESSION_ENV]: 'not-a-workbench-session',
      [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 't',
      [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:6000',
    },
    execution: traced,
    fetch: async (_input, init) => {
      posted.push(JSON.parse(init!.body as string) as EventTraceReceipt);
      return new Response(null, { status: 204 });
    },
  });
  createEventTracer({ execution: traced, now: () => 1, observer: stray!.observer }).executeStart('standalone');
  await stray!.send();
  expect(posted[1]).not.toHaveProperty('devSession');
});

it('calls attachHostSession with the validated devSession and the host identity', async () => {
  const attached: [string, string | undefined][] = [];
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const routes = new HookReceiptRoutes({
    attachHostSession: (devSession, hostSessionId) => {
      attached.push([devSession, hostSessionId]);
    },
    token: 'secret-token',
    trace: hub,
  });
  const { url } = await listen((request, response) => routes.handle(request, response));
  const accepted = await post(url, JSON.stringify({ ...receipt(), devSession: hostSessionId }), jsonHeaders('secret-token'));
  expect(accepted.status).toBe(204);
  expect(attached).toEqual([[hostSessionId, 'session-1']]);
  expect(hub.replay().entries[0]?.correlation.sessionId).toBe('session-1');
});

it('does not post a receipt when nothing was traced', async () => {
  let calls = 0;
  const recorder = await openEventTraceReceipt({
    anchor: 'file:///nowhere/hooks/x.mjs',
    env: { [EVENT_TRACE_RECEIPT_TOKEN_ENV]: 't', [EVENT_TRACE_RECEIPT_URL_ENV]: 'http://127.0.0.1:6000' },
    execution,
    fetch: async () => { calls += 1; return new Response(null, { status: 204 }); },
  });
  await recorder!.send();
  expect(calls).toBe(0);
});
