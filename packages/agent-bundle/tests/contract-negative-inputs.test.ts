import { expect, it } from '@rstest/core';

import { negativeInputsFromJsonSchema } from '../src/test/contract.ts';

it('derives unknown-key, missing-required, and wrong-type negatives from a top-level object schema', () => {
  const negatives = negativeInputsFromJsonSchema({
    additionalProperties: false,
    properties: {
      count: { type: 'number' },
      enabled: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['note'],
    type: 'object',
  });

  expect(negatives).toEqual([
    { input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' },
    { input: {}, label: 'missing-required:note' },
    { input: { count: 'not-a-number', enabled: true, note: 'value' }, label: 'wrong-type:count' },
    { input: { count: 1, enabled: 'not-a-boolean', note: 'value' }, label: 'wrong-type:enabled' },
    { input: { count: 1, enabled: true, note: 0 }, label: 'wrong-type:note' },
  ]);
});

it('returns undefined when the advertised schema has no top-level object structure', () => {
  expect(negativeInputsFromJsonSchema({ type: 'string' })).toBeUndefined();
  expect(negativeInputsFromJsonSchema({ properties: {}, type: 'array' })).toBeUndefined();
  expect(negativeInputsFromJsonSchema({ type: 'object' })).toBeUndefined();
});

it('derives only an unknown-key negative for an object schema with no properties', () => {
  expect(negativeInputsFromJsonSchema({
    additionalProperties: false,
    properties: {},
    type: 'object',
  })).toEqual([
    { input: { __agentBundleContractNegative: true }, label: 'unknown-extra-key' },
  ]);
});
