import { expect, it } from '@rstest/core';

import type { ForegroundRequestAuthority } from '../src/mcp/mcp-route-client.ts';
import {
  decodeBase64,
  HostSessionClient,
  HostSessionClientError,
  type HostSessionStreamMessage,
} from '../src/sessions/host-session-client.ts';
import type { HostAvailability, HostSession } from '../../agent-bundle/src/contracts/host-sessions.ts';

const session: HostSession = Object.freeze({
  authority: Object.freeze({ epochId: 'epoch-1', install: '/home/dev/.claude/plugins/cache/curator', projectRoot: '/work/curator' }),
  cols: 120,
  host: 'claude',
  id: 'hs_0123456789abcdef',
  pid: 4242,
  prompt: 'Call the tool:curator/search_audible tool of this plugin and explain the result.',
  rows: 32,
  startedAt: 1_757_000_000_000,
  state: 'running',
});

const ended: HostSession = Object.freeze({
  authority: session.authority,
  cols: 120,
  endedAt: 1_757_000_005_000,
  exitCode: 0,
  host: 'claude',
  id: session.id,
  prompt: session.prompt,
  rows: 32,
  startedAt: session.startedAt,
  state: 'exited',
  traceSessionId: 'claude-own-session',
});

const hosts: readonly HostAvailability[] = Object.freeze([
  Object.freeze({ executable: '/usr/local/bin/claude', host: 'claude', launchable: true }),
  Object.freeze({ host: 'codex', launchable: false, reason: 'codex is not on PATH' }),
]);

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

interface Seen {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

const clientFor = (
  handler: (path: string, init: RequestInit) => Response | Promise<Response>,
): { readonly client: HostSessionClient; readonly seen: Seen[] } => {
  const seen: Seen[] = [];
  const foreground: ForegroundRequestAuthority = {
    protectedRequest: async (path, init = {}) => {
      seen.push({ body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, method: init.method ?? 'GET', path });
      return handler(path, init);
    },
  };
  return { client: new HostSessionClient({ foreground }), seen };
};

const sse = (frames: readonly string[]): Response => new Response(frames.join(''), {
  headers: { 'content-type': 'text/event-stream' },
});

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;


it('drives every route of the contract with the mutation-session authority and decodes strictly', async () => {
  const { client, seen } = clientFor((path, init) => {
    if (path === '/api/sessions' && init.method === undefined) return json({ hosts, sessions: [ended, session] });
    if (path === '/api/sessions') return json({ session }, 201);
    if (path === `/api/sessions/${session.id}`) return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ session });
    if (path.endsWith('/input') || path.endsWith('/resize')) return new Response(null, { status: 204 });
    if (path.endsWith('/terminate')) return json({ session: ended });
    if (path.endsWith('/restart')) return json({ session: { ...session, id: 'hs_fedcba9876543210', restartOf: session.id } }, 201);
    throw new Error(`unexpected ${path}`);
  });

  const list = await client.list();
  expect(list.hosts).toEqual(hosts);
  expect(list.sessions.map((entry) => entry.state)).toEqual(['exited', 'running']);
  expect(Object.isFrozen(list.sessions)).toBe(true);
  expect(await client.launch({ cols: 120, host: 'claude', prompt: session.prompt, rows: 32 })).toEqual(session);
  expect(await client.read(session.id)).toEqual(session);
  await client.input(session.id, 'ls\r');
  await client.resize(session.id, { cols: 100, rows: 40 });
  expect((await client.terminate(session.id)).state).toBe('exited');
  expect((await client.restart(session.id, { cols: 100, rows: 40 })).restartOf).toBe(session.id);
  await client.forget(session.id);

  expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([
    ['GET', '/api/sessions', undefined],
    ['POST', '/api/sessions', { cols: 120, host: 'claude', prompt: session.prompt, rows: 32 }],
    ['GET', `/api/sessions/${session.id}`, undefined],
    ['POST', `/api/sessions/${session.id}/input`, { data: 'ls\r' }],
    ['POST', `/api/sessions/${session.id}/resize`, { cols: 100, rows: 40 }],
    ['POST', `/api/sessions/${session.id}/terminate`, {}],
    ['POST', `/api/sessions/${session.id}/restart`, { cols: 100, rows: 40 }],
    ['DELETE', `/api/sessions/${session.id}`, undefined],
  ]);
});

it('rejects unknown keys, bad sizes, and malformed ids before or after the wire', async () => {
  const { client } = clientFor((path) => {
    if (path === '/api/sessions') return json({ hosts, sessions: [{ ...session, cwd: '/elsewhere' }] });
    return json({ session: { ...session, cols: 0 } });
  });
  await expect(client.list()).rejects.toMatchObject({ code: 'AB8261', name: 'HostSessionClientError' });
  await expect(client.read(session.id)).rejects.toMatchObject({ code: 'AB8261' });
  await expect(client.read('../etc')).rejects.toMatchObject({ code: 'AB8261' });
  await expect(client.input('a/b', 'x')).rejects.toMatchObject({ code: 'AB8261' });
});

it('surfaces the server diagnostic code and HTTP status of a refused request', async () => {
  const { client } = clientFor((path) => path.endsWith('/terminate')
    ? json({ diagnostic: { code: 'AB8262', message: 'Unknown host session.' } }, 404)
    : new Response('nope', { status: 503 }));
  const refused = await client.terminate('hs_missing').catch((reason: unknown) => reason);
  expect(refused).toBeInstanceOf(HostSessionClientError);
  expect(refused).toMatchObject({ code: 'AB8262', message: 'Unknown host session.', status: 404 });
  await expect(client.list()).rejects.toMatchObject({ code: 'AB8261', status: 503 });
});

it('decodes the SSE stream: state, base64 output bytes, keep-alive comments, and the final end frame', async () => {
  const output = new TextEncoder().encode('$ echo ready\r\nready\r\n');
  const { client } = clientFor(() => sse([
    frame('state', { session }),
    ': keep-alive\n\n',
    frame('output', { data: btoa(String.fromCharCode(...output)) }),
    frame('output', { data: '' }),
    frame('state', { session: { ...session, traceSessionId: 'claude-own-session' } }),
    frame('end', { session: ended }),
  ]));
  const messages: HostSessionStreamMessage[] = [];
  const final = await client.stream(session.id, (message) => messages.push(message));
  expect(final).toEqual(ended);
  expect(messages.map((message) => message.type)).toEqual(['state', 'output', 'output', 'state', 'end']);
  const first = messages[1];
  expect(first?.type === 'output' ? new TextDecoder().decode(first.bytes) : undefined).toBe('$ echo ready\r\nready\r\n');
  const empty = messages[2];
  expect(empty?.type === 'output' ? empty.bytes.length : undefined).toBe(0);
  const attached = messages[3];
  expect(attached?.type === 'state' ? attached.session.traceSessionId : undefined).toBe('claude-own-session');
  expect(decodeBase64('AAEC/w==')).toEqual(Uint8Array.from([0, 1, 2, 255]));
});

it('refuses a stream frame that is not on the contract and a stream that ends without an end frame', async () => {
  const cases: readonly (readonly string[])[] = [
    [frame('output', { data: 'not base64!' })],
    [frame('state', { session: { ...session, state: 'starting' } })],
    [frame('progress', { percent: 1 })],
    ['event: state\ndata: {"session": nope}\n\n'],
    [frame('state', { session })],
  ];
  for (const frames of cases) {
    const { client } = clientFor(() => sse(frames));
    await expect(client.stream(session.id, () => undefined)).rejects.toMatchObject({ code: 'AB8261' });
  }
  const { client } = clientFor(() => json({ diagnostic: { code: 'AB8262', message: 'Unknown host session.' } }, 404));
  await expect(client.stream(session.id, () => undefined)).rejects.toMatchObject({ code: 'AB8262', status: 404 });
});
