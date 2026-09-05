import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { inspect, type ReadyInspectResult, validate } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { discoverProject } from '../src/config/discover.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';
import { compileRouteGraph, emptyCompiledRouteGraph, isEmptyRouteGraph } from '../src/routes/graph.ts';
import * as routesModule from '../src/routes/index.ts';
import { emptyRouteConfig, type CompiledRouteGraph } from '../src/routes/types.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-route-graph-')));
  roots.push(root);
  return root;
};

const moduleSource = 'export const inputSchema = {}; export const resultSchema = {}; export default async () => undefined;\n';

const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
};

const fixtureConfig = (extra: Readonly<Record<string, unknown>> = {}): AgentBundleConfig => ({
  plugin: { name: 'routes-fixture', version: '1.0.0' },
  ...extra,
});

const conventionalTree: Readonly<Record<string, string>> = {
  // CLI routes (plain and rendered) compile through the argv grammar, so the
  // fixtures carry real (statically parseable) zod object schemas.
  'src/cli/doctor.tsx': [
    'export const inputSchema = z.object({ verbose: z.boolean().optional() }).strict();',
    'export const resultSchema = {};',
    'export default async () => undefined;',
    '',
  ].join('\n'),
  'src/cli/library/audit.ts': [
    "export const config = { description: 'Audit the library.' };",
    'export const inputSchema = z.object({ strict: z.boolean().optional() }).strict();',
    'export const resultSchema = {};',
    'export default async () => undefined;',
    '',
  ].join('\n'),
  'src/events/workspace/open.tsx': moduleSource,
  'src/mcp/curator/apps/dashboard.tsx': `export const config = { resourceUri: 'ui://curator/dashboard.html' }; ${moduleSource}`,
  'src/mcp/curator/prompts/curate.tsx': moduleSource,
  'src/mcp/curator/resources/catalog.ts': moduleSource,
  'src/mcp/curator/tools/inspect.tsx': moduleSource,
  'src/providers/git-worktree.ts': moduleSource,
  'src/scripts/rebuild-index.ts': moduleSource,
};

const codesOf = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const createInspectProject = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await createRoot();
  await writeTree(root, {
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    ...files,
  });
  return root;
};

it('compiles the conventional tree into one frozen graph with a machine-independent digest', async () => {
  const root = await createRoot();
  await writeTree(root, conventionalTree);
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics).toEqual([]);
  expect(graph.servers).toHaveLength(1);
  const [curator] = graph.servers;
  expect(curator).toMatchObject({ id: 'mcp:curator', mode: 'generated', name: 'curator' });
  expect(curator!.routes.map((route) => route.id)).toEqual([
    'app:curator/dashboard',
    'prompt:curator/curate',
    'resource:curator/catalog',
    'tool:curator/inspect',
  ]);
  expect(curator!.routes.map((route) => route.kind)).toEqual(['app', 'prompt', 'resource', 'tool']);
  expect(curator!.routes.every((route) => route.serverId === 'mcp:curator')).toBe(true);
  expect(graph.events.map((route) => route.id)).toEqual(['event:workspace/open']);
  expect(graph.events[0]).toMatchObject({
    event: 'workspace/open',
    kind: 'event-route',
    provenance: { kind: 'conventional', relativePath: 'src/events/workspace/open.tsx' },
    source: join(root, 'src/events/workspace/open.tsx'),
  });
  expect(graph.cli).toMatchObject({ mode: 'generated' });
  expect(graph.cli!.routes.map((route) => route.id)).toEqual(['cli:doctor', 'cli:library/audit']);
  expect(graph.scripts.map((route) => route.id)).toEqual(['script:rebuild-index']);
  expect(graph.providers).toEqual([{
    id: 'provider:git-worktree',
    name: 'git-worktree',
    provenance: { kind: 'conventional', relativePath: 'src/providers/git-worktree.ts' },
    source: join(root, 'src/providers/git-worktree.ts'),
  }]);

  // The IR is immutable and every route carries the shared frozen empty config.
  expect(Object.isFrozen(graph)).toBe(true);
  expect(Object.isFrozen(graph.servers)).toBe(true);
  expect(Object.isFrozen(curator!.routes[0])).toBe(true);
  expect(Object.isFrozen(graph.cli!.routes)).toBe(true);
  expect(curator!.routes.filter((route) => route.kind !== 'app').every((route) => route.config === emptyRouteConfig)).toBe(true);
  expect(curator!.routes.find((route) => route.kind === 'app')?.config).toEqual({ resourceUri: 'ui://curator/dashboard.html' });
  expect(graph.events[0]!.config).toEqual({});

  // The digest covers relative identity only: the same tree in a different
  // absolute root produces the same digest.
  const otherRoot = await createRoot();
  await writeTree(otherRoot, conventionalTree);
  const otherGraph = await compileRouteGraph(otherRoot, fixtureConfig());
  expect(otherGraph.digest).toBe(graph.digest);
  expect(isEmptyRouteGraph(graph)).toBe(false);
});

it('populates bounded input schemas for every route kind and includes them in the digest', async () => {
  const root = await createRoot();
  const bounded = (config = '') => [
    config,
    "export const inputSchema = z.object({ count: z.number().optional(), root: z.string().describe('Project root.') }).strict();",
    'export const resultSchema = {};',
    'export default async () => undefined;',
    '',
  ].join('\n');
  const tree = {
    'src/cli/audit.ts': bounded(),
    'src/events/stop.ts': bounded(),
    'src/mcp/curator/apps/dashboard.tsx': bounded("export const config = { resourceUri: 'ui://curator/dashboard.html' };"),
    'src/mcp/curator/prompts/curate.ts': bounded(),
    'src/mcp/curator/resources/catalog.ts': bounded(),
    'src/mcp/curator/tools/inspect.ts': bounded(),
    'src/mcp/curator/tools/rich.ts': [
      'const sharedSchema = z.object({ nested: z.object({ value: z.string() }) });',
      'export const inputSchema = sharedSchema;',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n'),
    'src/scripts/rebuild.ts': bounded(),
  };
  await writeTree(root, tree);

  const graph = await compileRouteGraph(root, fixtureConfig());
  const routes = [
    ...graph.servers.flatMap((server) => server.routes),
    ...graph.events,
    ...graph.cli!.routes,
    ...graph.scripts,
  ];
  expect(graph.diagnostics).toEqual([]);
  expect(routes.filter((route) => route.id !== 'tool:curator/rich').every((route) => route.inputSchema !== undefined)).toBe(true);
  expect(routes.find((route) => route.id === 'tool:curator/rich')?.inputSchema).toBeUndefined();
  expect(routes.find((route) => route.id === 'tool:curator/inspect')?.inputSchema).toEqual({
    additionalProperties: false,
    properties: {
      count: { type: 'number' },
      root: { description: 'Project root.', type: 'string' },
    },
    required: ['root'],
    type: 'object',
  });

  const changedRoot = await createRoot();
  await writeTree(changedRoot, tree);
  const inspectPath = join(changedRoot, 'src/mcp/curator/tools/inspect.ts');
  await writeFile(inspectPath, (await readFile(inspectPath, 'utf8')).replace('Project root.', 'Workspace root.'));
  const changed = await compileRouteGraph(changedRoot, fixtureConfig());
  expect(changed.digest).not.toBe(graph.digest);
  // Pre-#593 pin: an inline-only tree must digest exactly as it does on
  // current main. Contract ids for route-local literals do not join identity.
  expect(graph.digest).toBe('d4d97709727353b0acf39b9d1b26a507e41c9ba22ba5f897c0a5e9578fd2fb50');
});

it('shares one RouteContract across a CLI route and a tool route that import the same schema', async () => {
  const root = await createRoot();
  const schema = [
    'export const statusInputSchema = z.object({',
    '  limit: z.number().int().min(1).max(500).optional(),',
    '  laneKey: z.string().min(1).optional(),',
    '}).strict();',
    '',
  ].join('\n');
  const route = (specifier: string): string => [
    `import { statusInputSchema } from '${specifier}';`,
    'export const inputSchema = statusInputSchema;',
    'export const resultSchema = {};',
    'export default async () => undefined;',
    '',
  ].join('\n');
  await writeTree(root, {
    'src/cli/status.ts': route('../lib/protocol-schemas.js'),
    'src/lib/protocol-schemas.ts': schema,
    'src/mcp/hauler/tools/hauler_status.tsx': route('../../../lib/protocol-schemas.js'),
  });
  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics).toEqual([]);
  expect(graph.contracts).toHaveLength(1);
  const [contract] = graph.contracts ?? [];
  expect(contract).toMatchObject({
    id: 'contract:src/lib/protocol-schemas.ts#statusInputSchema',
    origin: { binding: 'statusInputSchema', module: 'src/lib/protocol-schemas.ts' },
    routes: ['cli:status', 'tool:hauler/hauler_status'],
  });
  const cli = graph.cli!.routes.find((entry) => entry.id === 'cli:status')!;
  const tool = graph.servers[0]!.routes.find((entry) => entry.id === 'tool:hauler/hauler_status')!;
  expect(cli.contract).toBe(contract!.id);
  expect(tool.contract).toBe(contract!.id);
  expect(contract!.input).toBe(cli.inputSchema);
  expect(contract!.input).toBe(tool.inputSchema);
});

it('assigns a route-local literal the contract id of its own module and lists it in contracts', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/cli/audit.ts': [
      'export const inputSchema = z.object({ strict: z.boolean().optional() }).strict();',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n'),
  });
  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics).toEqual([]);
  expect(graph.contracts).toEqual([
    expect.objectContaining({
      id: 'contract:src/cli/audit.ts#inputSchema',
      origin: { binding: 'inputSchema', module: 'src/cli/audit.ts' },
      routes: ['cli:audit'],
    }),
  ]);
  expect(graph.cli!.routes[0]!.contract).toBe('contract:src/cli/audit.ts#inputSchema');
  expect(graph.contracts![0]!.input).toBe(graph.cli!.routes[0]!.inputSchema);
});

it('omits contract on a route with no static schema', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/scripts/rebuild.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics).toEqual([]);
  expect(graph.scripts[0]!.contract).toBeUndefined();
  expect(graph.contracts).toBeUndefined();
});

it('does not list routes of a custom-mode server on any contract', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': [
      'export const inputSchema = z.object({ root: z.string() }).strict();',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n'),
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    mcp: { servers: { curator: { entry: './src/mcp/curator.ts' } } },
    routes: { servers: { curator: 'custom' } },
  }));
  expect(graph.diagnostics).toEqual([]);
  expect(graph.servers[0]).toMatchObject({ mode: 'custom', routes: [] });
  expect(graph.contracts).toBeUndefined();
});

it('changes the graph digest when a route imports its schema from another module', async () => {
  const schema = 'z.object({ name: z.string() }).strict()';
  const command = (inputSchema: string): string => [
    `export const inputSchema = ${inputSchema};`,
    'export const resultSchema = {};',
    'export default async () => undefined;',
    '',
  ].join('\n');
  const inlineRoot = await createRoot();
  await writeTree(inlineRoot, { 'src/cli/status.ts': command(schema) });
  const importedRoot = await createRoot();
  await writeTree(importedRoot, {
    'src/cli/status.ts': command('statusInputSchema').replace(
      'export const inputSchema',
      "import { statusInputSchema } from '../lib/protocol-schemas.js';\nexport const inputSchema",
    ),
    'src/lib/protocol-schemas.ts': `export const statusInputSchema = ${schema};\n`,
  });
  const inline = await compileRouteGraph(inlineRoot, fixtureConfig());
  const imported = await compileRouteGraph(importedRoot, fixtureConfig());
  expect(inline.diagnostics).toEqual([]);
  expect(imported.diagnostics).toEqual([]);
  expect(imported.digest).not.toBe(inline.digest);
});

