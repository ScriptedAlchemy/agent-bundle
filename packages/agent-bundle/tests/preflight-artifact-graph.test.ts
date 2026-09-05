import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import { init, parse } from 'es-module-lexer';

import { build, type BuildProjectResult } from '../src/api.ts';
import { parseArtifactManifest } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import { isRelativeSpecifier, moduleCandidates, readModuleFromDisk } from '../src/routes/module-candidates.ts';
import { runNodeScript } from './support/run-node-script.ts';

/**
 * #595's emitted-graph proof, pre-staged at the built-artifact level: the
 * public hook entry a host invokes (`hooks/hooks.json` → `hooks/<name>.mjs`)
 * must be physically cheap — its static module graph carries the preflight
 * leaf and none of the rendered route, layouts, application providers, React,
 * or the RSC renderer — while everything execution needs lives behind a
 * deferred edge (a literal `import('./x.mjs')` or a sibling
 * `new URL('./x.mjs', import.meta.url)`) in modules that stay self-contained
 * (the AB6005 rule: Node built-ins and in-artifact relative imports only).
 *
 * Runs a real Rslib build, so it belongs in `integrationTestFiles`.
 */

const sentinels = Object.freeze({
  layout: 'sentinel:layout:root:9d0f52',
  preflightLeaf: 'sentinel:preflight-leaf:7f3a9c',
  provider: 'sentinel:provider:daemon-probe:c41d07',
  renderedRoute: 'sentinel:rendered-route:2b8e41',
});

