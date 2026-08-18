import { expect, it } from '@rstest/core';

import { LogClient, LogClientError } from '../src/logs/log-client.ts';

const record = Object.freeze({
  context: Object.freeze({ target: 'codex' }),
  details: Object.freeze({ event: 'safe' }),
  kind: 'build.started',
  level: 'info',
  occurredAt: '2026-08-18T12:00:00.000Z',
  producer: 'build',
  schemaVersion: 1,
  sequence: 1,
  summary: 'Project build started.',
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const session = (): Response => json({ origin: 'http://foreground.test', token: 'test-session-token' });

const ndjson = (chunks: readonly Uint8Array[]): Response => new Response(new ReadableStream<Uint8Array>({
  start: (controller) => {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { headers: { 'content-type': 'application/x-ndjson' } });

const streamClient = (response: Response): LogClient => new LogClient({
  fetch: async (input) => String(input).includes('/api/project/session') ? session() : response,
});

it('rejects hostile or noncontiguous replay envelopes before exposing them to the page', async () => {
  let calls = 0;
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error('hostile envelope'); } });
  const client = new LogClient({
    fetch: async () => {
      calls += 1;
      return calls === 1 ? session() : {
        json: async () => hostile,
        ok: true,
        status: 200,
      } as unknown as Response;
    },
  });

  await expect(client.replay()).rejects.toBeInstanceOf(LogClientError);

  const noncontiguous = new LogClient({
    fetch: async (input) => String(input).includes('/api/project/session')
      ? session()
      : json({ replay: { cursor: { afterSequence: 3 }, records: [{ ...record, sequence: 3 }] } }),
  });
  await expect(noncontiguous.replay()).rejects.toMatchObject({ code: 'AB8093' });
});

it('rejects a trailing unterminated NDJSON frame instead of accepting a partial record', async () => {
  const encoder = new TextEncoder();
  const client = streamClient(ndjson([encoder.encode(JSON.stringify(record))]));

  const stream = client.stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(stream.done).rejects.toMatchObject({ code: 'AB8093' });
});

it('rejects duplicate replay keys, extra record fields, and unsafe wire text before the page receives a record', async () => {
  const replay = { replay: { cursor: { afterSequence: 1 }, records: [record] } };
  const duplicateDetails = JSON.stringify(replay).replace('"event":"safe"', '"event":"safe","event":"changed"');
  const duplicate = new LogClient({
    fetch: async (input) => String(input).includes('/api/project/session') ? session() : new Response(duplicateDetails),
  });
  await expect(duplicate.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const extraField = new LogClient({
    fetch: async (input) => String(input).includes('/api/project/session')
      ? session()
      : json({ replay: { cursor: { afterSequence: 1 }, records: [{ ...record, untrusted: 'extra' }] } }),
  });
  await expect(extraField.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const unsafeText = new LogClient({
    fetch: async (input) => String(input).includes('/api/project/session')
      ? session()
      : json({ replay: { cursor: { afterSequence: 1 }, records: [{ ...record, summary: '/private/fixture-secret' }] } }),
  });
  await expect(unsafeText.replay()).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });
});

it('rejects malformed UTF-8 and a frame larger than 64 KiB before decoding NDJSON records', async () => {
  const encoder = new TextEncoder();
  const malformedPrefix = encoder.encode('{"context":{},"details":{},"kind":"project.load","level":"info","occurredAt":"2026-08-18T12:00:00.000Z","producer":"project","schemaVersion":1,"sequence":1,"summary":"');
  const malformedSuffix = encoder.encode('"}\n');
  const malformed = new Uint8Array(malformedPrefix.length + 1 + malformedSuffix.length);
  malformed.set(malformedPrefix);
  malformed[malformedPrefix.length] = 0xff;
  malformed.set(malformedSuffix, malformedPrefix.length + 1);
  const malformedStream = streamClient(ndjson([malformed])).stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(malformedStream.done).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });

  const oversized = { ...record, summary: 'x'.repeat(65 * 1024) };
  const oversizedStream = streamClient(ndjson([encoder.encode(`${JSON.stringify(oversized)}\n`)])).stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(oversizedStream.done).rejects.toMatchObject({ code: 'AB8093', message: 'Dev Log route returned an invalid response.' });
});