it('skips ignored paths, private segments, and declaration files', async () => {
  const root = await createRoot();
  await writeTree(root, {
    '.gitignore': 'src/scripts/generated.ts\n',
    'src/events/.internal/probe.ts': moduleSource,
    'src/mcp/curator/tools/_draft.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'src/mcp/curator/tools/types.d.ts': 'export type Probe = string;\n',
    'src/scripts/generated.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics).toEqual([]);
  expect(graph.servers[0]!.routes.map((route) => route.id)).toEqual(['tool:curator/inspect']);
  expect(graph.events).toEqual([]);
  expect(graph.scripts).toEqual([]);
});

it('discovers .jsx script routes so the rendered-script pipeline can ship them', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/scripts/rebuild-index.ts': moduleSource,
    'src/scripts/render-poster.jsx': 'export default async () => <section>poster</section>;\n',
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  // Discovery is not a packaging choice: the .jsx module compiles into the
  // graph so normalization ships it through the renderer pipeline (#102 s3).
  expect(graph.diagnostics).toEqual([]);
  expect(graph.scripts.map((route) => route.id)).toEqual(['script:rebuild-index', 'script:render-poster']);
  expect(graph.scripts.find((route) => route.id === 'script:render-poster')).toMatchObject({
    kind: 'script',
    provenance: { kind: 'conventional', relativePath: 'src/scripts/render-poster.jsx' },
    source: join(root, 'src/scripts/render-poster.jsx'),
  });
});

it('never compiles a module explicit configuration claims: config always wins', async () => {
  const root = await createRoot();
  await writeTree(root, {
    // The examples/hooks-and-scripts shape: explicit scripts entries under src/scripts/.
    'src/hooks/session-start.ts': moduleSource,
    'src/scripts/detect-risk.ts': moduleSource,
    'src/scripts/rebuild-index.ts': moduleSource,
    'src/scripts/verify-release.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    hooks: { sessionStart: { handler: './src/hooks/session-start.ts' } },
    scripts: {
      'detect-risk': { entry: './src/scripts/detect-risk.ts', targets: ['portable'] },
      'verify-release': './src/scripts/verify-release.ts',
    },
  }));

  expect(graph.diagnostics).toEqual([]);
  // Only the unclaimed module is a route; the claimed ones belong to their declarations.
  expect(graph.scripts.map((route) => route.id)).toEqual(['script:rebuild-index']);

  // A fully claimed tree compiles the empty graph, so discovery attaches none.
  const claimedRoot = await createRoot();
  await writeTree(claimedRoot, { 'src/scripts/check-service-fixture.ts': moduleSource });
  const discovered = await discoverProject(claimedRoot, fixtureConfig({
    scripts: { 'check-service-fixture': './src/scripts/check-service-fixture.ts' },
  }));
  expect('routeGraph' in discovered).toBe(false);
});

it('keeps a bin-claimed src/scripts module in script discovery while lib still claims (#389)', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/cli/doctor.ts': moduleSource,
    'src/cli.ts': moduleSource,
    'src/index.ts': moduleSource,
    'src/scripts/hauler.ts': moduleSource,
    'src/scripts/internal/tool.ts': moduleSource,
    'src/scripts/my tool.ts': moduleSource,
    'src/scripts/shared.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    // The #389 shape: one entry is the npm bin and the artifact hook target.
    bin: {
      doctor: './src/cli/doctor.ts',
      hauler: './src/scripts/hauler.ts',
      main: './src/cli.ts',
      spaced: './src/scripts/my tool.ts',
      tool: './src/scripts/internal/tool.ts',
    },
    lib: { entry: './src/scripts/shared.ts' },
  }));

  expect(graph.diagnostics).toEqual([]);
  // A bin claim never removes a safely named direct src/scripts/<name> child:
  // the bin and the artifact script are disjoint outputs running the same
  // main, so both surfaces ship. The nested and the unsafely named modules
  // stay claimed — discovering them would only turn a valid bin-only
  // configuration into AB4808 or AB4803 — and a lib entry still claims its
  // module: a library is not a script.
  expect(graph.scripts.map((route) => route.id)).toEqual(['script:hauler']);
  // Every other route kind still belongs to the claiming declaration.
  expect(graph.cli).toBeUndefined();
});

it('gates a bin-claimed rendered script with AB4737 only when it exports no main (#389)', async () => {
  const project = await createInspectProject({
    'agent-bundle.config.ts': [
      'export default {',
      '  bin: {',
      "    notes: './src/scripts/render-notes.tsx',",
      "    object: './src/scripts/render-object.tsx',",
      "    poster: './src/scripts/render-poster.tsx',",
      "    reexport: './src/scripts/render-reexport.tsx',",
      "    tool: './src/scripts/render-tool.tsx',",
      "    typed: './src/scripts/render-typed.tsx',",
      '  },',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    // A default re-exported from a private sibling is judged in that sibling
    // (#446): an async component there satisfies the rendered surface here.
    'src/scripts/_component.tsx': 'export default async () => undefined;\n',
    'src/scripts/render-reexport.tsx': [
      'export const main = async (argv: readonly string[]): Promise<number> => argv.length;',
      "export { default } from './_component.tsx';",
      '',
    ].join('\n'),
    // main plus a type-only default alias of an async function binding: no
    // JavaScript default export is emitted, so the rendered script has no
    // component even though a same-named function exists.
    'src/scripts/render-typed.tsx': [
      'const Component = async () => undefined;',
      'export const main = async (argv: readonly string[]): Promise<number> => argv.length;',
      'export { type Component as default };',
      '',
    ].join('\n'),
    // Exports both: main(argv) for the bin envelope, the component for the
    // rendered script, so the module serves both surfaces.
    'src/scripts/render-notes.tsx': [
      'export const main = async (argv: readonly string[]): Promise<number> => argv.length;',
      'export default async () => undefined;',
      '',
    ].join('\n'),
    // A default export that is not a component: present, but the rendered
    // script would fail at run time, so presence alone is not enough.
    'src/scripts/render-object.tsx': [
      'export const main = async (argv: readonly string[]): Promise<number> => argv.length;',
      'export default {};',
      '',
    ].join('\n'),
    // Component plus a type-only main: the bin envelope ignores type exports
    // and would still call the component as main(argv).
    'src/scripts/render-poster.tsx': [
      'export type main = (argv: readonly string[]) => Promise<number>;',
      'export default async () => undefined;',
      '',
    ].join('\n'),
    // main only: the bin works, but the rendered script has no component to render.
    'src/scripts/render-tool.tsx': 'export const main = async (argv: readonly string[]): Promise<number> => argv.length;\n',
  });

  const result = await validate({ root: project });
  const gate = result.diagnostics.filter(({ code }) => code === 'AB4737');
  expect(gate.map((diagnostic) => diagnostic.sourcePath)).toEqual([
    join(project, 'src/scripts/render-object.tsx'),
    join(project, 'src/scripts/render-poster.tsx'),
    join(project, 'src/scripts/render-tool.tsx'),
    join(project, 'src/scripts/render-typed.tsx'),
  ]);
  expect(gate[0]!.message).toContain('render-object.tsx is also the entry of bin "object" but exports no async default Server Component');
  expect(gate[1]!.message).toContain('render-poster.tsx is also the entry of bin "poster" but exports no named main');
  expect(gate[2]!.message).toContain('render-tool.tsx is also the entry of bin "tool" but exports no async default Server Component');
  expect(gate[3]!.message).toContain('render-typed.tsx is also the entry of bin "typed" but exports no async default Server Component');
  expect(gate.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  // Every rendered script stays discovered beside its bin: the gate names
  // the conflict instead of dropping a route.
  const graph = await compileRouteGraph(project, fixtureConfig({
    bin: {
      notes: './src/scripts/render-notes.tsx',
      object: './src/scripts/render-object.tsx',
      poster: './src/scripts/render-poster.tsx',
      reexport: './src/scripts/render-reexport.tsx',
      tool: './src/scripts/render-tool.tsx',
      typed: './src/scripts/render-typed.tsx',
    },
  }));
  expect(graph.scripts.map((route) => route.id)).toEqual([
    'script:render-notes',
    'script:render-object',
    'script:render-poster',
    'script:render-reexport',
    'script:render-tool',
    'script:render-typed',
  ]);
});

it('gates a bin-claimed plain script with AB4738 only when its bin would run a default export the script ignores (#389)', async () => {
  const project = await createInspectProject({
    'agent-bundle.config.ts': [
      'export default {',
      '  bin: {',
      "    'default-only': './src/scripts/default-only.ts',",
      "    hauler: './src/scripts/hauler.ts',",
      "    plain: './src/scripts/plain.ts',",
      '  },',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    // The bin envelope would run this default export; the artifact script
    // pipeline only wraps main, so scripts/default-only.mjs would be inert.
    'src/scripts/default-only.ts': 'export default async (argv: readonly string[]): Promise<number> => argv.length;\n',
    // main is wrapped by both envelopes; a self-executing module bundles
    // byte for byte on both surfaces.
    'src/scripts/hauler.ts': 'export const main = async (argv: readonly string[]): Promise<number> => argv.length;\n',
    'src/scripts/plain.ts': "process.stdout.write('plain\\n');\n",
  });

  const result = await validate({ root: project });
  const gate = result.diagnostics.filter(({ code }) => code === 'AB4738');
  expect(gate).toHaveLength(1);
  expect(gate[0]).toMatchObject({
    message: expect.stringContaining('default-only.ts is also the entry of bin "default-only" and exports a default but no main'),
    severity: 'error',
    sourcePath: join(project, 'src/scripts/default-only.ts'),
  });
  expect(result.diagnostics.filter(({ code }) => code === 'AB4737')).toEqual([]);
});

it('errors with AB4800 when a declared entry, command, or url claims a routed server', async () => {
  const root = await createRoot();
  await writeTree(root, { 'src/mcp/curator/tools/inspect.ts': moduleSource });
  const graph = await compileRouteGraph(root, fixtureConfig({
    mcp: { servers: { curator: { url: 'https://example.test/mcp' } } },
  }));

  expect(codesOf(graph.diagnostics)).toEqual(['AB4800']);
  expect(graph.servers[0]).toMatchObject({ mode: 'conflict' });
  expect(graph.servers[0]!.routes.map((route) => route.id)).toEqual(['tool:curator/inspect']);
});

it('errors with AB4800 when an entry module and route modules claim one MCP server, and inspect turns invalid', async () => {
  const files = {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  };
  const root = await createRoot();
  await writeTree(root, files);
  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(codesOf(graph.diagnostics)).toEqual(['AB4800']);
  // Discovery is not a packaging choice: the conflicting surface keeps its routes.
  expect(graph.servers[0]).toMatchObject({ mode: 'conflict' });
  expect(graph.servers[0]!.routes.map((route) => route.id)).toEqual(['tool:curator/inspect']);

  const project = await createInspectProject(files);
  const result = await inspect({ root: project });
  expect(result.state).toBe('invalid');
  expect(codesOf(result.diagnostics)).toContain('AB4800');
});

it('keeps routes and silences AB4800 under an explicit generated mode', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    routes: { servers: { curator: 'generated' } },
  }));

  expect(graph.diagnostics).toEqual([]);
  expect(graph.servers[0]).toMatchObject({ mode: 'generated' });
  expect(graph.servers[0]!.routes.map((route) => route.id)).toEqual(['tool:curator/inspect']);
});

