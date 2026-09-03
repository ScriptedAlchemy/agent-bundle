import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { inspect, type ReadyInspectResult, validate } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
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
      "    tool: './src/scripts/render-tool.tsx',",
      '  },',
      "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
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
    // Component only: the bin envelope would call it as main(argv).
    'src/scripts/render-poster.tsx': 'export default async () => undefined;\n',
    // main only: the bin works, but the rendered script has no component to render.
    'src/scripts/render-tool.tsx': 'export const main = async (argv: readonly string[]): Promise<number> => argv.length;\n',
  });

  const result = await validate({ root: project });
  const gate = result.diagnostics.filter(({ code }) => code === 'AB4737');
  expect(gate.map((diagnostic) => diagnostic.sourcePath)).toEqual([
    join(project, 'src/scripts/render-object.tsx'),
    join(project, 'src/scripts/render-poster.tsx'),
    join(project, 'src/scripts/render-tool.tsx'),
  ]);
  expect(gate[0]!.message).toContain('render-object.tsx is also the entry of bin "object" but exports no async default Server Component');
  expect(gate[1]!.message).toContain('render-poster.tsx is also the entry of bin "poster" but exports no named main');
  expect(gate[2]!.message).toContain('render-tool.tsx is also the entry of bin "tool" but exports no async default Server Component');
  expect(gate.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  // Every rendered script stays discovered beside its bin: the gate names
  // the conflict instead of dropping a route.
  const graph = await compileRouteGraph(project, fixtureConfig({
    bin: {
      notes: './src/scripts/render-notes.tsx',
      object: './src/scripts/render-object.tsx',
      poster: './src/scripts/render-poster.tsx',
      tool: './src/scripts/render-tool.tsx',
    },
  }));
  expect(graph.scripts.map((route) => route.id)).toEqual([
    'script:render-notes',
    'script:render-object',
    'script:render-poster',
    'script:render-tool',
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
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const root = await createInspectProject({
    'src/mcp/curator/tools/inspect.ts': moduleSource,
  });
  const stdout: string[] = [];
  const code = await runCli(['inspect', '--root', root, '--routes', '--json'], {
    stderr: { write: () => undefined },
    stdout: { write: (chunk: string) => stdout.push(chunk) },
  });
  expect(code).toBe(0);
  const document = JSON.parse(stdout.join('')) as ReadyInspectResult;
  expect(document.selected?.routes?.servers?.[0]).toMatchObject({ id: 'mcp:curator', mode: 'generated' });

  const stderr: string[] = [];
  const ambiguous = await runCli(['inspect', '--root', root, '--routes', '--skills'], {
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    stdout: { write: () => undefined },
  });
  expect(ambiguous).toBe(1);
  expect(stderr.join('')).toContain('Choose at most one inspect focus.');
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
  // A provider-free graph declares no provider surface and never augments the runtime.
  expect(first).not.toContain('AgentBundleProviders');
  expect(first).not.toContain("declare module '@agent-bundle/runtime'");
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
  expect(first).toContain("declare module '@agent-bundle/runtime' {\n  interface AgentProviderValues {\n    readonly \"projectAuth\": ProviderValueOf<typeof provider0.default>;\n    readonly \"zeta\": ProviderValueOf<typeof provider1.default>;\n  }\n}");
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
    'assertions.ts': [
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
      '',
    ].join('\n'),
  });

  const program = ts.createProgram([join(root, 'assertions.ts')], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
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
