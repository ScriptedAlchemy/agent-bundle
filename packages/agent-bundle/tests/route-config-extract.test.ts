import { expect, it } from '@rstest/core';

import {
  extractRouteConfig,
  resolveRouteConfigAppReferences,
  type RouteConfigExtractionOptions,
} from '../src/routes/config-extract.ts';
import { emptyRouteConfig } from '../src/routes/types.ts';

const extract = (
  text: string,
  relativePath = 'src/mcp/notes/tools/search.ts',
  options: RouteConfigExtractionOptions = {},
) => extractRouteConfig(text, relativePath, `/project/${relativePath}`, options);

const codes = (diagnostics: readonly { readonly code: string }[]): string[] => diagnostics.map((diagnostic) => diagnostic.code);

/** An in-memory project tree standing in for the sibling modules a const reference imports. */
const virtualProject = (files: Readonly<Record<string, string>>): RouteConfigExtractionOptions => ({
  projectRoot: '/project',
  readModule: (path) => files[path],
});

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

it('resolves a same-module top-level const string literal, exported or not', () => {
  const { appReferences, config, diagnostics } = extract([
    "const APP_URI = 'ui://notes/panel.html' as const;",
    'export const TITLE = (`Search notes`);',
    'export const config = { _meta: { ui: { resourceUri: APP_URI } }, title: TITLE };',
    'export default () => null;',
  ].join('\n'));
  expect(diagnostics).toEqual([]);
  expect(appReferences).toEqual([]);
  expect(config).toEqual({ _meta: { ui: { resourceUri: 'ui://notes/panel.html' } }, title: 'Search notes' });
});

it('resolves an exported const string literal imported from a relative sibling module', () => {
  const project = virtualProject({
    '/project/src/mcp/notes/constants.ts': [
      "export const APP_RESOURCE_URI = 'ui://notes/panel.html';",
      "export const OTHER = 'unused';",
      '',
    ].join('\n'),
    '/project/src/shared/index.ts': "export const SHARED_TITLE = 'Shared' as const;\n",
  });
  const { config, diagnostics } = extract([
    "import { APP_RESOURCE_URI as URI } from '../constants.js';",
    "import { SHARED_TITLE } from '../../../shared';",
    "import type { ToolConfig } from 'agent-bundle';",
    'export const config = { _meta: { ui: { resourceUri: URI } }, title: SHARED_TITLE } satisfies ToolConfig;',
    'export default () => null;',
  ].join('\n'), 'src/mcp/notes/tools/search.ts', project);
  expect(diagnostics).toEqual([]);
  expect(config).toEqual({ _meta: { ui: { resourceUri: 'ui://notes/panel.html' } }, title: 'Shared' });
});

it.each([
  [
    'a bare package specifier',
    "import { URI } from 'my-constants';",
    {},
    'imported from "my-constants", which is not a relative module path',
  ],
  [
    'a missing sibling module',
    "import { URI } from './missing';",
    {},
    'imported from "./missing", which does not resolve to a module inside the project',
  ],
  [
    'a module outside the project root',
    "import { URI } from '../../../../../outside';",
    { '/outside.ts': "export const URI = 'ui://x/y.html';\n" },
    'imported from "../../../../../outside", which resolves outside the project',
  ],
  [
    'a sibling without that export',
    "import { URI } from './constants';",
    { '/project/src/mcp/notes/tools/constants.ts': "const URI = 'ui://x/y.html';\nexport const OTHER = 1;\n" },
    'which does not declare a top-level `export const URI`',
  ],
  [
    'a sibling whose const is not a string literal',
    "import { URI } from './constants';",
    { '/project/src/mcp/notes/tools/constants.ts': "export const URI = `ui://${'x'}/y.html`;\n" },
    'whose `export const URI` initializer is not a string literal',
  ],
  [
    'a type-only import',
    "import type { URI } from './constants';",
    { '/project/src/mcp/notes/tools/constants.ts': "export const URI = 'ui://x/y.html';\n" },
    'neither a top-level const string literal in this module nor a named import',
  ],
  [
    'a default import',
    "import URI from './constants';",
    { '/project/src/mcp/notes/tools/constants.ts': "export default 'ui://x/y.html';\n" },
    'which is not a top-level `const` string literal',
  ],
])('keeps an identifier through %s dynamic (AB4806) and names both supported forms', (_name, importLine, files, fragment) => {
  const { config, diagnostics } = extract([
    importLine,
    'export const config = { _meta: { ui: { resourceUri: URI } } };',
  ].join('\n'), 'src/mcp/notes/tools/search.ts', virtualProject(files));
  expect(config).toBe(emptyRouteConfig);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: 'AB4806', severity: 'error' });
  expect(diagnostics[0]!.message).toContain('a reference to the identifier "URI"');
  expect(diagnostics[0]!.message).toContain(fragment);
  expect(diagnostics[0]!.recovery).toContain("appResourceUri('<app>')");
  expect(diagnostics[0]!.recovery).toContain('agent-bundle/routes');
  expect(diagnostics[0]!.recovery).toContain('const string literal');
});

