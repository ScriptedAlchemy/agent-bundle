import { expect, it } from '@rstest/core';

import { extractInputSchema } from '../src/routes/input-schema.ts';

const extract = (schema: string) => extractInputSchema(
  `export const inputSchema = ${schema};\n`,
  'src/mcp/library/tools/inspect.ts',
);

it('projects the bounded zod grammar into a sorted frozen JSON Schema subset', () => {
  const schema = extract([
    'z.object({',
    "  tags: z.array(z.enum(['fiction', 'history'])).default(['history']).describe('Catalog tags.'),",
    "  count: z.number().int().min(1).optional().describe('Maximum matches.'),",
    '  enabled: z.boolean().default(true),',
    "  format: z.enum(['json', 'table']).default('table'),",
    '  root: z.url(),',
    '}).strict()',
  ].join('\n'));

  expect(schema).toEqual({
    additionalProperties: false,
    properties: {
      count: { description: 'Maximum matches.', type: 'number' },
      enabled: { default: true, type: 'boolean' },
      format: { default: 'table', enum: ['json', 'table'], type: 'string' },
      root: { type: 'string' },
      tags: {
        default: ['history'],
        description: 'Catalog tags.',
        items: { enum: ['fiction', 'history'], type: 'string' },
        type: 'array',
      },
    },
    required: ['root'],
    type: 'object',
  });
  expect(Object.isFrozen(schema)).toBe(true);
  expect(Object.isFrozen(schema?.properties)).toBe(true);
  expect(Object.isFrozen(schema?.properties.tags)).toBe(true);
  expect(Object.isFrozen(schema?.properties.tags?.type === 'array' ? schema.properties.tags.items : undefined)).toBe(true);
});

it('accepts strictObject and omits an empty required array', () => {
  expect(extract("z.strictObject({ name: z.string().default('library') })")).toEqual({
    additionalProperties: false,
    properties: {
      name: { default: 'library', type: 'string' },
    },
    type: 'object',
  });
});

it('returns no projection for absent and out-of-grammar schemas without diagnostics', () => {
  expect(extractInputSchema(
    'export const other = 1;\n',
    'src/mcp/library/tools/inspect.ts',
  )).toBeUndefined();
  expect(extract('z.object({ nested: z.object({ value: z.string() }) })')).toBeUndefined();
  expect(extract('z.object({ root: sharedPathSchema })')).toBeUndefined();
  expect(extract('z.object({ flags: z.array(z.boolean()) })')).toBeUndefined();
  expect(extract('z.object({ value: z.string().transform(String) })')).toBeUndefined();
});
