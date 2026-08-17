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
  const queue = createRuntimeConsentQueue((next) => { visible.push(next?.id); });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const thirdAbort = new AbortController();

  const first = queue.request(challenge('first'), firstAbort.signal);
  const second = queue.request(challenge('second'), secondAbort.signal);
  const third = queue.request(challenge('third'), thirdAbort.signal);
  expect(queue.current?.id).toBe('first');

  const queuedReason = new DOMException('Queued consent cancelled.', 'AbortError');
  secondAbort.abort(queuedReason);
  await expect(second).rejects.toBe(queuedReason);
  expect(queue.current?.id).toBe('first');

  const activeReason = new DOMException('Active consent cancelled.', 'AbortError');
  firstAbort.abort(activeReason);
  await expect(first).rejects.toBe(activeReason);
  expect(queue.current?.id).toBe('third');
  expect(queue.resolve('allow-once')).toBe(true);
  await expect(third).resolves.toBe('allow-once');
  expect(queue.current).toBeUndefined();
  expect(queue.resolve('deny')).toBe(false);
  expect(visible).toEqual(['first', 'third', undefined]);
});
