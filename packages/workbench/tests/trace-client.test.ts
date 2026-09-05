import { expect, it } from '@rstest/core';

import type { TraceMessage, TraceReplay } from '../../agent-bundle/src/contracts/trace.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import {
  decodeTraceEntry,
  decodeTraceMessage,
  decodeTraceReplay,
  ForegroundTraceClient,
  openTraceFeed,
  TRACE_INVALID_RESPONSE_CODE,
  TraceClientError,
  type TraceClient,
  type TraceFeedState,
} from '../src/trace/trace-client.ts';
import { sampleTraceEntries } from './support/trace-fixtures.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});
const session = (): Response => json({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
  instanceId: 'foreground-instance-a',
  origin: 'http://foreground.test',
  token: 'test-session-token',
});
const ndjson = (chunks: readonly Uint8Array[]): Response => new Response(new ReadableStream<Uint8Array>({
  start: (controller) => {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson' } });
const clientFor = (respond: (url: string) => Response | Promise<Response>): ForegroundTraceClient => new ForegroundTraceClient({
  foreground: new ForegroundRouteClient({ fetch: async (input) => String(input).includes('/api/project/session') ? session() : respond(String(input)) }),
});
const encode = (messages: readonly unknown[]): Uint8Array => new TextEncoder().encode(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
const replayOf = (entries: readonly unknown[], extra: Record<string, unknown> = {}): unknown => ({
  entries,
  latestSequence: (entries.at(-1) as { readonly sequence: number } | undefined)?.sequence ?? 0,
  ...extra,
});
const [first, second] = sampleTraceEntries;
const invalid = { code: TRACE_INVALID_RESPONSE_CODE, name: 'TraceClientError' };

it('decodes the replay the hub produces and freezes it', async () => {
  const requested: string[] = [];
  const client = clientFor((url) => { requested.push(url); return json(replayOf(sampleTraceEntries)); });
  const replay = await client.replay();
  expect(requested).toEqual(['/api/trace?after=0']);
  expect(replay.entries).toEqual(sampleTraceEntries);
  expect(replay.latestSequence).toBe(9);
  expect(Object.isFrozen(replay) && Object.isFrozen(replay.entries[1]) && Object.isFrozen(replay.entries[1]?.correlation) && Object.isFrozen(replay.entries[1]?.details)).toBe(true);

  const gap = { droppedCount: 2, firstAvailableSequence: 3, requestedAfterSequence: 0, type: 'trace.gap' };
  const gapped = decodeTraceReplay(replayOf(sampleTraceEntries.slice(2), { gap }), 0);
  expect(gapped.gap).toEqual(gap);
  expect(decodeTraceReplay({ entries: [], latestSequence: 4 }, 4)).toEqual({ entries: [], latestSequence: 4 });
});

it('rejects replay envelopes that are malformed, non-contiguous, or inconsistent with their cursor', () => {
  const reject = (value: unknown, after = 0): void => { expect(() => decodeTraceReplay(value, after)).toThrow(TraceClientError); };
  reject({ entries: [first] });
  reject({ entries: [first], latestSequence: 1, extra: true });
  reject({ entries: [second], latestSequence: 2 });
  reject({ entries: [first, second], latestSequence: 3 });
  reject({ entries: [], latestSequence: 3 }, 0);
  reject({ entries: [], latestSequence: 2 }, 4);
  reject({ entries: [first], latestSequence: 1 }, 1);
  reject({ entries: [first], latestSequence: 1, gap: { droppedCount: 0, firstAvailableSequence: 1, requestedAfterSequence: 0, type: 'trace.gap' } });
  reject({ entries: [second], latestSequence: 2, gap: { droppedCount: 1, firstAvailableSequence: 2, requestedAfterSequence: 1, type: 'trace.gap' } }, 0);
  reject('[]');
});

it('rejects an entry with an unknown source, a stray key, or unsafe text instead of crashing', () => {
  const accept = (value: unknown): void => { expect(decodeTraceEntry(value)).toEqual(value); };
  const reject = (value: unknown): void => { expect(() => decodeTraceEntry(value)).toThrow(expect.objectContaining(invalid)); };
  // The browser decoder's own code, between the trace routes (AB8240–AB8242) and the hook receipt route (AB8247–AB8249).
  expect(TRACE_INVALID_RESPONSE_CODE).toBe('AB8243');
  accept(second);
  accept({ ...first, status: 'running', durationMs: 0, details: null });
  accept({ ...first, correlation: { mcpRequestId: 'req/1:2', routeId: 'tool:curator/search_audible', host: 'codex' } });
  accept({ ...first, summary: 'tool:curator/search · <project>/src/x.tsx · tools/call' });
  reject({ ...first, source: 'notice' });
  reject({ ...first, source: undefined });
  reject({ ...first, extra: 1 });
  reject({ ...first, id: 'trc 1' });
  reject({ ...first, id: '' });
  reject({ ...first, sequence: 0 });
  reject({ ...first, sequence: 1.5 });
  reject({ ...first, occurredAt: '2026-09-05 22:41:04' });
  reject({ ...first, kind: 'started' });
  reject({ ...first, kind: 'hook started' });
  reject({ ...first, status: 'succeeded' });
  reject({ ...first, durationMs: -1 });
  reject({ ...first, durationMs: Number.NaN });
  reject({ ...first, summary: '' });
  reject({ ...first, summary: 'x'.repeat(241) });
  reject({ ...first, summary: 'line\nbreak' });
  reject({ ...first, summary: 'wrote /home/zack/project/out.json' });
  reject({ ...first, summary: 'C:\\Users\\zack\\out.json' });
  reject({ ...first, summary: 'file:///tmp/x' });
  reject({ ...first, summary: 'token sk-proj-abcdefghijklmnopqrst' });
  reject({ ...first, correlation: { sessionId: 'a b' } });
  reject({ ...first, correlation: { unknownKey: 'x' } });
  reject({ ...first, correlation: { host: 1 } });
  reject({ ...first, correlation: [] });
  reject({ ...first, details: { apiKey: 'x' } });
  reject({ ...first, details: { path: '/home/zack/secret' } });
  reject({ ...first, details: { nested: ['ok', 'ghp_abcdefghijklmnopqrst'] } });
  reject({ ...first, href: 'https://example.com/routes/x' });
  reject({ ...first, href: '//evil/routes/x' });
  reject({ ...first, href: '/api/routes/invocations/inv_1' });
  reject({ ...first, href: '/routes/x#hash' });
  reject({ ...first, href: 'routes/x' });
  accept({ ...first, href: '/trace/trc_9?correlation=exec-1' });
  accept({ ...first, href: '/routes/mcp/curator/tool/search_audible?invocation=inv_1&tab=raw' });
});

it('decodes gaps and rejects a gap whose arithmetic does not add up', () => {
  const gap = { droppedCount: 4, firstAvailableSequence: 7, requestedAfterSequence: 2, type: 'trace.gap' };
  expect(decodeTraceMessage(gap)).toEqual(gap);
  expect(() => decodeTraceMessage({ ...gap, firstAvailableSequence: 8 })).toThrow(TraceClientError);
  expect(() => decodeTraceMessage({ ...gap, droppedCount: 0, firstAvailableSequence: 3 })).toThrow(TraceClientError);
  expect(() => decodeTraceMessage({ ...gap, type: 'replay.gap' })).toThrow(TraceClientError);
  expect(() => decodeTraceMessage({ ...gap, extra: 1 })).toThrow(TraceClientError);
});

it('streams contiguous NDJSON messages, accepts a live gap, and rejects a sequence skip', async () => {
  const gap = { droppedCount: 1, firstAvailableSequence: 6, requestedAfterSequence: 4, type: 'trace.gap' };
  const received: TraceMessage[] = [];
  const client = clientFor(() => ndjson([encode([sampleTraceEntries[2], sampleTraceEntries[3], gap, sampleTraceEntries[5]])]));
  await client.stream(2, (message) => received.push(message), new AbortController().signal);
  expect(received.map((message) => 'sequence' in message ? message.sequence : 'gap')).toEqual([3, 4, 'gap', 6]);
  expect(received.every((message) => Object.isFrozen(message))).toBe(true);

  const skipped = clientFor(() => ndjson([encode([sampleTraceEntries[2], sampleTraceEntries[4]])]));
  await expect(skipped.stream(2, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);

  const wrongGap = clientFor(() => ndjson([encode([{ droppedCount: 1, firstAvailableSequence: 4, requestedAfterSequence: 2, type: 'trace.gap' }])]));
  await expect(wrongGap.stream(3, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);
});

it('rejects a trailing unterminated frame, an oversized frame, malformed UTF-8, and duplicate keys', async () => {
  const encoder = new TextEncoder();
  await expect(clientFor(() => ndjson([encoder.encode(JSON.stringify(first))])).stream(0, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);
  await expect(clientFor(() => ndjson([encode([{ ...first, summary: 'x'.repeat(65 * 1024) }])])).stream(0, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);
  const malformed = new Uint8Array([...encoder.encode('{"a":"'), 0xff, ...encoder.encode('"}\n')]);
  await expect(clientFor(() => ndjson([malformed])).stream(0, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);
  const duplicate = `${JSON.stringify(first).replace('"kind":"session.started"', '"kind":"session.started","kind":"session.ended"')}\n`;
  await expect(clientFor(() => ndjson([encoder.encode(duplicate)])).stream(0, () => undefined, new AbortController().signal)).rejects.toMatchObject(invalid);
  await expect(clientFor(() => new Response('{')).replay()).rejects.toMatchObject(invalid);
  await expect(clientFor(() => json(replayOf([{ ...first, source: 'notice' }]))).replay()).rejects.toMatchObject(invalid);
});

it('splits frames across chunks and stops delivering once the signal aborts', async () => {
  const bytes = encode([first, second]);
  const received: number[] = [];
  const split = clientFor(() => ndjson([bytes.subarray(0, 40), bytes.subarray(40)]));
  await split.stream(0, (message) => { if ('sequence' in message) received.push(message.sequence); }, new AbortController().signal);
  expect(received).toEqual([1, 2]);

  const controller = new AbortController();
  const aborted: number[] = [];
  await clientFor(() => ndjson([bytes])).stream(0, (message) => {
    if ('sequence' in message) aborted.push(message.sequence);
    controller.abort();
  }, controller.signal);
  expect(aborted).toEqual([1]);
});

it('surfaces a coded server refusal, maps hostile refusals to the local error, and returns quietly from an aborted stream request', async () => {
  await expect(clientFor(() => json({ diagnostic: { code: 'AB8242', message: 'Trace cursor is ahead.' } }, 409)).replay(5))
    .rejects.toMatchObject({ code: 'AB8242', message: 'Trace route refused the request (AB8242, HTTP 409).', name: 'TraceClientError' });
  await expect(clientFor(() => json({ diagnostic: { code: 'nope', message: '/etc/passwd' } }, 500)).replay()).rejects.toMatchObject(invalid);
  await expect(clientFor(() => json({ diagnostic: { code: 'AB8242', message: 'x' } }, 409)).stream(5, () => undefined, new AbortController().signal))
    .rejects.toMatchObject({ code: 'AB8242' });
  await expect(clientFor(() => json({ entries: [], latestSequence: 0 })).replay(-1)).rejects.toMatchObject(invalid);
  const controller = new AbortController();
  controller.abort();
  await expect(clientFor(() => json(replayOf([]))).stream(0, () => undefined, controller.signal)).resolves.toBeUndefined();
});

interface FakeStream {
  readonly after: number | undefined;
  readonly deliver: (message: TraceMessage) => void;
  readonly end: (reason?: unknown) => void;
}

/** A scripted `TraceClient`: each `replay` answer is consumed in order; every stream stays open until the test ends it. */
const fakeClient = (replays: readonly (TraceReplay | Error)[]): TraceClient & { readonly replayCursors: number[]; readonly streams: FakeStream[] } => {
  const replayCursors: number[] = [];
  const streams: FakeStream[] = [];
  let index = 0;
  return {
    replay: async (after = 0) => {
      replayCursors.push(after);
      const answer = replays[Math.min(index, replays.length - 1)];
      index += 1;
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no replay scripted');
      return answer;
    },
    replayCursors,
    stream: (after, onMessage, signal) => new Promise<void>((resolve, reject) => {
      streams.push({
        after,
        deliver: (message) => { if (!signal.aborted) onMessage(message); },
        end: (reason) => { if (reason === undefined) resolve(); else reject(reason); },
      });
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    streams,
  };
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

it('replays, follows the stream, merges live entries, and reconnects from the last sequence with back-off when the stream ends', async () => {
  const client = fakeClient([
    { entries: sampleTraceEntries.slice(0, 2), latestSequence: 2 },
    { entries: sampleTraceEntries.slice(3, 4), latestSequence: 4 },
  ]);
  const states: TraceFeedState[] = [];
  const delays: number[] = [];
  const feed = openTraceFeed({ client, onState: (state) => states.push(state), retryDelay: async (ms) => { delays.push(ms); } });
  await settle();
  expect(states.at(-1)).toMatchObject({ connected: true, loaded: true, entries: sampleTraceEntries.slice(0, 2) });
  expect(client.streams[0]?.after).toBe(2);

  client.streams[0]!.deliver(sampleTraceEntries[2]!);
  client.streams[0]!.deliver({ droppedCount: 1, firstAvailableSequence: 2, requestedAfterSequence: 0, type: 'trace.gap' });
  expect(states.at(-1)).toMatchObject({ connected: true, entries: sampleTraceEntries.slice(0, 3), gap: { droppedCount: 1 } });

  client.streams[0]!.end();
  await settle();
  expect(delays).toEqual([250]);
  expect(client.replayCursors).toEqual([0, 3]);
  expect(client.streams[1]?.after).toBe(4);
  expect(states.at(-1)).toMatchObject({ connected: true, entries: sampleTraceEntries.slice(0, 4) });
  expect(states.some((state) => !state.connected && state.loaded && state.error === undefined)).toBe(true);

  feed.close();
  const count = states.length;
  client.streams[1]!.deliver(sampleTraceEntries[4]!);
  await settle();
  expect(states).toHaveLength(count);
});

it('reports a failed replay, doubles the back-off, and starts over from zero when a non-zero cursor is refused', async () => {
  const refused = new TraceClientError('AB8242', 'Trace route refused the request (AB8242, HTTP 409).');
  const client = fakeClient([
    new Error('offline'),
    { entries: sampleTraceEntries.slice(0, 1), latestSequence: 1 },
    refused,
    { entries: sampleTraceEntries.slice(6, 7), latestSequence: 7 },
  ]);
  const states: TraceFeedState[] = [];
  const delays: number[] = [];
  const feed = openTraceFeed({ client, onState: (state) => states.push(state), retryDelay: async (ms) => { delays.push(ms); } });
  await settle();
  expect(states[0]).toMatchObject({ connected: false, error: 'offline', loaded: false, entries: [] });
  expect(states.at(-1)).toMatchObject({ connected: true, loaded: true, entries: sampleTraceEntries.slice(0, 1) });
  expect(delays).toEqual([250]);

  client.streams[0]!.end(new TraceClientError(TRACE_INVALID_RESPONSE_CODE, 'Trace route returned an invalid response.'));
  await settle();
  expect(delays).toEqual([250, 250]);
  expect(client.replayCursors).toEqual([0, 0, 1, 0]);
  expect(states.at(-1)).toMatchObject({ connected: true, entries: sampleTraceEntries.slice(6, 7) });
  expect(states.some((state) => state.error === refused.message && state.entries.length === 0)).toBe(true);
  feed.close();
});
