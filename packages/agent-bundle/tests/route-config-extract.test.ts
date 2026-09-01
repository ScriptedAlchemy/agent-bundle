import { expect, it } from '@rstest/core';

import { extractRouteConfig } from '../src/routes/config-extract.ts';
import { emptyRouteConfig } from '../src/routes/types.ts';

const extract = (text: string, relativePath = 'src/mcp/notes/tools/search.ts') =>
  extractRouteConfig(text, relativePath, `/project/${relativePath}`);

it('extracts the accepted literal grammar into a frozen config', () => {
  const { config, diagnostics } = extract([
    'export const config = {',
    "  title: 'Search notes',",
    '  "annotations": { readOnlyHint: true, priority: 0.5 },',
    "  tags: ['notes', `search`],",
    '  limits: { depth: -2, offset: +3, 42: null },',
    '  flag: false,',
    '} as const;',
    'export default () => null;',
  ].join('\n'));
  expect(diagnostics).toEqual([]);
  expect(config).toEqual({
    annotations: { priority: 0.5, readOnlyHint: true },
    flag: false,
    limits: { 42: null, depth: -2, offset: 3 },
    tags: ['notes', 'search'],
    title: 'Search notes',
  });
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen((config as { annotations: object }).annotations)).toBe(true);
});

it('unwraps satisfies, parentheses, and non-null wrappers', () => {
  const { config, diagnostics } = extract(
    "export const config = (({ mode: 'fast' }) satisfies Record<string, string>)!;",
  );
  expect(diagnostics).toEqual([]);
  expect(config).toEqual({ mode: 'fast' });
});

it('parses TSX modules whose bodies contain JSX', () => {
  const { config, diagnostics } = extract([
    "export const config = { title: 'App' };",
    'export default function App() { return <main title="x">hi</main>; }',
  ].join('\n'), 'src/mcp/notes/apps/panel.tsx');
  expect(diagnostics).toEqual([]);
  expect(config).toEqual({ title: 'App' });
});

it('parses JSX modules whose bodies contain JSX', () => {
  const { config, diagnostics } = extract([
    "export const config = { title: 'Poster' };",
    'export default function Poster() { return <section>poster</section>; }',
  ].join('\n'), 'src/scripts/render-poster.jsx');
  expect(diagnostics).toEqual([]);
  expect(config).toEqual({ title: 'Poster' });
});

it('preserves a literal "__proto__" key as an own config property', () => {
  const { config, diagnostics } = extract(
    'export const config = { "__proto__": { injected: true }, title: \'safe\' };',
  );
  expect(diagnostics).toEqual([]);
  // The key is an ordinary own data property: enumerated, serialized, and
  // frozen like any other — never a prototype swap that inspection and the
  // digest would silently drop.
  expect(Object.keys(config)).toEqual(['__proto__', 'title']);
  const descriptor = Object.getOwnPropertyDescriptor(config, '__proto__');
  expect(descriptor?.value).toEqual({ injected: true });
  expect(JSON.parse(JSON.stringify(config))).toMatchObject({ title: 'safe' });
  expect(JSON.stringify(config)).toContain('"__proto__":{"injected":true}');
  expect(Object.isFrozen(descriptor?.value)).toBe(true);
});

it('extracts silently to the empty config when no config export exists', () => {
  const { config, diagnostics } = extract('export default () => null;\nconst config = { hidden: true };');
  expect(diagnostics).toEqual([]);
  expect(config).toBe(emptyRouteConfig);
});

it.each([
  ['identifier reference', "const base = {};\nexport const config = base;", 'AB4806', 'reference to the identifier "base"'],
  ['call expression', 'export const config = make();', 'AB4806', 'a call expression'],
  ['template substitution', 'export const config = { title: `v${1}` };', 'AB4806', 'a template literal with substitutions'],
  ['object spread', 'export const config = { ...rest };', 'AB4806', 'a spread'],
  ['shorthand property', 'const title = 1;\nexport const config = { title };', 'AB4806', 'a shorthand property reference'],
  ['computed name', "export const config = { ['k']: 1 };", 'AB4806', 'a computed property name'],
  ['method', 'export const config = { run() { return 1; } };', 'AB4806', 'a method or accessor'],
  ['array spread', 'export const config = { tags: [...list] };', 'AB4806', 'a spread'],
  ['undefined value', 'export const config = { title: undefined };', 'AB4806', 'the non-JSON value `undefined`'],
  ['overflowing numeric literal', 'export const config = { limit: 1e999 };', 'AB4806', 'the non-finite number `Infinity`'],
  ['negated overflowing numeric literal', 'export const config = { limit: -1e999 };', 'AB4806', 'the non-finite number `-Infinity`'],
  ['bigint literal', 'export const config = { big: 1n };', 'AB4806', 'a bigint literal'],
  ['let declaration', 'export let config = {};', 'AB4805', 'a mutable `let`/`var` declaration'],
  ['destructuring', 'export const { config } = source;', 'AB4805', 'a destructuring declaration'],
  ['indirect export', 'const config = {};\nexport { config };', 'AB4805', 'an indirect `export { config }` clause'],
  ['function declaration', 'export function config() { return {}; }', 'AB4805', 'a function or class declaration'],
  ['missing initializer', 'export declare const config: object;', 'AB4805', 'a declaration without an initializer'],
  ['non-object value', "export const config = 'title';", 'AB4805', 'exports a string config'],
])('rejects %s with a named diagnostic', (_name, text, code, fragment) => {
  const { config, diagnostics } = extract(text);
  expect(config).toBe(emptyRouteConfig);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    code,
    severity: 'error',
    sourcePath: '/project/src/mcp/notes/tools/search.ts',
  });
  expect(diagnostics[0]!.message).toContain(fragment);
});

it('names the position of the first dynamic construct', () => {
  const { diagnostics } = extract([
    'export const config = {',
    "  ok: 'yes',",
    '  bad: compute(),',
    '};',
  ].join('\n'));
  expect(diagnostics[0]!.message).toContain('3:8');
});
