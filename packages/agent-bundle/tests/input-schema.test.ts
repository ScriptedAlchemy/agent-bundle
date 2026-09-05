import { expect, it } from '@rstest/core';

import { extractInputSchema, parseInputSchema } from '../src/routes/input-schema.ts';

const extract = (schema: string) => {
  const extracted = extractInputSchema(
    `export const inputSchema = ${schema};\n`,
    'src/mcp/library/tools/inspect.ts',
  );
  return extracted !== undefined && typeof extracted === 'object' && 'schema' in extracted
    ? extracted.schema
    : extracted;
};

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

const routeRelativePath = 'src/cli/library/status.ts';
const routeSource = `/project/${routeRelativePath}`;

const nameObjectSchema = 'z.object({ name: z.string() }).strict()';

const nameObjectProjection = {
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
  },
  required: ['name'],
  type: 'object',
} as const;

/** An in-memory project tree standing in for the sibling modules a schema reference imports. */
const virtualProject = (files: Readonly<Record<string, string>>, source = routeSource) => {
  const modules = new Map(Object.entries(files));
  return {
    projectRoot: '/project',
    readModule: (path: string) => modules.get(path),
    source,
  };
};

const parse = (
  text: string,
  files: Readonly<Record<string, string>> = {},
  relativePath = routeRelativePath,
) => parseInputSchema(text, relativePath, virtualProject(files, `/project/${relativePath}`));

const extractResolved = (
  text: string,
  files: Readonly<Record<string, string>> = {},
  relativePath = routeRelativePath,
) => extractInputSchema(text, relativePath, virtualProject(files, `/project/${relativePath}`));

it('records the route-local literal origin as the inputSchema binding', () => {
  const text = `export const inputSchema = ${nameObjectSchema};\n`;
  const parsed = parse(text);
  expect(parsed.found).toBe(true);
  expect(parsed.issues).toEqual([]);
  expect(parsed.origin).toEqual({ binding: 'inputSchema', module: routeRelativePath });
  expect(parsed.resolution).toBeUndefined();
  expect(extractResolved(text)?.origin).toEqual({ binding: 'inputSchema', module: routeRelativePath });
  expect(extractResolved(text)?.schema).toEqual(nameObjectProjection);
});

it('resolves a same-module non-exported const alias and records that binding as the origin', () => {
  const text = [
    `const s = ${nameObjectSchema};`,
    'export const inputSchema = s;',
    '',
  ].join('\n');
  const parsed = parse(text);
  expect(parsed.found).toBe(true);
  expect(parsed.issues).toEqual([]);
  expect(parsed.origin).toEqual({ binding: 's', module: routeRelativePath });
  expect(extractResolved(text)?.schema).toEqual(nameObjectProjection);
});

it('resolves one hop through a .js named import onto the .ts sibling and matches the inline twin', () => {
  const files = {
    '/project/src/lib/protocol-schemas.ts': `export const statusInputSchema = ${nameObjectSchema};\n`,
  };
  const imported = [
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';",
    'export const inputSchema = statusInputSchema;',
    '',
  ].join('\n');
  const inline = `export const inputSchema = ${nameObjectSchema};\n`;
  const parsed = parse(imported, files);
  expect(parsed.origin).toEqual({
    binding: 'statusInputSchema',
    module: 'src/lib/protocol-schemas.ts',
  });
  expect(extractResolved(imported, files)?.schema).toEqual(extractResolved(inline)?.schema);
  expect(extractResolved(imported, files)?.schema).toEqual(nameObjectProjection);
});

it('follows a two-hop alias chain and records the origin at the end of the chain', () => {
  const files = {
    '/project/src/lib/base.ts': `export const baseSchema = ${nameObjectSchema};\n`,
    '/project/src/lib/protocol-schemas.ts': [
      "import { baseSchema } from './base.js';",
      'export const statusInputSchema = baseSchema;',
      '',
    ].join('\n'),
  };
  const text = [
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';",
    'export const inputSchema = statusInputSchema;',
    '',
  ].join('\n');
  const parsed = parse(text, files);
  expect(parsed.origin).toEqual({ binding: 'baseSchema', module: 'src/lib/base.ts' });
  expect(extractResolved(text, files)?.schema).toEqual(nameObjectProjection);
});

