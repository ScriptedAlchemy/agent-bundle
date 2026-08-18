import { expect, it } from '@rstest/core';

import { ForegroundTransport } from '../src/foreground-session.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const session = (): Response => json({ origin: 'http://foreground.test', token: 'test-session-token' });

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
