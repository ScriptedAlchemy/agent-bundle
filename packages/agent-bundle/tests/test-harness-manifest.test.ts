import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { routeTestSetupSource } from '../src/rstest/setup-module.ts';
import { AgentTestError } from '../src/test/errors.ts';
import { compileTestManifest, testManifestFromRouteGraph } from '../src/test/manifest.ts';
import { AGENT_TEST_REGISTRY_VERSION, registerTestRoutes } from '../src/test/registry.ts';
import { renderRoute } from '../src/test/render.ts';
import { expectDocument } from '../src/test/matchers.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import type { AgentBundleTestManifest } from '../src/test/manifest.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/route-harness');

const manifest = await compileTestManifest({ root: fixtureRoot });

describe('the compiled test manifest', () => {
  it('names every conventional route the compiler discovered, with its extracted config', () => {
    expect(Object.keys(manifest.routes).sort()).toEqual([
      'app:harness/panel',
      'event:tool/after',
      'resource:harness/notes',
      'tool:harness/echo',
      'tool:harness/unavailable',
    ]);
    expect(manifest.diagnostics).toEqual([]);
    expect(manifest.routes['tool:harness/echo']).toEqual({
      config: {
        description: 'Echoes one message back with the observed workspace root.',
        title: 'Echo',
      },
      id: 'tool:harness/echo',
      kind: 'tool',
      relativePath: 'src/mcp/harness/tools/echo.tsx',
      serverId: 'mcp:harness',
      source: resolve(fixtureRoot, 'src/mcp/harness/tools/echo.tsx'),
    });
    expect(manifest.proofLevel).toBe('route-unit');
    expect(manifest.projectRoot).toBe(fixtureRoot);
    expect(manifest.targets).toEqual(['claude']);
  });

  it('reuses the compiler pass rather than compiling a second route graph', async () => {
    const graph = await compileRouteGraph(fixtureRoot, { targets: ['claude'] } as never);

    expect(manifest.digest).toBe(graph.digest);
  });

  it('projects an already-compiled graph without touching the filesystem again', async () => {
    const graph = await compileRouteGraph(fixtureRoot, { targets: ['claude'] } as never);
    const projected = testManifestFromRouteGraph({ graph, projectRoot: fixtureRoot, targets: ['claude'] });

    expect(projected.routes).toEqual(manifest.routes);
    expect(Object.isFrozen(projected.routes)).toBe(true);
  });
});

describe('the generated route registry', () => {
  const source = routeTestSetupSource(manifest);

  it('registers the renderable routes and leaves browser and resource surfaces out of the Node bundle', () => {
    const loaders = /loaders: \{\n(?<body>[\s\S]*?)\n {2}\},/u.exec(source)?.groups?.body ?? '';

    expect(loaders).toContain('"event:tool/after": () => import(');
    expect(loaders).toContain('"tool:harness/echo": () => import(');
    expect(loaders).toContain('"tool:harness/unavailable": () => import(');
    expect(loaders).not.toContain('app:harness/panel');
    expect(loaders).toContain('"resource:harness/notes": () => import(');
    // The manifest still inventories every compiled route; only the loaders,
    // which decide what enters the Node test bundle, are filtered.
    expect(source).toContain('app:harness/panel');
  });

  it('carries the manifest and the registry version the helpers require', () => {
    expect(source).toContain(`version: ${String(AGENT_TEST_REGISTRY_VERSION)}`);
    expect(source).toContain('globalThis[Symbol.for("agent-bundle/test-route-registry")]');
    expect(JSON.parse(/manifest: JSON\.parse\((".*?")\),/u.exec(source)![1]!) as string)
      .toBe(JSON.stringify(manifest));
  });

  it('refuses a registry written by a different agent-bundle version', () => {
    expect(() => registerTestRoutes({ loaders: {}, manifest, version: 99 }))
      .toThrow('Incompatible Agent Bundle test registry version');
  });
});

