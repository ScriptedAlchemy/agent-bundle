import { expect, it } from '@rstest/core';

import { parseInputSchema } from '../src/routes/input-schema.ts';

it('reads explicit input JSON Schema metadata and rejects unsupported or undeclared fields', () => {
  const schema = { additionalProperties: false, properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['name'], type: 'object' };
  expect(parseInputSchema(schema, 'config.inputJsonSchema')).toEqual(schema);
  expect(Object.isFrozen(parseInputSchema(schema, 'config.inputJsonSchema').properties)).toBe(true);
  for (const invalid of [
    { ...schema, required: ['missing'] },
    { ...schema, additionalProperties: true },
    { ...schema, properties: { nested: { type: 'object', properties: {} } } },
    { ...schema, unknown: true },
  ]) expect(() => parseInputSchema(invalid, 'config.inputJsonSchema')).toThrow('config.inputJsonSchema');
});