it('accepts a config declaration that augments a route-generated server with env, args, targets, and apps (#380)', async () => {
  const project = await createInspectProject({
    'agent-bundle.config.ts': [
      'export default {',
      '  mcp: { servers: { curator: {',
      "    apps: { panel: { entry: './views/panel.ts', resourceUri: 'ui://routes-fixture/panel.html' } },",
      "    args: ['--strict'],",
      "    env: { CURATOR_MODE: 'strict' },",
      "    targets: ['portable'],",
      "    transport: 'stdio',",
      '  } } },',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable', 'claude'],",
      '};',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'views/panel.ts': "document.body.textContent = 'panel';\n",
  });

  const validation = await validate({ root: project });
  expect(validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

  const result = await inspect({ root: project });
  expect(result.state).toBe('ready');
  const ready = result as ReadyInspectResult;
  expect(ready.model.mcpServers).toHaveLength(1);
  expect(ready.model.mcpServers[0]).toMatchObject({
    args: [expect.stringMatching(/^mcp\/mcp-curator-[0-9a-f]+\.mjs$/u), '--strict'],
    env: { CURATOR_MODE: 'strict' },
    id: 'mcp:curator',
    provenance: { kind: 'conventional' },
    targets: ['portable'],
    transport: 'stdio',
  });
  expect(ready.model.mcpServers[0]!.generatedRoutes?.map((route) => route.id)).toEqual(['tool:curator/inspect']);
  expect(ready.model.mcpApps?.map((app) => ({ id: app.id, provenance: app.provenance.kind, targets: app.targets }))).toEqual([
    { id: 'mcp-app:curator:panel', provenance: 'config', targets: ['portable'] },
  ]);
});

it('errors with AB4340 when a declaration for a route-generated server redeclares its entry', async () => {
  const project = await createInspectProject({
    'agent-bundle.config.ts': [
      'export default {',
      "  mcp: { servers: { curator: { entry: './src/mcp/curator.ts', env: { CURATOR_MODE: 'strict' } } } },",
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  routes: { servers: { curator: 'generated' } },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });

  const validation = await validate({ root: project });
  const errors = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(codesOf(errors)).toEqual(['AB4340']);
  expect(errors[0]!.message).toContain('cannot set entry');
  expect(errors[0]!.recovery).toContain('routes.servers.curator');
  expect(codesOf(validation.diagnostics)).not.toContain('AB4304');
  expect(codesOf(validation.diagnostics)).not.toContain('AB4800');
});

it('checks an augmenting declaration\'s Apps against the route-declared Apps of the same server', async () => {
  const configWithApps = (apps: string): string => [
    'export default {',
    `  mcp: { servers: { curator: { apps: { ${apps} } } } },`,
    "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
    "  targets: ['portable'],",
    '};',
    '',
  ].join('\n');
  const routes = {
    'src/mcp/curator/apps/dashboard.tsx': `export const config = { resourceUri: 'ui://curator/dashboard.html' }; ${moduleSource}`,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'views/panel.ts': "document.body.textContent = 'panel';\n",
  };

  // Same resourceUri under another name: AB4330, not two Apps on one URI.
  const sameUri = await createInspectProject({
    ...routes,
    'agent-bundle.config.ts': configWithApps("panel: { entry: './views/panel.ts', resourceUri: 'ui://curator/dashboard.html' }"),
  });
  const sameUriErrors = (await validate({ root: sameUri })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(codesOf(sameUriErrors)).toEqual(['AB4330']);

  // Same name as a route App: AB4325 from validation, before the duplicate ID would surface as AB4101.
  const sameName = await createInspectProject({
    ...routes,
    'agent-bundle.config.ts': configWithApps("dashboard: { entry: './views/panel.ts', resourceUri: 'ui://curator/panel.html' }"),
  });
  const sameNameErrors = (await validate({ root: sameName })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(codesOf(sameNameErrors)).toEqual(['AB4325']);

  // A distinct name and URI still augments cleanly beside the route App.
  const distinct = await createInspectProject({
    ...routes,
    'agent-bundle.config.ts': configWithApps("panel: { entry: './views/panel.ts', resourceUri: 'ui://curator/panel.html' }"),
  });
  expect((await validate({ root: distinct })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const ready = (await inspect({ root: distinct })) as ReadyInspectResult;
  expect(ready.state).toBe('ready');
  expect(ready.model.mcpApps?.map((app) => app.id)).toEqual(['mcp-app:curator:dashboard', 'mcp-app:curator:panel']);
});

it('applies the local-entry field rules to an augmenting declaration', async () => {
  const project = await createInspectProject({
    'agent-bundle.config.ts': [
      'export default {',
      "  mcp: { servers: { curator: { cwd: './elsewhere', headers: { a: 'b' }, transport: 'streamable-http' } } },",
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });

  const validation = await validate({ root: project });
  expect(codesOf(validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).sort()).toEqual([
    'AB4308',
    'AB4309',
    'AB4310',
  ]);
});

it('omits a server\'s routes and silences AB4800 under an explicit custom mode', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    mcp: { servers: { curator: { entry: './src/mcp/curator.ts' } } },
    routes: { servers: { curator: 'custom' } },
  }));

  expect(graph.diagnostics).toEqual([]);
  expect(graph.servers[0]).toMatchObject({ id: 'mcp:curator', mode: 'custom' });
  expect(graph.servers[0]!.routes).toEqual([]);
});

it('skips a server layout entirely when routes.servers pins that server to a non-generated mode', async () => {
  const root = await createRoot();
  // The custom-mode layout is deliberately invalid and duplicated across .ts
  // and .tsx, and the remote server has no route modules: none of AB4830,
  // AB4831, or AB4832 may fire because the opt-out means no generated worker
  // will ever compose those layouts.
  await writeTree(root, {
    'src/layout.tsx': 'export default ({ children }) => children;\n',
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/layout.ts': 'export default { children: undefined };\n',
    'src/mcp/curator/layout.tsx': 'export default { children: undefined };\n',
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'src/mcp/relay/layout.tsx': 'export default ({ children }) => children;\n',
  });
  const graph = await compileRouteGraph(root, fixtureConfig({
    mcp: {
      servers: {
        curator: { entry: './src/mcp/curator.ts' },
        relay: { url: 'https://example.test/mcp' },
      },
    },
    routes: { servers: { curator: 'custom', relay: 'remote' } },
  }));

  expect(graph.diagnostics).toEqual([]);
  expect(graph.layouts!.map((layout) => layout.id)).toEqual(['layout:root']);
  expect(graph.servers.map((server) => ({ mode: server.mode, name: server.name }))).toEqual([{ mode: 'custom', name: 'curator' }]);

  // Flipping the same server back to generated re-enables both the duplicate
  // and the contract checks.
  const generated = await compileRouteGraph(root, fixtureConfig({
    mcp: { servers: { relay: { url: 'https://example.test/mcp' } } },
    routes: { servers: { curator: 'generated', relay: 'remote' } },
  }));
  expect(codesOf(generated.diagnostics)).toEqual(['AB4831', 'AB4830']);
  expect(generated.layouts!.map((layout) => layout.id)).toEqual(['layout:root', 'layout:mcp:curator']);
});

it('errors with AB4801 when the conventional CLI entry and command routes both exist', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/cli.ts': moduleSource,
    'src/cli/doctor.tsx': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(codesOf(graph.diagnostics)).toEqual(['AB4801']);
  expect(graph.cli).toMatchObject({ mode: 'conflict' });
  expect(graph.cli!.routes.map((route) => route.id)).toEqual(['cli:doctor']);
});

it('errors with AB4802 when two route modules derive one id', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'src/mcp/curator/tools/inspect.tsx': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(codesOf(graph.diagnostics)).toEqual(['AB4802']);
  expect(graph.diagnostics[0]!.message).toContain('src/mcp/curator/tools/inspect.ts');
  expect(graph.diagnostics[0]!.message).toContain('src/mcp/curator/tools/inspect.tsx');
  expect(graph.servers[0]!.routes).toHaveLength(1);
});

it('errors with AB4803 on unsafe identity segments', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/cli/-doctor.ts': moduleSource,
    'src/mcp/bad name/tools/inspect.ts': moduleSource,
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(codesOf(graph.diagnostics)).toEqual(['AB4803', 'AB4803']);
  expect(graph.servers).toEqual([]);
  expect(graph.cli).toBeUndefined();
});

it('errors with AB4804 on invalid routes mode overrides', async () => {
  const root = await createRoot();
  await writeTree(root, { 'src/mcp/curator/tools/inspect.ts': moduleSource });
  const graph = await compileRouteGraph(root, fixtureConfig({
    routes: { cli: 42, servers: { curator: 'bogus' } },
  }));

  expect(codesOf(graph.diagnostics)).toEqual(['AB4804', 'AB4804']);
  // The invalid override is ignored; the conflict-free server stays generated.
  expect(graph.servers[0]).toMatchObject({ mode: 'generated' });
});

it('attaches no routeGraph key to a route-free discovered project', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/skills/review/SKILL.md': '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
  });
  const discovered = await discoverProject(root, fixtureConfig());

  expect(discovered.skills).toHaveLength(1);
  expect('routeGraph' in discovered).toBe(false);
});

it('serves the shared empty graph under the routes focus of a route-free project', async () => {
  const root = await createInspectProject({
    'src/index.ts': 'export const library = true;\n',
  });
  const compiled = await compileRouteGraph(root, fixtureConfig());
  expect(isEmptyRouteGraph(compiled)).toBe(true);
  expect(compiled.digest).toBe(emptyCompiledRouteGraph.digest);

  const result = await inspect({ focus: 'routes', root });

  expect(result.state).toBe('ready');
  const routes = (result as ReadyInspectResult).selected?.routes;
  expect(routes).toMatchObject({ diagnostics: [], events: [], providers: [], scripts: [], servers: [] });
  expect(routes!.digest).toBe(emptyCompiledRouteGraph.digest);
  expect(isEmptyRouteGraph(routes!)).toBe(true);
});

it('selects the compiled graph under the routes inspect focus', async () => {
  const root = await createInspectProject({
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'src/scripts/rebuild-index.ts': moduleSource,
  });
  const result = await inspect({ focus: 'routes', root });

  expect(result.state).toBe('ready');
  const routes = (result as ReadyInspectResult).selected?.routes;
  expect(routes).toBeDefined();
  expect(routes!.servers[0]!.routes.map((route) => route.id)).toEqual(['tool:curator/inspect']);
  expect(routes!.scripts.map((route) => route.id)).toEqual(['script:rebuild-index']);
  expect(routes!.digest).toMatch(/^[a-f\d]{64}$/u);
});

it('shows projected MCP command provenance and safety in the routes inspect focus', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      '  routes: { mcpCommands: true },',
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    'src/mcp/curator/tools/read_item.tsx': [
      "export const config = { annotations: { readOnlyHint: true }, description: 'Read one item.' };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/tools/write_item.tsx': moduleSource,
  });

  const result = await inspect({ focus: 'routes', root });

  expect(result.state).toBe('ready');
  const routes = (result as ReadyInspectResult).selected?.routes;
  expect(routes?.cli?.commands).toEqual([
    expect.objectContaining({
      mcp: { confirm: false, server: 'curator', tool: 'read_item' },
      routeId: 'tool:curator/read_item',
    }),
    expect.objectContaining({
      mcp: { confirm: true, server: 'curator', tool: 'write_item' },
      routeId: 'tool:curator/write_item',
    }),
  ]);
  expect(routes?.servers[0]?.routes.map((route) => route.provenance.relativePath)).toEqual([
    'src/mcp/curator/tools/read_item.tsx',
    'src/mcp/curator/tools/write_item.tsx',
  ]);
  const declarations = routesModule.generateRouteTypes(routes!);
  expect(declarations.match(/"tool:curator\/read_item"/gu)).toHaveLength(1);
  expect(declarations.match(/"tool:curator\/write_item"/gu)).toHaveLength(1);
});