describe('route-unit failure diagnostics', () => {
  it('names the route, the compiled inventory, and the recovery when no route matches', async () => {
    const error = await renderRoute('tool:harness/missing', { manifest }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('route-not-found');
    expect((error as AgentTestError).message).toContain('tool:harness/echo');
    expect((error as AgentTestError).message).toContain('recovery:');
  });

  it('refuses a browser App surface by naming the proof level that owns it', async () => {
    const error = await renderRoute('app:harness/panel', { manifest }).catch((thrown: unknown) => thrown);

    expect((error as AgentTestError).code).toBe('unsupported-route-kind');
    expect((error as AgentTestError).message).toContain('browser proof level');
  });

  it('names the route and the wiring step when no module loader is registered', async () => {
    const error = await renderRoute('tool:harness/echo', { manifest }).catch((thrown: unknown) => thrown);

    expect((error as AgentTestError).code).toBe('manifest-unavailable');
    expect((error as AgentTestError).message).toContain('agentBundleRstest()');
    expect((error as AgentTestError).message).toContain('src/mcp/harness/tools/echo.tsx');
    expect((error as AgentTestError).message).toContain('route-unit');
  });

  it('reports the unregistered manifest instead of pretending the project has no routes', async () => {
    await expect(renderRoute('tool:harness/echo')).rejects.toThrow('No Agent Bundle test manifest is registered');
  });
});

describe('document matchers', () => {
  const document = Object.freeze({
    root: Object.freeze({
      children: Object.freeze([
        Object.freeze({ kind: 'markdown', text: '# Inventory\n\n2 files' }),
        Object.freeze({ kind: 'text', text: 'workspace: /tmp/library' }),
      ]),
      kind: 'result',
    }),
    status: 'success',
    value: { files: 2 },
    version: 1,
  }) as never;

  it('accepts a document that satisfies every assertion', () => {
    expectDocument(document)
      .toHaveStatus('success')
      .toContainMarkdown('2 files')
      .toContainText('/tmp/library')
      .toHaveValue({ files: 2 })
      .toHaveNodeKinds(['result', 'markdown', 'text']);
  });

  it('reports the expected and received value with the route provenance', () => {
    const rendered = {
      document,
      provenance: {
        kind: 'tool',
        manifestDigest: manifest.digest,
        projectRoot: fixtureRoot,
        proofLevel: 'route-unit',
        relativePath: 'src/mcp/harness/tools/echo.tsx',
        routeId: 'tool:harness/echo',
        serverId: 'mcp:harness',
        source: 'manifest',
        targets: ['claude'],
      },
    } as never;
    const error = (() => {
      try {
        expectDocument(rendered).toHaveValue({ files: 3 });
        return undefined;
      } catch (thrown: unknown) {
        return thrown as AgentTestError;
      }
    })();

    expect(error?.code).toBe('assertion-failed');
    expect(error?.message).toContain('route:        tool:harness/echo (tool)');
    expect(error?.message).toContain('server:       mcp:harness');
    expect(error?.message).toContain('src/mcp/harness/tools/echo.tsx');
    expect(error?.message).toContain('targets:      claude');
    expect(error?.message).toContain('{"files":3}');
    expect(error?.message).toContain('{"files":2}');
  });

  it('fails an unmet status, Markdown, text, and error assertion', () => {
    expect(() => expectDocument(document).toHaveStatus('failed')).toThrow('unexpected status');
    expect(() => expectDocument(document).toContainMarkdown('missing')).toThrow('no Markdown node');
    expect(() => expectDocument(document).toContainText('missing')).toThrow('no text node');
    expect(() => expectDocument(document).toHaveError()).toThrow('no matching error');
    expect(() => expectDocument(document).toHaveNodeKinds(['result'])).toThrow('node kinds differ');
  });
});

describe('the manifest a route-free project compiles', () => {
  it('reports no routes and no proof beyond the route-unit level', async () => {
    const empty: AgentBundleTestManifest = await compileTestManifest({
      root: resolve(import.meta.dirname, '../../../fixtures/integration/skills-only'),
    });

    expect(empty.routes).toEqual({});
    expect(empty.proofLevel).toBe('route-unit');
    expect(empty.targets).toEqual(['portable']);
  });
});

describe('the harness package boundary', () => {
  const packageRoot = resolve(import.meta.dirname, '..');

  it('publishes both harness subpaths', async () => {
    const declared = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Readonly<Record<string, string>>;
      peerDependencies: Readonly<Record<string, string>>;
      exports: Readonly<Record<string, { import: string; types: string }>>;
      peerDependenciesMeta: Readonly<Record<string, { optional: boolean }>>;
    };

    expect(declared.exports['./rstest']).toEqual({ import: './dist/rstest.js', types: './dist/rstest/index.d.ts' });
    expect(declared.exports['./test']).toEqual({ import: './dist/test.js', types: './dist/test/index.d.ts' });
    // Declaring the three as optional peers is also what keeps them external in
    // the published bundle: vendoring the Flight server would ship a second
    // React server copy whose RSC manifest is not the consumer project's.
    for (const peer of ['@agent-bundle/runtime', '@rstest/core', 'react']) {
      expect(declared.peerDependenciesMeta[peer]).toEqual({ optional: true });
      expect(declared.dependencies).not.toHaveProperty(peer);
    }

    // npm refuses to install a tarball whose manifest carries a `workspace:`
    // range, even for an optional peer.
    for (const [peer, range] of Object.entries(declared.peerDependencies)) {
      expect(range, peer).not.toContain('workspace:');
    }
  });

  it('keeps every optional peer out of the harness modules at value level', async () => {
    const sources = await Promise.all(
      ['src/rstest/index.ts', 'src/rstest/setup-module.ts', 'src/test/index.ts', 'src/test/manifest.ts', 'src/test/matchers.ts', 'src/test/registry.ts', 'src/test/render.ts', 'src/test/types.ts', 'src/test/errors.ts']
        .map(async (relativePath) => [relativePath, await readFile(resolve(packageRoot, relativePath), 'utf8')] as const),
    );

    const optionalPeers = ['@agent-bundle/runtime', '@agent-bundle/runtime/flight/server', '@rstest/core', 'react'];
    for (const [relativePath, text] of sources) {
      for (const statement of text.matchAll(/^import (?<kind>type )?[^;]*?from '(?<specifier>[^']+)';$/gmu)) {
        if (statement.groups?.kind !== undefined) continue;
        expect(optionalPeers, `${relativePath} imports it at value level`).not.toContain(statement.groups!.specifier);
      }
    }

    // The renderer reaches the runtime through `await import(...)` instead, so
    // the value only loads inside a route-unit test that actually renders.
    const render = sources.find(([relativePath]) => relativePath === 'src/test/render.ts')![1];
    expect(render).toContain("import type * as AgentRuntime from '@agent-bundle/runtime';");
    expect(render).toContain("import('@agent-bundle/runtime'),");
  });
});