/** Byte-level evidence of React itself and of the RSC renderer/client. */
const reactMarker = /Symbol\.for\(["']react\./u;
const rscMarkers = [/react-server-dom/u, /renderToReadableStream|renderToPipeableStream|renderAgentFlight/u, /createAgentRenderDispatcher/u];

const projectFiles: Readonly<Record<string, string>> = {
  'agent-bundle.config.ts': [
    "import { defineConfig } from 'agent-bundle/config';",
    'export default defineConfig({',
    "  plugin: { description: 'Preflight graph fixture.', name: 'preflight-graph-fixture', version: '1.0.0' },",
    "  targets: ['claude'],",
    '});',
    '',
  ].join('\n'),
  'package.json': JSON.stringify({
    dependencies: { '@agent-bundle/runtime': 'workspace:*', react: '19.2.8', zod: '4.4.3' },
    name: 'preflight-graph-fixture',
    type: 'module',
    version: '1.0.0',
  }),
  // The cheap leaf: one relative helper, no React, no runtime, no providers.
  'src/cheap/tokens.ts': [
    `export const PREFLIGHT_LEAF_SENTINEL = ${JSON.stringify(sentinels.preflightLeaf)};`,
    'export const mentionsCargo = (command: string): boolean => /\\b(?:cargo|hauler)\\b/u.test(command);',
    '',
  ].join('\n'),
  'src/events/tool/before.preflight.ts': [
    "import { PREFLIGHT_LEAF_SENTINEL, mentionsCargo } from '../../cheap/tokens.js';",
    'export default ({ canonical }: { readonly canonical: { readonly payload?: Record<string, unknown> } }) => {',
    "  const tool = canonical.payload?.['toolInput'] as { readonly value?: { readonly command?: unknown } } | undefined;",
    "  const command = typeof tool?.value?.command === 'string' ? tool.value.command : '';",
    "  if (mentionsCargo(command)) return 'execute';",
    "  return command === 'blocked' ? { outcome: 'deny', reason: PREFLIGHT_LEAF_SENTINEL } : { outcome: 'continue' };",
    '};',
    '',
  ].join('\n'),
  // The rendered route: standalone so the whole execution path is inside the
  // artifact, with a declared provider and a deliberately heavy import graph.
  'src/events/tool/before.tsx': [
    "import { Agent } from '@agent-bundle/runtime';",
    "import { RENDERED_ROUTE_SENTINEL } from '../../heavy/rendered-route.js';",
    "export { default as preflight } from './before.preflight.js';",
    "export const config = { providers: ['daemonProbe'], runtime: 'standalone' };",
    'export default async function ToolBefore({ canonical }) {',
    "  return <Agent.Result value={{ outcome: 'deny', reason: RENDERED_ROUTE_SENTINEL }}><Agent.Context>{canonical.event}</Agent.Context></Agent.Result>;",
    '}',
    '',
  ].join('\n'),
  'src/heavy/rendered-route.ts': `export const RENDERED_ROUTE_SENTINEL = ${JSON.stringify(sentinels.renderedRoute)};\n`,
  'src/layout.tsx': [
    "import { Agent } from '@agent-bundle/runtime';",
    `const LAYOUT_SENTINEL = ${JSON.stringify(sentinels.layout)};`,
    'export default async function Layout({ children }) {',
    '  return <Agent.Result metadata={{ sentinel: LAYOUT_SENTINEL }}>{children}</Agent.Result>;',
    '}',
    '',
  ].join('\n'),
  'src/providers/daemon-probe.ts': [
    "import { createElement } from 'react';",
    `const PROVIDER_SENTINEL = ${JSON.stringify(sentinels.provider)};`,
    'export default async function daemonProbe() {',
    '  return { element: typeof createElement, sentinel: PROVIDER_SENTINEL };',
    '}',
    '',
  ].join('\n'),
};

const heavySources = ['src/events/tool/before.tsx', 'src/heavy/rendered-route.ts', 'src/layout.tsx', 'src/providers/daemon-probe.ts'];

const toPosix = (path: string): string => path.replaceAll('\\', '/');

/** One emitted module's edges, read the way AB6005 reads them (es-module-lexer). */
interface EmittedModule {
  readonly bare: readonly string[];
  readonly bytes: string;
  /** Literal dynamic imports and sibling `new URL('./x.mjs', import.meta.url)` references, artifact-relative. */
  readonly deferred: readonly string[];
  readonly nonLiteralDynamic: number;
  readonly path: string;
  readonly statics: readonly string[];
}

const siblingUrlReference = /new URL\(\s*(?:\/\*[^*]*\*\/\s*)?["'](\.\.?\/[^"']+\.mjs)["']\s*,\s*import\.meta\.url\s*\)/gu;

const importKind = (d: number): 'dynamic' | 'meta' | 'static' => {
  if (d === -2) return 'meta';
  if (d === -1) return 'static';
  return 'dynamic';
};

const readEmittedModule = async (artifactRoot: string, path: string): Promise<EmittedModule> => {
  const bytes = await readFile(join(artifactRoot, path), 'utf8');
  const imports = parse(bytes)[0].map((record) => ({ kind: importKind(record.d), specifier: record.n }));
  const statics: string[] = [];
  const deferred: string[] = [];
  const bare: string[] = [];
  let nonLiteralDynamic = 0;
  const resolveInArtifact = (specifier: string): string | undefined => {
    if (!specifier.startsWith('.') && !specifier.startsWith('file:')) return undefined;
    const url = new URL(specifier, pathToFileURL(join(artifactRoot, path)));
    const target = toPosix(relative(artifactRoot, fileURLToPath(url)));
    return target.startsWith('../') ? undefined : target;
  };
  for (const imported of imports) {
    if (imported.kind === 'meta') continue;
    if (imported.specifier === undefined) {
      nonLiteralDynamic += 1;
      continue;
    }
    if (isBuiltin(imported.specifier)) continue;
    const target = resolveInArtifact(imported.specifier);
    if (target === undefined) {
      bare.push(imported.specifier);
      continue;
    }
    (imported.kind === 'static' ? statics : deferred).push(target);
  }
  for (const match of bytes.matchAll(siblingUrlReference)) {
    const target = resolveInArtifact(match[1]!);
    if (target !== undefined) deferred.push(target);
  }
  return Object.freeze({ bare, bytes, deferred: Object.freeze([...new Set(deferred)]), nonLiteralDynamic, path, statics: Object.freeze([...new Set(statics)]) });
};

/** Transitive closure over the chosen edge kinds, in first-seen order. */
const closure = async (
  artifactRoot: string,
  roots: readonly string[],
  edges: (module: EmittedModule) => readonly string[],
  cache: Map<string, EmittedModule>,
): Promise<readonly EmittedModule[]> => {
  const seen = new Set<string>();
  const ordered: EmittedModule[] = [];
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const module = cache.get(path) ?? await readEmittedModule(artifactRoot, path);
    cache.set(path, module);
    ordered.push(module);
    pending.push(...edges(module));
  }
  return Object.freeze(ordered);
};

const concatenated = (modules: readonly EmittedModule[]): string => modules.map((module) => module.bytes).join('\n');

/** The project-source closure of one module through relative imports, as the route-graph scans resolve them. */
const sourceClosure = (entry: string): readonly string[] => {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.shift()!;
    if (seen.has(path)) continue;
    const text = readModuleFromDisk(path);
    if (text === undefined) continue;
    seen.add(path);
    for (const match of text.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/gu)) {
      const specifier = match[1] ?? match[2]!;
      if (!isRelativeSpecifier(specifier)) continue;
      const candidate = moduleCandidates(dirname(path), specifier).find((file) => readModuleFromDisk(file) !== undefined);
      if (candidate !== undefined) pending.push(candidate);
    }
  }
  return Object.freeze([...seen]);
};

