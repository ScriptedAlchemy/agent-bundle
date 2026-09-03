import { expect, it } from '@rstest/core';

import { banner, frozenMeta, identity } from '../../src/lib/identity.ts';

// The values the sibling package.json and agent-bundle.config.ts declare; the
// spawning repository test cross-checks them against the files themselves.
const expected = {
  name: 'meta-consumer',
  packageName: 'meta-consumer-fixture',
  packageVersion: '3.4.5',
  version: '3.4.5',
};

it('loads a source module importing agent-bundle/meta with the package identity', () => {
  expect(identity).toEqual(expected);
  expect(banner).toBe('meta-consumer 3.4.5');
});

it('serves the frozen aggregate the published type declares', () => {
  expect(frozenMeta).toEqual(expected);
  expect(Object.isFrozen(frozenMeta)).toBe(true);
});
