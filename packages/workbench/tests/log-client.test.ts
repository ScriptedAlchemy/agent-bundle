import { expect, it } from '@rstest/core';

import { LogClient, LogClientError } from '../src/logs/log-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';

const record = Object.freeze({
  context: Object.freeze({ target: 'codex' }),
  details: Object.freeze({ event: 'safe' }),
  kind: 'build.started',
  level: 'info',
  occurredAt: '2026-08-18T12:00:00.000Z',
  producer: 'build',
  sequence: 1,
  summary: 'Project build started.',
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const session = (): Response => json({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a',
  origin: 'http://foreground.test',
  token: 'test-session-token',
});
const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

const ndjson = (chunks: readonly Uint8Array[]): Response => new Response(new ReadableStream<Uint8Array>({
  start: (controller) => {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson' } });

const clientFor = (response: Response): LogClient => new LogClient({
  foreground: foreground(async (input) => String(input).includes('/api/project/session') ? session() : response),
});

it('accepts development host sync project and diagnostic log kinds', async () => {
  const records = [
    {
      ...record,
      context: { epochId: 'epoch-1' },
      details: { epochId: 'epoch-1', host: 'cursor', state: 'succeeded' },
      kind: 'dev.host.sync',
      producer: 'project',
      summary: 'Development host install was synchronized.',
    },
    {
      ...record,
      context: { diagnosticCode: 'AB7202' },
      details: { code: 'AB7202', message: 'Host sync failed.', severity: 'error' },
      kind: 'dev.host.sync.diagnostic',
      level: 'error',
      producer: 'diagnostic',
      sequence: 2,
      summary: 'Project diagnostic was recorded.',
    },
  ];
  await expect(clientFor(json({
    replay: { cursor: { afterSequence: 2 }, records },
  })).replay()).resolves.toMatchObject({ records });
});

it('rejects malformed or noncontiguous replay envelopes before exposing them to the page', async () => {
  await expect(clientFor(new Response('{')).replay()).rejects.toBeInstanceOf(LogClientError);

  const noncontiguous = clientFor(json({
    replay: { cursor: { afterSequence: 3 }, records: [{ ...record, sequence: 3 }] },
  }));
  await expect(noncontiguous.replay()).rejects.toMatchObject({ code: 'AB8093' });
});

it('rejects a trailing unterminated NDJSON frame instead of accepting a partial record', async () => {
  const encoder = new TextEncoder();
  const client = clientFor(ndjson([encoder.encode(JSON.stringify(record))]));

  const stream = client.stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(stream.done).rejects.toMatchObject({ code: 'AB8093' });
});

it('rejects duplicate replay keys, extra record fields, and unsafe wire text before the page receives a record', async () => {
  const replay = { replay: { cursor: { afterSequence: 1 }, records: [record] } };
  const duplicateDetails = JSON.stringify(replay).replace('"event":"safe"', '"event":"safe","event":"changed"');
  const duplicate = clientFor(new Response(duplicateDetails));
  await expect(duplicate.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const extraField = clientFor(json({
    replay: { cursor: { afterSequence: 1 }, records: [{ ...record, untrusted: 'extra' }] },
  }));
  await expect(extraField.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const versioned = clientFor(json({
    replay: { cursor: { afterSequence: 1 }, records: [{ ...record, schemaVersion: 1 }] },
  }));
  await expect(versioned.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const unsafeText = clientFor(json({
    replay: { cursor: { afterSequence: 1 }, records: [{ ...record, summary: '/private/fixture-secret' }] },
  }));
  await expect(unsafeText.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  for (const summary of [
    'C:\\private\\fixture',
    'C:/private/fixture',
    'C:private',
    '\\\\server\\share',
    'file:///private/fixture',
  ]) {
    const path = clientFor(json({ replay: { cursor: { afterSequence: 1 }, records: [{ ...record, summary }] } }));
    await expect(path.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });
  }
});

it('rejects malformed UTF-8 and a frame larger than 64 KiB before decoding NDJSON records', async () => {
  const encoder = new TextEncoder();
  const malformedPrefix = encoder.encode('{"context":{},"details":{},"kind":"project.load","level":"info","occurredAt":"2026-08-18T12:00:00.000Z","producer":"project","sequence":1,"summary":"');
  const malformedSuffix = encoder.encode('"}\n');
  const malformed = new Uint8Array(malformedPrefix.length + 1 + malformedSuffix.length);
  malformed.set(malformedPrefix);
  malformed[malformedPrefix.length] = 0xff;
  malformed.set(malformedSuffix, malformedPrefix.length + 1);
  const malformedStream = clientFor(ndjson([malformed])).stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(malformedStream.done).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const oversized = { ...record, summary: 'x'.repeat(65 * 1024) };
  const oversizedStream = clientFor(ndjson([encoder.encode(`${JSON.stringify(oversized)}\n`)])).stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(oversizedStream.done).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });
});

it('accepts a live overflow gap relative to the last delivered record', async () => {
  const messages = [
    { ...record, sequence: 2 },
    { ...record, sequence: 3 },
    { ...record, sequence: 4 },
    {
      earliestAvailableSequence: 8,
      latestDroppedSequence: 7,
      requestedAfterSequence: 4,
      type: 'replay.gap',
    },
    { ...record, sequence: 8 },
    { ...record, sequence: 9 },
    { ...record, sequence: 10 },
  ];
  const bytes = new TextEncoder().encode(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  const received: Array<number | 'gap'> = [];
  const stream = clientFor(ndjson([bytes])).stream({
    afterSequence: 1,
    onMessage: (message) => received.push('sequence' in message ? message.sequence : 'gap'),
  });

  await expect(stream.done).resolves.toBeUndefined();
  expect(received).toEqual([2, 3, 4, 'gap', 8, 9, 10]);
});

it('maps hostile diagnostics and provider credential values to the stable local error', async () => {
  const hostileDiagnostic = clientFor(json({ diagnostic: { code: 'AB8093', message: 'fixture-secret' } }, 503));
  await expect(hostileDiagnostic.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  for (const unsafe of [
    { ...record, summary: 'sk-proj-abcdefghijklmnopqrst' },
    { ...record, context: { target: 'ghp_abcdefghijklmnopqrst' } },
    { ...record, details: { event: 'sk-proj-abcdefghijklmnopqrst' } },
  ]) {
    const client = clientFor(json({ replay: { cursor: { afterSequence: 1 }, records: [unsafe] } }));
    await expect(client.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });
  }
});

it('accepts benign log text containing token, secret, and tokenizer', async () => {
  const client = clientFor(json({
    replay: {
      cursor: { afterSequence: 1 },
      records: [{
        ...record,
        context: { target: 'Tokenizer' },
        details: { event: 'Unexpected token' },
        summary: 'Unexpected token in the secret named Tokenizer.',
      }],
    },
  }));

  await expect(client.replay()).resolves.toMatchObject({ records: [{ summary: 'Unexpected token in the secret named Tokenizer.' }] });
});

it('accepts a canonical hook id containing a colon in an otherwise contiguous replay', async () => {
  const hookRecord = {
    ...record,
    context: { epochId: 'epoch-1', hookId: 'hook:fixture', target: 'node' },
    details: {},
    kind: 'hook.simulate.started',
    producer: 'hook',
    sequence: 17,
    summary: 'Hook simulation started.',
  };
  const client = clientFor(json({
    replay: {
      cursor: { afterSequence: 17 },
      records: [
        ...Array.from({ length: 16 }, (_value, index) => ({ ...record, sequence: index + 1 })),
        hookRecord,
      ],
    },
  }));

  const replay = await client.replay();
  expect(replay.cursor).toEqual({ afterSequence: 17 });
  expect(replay.records.map((entry) => entry.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
  ]);
  expect(replay.records.at(-1)).toMatchObject(hookRecord);

  const streamed: unknown[] = [];
  const stream = clientFor(ndjson([new TextEncoder().encode(`${JSON.stringify(hookRecord)}\n`)]))
    .stream({ afterSequence: 16, onMessage: (message) => streamed.push(message) });
  await expect(stream.done).resolves.toBeUndefined();
  expect(streamed).toEqual([hookRecord]);
});

it('accepts a fragmented initial gap and rejects a gap with the wrong live cursor', async () => {
  const encoder = new TextEncoder();
  const gap = Object.freeze({
    earliestAvailableSequence: 3,
    latestDroppedSequence: 2,
    requestedAfterSequence: 0,
    type: 'replay.gap' as const,
  });
  const third = Object.freeze({ ...record, sequence: 3 });
  const illegal = clientFor(ndjson([encoder.encode(`${JSON.stringify(record)}\n${JSON.stringify(gap)}\n${JSON.stringify(third)}\n`)]));
  await expect(illegal.stream({ afterSequence: 0, onMessage: () => undefined }).done).rejects.toMatchObject({ code: 'AB8093' });

  const expected = `${JSON.stringify(gap)}\n${JSON.stringify(third)}\n`;
  const received: unknown[] = [];
  const fragmented = clientFor(ndjson([encoder.encode(expected.slice(0, 17)), encoder.encode(expected.slice(17))]));
  await expect(fragmented.stream({ afterSequence: 0, onMessage: (message) => received.push(message) }).done).resolves.toBeUndefined();
  expect(received).toEqual([gap, third]);
});

it('aborts one replay without cancelling its peer on the shared foreground bootstrap', async () => {
  let replayRequests = 0;
  let sessionRequests = 0;
  let resolveSession: ((response: Response) => void) | undefined;
  const sharedForeground = foreground(async (input) => {
    if (String(input).includes('/api/project/session')) {
      sessionRequests += 1;
      if (resolveSession === undefined) {
        return await new Promise<Response>((resolve) => { resolveSession = resolve; });
      }
      throw new Error('Foreground authentication bootstrapped more than once.');
    }
    replayRequests += 1;
    return json({ replay: { cursor: { afterSequence: 1 }, records: [record] } });
  });
  const cancelled = new LogClient({ foreground: sharedForeground });
  const active = new LogClient({ foreground: sharedForeground });
  const controller = new AbortController();
  const cancelledReplay = cancelled.replay(0, controller.signal);
  const activeReplay = active.replay();
  if (resolveSession === undefined) throw new Error('Expected foreground session acquisition.');
  controller.abort();
  resolveSession(session());

  await expect(cancelledReplay).rejects.toMatchObject({ name: 'AbortError' });
  await expect(activeReplay).resolves.toMatchObject({ cursor: { afterSequence: 1 }, records: [{ sequence: 1 }] });
  expect(sessionRequests).toBe(1);
  expect(replayRequests).toBe(1);
});

it('does not finish replay body parsing after its signal aborts', async () => {
  let beginBodyRead: (() => void) | undefined;
  let resolveBody: ((body: ArrayBuffer) => void) | undefined;
  const bodyReading = new Promise<void>((resolve) => { beginBodyRead = resolve; });
  const body = new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; });
  const replayResponse = {
    arrayBuffer: async () => {
      beginBodyRead?.();
      return await body;
    },
    ok: true,
    status: 200,
  } as unknown as Response;
  const client = new LogClient({ foreground: foreground(async (input) =>
    String(input).includes('/api/project/session') ? session() : replayResponse) });
  const controller = new AbortController();
  const pending = client.replay(0, controller.signal);
  await bodyReading;
  controller.abort();
  if (resolveBody === undefined) throw new Error('Expected replay body read.');
  const encoded = new TextEncoder().encode(JSON.stringify({ replay: { cursor: { afterSequence: 1 }, records: [record] } }));
  resolveBody(encoded.buffer);

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

it('does not deliver a stream callback after its shared generation signal aborts', async () => {
  const encoder = new TextEncoder();
  let markReading: (() => void) | undefined;
  let release: (() => void) | undefined;
  let cancelled = false;
  const reading = new Promise<void>((resolve) => { markReading = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    pull: () => markReading?.(),
    start: (controller) => {
      release = () => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
        controller.close();
      };
    },
    cancel: () => { cancelled = true; },
  }, { highWaterMark: 0 }));
  const client = clientFor(response);
  const controller = new AbortController();
  const received: unknown[] = [];
  const stream = client.stream({ afterSequence: 0, onMessage: (message) => received.push(message), signal: controller.signal });
  await reading;
  controller.abort();
  if (release === undefined) throw new Error('Expected an open stream.');
  release();

  await expect(stream.done).resolves.toBeUndefined();
  expect(received).toEqual([]);
});

it('settles a pending stream read when its shared generation signal aborts', async () => {
  let markReading: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => { markReading = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    pull: () => markReading?.(),
  }, { highWaterMark: 0 }));
  const client = clientFor(response);
  const controller = new AbortController();
  const stream = client.stream({ afterSequence: 0, onMessage: () => undefined, signal: controller.signal });
  await reading;
  controller.abort();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([
      stream.done.then(() => 'settled'),
      new Promise<'timed out'>((resolve) => { timeout = setTimeout(() => resolve('timed out'), 50); }),
    ])).resolves.toBe('settled');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
});

it('stops processing later records from the same chunk after its callback aborts', async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n${JSON.stringify({ ...record, sequence: 2 })}\n`);
  const client = clientFor(ndjson([bytes]));
  const controller = new AbortController();
  const received: number[] = [];
  const stream = client.stream({
    afterSequence: 0,
    onMessage: (message) => {
      if (!('sequence' in message)) return;
      received.push(message.sequence);
      controller.abort();
    },
    signal: controller.signal,
  });

  await expect(stream.done).resolves.toBeUndefined();
  expect(received).toEqual([1]);
});