it('dumps the graph through the CLI --routes focus and rejects ambiguous focuses', async () => {
  const root = await createInspectProject({
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const terminal = captureCliTerminal();
  const code = await runCli(['inspect', '--root', root, '--routes', '--json'], terminal.output);
  expect(code).toBe(0);
  const document = JSON.parse(terminal.stdout()) as ReadyInspectResult;
  expect(document.selected?.routes?.servers?.[0]).toMatchObject({ id: 'mcp:curator', mode: 'generated' });

  const ambiguousTerminal = captureCliTerminal();
  const ambiguous = await runCli(['inspect', '--root', root, '--routes', '--skills'], ambiguousTerminal.output);
  expect(ambiguous).toBe(1);
  expect(ambiguousTerminal.stderr()).toContain('Choose at most one inspect focus.');
});

it('evaluates a stateful config factory once when inspecting the routes focus', async () => {
  const root = await createRoot();
  const counterPath = join(root, 'config-load-count.txt');
  await writeTree(root, {
    'agent-bundle.config.ts': [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      '',
      'export default (ctx: { readonly projectRoot: string }) => {',
      "  const path = join(ctx.projectRoot, 'config-load-count.txt');",
      "  writeFileSync(path, `${Number(readFileSync(path, 'utf8')) + 1}\\n`);",
      '  return {',
      "    plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "    targets: ['portable'],",
      '  };',
      '};',
      '',
    ].join('\n'),
    'config-load-count.txt': '0\n',
    'package.json': '{"type":"module"}\n',
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });

  const result = await inspect({ focus: 'routes', root });
  expect(result.state).toBe('ready');
  expect(Number(await readFile(counterPath, 'utf8'))).toBe(1);

  const routes = (result as ReadyInspectResult).selected?.routes;
  const discovered = await discoverProject(root, fixtureConfig());
  expect(routes).toBeDefined();
  expect(discovered.routeGraph).toBeDefined();
  expect(routes!.digest).toBe(discovered.routeGraph!.digest);
  expect(routes!.servers[0]!.routes.map((route) => route.id)).toEqual(
    discovered.routeGraph!.servers[0]!.routes.map((route) => route.id),
  );
});

it('extracts each route module static config export into the graph', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/tools/search.ts': [
      "export const config = { annotations: { readOnlyHint: true }, title: 'Search' } as const;",
      moduleSource,
    ].join('\n'),
    'src/scripts/rebuild.ts': moduleSource,
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(codesOf(graph.diagnostics)).toEqual([]);
  const tool = graph.servers[0]!.routes[0]!;
  expect(tool.config).toEqual({ annotations: { readOnlyHint: true }, title: 'Search' });
  expect(Object.isFrozen(tool.config)).toBe(true);
  expect(graph.scripts[0]!.config).toBe(emptyRouteConfig);
});

it('compiles dynamic-config routes with an empty config beside the named error', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/tools/search.ts': [
      'const title = process.env.TITLE;',
      'export const config = { title };',
      moduleSource,
    ].join('\n'),
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(codesOf(graph.diagnostics)).toEqual(['AB4806']);
  expect(graph.diagnostics[0]!.sourcePath).toBe(join(root, 'src/mcp/curator/tools/search.ts'));
  expect(graph.servers[0]!.routes[0]!.config).toBe(emptyRouteConfig);
});

it('resolves appResourceUri() references and imported const identifiers to the App route resourceUri', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/apps/dashboard.tsx': [
      "import { APP_RESOURCE_URI } from '../constants.ts';",
      "export const config = { resourceUri: APP_RESOURCE_URI, template: './dashboard.html' };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/apps/dashboard.html': '<!doctype html><html><body></body></html>\n',
    'src/mcp/curator/constants.ts': "export const APP_RESOURCE_URI = 'ui://curator/dashboard.html';\n",
    'src/mcp/curator/prompts/curate.ts': [
      "import { appResourceUri } from 'agent-bundle/routes';",
      "export const config = { _meta: { ui: { resourceUri: appResourceUri('app:curator/dashboard') } } };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/resources/catalog.ts': [
      "import { APP_RESOURCE_URI as URI } from '../constants';",
      "export const config = { _meta: { ui: { resourceUri: URI } }, uri: 'catalog://books' };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': [
      "import { appResourceUri as app } from 'agent-bundle/routes';",
      "export const config = { _meta: { ui: { resourceUri: app('dashboard') } }, related: [app('../apps/dashboard'), app('curator/dashboard')] };",
      moduleSource,
    ].join('\n'),
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics).toEqual([]);
  const configs = Object.fromEntries(graph.servers.flatMap((server) => server.routes.map((route) => [route.id, route.config])));
  expect(configs).toEqual({
    'app:curator/dashboard': { resourceUri: 'ui://curator/dashboard.html', template: './dashboard.html' },
    'prompt:curator/curate': { _meta: { ui: { resourceUri: 'ui://curator/dashboard.html' } } },
    'resource:curator/catalog': { _meta: { ui: { resourceUri: 'ui://curator/dashboard.html' } }, uri: 'catalog://books' },
    'tool:curator/inspect': { _meta: { ui: { resourceUri: 'ui://curator/dashboard.html' } }, related: ['ui://curator/dashboard.html', 'ui://curator/dashboard.html'] },
  });
  expect(Object.isFrozen(configs['tool:curator/inspect'])).toBe(true);

  // The resolved URI, not the reference text, is what the digest and the
  // generated server see: renaming the App's URI changes the graph identity.
  const renamed = await createRoot();
  await writeTree(renamed, {
    'src/mcp/curator/apps/dashboard.tsx': [
      "export const config = { resourceUri: 'ui://curator/panel.html' };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': [
      "import { appResourceUri } from 'agent-bundle/routes';",
      "export const config = { _meta: { ui: { resourceUri: appResourceUri('dashboard') } } };",
      moduleSource,
    ].join('\n'),
  });
  const renamedGraph = await compileRouteGraph(renamed, fixtureConfig());
  expect(renamedGraph.diagnostics).toEqual([]);
  expect(renamedGraph.servers[0]!.routes.find((route) => route.kind === 'tool')!.config)
    .toEqual({ _meta: { ui: { resourceUri: 'ui://curator/panel.html' } } });
});

it('diagnoses an appResourceUri() reference to an unknown App with AB4826 and keeps non-literal identifiers AB4806', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/apps/dashboard.tsx': [
      "export const config = { resourceUri: 'ui://curator/dashboard.html' };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': [
      "import { appResourceUri } from 'agent-bundle/routes';",
      "export const config = { _meta: { ui: { resourceUri: appResourceUri('panel') } } };",
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/tools/search.ts': [
      "import { APP_RESOURCE_URI } from '../constants.ts';",
      'export const config = { _meta: { ui: { resourceUri: APP_RESOURCE_URI } } };',
      moduleSource,
    ].join('\n'),
    'src/mcp/curator/constants.ts': "export const APP_RESOURCE_URI = process.env.APP_URI ?? 'ui://curator/dashboard.html';\n",
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(codesOf(graph.diagnostics).sort()).toEqual(['AB4806', 'AB4826']);
  const unknownApp = graph.diagnostics.find((diagnostic) => diagnostic.code === 'AB4826')!;
  expect(unknownApp.sourcePath).toBe(join(root, 'src/mcp/curator/tools/inspect.ts'));
  expect(unknownApp.message).toContain('references MCP App "panel"');
  expect(unknownApp.message).toContain('known App routes of "curator": app:curator/dashboard');
  const nonLiteral = graph.diagnostics.find((diagnostic) => diagnostic.code === 'AB4806')!;
  expect(nonLiteral.sourcePath).toBe(join(root, 'src/mcp/curator/tools/search.ts'));
  expect(nonLiteral.message).toContain('whose `export const APP_RESOURCE_URI` initializer is not a string literal');
  expect(nonLiteral.recovery).toContain("appResourceUri('<app>')");
  const routes = graph.servers[0]!.routes;
  expect(routes.find((route) => route.id === 'tool:curator/inspect')!.config).toBe(emptyRouteConfig);
  expect(routes.find((route) => route.id === 'tool:curator/search')!.config).toBe(emptyRouteConfig);
  expect(routes.find((route) => route.kind === 'app')!.config).toEqual({ resourceUri: 'ui://curator/dashboard.html' });
});

it('resolves appResourceUri() references only against Apps of the same generated server', async () => {
  const app = "export const config = { resourceUri: 'ui://curator/dashboard.html' };\n" + moduleSource;
  const referencing = (reference: string): string => [
    "import { appResourceUri } from 'agent-bundle/routes';",
    `export const config = { _meta: { ui: { resourceUri: appResourceUri('${reference}') } } };`,
    moduleSource,
  ].join('\n');

  // A generated server registers only its own Apps, so a route on another
  // server can never serve this URI: the qualified form is rejected too.
  const crossServer = await createRoot();
  await writeTree(crossServer, {
    'src/mcp/curator/apps/dashboard.tsx': app,
    'src/mcp/reporter/tools/summarize.ts': referencing('curator/dashboard'),
  });
  const crossServerGraph = await compileRouteGraph(crossServer, fixtureConfig());
  expect(codesOf(crossServerGraph.diagnostics)).toEqual(['AB4826']);
  expect(crossServerGraph.diagnostics[0]!.sourcePath).toBe(join(crossServer, 'src/mcp/reporter/tools/summarize.ts'));
  expect(crossServerGraph.diagnostics[0]!.message).toContain('which is app:curator/dashboard on another server');
  expect(crossServerGraph.diagnostics[0]!.message).toContain('"reporter" cannot serve it');
  expect(crossServerGraph.servers.find((server) => server.name === 'reporter')!.routes[0]!.config).toBe(emptyRouteConfig);

  // Non-MCP routes have no generated server to register an App on.
  const script = await createRoot();
  await writeTree(script, {
    'src/mcp/curator/apps/dashboard.tsx': app,
    'src/scripts/report.ts': referencing('curator/dashboard'),
  });
  const scriptGraph = await compileRouteGraph(script, fixtureConfig());
  expect(codesOf(scriptGraph.diagnostics)).toEqual(['AB4826']);
  expect(scriptGraph.diagnostics[0]!.message).toContain('App references resolve only from MCP route modules');

  // A server kept custom by override ships no route config at all, so its
  // references are neither resolved nor reported; the override is the fact.
  const custom = await createRoot();
  await writeTree(custom, {
    'src/mcp/curator/apps/dashboard.tsx': app,
    'src/mcp/curator/tools/open.ts': referencing('dashboard'),
  });
  const customGraph = await compileRouteGraph(custom, fixtureConfig({ routes: { servers: { curator: 'custom' } } }));
  expect(customGraph.diagnostics).toEqual([]);
  expect(customGraph.servers[0]).toMatchObject({ mode: 'custom', routes: [] });

  // An unresolved entry conflict reports AB4800 alone; the routes stay visible
  // with their authored reference until the mode is decided.
  const conflict = await createRoot();
  await writeTree(conflict, {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/apps/dashboard.tsx': app,
    'src/mcp/curator/tools/open.ts': referencing('dashboard'),
  });
  const conflictGraph = await compileRouteGraph(conflict, fixtureConfig());
  expect(codesOf(conflictGraph.diagnostics)).toEqual(['AB4800']);
  expect(conflictGraph.servers[0]!.routes.find((route) => route.kind === 'tool')!.config)
    .toEqual({ _meta: { ui: { resourceUri: 'dashboard' } } });

  // The explicit generated override resolves the reference.
  const generated = await createRoot();
  await writeTree(generated, {
    'src/mcp/curator.ts': moduleSource,
    'src/mcp/curator/apps/dashboard.tsx': app,
    'src/mcp/curator/tools/open.ts': referencing('app:curator/dashboard'),
  });
  const generatedGraph = await compileRouteGraph(generated, fixtureConfig({ routes: { servers: { curator: 'generated' } } }));
  expect(generatedGraph.diagnostics).toEqual([]);
  expect(generatedGraph.servers[0]!.routes.find((route) => route.kind === 'tool')!.config)
    .toEqual({ _meta: { ui: { resourceUri: 'ui://curator/dashboard.html' } } });
});

