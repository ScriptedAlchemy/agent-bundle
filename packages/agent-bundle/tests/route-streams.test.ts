import { expect, it } from '@rstest/core';

import { encodedNdjsonFrame } from '../src/dev/route-streams.ts';

it('re-encodes mutable messages instead of serving stale stream frames', () => {
  const message = { sequence: 1 };

  expect(encodedNdjsonFrame(message)).toBe('{"sequence":1}\n');
  message.sequence = 2;

  expect(encodedNdjsonFrame(message)).toBe('{"sequence":2}\n');
});
