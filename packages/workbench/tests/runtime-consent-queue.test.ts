import { expect, it } from '@rstest/core';

import type { McpAppConsentChallenge } from '../src/mcp/mcp-app-client.ts';
import { createRuntimeConsentQueue } from '../src/mcp/runtime-consent-queue.ts';

const challenge = (id: string): McpAppConsentChallenge => Object.freeze({
  expiresAt: 10,
  id,
  request: Object.freeze({ actionFingerprint: `runtime-app:${id}:v1`, capability: 'call-tool', details: Object.freeze({}), scope: 'action', summary: `Call ${id}` }),
});

it('removes an aborted queued consent and dismisses an aborted active consent before advancing the FIFO', async () => {
  const visible: Array<string | undefined> = [];
  const queue = createRuntimeConsentQueue((next) => { visible.push(next?.challenge.id); });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const thirdAbort = new AbortController();

  const first = queue.request(challenge('first'), firstAbort.signal);
  const second = queue.request(challenge('second'), secondAbort.signal);
  const third = queue.request(challenge('third'), thirdAbort.signal);
  expect(queue.current?.challenge.id).toBe('first');

  const queuedReason = new DOMException('Queued consent cancelled.', 'AbortError');
  secondAbort.abort(queuedReason);
  await expect(second).rejects.toBe(queuedReason);
  expect(queue.current?.challenge.id).toBe('first');

  const activeReason = new DOMException('Active consent cancelled.', 'AbortError');
  firstAbort.abort(activeReason);
  await expect(first).rejects.toBe(activeReason);
  expect(queue.current?.challenge.id).toBe('third');
  expect(queue.resolve(queue.current!, 'allow-once')).toBe(true);
  await expect(third).resolves.toBe('allow-once');
  expect(queue.current).toBeUndefined();
  expect(queue.resolve(Object.freeze({ challenge: challenge('missing') }), 'deny')).toBe(false);
  expect(visible).toEqual(['first', 'third', undefined]);
});

it('does not let a stale visible consent entry decide its indistinguishable FIFO successor', async () => {
  const queue = createRuntimeConsentQueue(() => undefined);
  const first = queue.request(challenge('first'));
  const firstEntry = queue.current;
  const second = queue.request(challenge('second'));

  expect(firstEntry).toBeDefined();
  expect(queue.resolve(firstEntry!, 'allow-once')).toBe(true);
  await expect(first).resolves.toBe('allow-once');
  const secondEntry = queue.current;
  expect(secondEntry).toBeDefined();
  expect(queue.resolve(firstEntry!, 'deny')).toBe(false);
  expect(queue.current).toBe(secondEntry);
  expect(queue.resolve(secondEntry!, 'deny')).toBe(true);
  await expect(second).resolves.toBe('deny');
});