it('resolves an App route template relative to the route module, accepting the legacy root-relative form only when unambiguous', async () => {
  const app = (template: string): string => [
    `export const config = { resourceUri: 'ui://curator/dashboard.html', template: '${template}' };`,
    moduleSource,
  ].join('\n');
  const html = '<!doctype html><html><body></body></html>\n';
  const appOf = (graph: CompiledRouteGraph) => graph.servers[0]!.routes.find((route) => route.kind === 'app')!;

  // Route-relative: the documented form, resolved like the module's imports.
  const routeRelative = await createRoot();
  await writeTree(routeRelative, {
    'src/mcp/curator/apps/dashboard.html': html,
    'src/mcp/curator/apps/dashboard.tsx': app('./dashboard.html'),
  });
  const routeRelativeGraph = await compileRouteGraph(routeRelative, fixtureConfig());
  expect(routeRelativeGraph.diagnostics).toEqual([]);
  expect(appOf(routeRelativeGraph).config).toEqual({ resourceUri: 'ui://curator/dashboard.html', template: './dashboard.html' });

  // Legacy project-root-relative: still accepted while it is the only match, without a diagnostic.
  const rootRelative = await createRoot();
  await writeTree(rootRelative, {
    'src/mcp/curator/apps/dashboard.tsx': app('./views/dashboard.html'),
    'views/dashboard.html': html,
  });
  expect((await compileRouteGraph(rootRelative, fixtureConfig())).diagnostics).toEqual([]);

  // Both interpretations name different existing files: AB4827 names both.
  const ambiguous = await createRoot();
  await writeTree(ambiguous, {
    'src/mcp/curator/apps/dashboard.tsx': app('./views/dashboard.html'),
    'src/mcp/curator/apps/views/dashboard.html': html,
    'views/dashboard.html': html,
  });
  const ambiguousGraph = await compileRouteGraph(ambiguous, fixtureConfig());
  expect(codesOf(ambiguousGraph.diagnostics)).toEqual(['AB4827']);
  expect(ambiguousGraph.diagnostics[0]).toMatchObject({ severity: 'error', sourcePath: join(ambiguous, 'src/mcp/curator/apps/dashboard.tsx') });
  expect(ambiguousGraph.diagnostics[0]!.message).toContain('names two different existing files');
  expect(ambiguousGraph.diagnostics[0]!.message).toContain(`${join(ambiguous, 'src/mcp/curator/apps/views/dashboard.html')} (route-relative)`);
  expect(ambiguousGraph.diagnostics[0]!.message).toContain(`${join(ambiguous, 'views/dashboard.html')} (project-root-relative)`);
  expect(ambiguousGraph.diagnostics[0]!.recovery).toContain('relative to the route module');

  // Neither exists: AB4827 names both candidates and the fix.
  const missing = await createRoot();
  await writeTree(missing, { 'src/mcp/curator/apps/dashboard.tsx': app('./dashboard.html') });
  const missingGraph = await compileRouteGraph(missing, fixtureConfig());
  expect(codesOf(missingGraph.diagnostics)).toEqual(['AB4827']);
  expect(missingGraph.diagnostics[0]!.message).toContain('but neither');
  expect(missingGraph.diagnostics[0]!.message).toContain(`${join(missing, 'src/mcp/curator/apps/dashboard.html')} (route-relative)`);
  expect(missingGraph.diagnostics[0]!.message).toContain(`${join(missing, 'dashboard.html')} (project-root-relative)`);

  // An absolute template has a single candidate, which still has to exist.
  const absolute = await createRoot();
  await writeTree(absolute, { 'src/mcp/curator/apps/dashboard.tsx': app(join(absolute, 'shell', 'missing.html')) });
  const absoluteGraph = await compileRouteGraph(absolute, fixtureConfig());
  expect(codesOf(absoluteGraph.diagnostics)).toEqual(['AB4827']);
  expect(absoluteGraph.diagnostics[0]!.message).toContain(`but ${join(absolute, 'shell', 'missing.html')} does not exist.`);
  const absolutePresent = await createRoot();
  await writeTree(absolutePresent, {
    'shell/dashboard.html': html,
    'src/mcp/curator/apps/dashboard.tsx': app(join(absolutePresent, 'shell', 'dashboard.html')),
  });
  expect((await compileRouteGraph(absolutePresent, fixtureConfig())).diagnostics).toEqual([]);

  // The same tree in another checkout digests identically: the template stays
  // the authored path in the IR, and only its resolution is machine-specific.
  const twin = await createRoot();
  await writeTree(twin, {
    'src/mcp/curator/apps/dashboard.html': html,
    'src/mcp/curator/apps/dashboard.tsx': app('./dashboard.html'),
  });
  expect((await compileRouteGraph(twin, fixtureConfig())).digest).toBe(routeRelativeGraph.digest);
});

