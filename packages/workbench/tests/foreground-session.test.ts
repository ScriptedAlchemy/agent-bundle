import { expect, it } from '@rstest/core';

import { ForegroundTransport } from '../src/foreground-session.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const session = (): Response => json({ origin: 'http://foreground.test', token: 'test-session-token' });

const invalidSessionBodies: readonly [string, unknown][] = [
  ['a versioned payload', { origin: 'http://foreground.test', schemaVersion: 1, token: 'test-session-token' }],
  ['an unexpected payload field', { origin: 'http://foreground.test', scope: 'workbench', token: 'test-session-token' }],
  ['a malformed payload', { origin: 'http://foreground.test' }],
];

for (const [description, body] of invalidSessionBodies) {
  it(`rejects ${description} from the foreground session bootstrap`, async () => {
    const routePaths: string[] = [];
    const transport = new ForegroundTransport({
      errorFor: (code, message) => Object.assign(new Error(message), { code }),
      fallbackCode: 'AB8093',
      fetch: async (input) => {
        if (String(input) === '/api/project/session') return json(body);
        routePaths.push(String(input));
        return json({ ok: true });
      },
      label: 'Dev Log',
    });

    await expect(transport.request('/api/logs')).rejects.toMatchObject({ code: 'AB8093' });
    expect(routePaths).toEqual([]);
  });
}

it('does not issue an aborted request after it waits for cached session bootstrap', async () => {
  let resolveSession: ((response: Response) => void) | undefined;
  const routePaths: string[] = [];
  const transport = new ForegroundTransport({
    errorFor: (code, message) => Object.assign(new Error(message), { code }),
    fallbackCode: 'AB8093',
    fetch: async (input) => {
      const path = String(input);
      if (path.includes('/api/project/session')) {
        return await new Promise<Response>((resolve) => { resolveSession = resolve; });
      }
      routePaths.push(path);
      return json({ ok: true });
    },
    label: 'Dev Log',
  });
  const first = transport.request('/api/logs/first');
  const controller = new AbortController();
  const second = transport.request('/api/logs/second', { signal: controller.signal });
  if (resolveSession === undefined) throw new Error('Expected foreground session acquisition.');
  controller.abort();
  resolveSession(session());

  await expect(first).resolves.toBeInstanceOf(Response);
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(routePaths).toEqual(['/api/logs/first']);
});