it('projects the cargo-hauler enum-array shape through an imported as-const and a local non-exported const', () => {
  const files = {
    '/project/src/daemon/protocol.ts':
      "export const requestStatuses = ['queued', 'running', 'succeeded', 'failed'] as const;\n",
    '/project/src/lib/protocol-schemas.ts': [
      "import { requestStatuses } from '../daemon/protocol.js';",
      'const requestStatusSchema = z.enum(requestStatuses);',
      'export const statusInputSchema = z.object({',
      '  limit: z.number().int().min(1).max(500).optional(),',
      '  laneKey: z.string().min(1).optional(),',
      '  tickets: z.array(z.string().min(1)).max(100).optional(),',
      '  statuses: z.array(requestStatusSchema).max(8).optional(),',
      '}).strict();',
      '',
    ].join('\n'),
  };
  const text = [
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';",
    'export const inputSchema = statusInputSchema;',
    '',
  ].join('\n');
  const parsed = parse(text, files);
  expect(parsed.issues).toEqual([]);
  expect(parsed.origin).toEqual({
    binding: 'statusInputSchema',
    module: 'src/lib/protocol-schemas.ts',
  });
  const statuses = parsed.properties?.find((property) => property.key === 'statuses');
  expect(statuses).toMatchObject({
    base: { choices: ['queued', 'running', 'succeeded', 'failed'], kind: 'enum' },
    optional: true,
    repeated: true,
  });
  expect(extractResolved(text, files)?.schema).toEqual({
    additionalProperties: false,
    properties: {
      laneKey: { type: 'string' },
      limit: { type: 'number' },
      statuses: {
        items: { enum: ['queued', 'running', 'succeeded', 'failed'], type: 'string' },
        type: 'array',
      },
      tickets: { items: { type: 'string' }, type: 'array' },
    },
    type: 'object',
  });
});

it('applies local chain methods after a resolved chain-root identifier', () => {
  const text = [
    'const shared = z.string().min(1);',
    'export const inputSchema = z.object({',
    "  name: shared.optional().describe('x'),",
    '}).strict();',
    '',
  ].join('\n');
  const parsed = parse(text);
  expect(parsed.issues).toEqual([]);
  expect(extractResolved(text)?.schema).toEqual({
    additionalProperties: false,
    properties: {
      name: { description: 'x', type: 'string' },
    },
    type: 'object',
  });
});

it('resolves z.object(shapeConst) and .default of a numeric const', () => {
  const text = [
    'const DEFAULT_LIMIT = 25;',
    'const shapeConst = {',
    '  limit: z.number().int().default(DEFAULT_LIMIT),',
    '};',
    'export const inputSchema = z.object(shapeConst).strict();',
    '',
  ].join('\n');
  const parsed = parse(text);
  expect(parsed.issues).toEqual([]);
  expect(extractResolved(text)?.schema).toEqual({
    additionalProperties: false,
    properties: {
      limit: { default: 25, type: 'number' },
    },
    type: 'object',
  });
});

it('reports a reference cycle with each step once plus the repeated binding and extracts nothing', () => {
  const files = {
    '/project/src/lib/a.ts': [
      "import { y } from './b.js';",
      'export const x = y;',
      '',
    ].join('\n'),
    '/project/src/lib/b.ts': [
      "import { x } from './a.js';",
      'export const y = x;',
      '',
    ].join('\n'),
  };
  const text = [
    "import { x } from '../../lib/a.js';",
    'export const inputSchema = x;',
    '',
  ].join('\n');
  const parsed = parse(text, files);
  expect(parsed.resolution).toEqual({
    chain: [
      'inputSchema',
      'x (src/lib/a.ts)',
      'y (src/lib/b.ts)',
      'x (src/lib/a.ts)',
    ],
    kind: 'cycle',
  });
  expect(parsed.properties).toBeUndefined();
  expect(extractResolved(text, files)).toBeUndefined();
});