it('rejects a route that advertises an App the server does not build for every target with AB4828', async () => {
  const tool = (resourceUri: string): string => [
    `export const config = { _meta: { ui: { resourceUri: ${resourceUri} } } };`,
    moduleSource,
  ].join('\n');
  const restrictedApp = "export const config = { resourceUri: 'ui://curator/dashboard.html', targets: ['codex'] };\ndocument.body.textContent = 'dashboard';\n";
  const configWith = (lines: readonly string[]): string => [
    'export default {',
    ...lines,
    "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
    "  targets: ['portable', 'codex'],",
    '};',
    '',
  ].join('\n');

  // The App ships to codex only; the server (and its tool) ship to portable too.
  const referenced = await createInspectProject({
    'agent-bundle.config.ts': configWith([]),
    'src/mcp/curator/apps/dashboard.tsx': restrictedApp,
    'src/mcp/curator/tools/open.ts': tool("appResourceUri('dashboard')").replace('export const config', "import { appResourceUri } from 'agent-bundle/routes';\nexport const config"),
  });
  const referencedErrors = (await validate({ root: referenced })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(codesOf(referencedErrors)).toEqual(['AB4828']);
  expect(referencedErrors[0]).toMatchObject({ sourcePath: join(referenced, 'src/mcp/curator/tools/open.ts') });
  expect(referencedErrors[0]!.message).toContain('is not built for "portable"');
  expect(referencedErrors[0]!.recovery).toContain('mcp.servers.curator.targets');

  // A hand-written literal is held to the same rule.
  const literal = await createInspectProject({
    'agent-bundle.config.ts': configWith([]),
    'src/mcp/curator/apps/dashboard.tsx': restrictedApp,
    'src/mcp/curator/tools/open.ts': tool("'ui://curator/dashboard.html'"),
  });
  expect(codesOf((await validate({ root: literal })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error'))).toEqual(['AB4828']);

  // Restricting the server to the App's targets makes the reference sound.
  const restrictedServer = await createInspectProject({
    'agent-bundle.config.ts': configWith(["  mcp: { servers: { curator: { targets: ['codex'] } } },"]),
    'src/mcp/curator/apps/dashboard.tsx': restrictedApp,
    'src/mcp/curator/tools/open.ts': tool("appResourceUri('dashboard')").replace('export const config', "import { appResourceUri } from 'agent-bundle/routes';\nexport const config"),
  });
  expect((await validate({ root: restrictedServer })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

  // A config-declared App of the same server is covered too.
  const configApp = await createInspectProject({
    'agent-bundle.config.ts': configWith([
      "  mcp: { servers: { curator: { apps: { panel: { entry: './views/panel.ts', resourceUri: 'ui://curator/panel.html', targets: ['codex'] } } } } },",
    ]),
    'src/mcp/curator/tools/open.ts': tool("'ui://curator/panel.html'"),
    'views/panel.ts': "document.body.textContent = 'panel';\n",
  });
  const configAppErrors = (await validate({ root: configApp })).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  expect(codesOf(configAppErrors)).toEqual(['AB4828']);
  expect(configAppErrors[0]!.message).toContain('config App "panel"');
});

it('rejects two App routes of one server that declare the same resourceUri with AB4829, but not the same URI across servers', async () => {
  const app = (resourceUri: string): string => `export const config = { resourceUri: '${resourceUri}' };\n${moduleSource}`;

  // Same server, two distinct route modules, one URI: the compiler names both
  // files and the server instead of registering whichever route came first.
  const sameServer = await createRoot();
  await writeTree(sameServer, {
    'src/mcp/curator/apps/dashboard.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/apps/panel.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const sameServerGraph = await compileRouteGraph(sameServer, fixtureConfig());
  expect(codesOf(sameServerGraph.diagnostics)).toEqual(['AB4829']);
  expect(sameServerGraph.diagnostics[0]).toMatchObject({
    severity: 'error',
    sourcePath: join(sameServer, 'src/mcp/curator/apps/panel.tsx'),
  });
  expect(sameServerGraph.diagnostics[0]!.message).toContain('src/mcp/curator/apps/dashboard.tsx');
  expect(sameServerGraph.diagnostics[0]!.message).toContain('src/mcp/curator/apps/panel.tsx');
  expect(sameServerGraph.diagnostics[0]!.message).toContain('"curator"');
  expect(sameServerGraph.diagnostics[0]!.message).toContain('"ui://curator/dashboard.html"');
  expect(sameServerGraph.diagnostics[0]!.recovery).toContain('distinct config.resourceUri');
  // Both routes stay visible in the IR beside the error; only the build is refused.
  expect(sameServerGraph.servers[0]!.routes.filter((route) => route.kind === 'app').map((route) => route.id))
    .toEqual(['app:curator/dashboard', 'app:curator/panel']);

  // A third claimant is reported against the first, once per extra route.
  const threeWay = await createRoot();
  await writeTree(threeWay, {
    'src/mcp/curator/apps/dashboard.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/apps/panel.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/apps/sidebar.tsx': app('ui://curator/dashboard.html'),
  });
  const threeWayGraph = await compileRouteGraph(threeWay, fixtureConfig());
  expect(codesOf(threeWayGraph.diagnostics)).toEqual(['AB4829', 'AB4829']);
  expect(threeWayGraph.diagnostics.map((diagnostic) => diagnostic.sourcePath)).toEqual([
    join(threeWay, 'src/mcp/curator/apps/panel.tsx'),
    join(threeWay, 'src/mcp/curator/apps/sidebar.tsx'),
  ]);

  // Two servers may legitimately serve the same App under one URI: each
  // generated server registers only its own Apps, so nothing collides.
  const acrossServers = await createRoot();
  await writeTree(acrossServers, {
    'src/mcp/archive/apps/dashboard.tsx': app('ui://shared/dashboard.html'),
    'src/mcp/archive/tools/list.ts': moduleSource,
    'src/mcp/curator/apps/dashboard.tsx': app('ui://shared/dashboard.html'),
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const acrossServersGraph = await compileRouteGraph(acrossServers, fixtureConfig());
  expect(acrossServersGraph.diagnostics).toEqual([]);
  expect(acrossServersGraph.servers.map((server) => server.name)).toEqual(['archive', 'curator']);

  // A server kept custom ships no Apps, so its duplicates are not reported either.
  const custom = await createRoot();
  await writeTree(custom, {
    'src/mcp/curator/apps/dashboard.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/apps/panel.tsx': app('ui://curator/dashboard.html'),
  });
  expect((await compileRouteGraph(custom, fixtureConfig({ routes: { servers: { curator: 'custom' } } }))).diagnostics).toEqual([]);

  // The collision fails validate/inspect like AB4812 does.
  const project = await createInspectProject({
    'src/mcp/curator/apps/dashboard.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/apps/panel.tsx': app('ui://curator/dashboard.html'),
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const validation = await validate({ root: project });
  expect(codesOf(validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'))).toEqual(['AB4829']);
  expect((await inspect({ root: project })).state).toBe('invalid');
});

it('normalizes the App route template to its resolved path for the build', async () => {
  const html = '<!doctype html><html><body></body></html>\n';
  const routeRelative = await createInspectProject({
    'src/mcp/curator/apps/dashboard.html': html,
    'src/mcp/curator/apps/dashboard.tsx': "export const config = { resourceUri: 'ui://curator/dashboard.html', template: './dashboard.html' };\ndocument.body.textContent = 'dashboard';\n",
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const ready = (await inspect({ root: routeRelative })) as ReadyInspectResult;
  expect(ready.state).toBe('ready');
  expect(ready.model.mcpApps?.map((app) => app.template)).toEqual([join(routeRelative, 'src/mcp/curator/apps/dashboard.html')]);

  const legacy = await createInspectProject({
    'src/mcp/curator/apps/dashboard.tsx': "export const config = { resourceUri: 'ui://curator/dashboard.html', template: './views/dashboard.html' };\ndocument.body.textContent = 'dashboard';\n",
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'views/dashboard.html': html,
  });
  const legacyReady = (await inspect({ root: legacy })) as ReadyInspectResult;
  expect(legacyReady.state).toBe('ready');
  expect(legacyReady.model.mcpApps?.map((app) => app.template)).toEqual([join(legacy, 'views/dashboard.html')]);

  const ambiguous = await createInspectProject({
    'src/mcp/curator/apps/dashboard.tsx': "export const config = { resourceUri: 'ui://curator/dashboard.html', template: './views/dashboard.html' };\ndocument.body.textContent = 'dashboard';\n",
    'src/mcp/curator/apps/views/dashboard.html': html,
    'src/mcp/curator/tools/inspect.ts': moduleSource,
    'views/dashboard.html': html,
  });
  const validation = await validate({ root: ambiguous });
  expect(codesOf(validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'))).toEqual(['AB4827']);
  expect((await inspect({ root: ambiguous })).state).toBe('invalid');
});

it('covers the route config in the graph digest', async () => {
  const withTitle = async (title: string): Promise<string> => {
    const root = await createRoot();
    await writeTree(root, {
      'src/scripts/rebuild.ts': [
        `export const config = { title: '${title}' };`,
        moduleSource,
      ].join('\n'),
    });
    return (await compileRouteGraph(root, fixtureConfig())).digest;
  };

  const [left, sameAsLeft, right] = await Promise.all([withTitle('a'), withTitle('a'), withTitle('b')]);
  expect(left).toBe(sameAsLeft);
  expect(left).not.toBe(right);
});


it('generates deterministic route-specific types from the compiled graph', () => {
  const generate = (routesModule as unknown as {
    readonly generateRouteTypes?: (graph: CompiledRouteGraph) => string;
  }).generateRouteTypes;
  expect(typeof generate).toBe('function');
  if (generate === undefined) return;

  const graph: CompiledRouteGraph = {
    diagnostics: [],
    digest: 'typegen-digest',
    events: [{
      config: emptyRouteConfig,
      event: 'workspace/open',
      id: 'event:workspace/open',
      kind: 'event-route',
      provenance: { kind: 'conventional', relativePath: 'src/events/workspace/open.tsx' },
      source: '/workspace/project/src/events/workspace/open.tsx',
    }],
    providers: [],
    scripts: [{
      config: emptyRouteConfig,
      id: 'script:rebuild-index',
      kind: 'script',
      provenance: { kind: 'conventional', relativePath: 'src/scripts/rebuild-index.ts' },
      source: '/workspace/project/src/scripts/rebuild-index.ts',
    }],
    servers: [{
      id: 'mcp:curator',
      mode: 'generated',
      name: 'curator',
      routes: [{
        config: emptyRouteConfig,
        id: 'tool:curator/inspect',
        kind: 'tool',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
        serverId: 'mcp:curator',
        source: '/workspace/project/src/mcp/curator/tools/inspect.tsx',
      }],
    }],
  };
  const first = generate(graph);
  const second = generate(structuredClone(graph));

  expect(second).toBe(first);
  expect(first).toContain('import type * as route0 from "../src/events/workspace/open.js";');
  expect(first).toContain('import type * as route1 from "../src/mcp/curator/tools/inspect.js";');
  expect(first).toContain('"event:workspace/open": EventRouteContract<typeof route0.default, "workspace/open">;');
  expect(first).toContain('"tool:curator/inspect": RouteContract<typeof route1.inputSchema, typeof route1.resultSchema>;');
  expect(first).not.toContain('src/scripts/rebuild-index');
  expect(first).not.toContain('"script:rebuild-index"');
  expect(first).toContain('export type RouteId = keyof AgentBundleRoutes;');
  expect(first).toContain('type ContractInput<Contract> =');
  expect(first).toContain('type ContractResult<Contract> =');
  expect(first).toContain('export type RouteInput<Id extends RouteId> = ContractInput<AgentBundleRoutes[Id]>;');
  expect(first).toContain('export type RouteResult<Id extends RouteId> = ContractResult<AgentBundleRoutes[Id]>;');
  // The registered map is the harness contract: an event route registers its `{ canonical, native }` payload and no result.
  expect(first).toContain("type HarnessInput<Contract> =\n  Contract extends { readonly input: infer Input } ? Input\n    : Contract extends { readonly component: infer Component } ? Omit<ComponentInput<Component>, 'signal'>\n      : never;");
  expect(first).toContain('type HarnessResult<Contract> =\n  Contract extends { readonly result: infer Result } ? Result\n    : Contract extends { readonly component: unknown } ? undefined\n      : never;');
  expect(first).toContain('export type AgentBundleRouteContracts = {\n  readonly [Id in RouteId]: Readonly<{ input: HarnessInput<AgentBundleRoutes[Id]>; result: HarnessResult<AgentBundleRoutes[Id]> }>;\n};');
  // A provider-free graph declares no provider surface; the runtime augmentation carries only the route registration.
  expect(first).not.toContain('AgentBundleProviders');
  expect(first).not.toContain('AgentProviderValues');
  expect(first).toContain("declare module '@agent-bundle/runtime' {\n  interface Register {\n    readonly routes: AgentBundleRouteContracts;\n  }\n}");
});

it('generates provider declarations and the runtime augmentation in execution order', () => {
  const graph: CompiledRouteGraph = {
    diagnostics: [],
    digest: 'provider-typegen-digest',
    events: [],
    providers: [
      {
        id: 'provider:zeta',
        name: 'zeta',
        provenance: { kind: 'conventional', relativePath: 'src/providers/zeta.ts' },
        source: '/workspace/project/src/providers/zeta.ts',
      },
      {
        id: 'provider:project-auth',
        name: 'project-auth',
        provenance: { kind: 'conventional', relativePath: 'src/providers/project-auth.tsx' },
        source: '/workspace/project/src/providers/project-auth.tsx',
      },
    ],
    scripts: [],
    servers: [{
      id: 'mcp:curator',
      mode: 'generated',
      name: 'curator',
      routes: [{
        config: emptyRouteConfig,
        id: 'tool:curator/inspect',
        kind: 'tool',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
        serverId: 'mcp:curator',
        source: '/workspace/project/src/mcp/curator/tools/inspect.tsx',
      }],
    }],
  };

  const first = routesModule.generateRouteTypes(graph);
  expect(routesModule.generateRouteTypes(structuredClone(graph))).toBe(first);
  // Providers import in camel-cased key order — the order generated scopes execute them.
  expect(first).toContain('import type * as provider0 from "../src/providers/project-auth.js";');
  expect(first).toContain('import type * as provider1 from "../src/providers/zeta.js";');
  expect(first).toContain('type ProviderValueOf<Factory> = Factory extends (...args: never[]) => infer Value ? Awaited<Value> : never;');
  expect(first).toContain('export interface AgentBundleProviders {');
  expect(first).toContain('  readonly "projectAuth": ProviderValueOf<typeof provider0.default>;');
  expect(first).toContain('  readonly "zeta": ProviderValueOf<typeof provider1.default>;');
  expect(first).toContain('export type ProviderKey = keyof AgentBundleProviders;');
  expect(first).toContain('export type ProviderValue<Key extends ProviderKey> = AgentBundleProviders[Key];');
  // One augmentation block registers routes and declares providers together.
  expect(first).toContain("declare module '@agent-bundle/runtime' {\n  interface Register {\n    readonly routes: AgentBundleRouteContracts;\n  }\n  interface AgentProviderValues {\n    readonly \"projectAuth\": ProviderValueOf<typeof provider0.default>;\n    readonly \"zeta\": ProviderValueOf<typeof provider1.default>;\n  }\n}");
  expect(first.match(/declare module '@agent-bundle\/runtime'/g)).toHaveLength(1);
  expect(first.indexOf('AgentBundleRoutes')).toBeLessThan(first.indexOf('AgentBundleProviders'));
});

it('resolves generated helper types for schema and event route contracts', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'package.json': '{"type":"module"}\n',
    'src/events/workspace/open.ts': [
      'export interface WorkspaceOpenInput {',
      "  readonly canonical: { readonly event: 'workspace/open' };",
      '  readonly native: Readonly<Record<string, unknown>>;',
      '  readonly signal: AbortSignal;',
      '}',
      'export interface WorkspaceOpenResult { readonly rendered: true; }',
      'export default async function WorkspaceOpen(_props: WorkspaceOpenInput): Promise<WorkspaceOpenResult> {',
      '  return { rendered: true };',
      '}',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/inspect.ts': [
      'export interface InspectInput { readonly source: string; }',
      'export interface InspectResult { readonly accepted: boolean; }',
      'export const inputSchema = {} as { readonly _output: InspectInput };',
      'export const resultSchema = {} as { readonly _output: InspectResult };',
      'export default async function Inspect() { return undefined; }',
      '',
    ].join('\n'),
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics).toEqual([]);
  await writeTree(root, {
    '.agent-bundle/routes.d.ts': routesModule.generateRouteTypes(graph),
    // A stand-in for the runtime's empty `Register`, so the augmentation has a declaration to merge into.
    'runtime-stub.d.ts': 'export interface Register {}\n',
    'assertions.ts': [
      "import type { Register } from '@agent-bundle/runtime';",
      "import type { RouteId, RouteInput, RouteResult } from './.agent-bundle/routes.js';",
      "import type { WorkspaceOpenInput, WorkspaceOpenResult } from './src/events/workspace/open.js';",
      "import type { InspectInput, InspectResult } from './src/mcp/curator/tools/inspect.js';",
      '',
      'type Equal<Left, Right> =',
      '  (<Value>() => Value extends Left ? 1 : 2) extends',
      '  (<Value>() => Value extends Right ? 1 : 2) ? true : false;',
      'type Assert<Value extends true> = Value;',
      '',
      "export type SchemaInput = Assert<Equal<RouteInput<'tool:curator/inspect'>, InspectInput>>;",
      "export type SchemaResult = Assert<Equal<RouteResult<'tool:curator/inspect'>, InspectResult>>;",
      "export type EventInput = Assert<Equal<RouteInput<'event:workspace/open'>, WorkspaceOpenInput>>;",
      "export type EventResult = Assert<Equal<RouteResult<'event:workspace/open'>, WorkspaceOpenResult>>;",
      'export type AllInputs = Assert<Equal<RouteInput<RouteId>, InspectInput | WorkspaceOpenInput>>;',
      'export type AllResults = Assert<Equal<RouteResult<RouteId>, InspectResult | WorkspaceOpenResult>>;',
      '// The augmentation registers the same contracts on the runtime, keyed by route id.',
      "export type RegisteredIds = Assert<Equal<keyof Register['routes'], RouteId>>;",
      "export type RegisteredInspect = Assert<Equal<Register['routes']['tool:curator/inspect'], Readonly<{ input: InspectInput; result: InspectResult }>>>;",
      '// An event route registers the harness payload (props without the signal the harness injects) and no result.',
      "export type RegisteredEvent = Assert<Equal<Register['routes']['event:workspace/open'], Readonly<{ input: Omit<WorkspaceOpenInput, 'signal'>; result: undefined }>>>;",
      "export type RegisteredEventInput = Assert<Equal<keyof Register['routes']['event:workspace/open']['input'], 'canonical' | 'native'>>;",
      '',
    ].join('\n'),
  });

  const program = ts.createProgram([join(root, 'assertions.ts')], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    paths: { '@agent-bundle/runtime': [join(root, 'runtime-stub.d.ts')] },
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  expect(diagnostics).toEqual([]);
});

it('validates the single async route-module authoring contract statically', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/mcp/curator/tools/valid.tsx': [
      'export const inputSchema = {};',
      'export const resultSchema = {};',
      'export default async function Valid() { return undefined; }',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/split.tsx': [
      'export const resultSchema = {};',
      'export const execute = async () => ({});',
      'export const render = () => undefined;',
      'export default function Split() { return undefined; }',
      '',
    ].join('\n'),
  });

  const graph = await compileRouteGraph(root, fixtureConfig());
  expect(graph.diagnostics.filter((diagnostic) => diagnostic.sourcePath?.endsWith('valid.tsx'))).toEqual([]);
  expect(graph.diagnostics.filter((diagnostic) => diagnostic.sourcePath?.endsWith('split.tsx')).map(({ code }) => code)).toEqual([
    'AB4810',
    'AB4811',
  ]);
});

it('follows a re-exported default to the module that declares it when one tool is placed on two servers (#446)', async () => {
  const root = await createRoot();
  await writeTree(root, {
    // The primary placement: a full route module.
    'src/mcp/public/tools/search.tsx': [
      "export const config = { description: 'Search.' };",
      'export const inputSchema = {};',
      'export const resultSchema = {};',
      'export default async function Search() { return undefined; }',
      '',
    ].join('\n'),
    // The second placement carries its own config and re-exports the rest.
    'src/mcp/library/tools/search.tsx': [
      "export const config = { description: 'Search from the widget server.' };",
      "export { default, inputSchema, resultSchema } from '../../public/tools/search.tsx';",
      '',
    ].join('\n'),
    // A named component aliased to default, through a shared page module.
    'src/pages/download.tsx': 'export async function DownloadPage() { return undefined; }\n',
    'src/mcp/library/tools/download.tsx': [
      "export const config = { description: 'Download.' };",
      "export { DownloadPage as default } from '../../../pages/download.tsx';",
      "export { inputSchema, resultSchema } from '../../public/tools/search.tsx';",
      '',
    ].join('\n'),
    // A chain: the shared module itself re-exports its default, and a
    // `.js` specifier names the emitted extension of a `.tsx` source.
    'src/pages/_delete-impl.tsx': 'export default async () => undefined;\n',
    'src/pages/delete.tsx': "export { default } from './_delete-impl.js';\n",
    'src/mcp/library/tools/delete.tsx': [
      "export const config = { description: 'Delete.' };",
      "export { default } from '../../../pages/delete.tsx';",
      "export { inputSchema, resultSchema } from '../../public/tools/search.tsx';",
      '',
    ].join('\n'),
    // A default from a package the scan cannot read is verified at run time.
    'src/mcp/library/tools/external.tsx': [
      "export const config = { description: 'External.' };",
      'export const inputSchema = {};',
      'export const resultSchema = {};',
      "export { default } from '@shared/routes/external';",
      '',
    ].join('\n'),
    // The re-exported default is judged where it is declared: a sync
    // function component there is still AB4810 here, naming the target.
    'src/pages/sync.tsx': 'export default function SyncPage() { return undefined; }\n',
    'src/mcp/library/tools/sync.tsx': [
      "export const config = { description: 'Sync.' };",
      "export { default } from '../../../pages/sync.tsx';",
      "export { inputSchema, resultSchema } from '../../public/tools/search.tsx';",
      '',
    ].join('\n'),
    // A type-only default re-export emits no binding and never satisfies the contract.
    'src/mcp/library/tools/typed.tsx': [
      "export const config = { description: 'Typed.' };",
      "export { type default } from '../../public/tools/search.tsx';",
      "export { inputSchema, resultSchema } from '../../public/tools/search.tsx';",
      '',
    ].join('\n'),
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics.map(({ code, message, sourcePath }) => ({
    code,
    message,
    source: sourcePath?.slice(root.length + 1).replaceAll('\\', '/'),
  }))).toEqual([
    {
      code: 'AB4810',
      message: 'Route module src/mcp/library/tools/sync.tsx does not satisfy the public route contract: default export re-exported from "../../../pages/sync.tsx" (default) is not an async function component.',
      source: 'src/mcp/library/tools/sync.tsx',
    },
    {
      code: 'AB4810',
      message: 'Route module src/mcp/library/tools/typed.tsx does not satisfy the public route contract: default export is not an async function component.',
      source: 'src/mcp/library/tools/typed.tsx',
    },
  ]);
  expect(graph.servers.map((server) => [server.name, server.routes.map((route) => route.id)])).toEqual([
    ['library', [
      'tool:library/delete',
      'tool:library/download',
      'tool:library/external',
      'tool:library/search',
      'tool:library/sync',
      'tool:library/typed',
    ]],
    ['public', ['tool:public/search']],
  ]);
});

it('reports the scanned export surface of a re-exporting module', () => {
  const modules = new Map<string, string>([
    ['/project/src/shared/page.tsx', [
      'export const helper = () => 1;',
      'export async function Page() { return undefined; }',
      'export { Page as Alias };',
      'export default Page;',
      '',
    ].join('\n')],
    ['/project/src/shared/cycle-a.tsx', "export { default } from './cycle-b.tsx';\n"],
    ['/project/src/shared/cycle-b.tsx', "export { default } from './cycle-a.tsx';\n"],
    // An emitted `.js` beside its `.tsx` source: TypeScript resolution order
    // names the source first, so the async component is judged, not the
    // stale sync emit.
    ['/project/src/shared/dual.js', 'export default function Dual() { return undefined; }\n'],
    ['/project/src/shared/dual.tsx', 'export default async function Dual() { return undefined; }\n'],
    ['/project/src/shared/dir/index.tsx', 'export default async () => undefined;\n'],
    ['/project/src/shared/legacy.cts', 'export default async function Legacy() { return undefined; }\n'],
  ]);
  const readModule = (path: string): string | undefined => modules.get(path);
  const scan = (text: string, source: string): routesModule.RouteModuleExports =>
    routesModule.scanRouteModuleExports(text, source.slice('/project/'.length), { readModule, source });

  // The same TypeScript candidate order the config extractor uses.
  expect(scan("export { default } from '../shared/dual.js';\n", '/project/src/mcp/dual.tsx').asyncDefault).toBe(true);
  expect(scan("export { default } from '../shared/dir';\n", '/project/src/mcp/dir.tsx').asyncDefault).toBe(true);
  expect(scan("export { default } from '../shared/legacy.cjs';\n", '/project/src/mcp/legacy.tsx').asyncDefault).toBe(true);
  expect(scan("export { default } from '../shared/dual.ts';\n", '/project/src/mcp/exact.tsx').defaultReExport?.resolution).toBe('unresolved');

  const followed = routesModule.scanRouteModuleExports(
    "export { default, helper, Alias as Component } from '../shared/page.tsx';\n",
    'src/mcp/a/tools/x.tsx',
    { readModule, source: '/project/src/mcp/x.tsx' },
  );
  expect(followed.asyncDefault).toBe(true);
  expect(followed.defaultFunction).toBe(true);
  expect(followed.defaultReExport).toEqual({ name: 'default', resolution: 'followed', specifier: '../shared/page.tsx' });
  expect([...followed.named].sort()).toEqual(['Component', 'helper']);
  expect([...followed.namedFunctions].sort()).toEqual(['Component', 'helper']);
  expect([...followed.namedAsyncFunctions]).toEqual(['Component']);

  const aliased = routesModule.scanRouteModuleExports(
    "export { Page as default } from '../shared/page.tsx';\n",
    'src/mcp/a/tools/y.tsx',
    { readModule, source: '/project/src/mcp/y.tsx' },
  );
  expect(aliased.asyncDefault).toBe(true);
  expect(aliased.defaultReExport?.name).toBe('Page');

  // Without a source there is nothing to resolve against.
  const sourceless = routesModule.scanRouteModuleExports(
    "export { default } from '../shared/page.tsx';\n",
    'src/mcp/a/tools/z.tsx',
    { readModule },
  );
  expect(sourceless.asyncDefault).toBe(false);
  expect(sourceless.defaultReExport?.resolution).toBe('unresolved');

  const cyclic = routesModule.scanRouteModuleExports(
    modules.get('/project/src/shared/cycle-a.tsx')!,
    'src/shared/cycle-a.tsx',
    { readModule, source: '/project/src/shared/cycle-a.tsx' },
  );
  expect(cyclic.asyncDefault).toBe(false);
  expect(cyclic.defaultReExport).toEqual({ name: 'default', resolution: 'unresolved', specifier: './cycle-b.tsx' });

  // A relative target no candidate file satisfies cannot be judged either.
  const missing = routesModule.scanRouteModuleExports(
    "export { default } from './missing.tsx';\n",
    'src/mcp/a/tools/m.tsx',
    { readModule, source: '/project/src/mcp/m.tsx' },
  );
  expect(missing.defaultReExport?.resolution).toBe('unresolved');
});

it('validates provider default factories with AB4940', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'src/providers/missing.ts': 'export const value = 1;\n',
    'src/providers/not-a-function.ts': 'export default { value: 1 };\n',
    'src/providers/valid.ts': 'export default ({ invocation }) => invocation.kind;\n',
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics.map(({ code, sourcePath }) => ({
    code,
    source: sourcePath?.slice(root.length + 1).replaceAll('\\', '/'),
  }))).toEqual([
    { code: 'AB4940', source: 'src/providers/missing.ts' },
    { code: 'AB4940', source: 'src/providers/not-a-function.ts' },
  ]);
});

it('discovers the root and per-server layout modules without changing a layout-free graph digest', async () => {
  const root = await createRoot();
  await writeTree(root, conventionalTree);
  const layoutFree = await compileRouteGraph(root, fixtureConfig());
  expect(layoutFree.layouts).toBeUndefined();
  expect('layouts' in layoutFree).toBe(false);

  await writeTree(root, {
    'src/layout.tsx': 'export default function Layout({ children }) { return children; }\n',
    'src/mcp/curator/layout.tsx': 'export default async ({ children }) => children;\n',
  });
  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics).toEqual([]);
  expect(graph.layouts).toEqual([
    {
      id: 'layout:root',
      provenance: { kind: 'conventional', relativePath: 'src/layout.tsx' },
      scope: 'root',
      source: join(root, 'src/layout.tsx'),
    },
    {
      id: 'layout:mcp:curator',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/layout.tsx' },
      scope: 'server',
      serverId: 'mcp:curator',
      source: join(root, 'src/mcp/curator/layout.tsx'),
    },
  ]);
  // The layout is never a route: the server's route list and ids are unchanged.
  expect(graph.servers[0]!.routes.map((route) => route.id)).toEqual(layoutFree.servers[0]!.routes.map((route) => route.id));
  expect(graph.digest).not.toBe(layoutFree.digest);
  expect(isEmptyRouteGraph(graph)).toBe(false);

  // A private layout file opts out of the convention.
  const optedOut = await createRoot();
  await writeTree(optedOut, {
    ...conventionalTree,
    'src/_layout.tsx': 'export default ({ children }) => children;\n',
    'src/mcp/curator/_layout.tsx': 'export default ({ children }) => children;\n',
  });
  const optedOutGraph = await compileRouteGraph(optedOut, fixtureConfig());
  expect(optedOutGraph.layouts).toBeUndefined();
  expect(optedOutGraph.digest).toBe(layoutFree.digest);
});

it('validates layout modules with AB4830, duplicate scopes with AB4831, and orphaned server layouts with AB4832', async () => {
  const root = await createRoot();
  await writeTree(root, {
    ...conventionalTree,
    'src/layout.ts': 'export default ({ children }) => children;\n',
    'src/layout.tsx': 'export default ({ children }) => children;\n',
    'src/mcp/curator/layout.tsx': [
      'export const inputSchema = {};',
      'export const resultSchema = {};',
      'export default { children: undefined };',
      '',
    ].join('\n'),
    'src/mcp/ghost/layout.tsx': 'export default ({ children }) => children;\n',
    // App routes are browser builds that never take a layout, so a server
    // declaring only apps is orphaned for layout purposes too.
    'src/mcp/panel/apps/main.tsx': `export const config = { resourceUri: 'ui://panel/main.html' }; ${moduleSource}`,
    'src/mcp/panel/layout.tsx': 'export default ({ children }) => children;\n',
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics.map(({ code, sourcePath }) => ({
    code,
    source: sourcePath?.slice(root.length + 1).replaceAll('\\', '/'),
  }))).toEqual([
    { code: 'AB4831', source: 'src/layout.tsx' },
    { code: 'AB4830', source: 'src/mcp/curator/layout.tsx' },
    { code: 'AB4832', source: 'src/mcp/ghost/layout.tsx' },
    { code: 'AB4832', source: 'src/mcp/panel/layout.tsx' },
  ]);
  expect(graph.diagnostics[0]!.message).toContain('src/layout.ts');
  expect(graph.diagnostics[0]!.message).toContain('src/layout.tsx');
  expect(graph.diagnostics[1]!.message).toContain('default export is not a function component');
  expect(graph.diagnostics[1]!.message).toContain('exports route-only inputSchema, resultSchema');
  expect(graph.diagnostics[2]!.message).toContain('"ghost"');
  expect(graph.diagnostics[3]!.message).toContain('"panel"');
  expect(graph.diagnostics[3]!.message).toContain('no tool, resource, or prompt route modules');
  // Discovery keeps the modules visible beside the errors; only the duplicate is dropped.
  expect(graph.layouts!.map((layout) => layout.id)).toEqual(['layout:root', 'layout:mcp:curator', 'layout:mcp:ghost', 'layout:mcp:panel']);
  expect(graph.servers.map((server) => server.name)).toEqual(['curator', 'panel']);
});

it('judges a layout or provider for AB4837 only when a generated executable bundles it', async () => {
  // Value imports of the compiler (#558): the route graph reports them
  // before the bundler would inline the compiler into a self-contained
  // executable. A layout is inlined only into the workers of the rendered
  // routes it wraps; a provider into every generated request scope.
  const compilerImport = "import { serveApp } from 'agent-bundle/api';\n";
  const layout = `${compilerImport}export default ({ children }) => { void serveApp; return children; };\n`;
  const provider = `${compilerImport}export default () => serveApp;\n`;
  const codesBySource = (diagnostics: readonly { readonly code: string; readonly sourcePath?: string }[], root: string) =>
    diagnostics
      .filter(({ code }) => code === 'AB4837')
      .map(({ sourcePath }) => sourcePath?.slice(root.length + 1).replaceAll('\\', '/'))
      .sort();

  // A generated tool route composes through the root layout: both are judged.
  const wrapped = await createRoot();
  await writeTree(wrapped, {
    'src/layout.tsx': layout,
    'src/mcp/curator/tools/inspect.tsx': moduleSource,
    'src/providers/git-worktree.ts': provider,
  });
  const wrappedGraph = await compileRouteGraph(wrapped, fixtureConfig());
  expect(codesBySource(wrappedGraph.diagnostics, wrapped)).toEqual(['src/layout.tsx', 'src/providers/git-worktree.ts']);
  expect(wrappedGraph.diagnostics.find(({ code }) => code === 'AB4837')!.message)
    .toMatch(/^Layout module src\/layout\.tsx imports "agent-bundle\/api" as a value; the generated executable is self-contained/u);

  // Apps are browser builds and event routes take no layout, so nothing
  // bundles the root layout — while the generated server and the hook
  // wrapper still mount the provider.
  const unwrapped = await createRoot();
  await writeTree(unwrapped, {
    'src/events/workspace/open.tsx': moduleSource,
    'src/layout.tsx': layout,
    'src/mcp/panel/apps/main.tsx': `export const config = { resourceUri: 'ui://panel/main.html' }; ${moduleSource}`,
    'src/providers/git-worktree.ts': provider,
  });
  const unwrappedGraph = await compileRouteGraph(unwrapped, fixtureConfig());
  expect(codesBySource(unwrappedGraph.diagnostics, unwrapped)).toEqual(['src/providers/git-worktree.ts']);

  // A plain `.ts` command runs without a render session, so the routed CLI
  // executable inlines no layout — but it mounts the providers.
  const plainCli = await createRoot();
  await writeTree(plainCli, {
    'src/cli/doctor.ts': [
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n'),
    'src/layout.tsx': layout,
    'src/providers/git-worktree.ts': provider,
  });
  expect(codesBySource((await compileRouteGraph(plainCli, fixtureConfig())).diagnostics, plainCli))
    .toEqual(['src/providers/git-worktree.ts']);

  // A rendered `.tsx` command renders through the worker, which imports both.
  const renderedCli = await createRoot();
  await writeTree(renderedCli, {
    'src/cli/doctor.tsx': [
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = {};',
      'export default async () => undefined;',
      '',
    ].join('\n'),
    'src/layout.tsx': layout,
    'src/providers/git-worktree.ts': provider,
  });
  expect(codesBySource((await compileRouteGraph(renderedCli, fixtureConfig())).diagnostics, renderedCli))
    .toEqual(['src/layout.tsx', 'src/providers/git-worktree.ts']);

  // A plain script is bundled from its own source: neither layouts nor
  // providers are inlined. A rendered script's worker inlines both.
  const plainScript = await createRoot();
  await writeTree(plainScript, {
    'src/layout.tsx': layout,
    'src/providers/git-worktree.ts': provider,
    'src/scripts/rebuild-index.ts': moduleSource,
  });
  expect(codesBySource((await compileRouteGraph(plainScript, fixtureConfig())).diagnostics, plainScript)).toEqual([]);
  const renderedScript = await createRoot();
  await writeTree(renderedScript, {
    'src/layout.tsx': layout,
    'src/providers/git-worktree.ts': provider,
    'src/scripts/rebuild-index.tsx': moduleSource,
  });
  expect(codesBySource((await compileRouteGraph(renderedScript, fixtureConfig())).diagnostics, renderedScript))
    .toEqual(['src/layout.tsx', 'src/providers/git-worktree.ts']);

  // A server layout of a server that is not generated wraps nothing that is
  // bundled either, and with no generated executable at all the provider is
  // never inlined.
  const custom = await createRoot();
  await writeTree(custom, {
    'src/mcp/curator/layout.tsx': layout,
    'src/mcp/curator/tools/inspect.tsx': moduleSource,
    'src/providers/git-worktree.ts': provider,
  });
  const customGraph = await compileRouteGraph(custom, fixtureConfig({ routes: { servers: { curator: 'custom' } } }));
  expect(codesBySource(customGraph.diagnostics, custom)).toEqual([]);
});

it('rejects provider key collisions and the reserved processLifetime key', async () => {
  const root = await createRoot();
  const provider = 'export default () => undefined;\n';
  await writeTree(root, {
    'src/providers/foo-bar.ts': provider,
    'src/providers/foo_bar.ts': provider,
    'src/providers/process-lifetime.ts': provider,
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.diagnostics.map(({ code }) => code)).toEqual(['AB4941', 'AB4942']);
  expect(graph.diagnostics[0]).toMatchObject({
    message: expect.stringMatching(/fooBar/u),
    sourcePath: expect.stringMatching(/src[/\\]providers[/\\]foo[-_]bar\.ts$/u),
  });
  expect(graph.diagnostics[0]!.message).toContain('foo-bar.ts');
  expect(graph.diagnostics[0]!.message).toContain('foo_bar.ts');
  expect(graph.diagnostics[1]).toMatchObject({
    message: expect.stringMatching(/processLifetime/u),
    sourcePath: join(root, 'src/providers/process-lifetime.ts'),
  });
});

it('discovers the canonical event families and validates their component contract', async () => {
  const root = await createRoot();
  const eventSource = 'export default async function EventRoute() { return undefined; }\n';
  await writeTree(root, {
    'src/events/agent/start.tsx': eventSource,
    'src/events/agent/stop.tsx': eventSource,
    'src/events/compact/after.tsx': eventSource,
    'src/events/compact/before.tsx': eventSource,
    'src/events/message/receive.tsx': eventSource,
    'src/events/prompt/submit.tsx': eventSource,
    'src/events/session/end.tsx': eventSource,
    'src/events/session/start.tsx': eventSource,
    'src/events/stop.tsx': eventSource,
    'src/events/tool/after.tsx': eventSource,
    'src/events/tool/before.tsx': 'export default function BeforeTool() { return undefined; }\n',
    'src/events/tool/failure.tsx': eventSource,
    'src/events/workspace/open.tsx': eventSource,
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.events.map((route) => route.id)).toEqual([
    'event:agent/start',
    'event:agent/stop',
    'event:compact/after',
    'event:compact/before',
    'event:prompt/submit',
    'event:session/end',
    'event:session/start',
    'event:stop',
    'event:tool/after',
    'event:tool/before',
    'event:tool/failure',
    'event:workspace/open',
  ]);
  expect(graph.events.map((route) => route.event)).toEqual([
    'agent/start',
    'agent/stop',
    'compact/after',
    'compact/before',
    'prompt/submit',
    'session/end',
    'session/start',
    'stop',
    'tool/after',
    'tool/before',
    'tool/failure',
    'workspace/open',
  ]);
  expect(graph.diagnostics.map(({ code }) => code)).toEqual(['AB4823', 'AB4810']);
  expect(graph.diagnostics[0]?.sourcePath).toBe(join(root, 'src/events/message/receive.tsx'));
  expect(graph.diagnostics[1]?.sourcePath).toBe(join(root, 'src/events/tool/before.tsx'));
});

it('fails unavailable event routes before packaging while admitting supported targets', async () => {
  const eventSource = 'export default async function WorkspaceOpen() { return undefined; }\n';
  const configSource = [
    'export default {',
    "  plugin: { name: 'event-capability-fixture', version: '1.0.0' },",
    "  targets: ['claude', 'cursor'],",
    '};',
    '',
  ].join('\n');
  const unrestrictedRoot = await createRoot();
  await writeTree(unrestrictedRoot, {
    'agent-bundle.config.ts': configSource,
    'package.json': '{"type":"module"}\n',
    'src/events/workspace/open.tsx': eventSource,
  });

  const unrestricted = await inspect({ root: unrestrictedRoot });
  expect(unrestricted.state).toBe('invalid');
  expect(unrestricted.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4824',
    target: 'claude',
  }));
  expect(unrestricted.diagnostics).not.toContainEqual(expect.objectContaining({
    code: 'AB4824',
    target: 'cursor',
  }));

  const restrictedRoot = await createRoot();
  await writeTree(restrictedRoot, {
    'agent-bundle.config.ts': configSource,
    'package.json': '{"type":"module"}\n',
    'src/events/workspace/open.tsx': [
      "export const config = { runtime: 'standalone', targets: ['cursor'] };",
      eventSource,
    ].join('\n'),
  });

  const restricted = await inspect({ root: restrictedRoot });
  expect(restricted.state).toBe('ready');
  expect(restricted.diagnostics).toEqual([]);
});

it('rejects malformed event route targets with AB4825', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'event-targets-fixture', version: '1.0.0' },",
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    'src/events/session/start.tsx': [
      "export const config = { targets: [] };",
      'export default async function SessionStart() { return undefined; }',
      '',
    ].join('\n'),
  });

  const result = await inspect({ root });
  expect(result.state).toBe('invalid');
  expect(result.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4825',
    sourcePath: join(root, 'src/events/session/start.tsx'),
  }));
});

it('preserves sub-second event route timeout precision in the normalized model', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'event-timeout-fixture', version: '1.0.0' },",
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    'src/events/session/start.tsx': [
      "export const config = { runtime: 'standalone', timeoutMs: 1250 };",
      'export default async function SessionStart() { return undefined; }',
      '',
    ].join('\n'),
  });

  const result = await validate({ root });
  expect(result.diagnostics).toEqual([]);
  expect(result.model?.hooks).toContainEqual(expect.objectContaining({
    eventRoute: expect.objectContaining({ event: 'session/start' }),
    timeoutMs: 1_250,
  }));
});

it('requires an explicit standalone mode when no generated runtime can host an event route', async () => {
  const root = await createRoot();
  await writeTree(root, {
    'agent-bundle.config.ts': [
      'export default {',
      "  plugin: { name: 'event-runtime-fixture', version: '1.0.0' },",
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n'),
    'package.json': '{"type":"module"}\n',
    'src/events/session/start.tsx': 'export default async function SessionStart() { return undefined; }\n',
  });

  const inspected = await inspect({ root });
  expect(inspected.state).toBe('invalid');
  expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4817',
    target: 'cursor',
  }));
});
