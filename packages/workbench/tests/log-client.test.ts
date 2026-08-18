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
  const client = new LogClient({
    fetch: async (input) => String(input).includes('/api/project/session')
      ? session()
      : new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(encoder.encode(JSON.stringify(record)));
          controller.close();
        },
      }), { headers: { 'content-type': 'application/x-ndjson' } }),
  });

  const stream = client.stream({ afterSequence: 0, onMessage: () => undefined });
  await expect(stream.done).rejects.toMatchObject({ code: 'AB8093' });
});