it('records appResourceUri() references for the graph compiler and resolves them to the App resourceUri', () => {
  const extracted = extract([
    "import { appResourceUri as ref } from 'agent-bundle/routes';",
    "const DASHBOARD = 'dashboard';",
    'export const config = {',
    "  _meta: { ui: { resourceUri: ref('dashboard') } },",
    "  related: [ref('notes/dashboard'), ref(DASHBOARD)],",
    "  title: 'Search',",
    '};',
    'export default () => null;',
  ].join('\n'));
  expect(extracted.diagnostics).toEqual([]);
  expect(extracted.appReferences).toEqual([
    { path: ['_meta', 'ui', 'resourceUri'], position: '4:31', reference: 'dashboard' },
    { path: ['related', 0], position: '5:13', reference: 'notes/dashboard' },
    { path: ['related', 1], position: '5:37', reference: 'dashboard' },
  ]);
  // Until resolution the reference text stands in, matching the run-time helper.
  expect(extracted.config).toEqual({
    _meta: { ui: { resourceUri: 'dashboard' } },
    related: ['notes/dashboard', 'dashboard'],
    title: 'Search',
  });
  expect(Object.isFrozen(extracted.appReferences)).toBe(true);

  const site = { relativePath: 'src/mcp/notes/tools/search.ts', serverName: 'notes', source: '/project/src/mcp/notes/tools/search.ts' };
  const apps = [{ id: 'app:notes/dashboard', resourceUri: 'ui://notes/dashboard.html', source: '/project/src/mcp/notes/apps/dashboard.tsx' }];
  const resolved = resolveRouteConfigAppReferences(extracted, site, apps);
  expect(resolved.diagnostics).toEqual([]);
  expect(resolved.appReferences).toEqual([]);
  expect(resolved.config).toEqual({
    _meta: { ui: { resourceUri: 'ui://notes/dashboard.html' } },
    related: ['ui://notes/dashboard.html', 'ui://notes/dashboard.html'],
    title: 'Search',
  });
  expect(Object.isFrozen(resolved.config)).toBe(true);
  expect(Object.isFrozen((resolved.config as { _meta: { ui: object } })._meta.ui)).toBe(true);
});

const notesApps = [
  { id: 'app:notes/dashboard', resourceUri: 'ui://notes/dashboard.html', source: '/project/src/mcp/notes/apps/dashboard.tsx' },
  { id: 'app:notes/foo.bar', resourceUri: 'ui://notes/foo.bar.html', source: '/project/src/mcp/notes/apps/foo.bar.ts' },
];

it.each([
  ['the route id', "appResourceUri('app:notes/dashboard')", 'ui://notes/dashboard.html'],
  ['a relative module path without extension', "appResourceUri('../apps/dashboard')", 'ui://notes/dashboard.html'],
  ['a relative module path with extension', "appResourceUri('../apps/dashboard.tsx')", 'ui://notes/dashboard.html'],
  ['a relative module path with a .js-style extension', "appResourceUri('../apps/dashboard.jsx')", 'ui://notes/dashboard.html'],
  ['a dotted App name without extension', "appResourceUri('../apps/foo.bar')", 'ui://notes/foo.bar.html'],
  ['a dotted App name with extension', "appResourceUri('./../apps/foo.bar.ts')", 'ui://notes/foo.bar.html'],
])('resolves an App reference written as %s', (_name, call, resourceUri) => {
  const extracted = extract([
    "import { appResourceUri } from 'agent-bundle/routes';",
    `export const config = { _meta: { ui: { resourceUri: ${call} } } };`,
  ].join('\n'));
  const resolved = resolveRouteConfigAppReferences(
    extracted,
    { relativePath: 'src/mcp/notes/tools/search.ts', serverName: 'notes', source: '/project/src/mcp/notes/tools/search.ts' },
    notesApps,
  );
  expect(resolved.diagnostics).toEqual([]);
  expect(resolved.config).toEqual({ _meta: { ui: { resourceUri } } });
});