const bareSourceImports = (paths: readonly string[]): readonly string[] => paths.flatMap((path) =>
  [...(readModuleFromDisk(path) ?? '').matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/gu)]
    .map((match) => match[1] ?? match[2]!)
    .filter((specifier) => !isRelativeSpecifier(specifier)));

describe('preflight artifact graph (#595)', () => {
  let root: string;
  let output: string;
  let result: BuildProjectResult;
  /** The public entry, artifact-relative, and the root the artifact's relative imports resolve against. */
  let artifactRoot: string;
  let entryPath: string;
  let entryGraph: readonly EmittedModule[];
  let deferredGraph: readonly EmittedModule[];
  const cache = new Map<string, EmittedModule>();

  beforeAll(async () => {
    await init;
    root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-preflight-graph-')));
    // The audiobook example's installed tree supplies @agent-bundle/runtime, react, and zod.
    await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const [path, contents] of Object.entries(projectFiles)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    output = join(root, 'artifact');
    result = await build({ output, root });
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);

    const compiled = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:tool-before' && hook.target === 'claude');
    if (compiled === undefined) throw new Error('The tool/before event route compiled no Claude hook entry.');
    // The wrapper lives at `<artifact root>/hooks/<name>.mjs` on either side of #578.
    artifactRoot = dirname(dirname(compiled.output));
    entryPath = toPosix(relative(artifactRoot, compiled.output));

    entryGraph = await closure(artifactRoot, [entryPath], (module) => module.statics, cache);
    const entryPaths = new Set(entryGraph.map((module) => module.path));
    const deferredRoots = [...new Set(entryGraph.flatMap((module) => module.deferred))].filter((path) => !entryPaths.has(path));
    deferredGraph = (await closure(artifactRoot, deferredRoots, (module) => [...module.statics, ...module.deferred], cache))
      .filter((module) => !entryPaths.has(module.path));
  }, 240_000);

  afterAll(async () => {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
  });

  it('attaches the preflight leaf to the event route node, and the leaf\'s source graph is cheap by construction', async () => {
    const graph = await compileRouteGraph(root, { plugin: { name: 'preflight-graph-fixture', version: '1.0.0' } });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.events.map((route) => route.id)).toEqual(['event:tool/before']);
    expect(graph.events[0]!.preflight).toEqual({
      provenance: { kind: 'conventional', relativePath: 'src/events/tool/before.preflight.ts' },
      source: join(root, 'src/events/tool/before.preflight.ts'),
    });
    expect(graph.events[0]!.config).toMatchObject({ providers: ['daemonProbe'], runtime: 'standalone' });
    expect(graph.providers.map((provider) => provider.name)).toEqual(['daemon-probe']);
    expect(graph.layouts?.map((layout) => layout.id)).toEqual(['layout:root']);

    // The gate's own graph: the leaf plus one helper, no bare imports at all,
    // and none of the modules the rendered route reaches.
    const leaf = sourceClosure(graph.events[0]!.preflight!.source).map((path) => toPosix(relative(root, path))).sort();
    expect(leaf).toEqual(['src/cheap/tokens.ts', 'src/events/tool/before.preflight.ts']);
    expect(bareSourceImports(leaf.map((path) => join(root, path)))).toEqual([]);
    expect(leaf.filter((path) => heavySources.includes(path))).toEqual([]);
  });

  it('emits the entry the Claude hook document invokes, indexed once, in an AB6005-clean artifact', async () => {
    const compiled = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:tool-before')!;
    const index = JSON.parse(await readFile(join(output, 'agent-bundle.hooks.json'), 'utf8')) as { hooks: { id: string; path: string; target: string }[] };
    const indexed = index.hooks.filter((hook) => hook.id === 'hook:event-route:tool-before');
    expect(indexed).toHaveLength(1);
    expect(join(output, indexed[0]!.path)).toBe(compiled.output);

    const document = JSON.parse(await readFile(join(artifactRoot, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const commands = Object.values(document.hooks).flat().flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands).toEqual([`node "\${CLAUDE_PLUGIN_ROOT}/${entryPath}"`]);

    const manifest = parseArtifactManifest(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'));
    const bundled = manifest.files.filter((file) => file.kind === 'bundle').map((file) => join(output, file.path));
    expect(bundled).toContain(compiled.output);
    // Every module of both graphs is a compiler-emitted bundle the manifest lists.
    for (const module of [...entryGraph, ...deferredGraph]) {
      expect(bundled, `${module.path} is not a manifest bundle`).toContain(join(artifactRoot, module.path));
    }
    const diagnostics = await validateArtifact({ artifactRoot: output });
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'AB6005' || diagnostic.severity === 'error')).toEqual([]);
  });

  it('runs continue, deny, and deferred execute outcomes through the published hook process', async () => {
    const invoke = (command: string) => runNodeScript({
      args: [join(artifactRoot, entryPath)],
      input: JSON.stringify({
        cwd: root,
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        tool_input: { command },
        tool_name: 'Bash',
        tool_use_id: 'use-1',
        transcript_path: join(root, 'transcript.json'),
      }),
    });

    await expect(invoke('echo hello')).resolves.toEqual({ code: 0, stderr: '', stdout: '' });
    const denied = await invoke('blocked');
    expect(denied.code).toBe(0);
    expect(denied.stderr).toBe('');
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: sentinels.preflightLeaf,
      },
    });
    const executed = await invoke('cargo check');
    expect(executed.code).toBe(0);
    expect(executed.stderr).toBe('');
    expect(JSON.parse(executed.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: sentinels.renderedRoute,
      },
    });
  });

  it('carries the preflight leaf in the public entry\'s static graph and names it among the entry\'s source inputs', () => {
    const bytes = concatenated(entryGraph);
    expect(bytes).toContain(sentinels.preflightLeaf);
    const compiled = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:tool-before')!;
    expect(compiled.sourceInputs).toEqual(expect.arrayContaining([
      join(root, 'src/events/tool/before.preflight.ts'),
      join(root, 'src/cheap/tokens.ts'),
    ]));
  });

  it('keeps the rendered route, the layout, and application providers out of the public entry\'s static graph', () => {
    const bytes = concatenated(entryGraph);
    expect(bytes).not.toContain(sentinels.renderedRoute);
    expect(bytes).not.toContain(sentinels.layout);
    expect(bytes).not.toContain(sentinels.provider);
    // No project source of the heavy side reaches the entry by path either.
    for (const source of heavySources) expect(bytes).not.toContain(join(root, source));
  });

  it('keeps React and the RSC renderer/client out of the public entry\'s static graph', () => {
    const bytes = concatenated(entryGraph);
    expect(bytes).not.toMatch(reactMarker);
    for (const marker of rscMarkers) expect(bytes, `entry graph matches ${String(marker)}`).not.toMatch(marker);
  });

  it('reaches execution only through a deferred edge whose artifact includes the route, providers, React, and the RSC renderer, and stays self-contained', () => {
    expect(deferredGraph.length).toBeGreaterThan(0);
    const entryPaths = new Set(entryGraph.map((module) => module.path));
    expect(deferredGraph.filter((module) => entryPaths.has(module.path))).toEqual([]);
    // The compiler's own report of the execution side must sit behind the boundary too.
    const compiled = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:tool-before')!;
    if (compiled.workerOutput !== undefined) {
      const workerPath = toPosix(relative(artifactRoot, compiled.workerOutput));
      expect(entryPaths.has(workerPath)).toBe(false);
      expect(deferredGraph.map((module) => module.path)).toContain(workerPath);
    }

    const bytes = concatenated(deferredGraph);
    expect(bytes).toContain(sentinels.renderedRoute);
    expect(bytes).toContain(sentinels.provider);
    expect(bytes).toMatch(reactMarker);
    expect(bytes).toMatch(/renderToReadableStream|renderToPipeableStream|renderAgentFlight/u);
    // Event routes compose no layout (`layoutChainFor`), so the layout is only
    // ever asserted absent from the entry, never present in the worker.

    // Self-contained on both sides of the boundary: Node built-ins and
    // in-artifact relative imports only, every dynamic import literal.
    for (const module of [...entryGraph, ...deferredGraph]) {
      expect(module.bare, `${module.path} imports bare specifiers`).toEqual([]);
      expect(module.nonLiteralDynamic, `${module.path} has non-literal dynamic imports`).toBe(0);
    }
  });
});
