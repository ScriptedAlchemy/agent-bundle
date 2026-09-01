import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { inspect, type ReadyInspectResult } from '../src/api.ts';
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
    'skills/review/SKILL.md': '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
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

it('discovers only the seven v1 event families and validates their component contract', async () => {
  const root = await createRoot();
  const eventSource = 'export default async function EventRoute() { return undefined; }\n';
  await writeTree(root, {
    'src/events/agent/start.tsx': eventSource,
    'src/events/agent/stop.tsx': eventSource,
    'src/events/prompt/submit.tsx': eventSource,
    'src/events/session/start.tsx': eventSource,
    'src/events/stop.tsx': eventSource,
    'src/events/tool/after.tsx': eventSource,
    'src/events/tool/before.tsx': 'export default function BeforeTool() { return undefined; }\n',
    'src/events/workspace/open.tsx': eventSource,
  });

  const graph = await compileRouteGraph(root, fixtureConfig());

  expect(graph.events.map((route) => route.id)).toEqual([
    'event:agent/start',
    'event:agent/stop',
    'event:session/start',
    'event:stop',
    'event:tool/after',
    'event:tool/before',
    'event:workspace/open',
  ]);
  expect(graph.events.map((route) => route.event)).toEqual([
    'agent/start',
    'agent/stop',
    'session/start',
    'stop',
    'tool/after',
    'tool/before',
    'workspace/open',
  ]);
  expect(graph.diagnostics.map(({ code }) => code)).toEqual(['AB4813', 'AB4810']);
  expect(graph.diagnostics[0]?.sourcePath).toBe(join(root, 'src/events/prompt/submit.tsx'));
  expect(graph.diagnostics[1]?.sourcePath).toBe(join(root, 'src/events/tool/before.tsx'));
});

it('fails unavailable event routes before packaging unless they are target-restricted', async () => {
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
    code: 'AB4814',
    target: 'claude',
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
    'src/events/workspace/open.tsx': 'export default async function WorkspaceOpen() { return undefined; }\n',
  });

  const inspected = await inspect({ root });
  expect(inspected.state).toBe('invalid');
  expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
    code: 'AB4816',
    target: 'cursor',
  }));
});