it.each([
  ['a mistyped extension', "appResourceUri('../apps/dashboard.tss')"],
  ['the wrong route-module extension', "appResourceUri('../apps/dashboard.ts')"],
  ['a path into another directory', "appResourceUri('./dashboard')"],
])('rejects a relative App reference with %s (AB4826)', (_name, call) => {
  const extracted = extract([
    "import { appResourceUri } from 'agent-bundle/routes';",
    `export const config = { _meta: { ui: { resourceUri: ${call} } } };`,
  ].join('\n'));
  const resolved = resolveRouteConfigAppReferences(
    extracted,
    { relativePath: 'src/mcp/notes/tools/search.ts', serverName: 'notes', source: '/project/src/mcp/notes/tools/search.ts' },
    notesApps,
  );
  expect(codes(resolved.diagnostics)).toEqual(['AB4826']);
  expect(resolved.config).toBe(emptyRouteConfig);
});

it('diagnoses an App reference that matches no App route (AB4826) and drops the config', () => {
  const extracted = extract([
    "import { appResourceUri } from 'agent-bundle/routes';",
    "export const config = { _meta: { ui: { resourceUri: appResourceUri('missing') } }, title: 'Search' };",
  ].join('\n'));
  expect(extracted.diagnostics).toEqual([]);
  const resolved = resolveRouteConfigAppReferences(
    extracted,
    { relativePath: 'src/mcp/notes/tools/search.ts', serverName: 'notes', source: '/project/src/mcp/notes/tools/search.ts' },
    [{ id: 'app:notes/dashboard', resourceUri: 'ui://notes/dashboard.html', source: '/project/src/mcp/notes/apps/dashboard.tsx' }],
  );
  expect(resolved.config).toBe(emptyRouteConfig);
  expect(resolved.diagnostics).toHaveLength(1);
  expect(resolved.diagnostics[0]).toMatchObject({
    code: 'AB4826',
    severity: 'error',
    sourcePath: '/project/src/mcp/notes/tools/search.ts',
  });
  expect(resolved.diagnostics[0]!.message).toContain('references MCP App "missing" at 2:53');
  expect(resolved.diagnostics[0]!.message).toContain('known App routes: app:notes/dashboard');

  // Outside an MCP server the bare form has no server to resolve against.
  const fromScript = resolveRouteConfigAppReferences(
    extracted,
    { relativePath: 'src/scripts/report.ts', source: '/project/src/scripts/report.ts' },
    [],
  );
  expect(fromScript.diagnostics[0]!.message).toContain("the bare '<app>' form needs an MCP route on the same server");
  expect(fromScript.diagnostics[0]!.message).toContain('no App route declares a static config.resourceUri');
});

it.each([
  ['not imported', '', "appResourceUri('dashboard')", 'a call to "appResourceUri" that is not imported from agent-bundle/routes'],
  ['imported from the wrong specifier', "import { appResourceUri } from 'agent-bundle';", "appResourceUri('dashboard')", 'imported from "agent-bundle" instead of agent-bundle/routes'],
  ['called with a non-string', "import { appResourceUri } from 'agent-bundle/routes';", 'appResourceUri(1)', 'whose argument is not a non-empty string'],
  ['called with two arguments', "import { appResourceUri } from 'agent-bundle/routes';", "appResourceUri('a', 'b')", 'without exactly one string argument'],
  ['called with a dynamic argument', "import { appResourceUri } from 'agent-bundle/routes';", 'appResourceUri(name)', 'a reference to the identifier "name"'],
])('keeps an appResourceUri call that is %s dynamic (AB4806)', (_name, importLine, call, fragment) => {
  const { config, diagnostics } = extract([
    importLine,
    `export const config = { _meta: { ui: { resourceUri: ${call} } } };`,
  ].join('\n'));
  expect(config).toBe(emptyRouteConfig);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: 'AB4806' });
  expect(diagnostics[0]!.message).toContain(fragment);
});

it.each([
  ['identifier reference', "const base = {};\nexport const config = base;", 'AB4806', 'reference to the identifier "base"'],
  ['let-bound identifier', "let title = 'x';\nexport const config = { title };", 'AB4806', 'a shorthand property reference'],
  ['let-bound identifier value', "let title = 'x';\nexport const config = { title: title };", 'AB4806', 'which is not a top-level `const` string literal'],
  ['unknown identifier', 'export const config = { title: missing };', 'AB4806', 'neither a top-level const string literal in this module nor a named import'],
  ['non-string const', 'const limit = 3;\nexport const config = { limit };', 'AB4806', 'a shorthand property reference'],
  ['non-string const value', 'const limit = 3;\nexport const config = { limit: limit };', 'AB4806', 'whose top-level const initializer is not a string literal'],
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