it.each([
  [
    'a bare package specifier',
    "import { statusInputSchema } from '@shared/protocol';\nexport const inputSchema = statusInputSchema;\n",
    {},
    ['inputSchema', 'statusInputSchema'],
    'imported from "@shared/protocol", which is not a relative module path',
  ],
  [
    'a module outside the project root',
    "import { statusInputSchema } from '../../../../../outside';\nexport const inputSchema = statusInputSchema;\n",
    { '/outside.ts': `export const statusInputSchema = ${nameObjectSchema};\n` },
    ['inputSchema', 'statusInputSchema'],
    'imported from "../../../../../outside", which resolves outside the project',
  ],
  [
    'a missing sibling module',
    "import { statusInputSchema } from './missing';\nexport const inputSchema = statusInputSchema;\n",
    {},
    ['inputSchema', 'statusInputSchema'],
    'imported from "./missing", which does not resolve to a module inside the project',
  ],
  [
    'a sibling without that export const',
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';\nexport const inputSchema = statusInputSchema;\n",
    { '/project/src/lib/protocol-schemas.ts': 'export const other = 1;\n' },
    ['inputSchema', 'statusInputSchema (src/lib/protocol-schemas.ts)'],
    'which does not declare a top-level `export const statusInputSchema`',
  ],
  [
    'a let binding',
    `let s = ${nameObjectSchema};\nexport const inputSchema = s;\n`,
    {},
    ['inputSchema', 's'],
    'which is not a top-level `const`',
  ],
  [
    'a destructured binding',
    'const { s } = source;\nexport const inputSchema = s;\n',
    {},
    ['inputSchema', 's'],
    'which is not a top-level `const`',
  ],
  [
    'a default import',
    "import s from '../../lib/protocol-schemas.js';\nexport const inputSchema = s;\n",
    { '/project/src/lib/protocol-schemas.ts': `export default ${nameObjectSchema};\n` },
    ['inputSchema', 's'],
    'which is not a top-level `const`',
  ],
  [
    'a namespace import',
    "import * as s from '../../lib/protocol-schemas.js';\nexport const inputSchema = s;\n",
    { '/project/src/lib/protocol-schemas.ts': `export const statusInputSchema = ${nameObjectSchema};\n` },
    ['inputSchema', 's'],
    'which is not a top-level `const`',
  ],
  [
    'a type-only import',
    "import type { statusInputSchema } from '../../lib/protocol-schemas.js';\nexport const inputSchema = statusInputSchema;\n",
    { '/project/src/lib/protocol-schemas.ts': `export const statusInputSchema = ${nameObjectSchema};\n` },
    ['inputSchema', 'statusInputSchema'],
    'which is neither a top-level const in this module nor a named import from a relative module',
  ],
  [
    'a dynamic initializer',
    'export const s = build();\nexport const inputSchema = s;\n',
    {},
    ['inputSchema', 's'],
    'whose initializer is a call expression',
  ],
  [
    'a spread inside the shape',
    'export const inputSchema = z.object({ ...shared, name: z.string() });\n',
    {},
    ['inputSchema'],
    'a spread',
  ],
])('leaves %s unresolved with the named chain and reason fragment', (_name, text, files, chain, fragment) => {
  const parsed = parse(text, files);
  expect(parsed.found).toBe(true);
  expect(parsed.resolution).toMatchObject({ chain, kind: 'unresolved' });
  expect(parsed.resolution && 'reason' in parsed.resolution ? parsed.resolution.reason : '').toContain(fragment);
  expect(parsed.properties).toBeUndefined();
  expect(extractResolved(text, files)).toBeUndefined();
});

it('qualifies a grammar violation inside an imported schema with the sibling position and AB4814 wording', () => {
  const files = {
    '/project/src/lib/protocol-schemas.ts': [
      'export const statusInputSchema = z.object({',
      '  nested: z.object({ value: z.string() }),',
      '}).strict();',
      '',
    ].join('\n'),
  };
  const text = [
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';",
    'export const inputSchema = statusInputSchema;',
    '',
  ].join('\n');
  const parsed = parse(text, files);
  expect(parsed.resolution).toBeUndefined();
  expect(parsed.issues[0]).toContain('src/lib/protocol-schemas.ts:2:11');
  expect(parsed.issues[0]).toContain('is outside the bounded argv grammar.');
  expect(parsed.issues[0]).toContain('the zod base z.object');
  expect(extractResolved(text, files)).toBeUndefined();
});

it('rejects an import reference when the source path option is missing', () => {
  const text = [
    "import { statusInputSchema } from '../../lib/protocol-schemas.js';",
    'export const inputSchema = statusInputSchema;',
    '',
  ].join('\n');
  const parsed = parseInputSchema(text, routeRelativePath, {
    projectRoot: '/project',
    readModule: () => `export const statusInputSchema = ${nameObjectSchema};\n`,
  });
  expect(parsed.resolution).toMatchObject({ kind: 'unresolved' });
  expect(parsed.resolution && 'reason' in parsed.resolution ? parsed.resolution.reason : '')
    .toMatch(/source path/u);
  expect(extractInputSchema(text, routeRelativePath, {
    projectRoot: '/project',
    readModule: () => `export const statusInputSchema = ${nameObjectSchema};\n`,
  })).toBeUndefined();
});
