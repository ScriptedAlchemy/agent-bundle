import { expect, it } from '@rstest/core';

import { readNdjsonResponseFrames } from '../src/ndjson.ts';

it('releases the response body after reading NDJSON frames', async () => {
  const response = new Response('{"sequence":1}\n');
  const body = response.body!;
  const frames: string[] = [];

  await readNdjsonResponseFrames(response, (bytes) => {
    frames.push(new TextDecoder().decode(bytes));
  }, {
    invalidFrameError: () => new Error('invalid frame'),
    maxFrameBytes: 1024,
    signal: new AbortController().signal,
  });

  expect(frames).toEqual(['{"sequence":1}']);
  expect(body.locked).toBe(false);
});
