import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { routeTestSetupSource } from '../src/rstest/setup-module.ts';
import { BROWSER_APP_PROOF_LEVEL_LABEL } from '../src/test/browser-registry.ts';
import { AgentTestError } from '../src/test/errors.ts';
import { invokeCli } from '../src/test/cli.ts';
import { compileTestManifest, proofLevelLabel, testManifestFromRouteGraph } from '../src/test/manifest.ts';
import {
  AGENT_TEST_REGISTRY_SYMBOL_KEY,
  AGENT_TEST_REGISTRY_VERSION,
  registerTestRoutes,
  testManifest,
} from '../src/test/registry.ts';
import { renderRoute } from '../src/test/render.ts';
import { expectDocument } from '../src/test/matchers.ts';
import { expectEvents } from '../src/test/events.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import type { AgentBundleTestManifest } from '../src/test/manifest.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/route-harness');

const manifest = await compileTestManifest({ root: fixtureRoot });

const registrySymbol = Symbol.for(AGENT_TEST_REGISTRY_SYMBOL_KEY);
const realm = globalThis as Record<symbol, unknown>;

/** Installs a registry the way the generated setup module does: straight onto the realm global. */
const withRealmRegistry = async <T>(registry: unknown, body: () => T | Promise<T>): Promise<T> => {
  const previous = realm[registrySymbol];
  realm[registrySymbol] = registry;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete realm[registrySymbol];
    else realm[registrySymbol] = previous;
  }
};

describe('the compiled test manifest', () => {
  it('names packed-deleted-source as verified self-contained artifact evidence', () => {
    expect(proofLevelLabel('packed-deleted-source')).toBe(
      'packed-deleted-source (packed tarball installed into a clean consumer, artifact built, project source removed and verified absent, generated stdio entry spawned as a real process; self-contained-artifact evidence)',
    );
  });

  it('names host-install as isolated real-host registration without overstating session or package proof', () => {
    expect(proofLevelLabel('host-install')).toBe(
      'host-install (built bundle installed into an isolated real host home through the public install path, registration observed via the host\'s own CLI; NOT session-behavior or packed-artifact evidence)',
    );
  });

  it('names browser-app as compiled browser evidence without overstating host or artifact proof', () => {
    expect(proofLevelLabel('browser-app')).toBe(
      'browser-app (MCP App HTML compiled through the production Rsbuild profile, mounted in a real browser page over the product bridge; NOT host embedding, packed-artifact, or Workbench evidence)',
    );
    // The browser-safe registry module cannot import this Node-side label, so
    // it carries its own copy; the copies must never drift apart.
    expect(BROWSER_APP_PROOF_LEVEL_LABEL).toBe(proofLevelLabel('browser-app'));
  });

  it('names every conventional route the compiler discovered, with its extracted config', () => {
    expect(Object.keys(manifest.routes).sort()).toEqual([
      'app:harness/panel',
      'cli:db/migrate',
      'cli:inventory',
      'cli:report',
      'cli:tooling/inspect',
      'cli:tooling/report',
      'event:tool/after',
      'prompt:harness/summarize',
      'resource:harness/notes',
      'script:badge',
      'script:banner',
      'script:blank',
      'script:broken',
      'script:checksum',
      'script:constant',
      'script:identity',
      'script:stalled',
      'script:summary',
      'script:tooling-summary',
      'tool:harness/catalog',
      'tool:harness/context',
      'tool:harness/echo',
      'tool:harness/fault',
      'tool:harness/journal',
      'tool:harness/layout-probe',
      'tool:harness/lifecycle',
      'tool:harness/mutation-probe',
      'tool:harness/publish-notice',
      'tool:harness/strict-report',
      'tool:harness/ticket',
      'tool:harness/tooling',
      'tool:harness/unavailable',
      'tool:harness/wait',
    ]);
    expect(manifest.diagnostics).toEqual([]);
    expect(manifest.providers).toEqual([{
      id: 'provider:library-tooling',
      key: 'libraryTooling',
      name: 'library-tooling',
      relativePath: 'src/providers/library-tooling.ts',
      source: resolve(fixtureRoot, 'src/providers/library-tooling.ts'),
    }]);
    // Layouts are never routes; the manifest carries them separately, ordered by id.
    expect(manifest.layouts).toEqual([
      {
        id: 'layout:mcp:harness',
        relativePath: 'src/mcp/harness/layout.tsx',
        scope: 'server',
        serverId: 'mcp:harness',
        source: resolve(fixtureRoot, 'src/mcp/harness/layout.tsx'),
      },
      {
        id: 'layout:root',
        relativePath: 'src/layout.tsx',
        scope: 'root',
        source: resolve(fixtureRoot, 'src/layout.tsx'),
      },
    ]);
    expect(manifest.routes['tool:harness/echo']).toEqual({
      config: {
        annotations: { readOnlyHint: true },
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
    expect(manifest.state).toEqual({
      id: 'route-harness/journal',
      lifetime: 'workspace-durable',
      relativePath: 'src/state.ts',
      source: resolve(fixtureRoot, 'src/state.ts'),
    });
    expect(manifest.targets).toEqual(['claude']);
    // Script descriptors carry the extension contract: `.tsx` renders, `.ts`
    // is a plain executable module; the name is the path-derived identity.
    expect(manifest.scripts).toEqual([
      {
        name: 'badge',
        relativePath: 'src/scripts/badge.ts',
        rendered: false,
        routeId: 'script:badge',
        source: resolve(fixtureRoot, 'src/scripts/badge.ts'),
      },
      {
        name: 'banner',
        relativePath: 'src/scripts/banner.ts',
        rendered: false,
        routeId: 'script:banner',
        source: resolve(fixtureRoot, 'src/scripts/banner.ts'),
      },
      {
        name: 'blank',
        relativePath: 'src/scripts/blank.tsx',
        rendered: true,
        routeId: 'script:blank',
        source: resolve(fixtureRoot, 'src/scripts/blank.tsx'),
      },
      {
        name: 'broken',
        relativePath: 'src/scripts/broken.tsx',
        rendered: true,
        routeId: 'script:broken',
        source: resolve(fixtureRoot, 'src/scripts/broken.tsx'),
      },
      {
        name: 'checksum',
        relativePath: 'src/scripts/checksum.ts',
        rendered: false,
        routeId: 'script:checksum',
        source: resolve(fixtureRoot, 'src/scripts/checksum.ts'),
      },
      {
        name: 'constant',
        relativePath: 'src/scripts/constant.ts',
        rendered: false,
        routeId: 'script:constant',
        source: resolve(fixtureRoot, 'src/scripts/constant.ts'),
      },
      {
        name: 'identity',
        relativePath: 'src/scripts/identity.ts',
        rendered: false,
        routeId: 'script:identity',
        source: resolve(fixtureRoot, 'src/scripts/identity.ts'),
      },
      {
        name: 'stalled',
        relativePath: 'src/scripts/stalled.tsx',
        rendered: true,
        routeId: 'script:stalled',
        source: resolve(fixtureRoot, 'src/scripts/stalled.tsx'),
      },
      {
        name: 'summary',
        relativePath: 'src/scripts/summary.tsx',
        rendered: true,
        routeId: 'script:summary',
        source: resolve(fixtureRoot, 'src/scripts/summary.tsx'),
      },
      {
        name: 'tooling-summary',
        relativePath: 'src/scripts/tooling-summary.tsx',
        rendered: true,
        routeId: 'script:tooling-summary',
        source: resolve(fixtureRoot, 'src/scripts/tooling-summary.tsx'),
      },
    ]);
    expect(manifest.apps).toEqual({
      panel: {
        id: 'mcp-app:harness:panel',
        name: 'panel',
        relativePath: 'src/mcp/harness/apps/panel.tsx',
        resourceUri: 'ui://harness/panel',
        serverIds: ['mcp:harness'],
        source: resolve(fixtureRoot, 'src/mcp/harness/apps/panel.tsx'),
        targets: ['claude'],
      },
    });
  });

  it('carries the compiled command graph the CLI dispatch level dispatches over', () => {
    expect(manifest.cliCommands.filter((command) => command.mcp === undefined)).toEqual([
      {
        aliases: [],
        description: 'Applies pending harness migrations.',
        exitCode: 'result',
        options: [expect.objectContaining({ key: 'dryRun', kind: 'boolean', option: 'dry-run' })],
        path: ['db', 'migrate'],
        rendered: false,
        routeId: 'cli:db/migrate',
      },
      {
        aliases: ['inv'],
        description: 'Lists the harness library inventory.',
        exitCode: 'zero',
        options: [
          expect.objectContaining({ choices: ['json', 'text'], defaultValue: 'text', key: 'format' }),
          expect.objectContaining({ key: 'limit', kind: 'number' }),
          expect.objectContaining({ key: 'shelf', positional: 0, required: true }),
        ],
        path: ['inventory'],
        rendered: false,
        routeId: 'cli:inventory',
      },
      {
        aliases: [],
        description: 'Renders a harness report.',
        exitCode: 'zero',
        options: [
          expect.objectContaining({
            choices: ['success', 'render-error', 'invalid-result', 'wait-for-abort'],
            defaultValue: 'success',
            key: 'mode',
          }),
          expect.objectContaining({ key: 'topic', positional: 0, required: true }),
        ],
        path: ['report'],
        rendered: true,
        routeId: 'cli:report',
      },
      {
        aliases: [],
        description: 'Reports the request providers a plain command observes.',
        exitCode: 'zero',
        options: [],
        path: ['tooling', 'inspect'],
        rendered: false,
        routeId: 'cli:tooling/inspect',
      },
      {
        aliases: [],
        description: 'Renders the request providers a rendered command observes.',
        exitCode: 'zero',
        options: [],
        path: ['tooling', 'report'],
        rendered: true,
        routeId: 'cli:tooling/report',
      },
    ]);
    const inputOption = {
      description: 'Tool input as one JSON object.',
      key: 'input',
      kind: 'string',
      option: 'input',
      repeated: false,
      required: false,
    };
    const confirmationOption = {
      description: 'Confirm running this mutation-capable MCP tool.',
      key: 'yes',
      kind: 'boolean',
      option: 'yes',
      repeated: false,
      required: false,
    };
    const projected = (
      tool: string,
      description: string | undefined,
      confirm: boolean,
    ) => ({
      aliases: [],
      ...(description === undefined ? {} : { description }),
      exitCode: 'zero',
      mcp: { confirm, server: 'harness', tool },
      options: confirm ? [inputOption, confirmationOption] : [inputOption],
      path: ['harness', tool],
      rendered: true,
      routeId: `tool:harness/${tool}`,
    });
    expect(manifest.cliCommands.filter((command) => command.mcp !== undefined)).toEqual([
      projected('catalog', 'Streams the harness catalog behind one Suspense boundary.', true),
      projected('context', 'Returns the request identity axes observed by this route.', true),
      projected('echo', 'Echoes one message back with the observed workspace root.', false),
      projected('fault', 'Throws from the route or from a nested Suspense boundary, for thrown-error projection proof.', false),
      projected('journal', 'Records and reads durable route-harness journal entries.', true),
      projected('layout-probe', 'Renders a bare valued result so the layout chain around it is observable.', false),
      projected('lifecycle', 'Replays a deterministic durable lifecycle through mounted state.', true),
      projected('mutation-probe', 'Records how many times the mutation probe executed.', true),
      projected('publish-notice', 'Publishes a durable notice for a later session event.', true),
      projected('strict-report', 'Returns a closed-object report that rejects unknown serialized keys.', true),
      projected('ticket', 'Returns a cargo-conductor-shaped ticket status with optional diagnostics fields.', true),
      projected('tooling', 'Reports the request providers an MCP tool observes.', false),
      projected('unavailable', 'Returns a typed unavailable result for projection checks.', true),
      projected('wait', 'Waits until aborted or holdMs elapses, for cancellation contract proof.', true),
    ]);
  });

  it('reuses the compiler pass rather than compiling a second route graph', async () => {
    const graph = await compileRouteGraph(fixtureRoot, {
      routes: { mcpCommands: true },
      targets: ['claude'],
    } as never);

    expect(manifest.digest).toBe(graph.digest);
  });

  it('projects an already-compiled graph without touching the filesystem again', async () => {
    const graph = await compileRouteGraph(fixtureRoot, { targets: ['claude'] } as never);
    const projected = testManifestFromRouteGraph({
      apps: [{
        id: 'mcp-app:harness:panel',
        name: 'panel',
        provenance: { kind: 'config', sourcePath: resolve(fixtureRoot, 'agent-bundle.config.ts') },
        resourceUri: 'ui://harness/panel.html',
        serverId: 'mcp:harness',
        serverName: 'harness',
        source: resolve(fixtureRoot, 'views/panel.ts'),
        targets: ['claude'],
        template: resolve(fixtureRoot, 'views/panel.html'),
      }, {
        id: 'mcp-app:mirror:panel',
        name: 'panel',
        provenance: { kind: 'config', sourcePath: resolve(fixtureRoot, 'agent-bundle.config.ts') },
        resourceUri: 'ui://harness/panel.html',
        serverId: 'mcp:mirror',
        serverName: 'mirror',
        source: resolve(fixtureRoot, 'views/panel.ts'),
        targets: ['claude'],
        template: resolve(fixtureRoot, 'views/panel.html'),
      }],
      graph,
      projectRoot: fixtureRoot,
      targets: ['claude'],
    });

    expect(projected.routes).toEqual(manifest.routes);
    expect(projected.apps).toEqual({
      panel: {
        id: 'mcp-app:harness:panel',
        name: 'panel',
        relativePath: 'views/panel.ts',
        resourceUri: 'ui://harness/panel.html',
        serverIds: ['mcp:harness', 'mcp:mirror'],
        source: resolve(fixtureRoot, 'views/panel.ts'),
        targets: ['claude'],
        template: resolve(fixtureRoot, 'views/panel.html'),
      },
    });
    expect(Object.isFrozen(projected.apps.panel)).toBe(true);
    expect(Object.isFrozen(projected.routes)).toBe(true);
  });

  it('lists only the conventional scripts normalization ships, never a nested or configuration-conflicting route', async () => {
    const graph = await compileRouteGraph(fixtureRoot, { targets: ['claude'] } as never);
    const checksum = graph.scripts.find((route) => route.id === 'script:checksum');
    if (checksum === undefined) throw new Error('fixture must compile script:checksum');
    const nested = {
      ...checksum,
      id: 'script:release/verify',
      provenance: { ...checksum.provenance, relativePath: 'src/scripts/release/verify.ts' },
      source: resolve(fixtureRoot, 'src/scripts/release/verify.ts'),
    };
    const projected = testManifestFromRouteGraph({
      graph: { ...graph, scripts: [...graph.scripts, nested] },
      projectRoot: fixtureRoot,
      scripts: [{
        id: 'script:banner',
        mode: 'bundle',
        name: 'banner',
        provenance: { kind: 'config', sourcePath: resolve(fixtureRoot, 'agent-bundle.config.ts') },
        source: resolve(fixtureRoot, 'tools/banner.ts'),
        targets: ['claude'],
      }],
    });

    // `banner` is claimed by configuration (AB4809) and `release/verify` is
    // nested (AB4808): neither becomes a scripts/<name>.mjs executable, so
    // neither is a script-dispatch target.
    expect(projected.scripts.map((script) => script.name)).toEqual(['badge', 'blank', 'broken', 'checksum', 'constant', 'identity', 'stalled', 'summary', 'tooling-summary']);
    expect(manifest.scripts.map((script) => script.name)).toEqual(['badge', 'banner', 'blank', 'broken', 'checksum', 'constant', 'identity', 'stalled', 'summary', 'tooling-summary']);
  });

  it('rejects a shared app name whose compile-relevant declaration differs', async () => {
    const graph = await compileRouteGraph(fixtureRoot, { targets: ['claude'] } as never);
    const app = {
      id: 'mcp-app:harness:panel',
      name: 'panel',
      provenance: { kind: 'config' as const, sourcePath: resolve(fixtureRoot, 'agent-bundle.config.ts') },
      resourceUri: 'ui://harness/panel.html',
      serverId: 'mcp:harness',
      serverName: 'harness',
      source: resolve(fixtureRoot, 'views/panel.ts'),
      targets: ['claude'],
    };

    expect(() => testManifestFromRouteGraph({
      apps: [app, { ...app, id: 'mcp-app:mirror:panel', serverId: 'mcp:mirror', source: resolve(fixtureRoot, 'views/other.ts') }],
      graph,
      projectRoot: fixtureRoot,
    })).toThrow('servers may share an app name only with an identical declaration');
  });

});

describe('the generated route registry', () => {
  const source = routeTestSetupSource(manifest);

  it('registers the renderable routes and leaves browser and resource surfaces out of the Node bundle', () => {
    const loaders = /loaders: \{\n(?<body>[\s\S]*?)\n {2}\},/u.exec(source)?.groups?.body ?? '';

    expect(loaders).toContain('"event:tool/after": () => import(');
    expect(loaders).toContain('"tool:harness/context": () => import(');
    expect(loaders).toContain('"tool:harness/echo": () => import(');
    expect(loaders).toContain('"tool:harness/journal": () => import(');
    expect(loaders).toContain('"tool:harness/mutation-probe": () => import(');
    expect(loaders).toContain('"tool:harness/unavailable": () => import(');
    expect(loaders).not.toContain('app:harness/panel');
    expect(loaders).toContain('"resource:harness/notes": () => import(');
    // The manifest still inventories every compiled route; only the loaders,
    // which decide what enters the Node test bundle, are filtered.
    expect(source).toContain('app:harness/panel');
  });

  it('registers a loader for every conventional provider so the harness mounts them like the entry shell', () => {
    const providerLoaders = /providerLoaders: \{\n(?<body>[\s\S]*?)\n {2}\},/u.exec(source)?.groups?.body ?? '';

    expect(providerLoaders).toContain('"provider:library-tooling": () => import(');
    expect(providerLoaders).toContain('/src/providers/library-tooling.ts');
    // A project without providers emits no loader table at all.
    expect(routeTestSetupSource({ ...manifest, providers: undefined })).not.toContain('providerLoaders');
  });

  it('registers one loader per compiled layout so renders compose the same chain the workers bake', () => {
    const layoutLoaders = /layoutLoaders: \{\n(?<body>[\s\S]*?)\n {2}\},/u.exec(source)?.groups?.body ?? '';

    expect(layoutLoaders).toContain('"layout:root": () => import(');
    expect(layoutLoaders).toContain('"layout:mcp:harness": () => import(');
    expect(layoutLoaders).toContain('/src/layout.tsx")');
    expect(layoutLoaders).toContain('/src/mcp/harness/layout.tsx")');
  });

  it('carries the manifest and the registry version the helpers require', () => {
    expect(source).toContain(`version: ${String(AGENT_TEST_REGISTRY_VERSION)}`);
    expect(source).toContain('globalThis[Symbol.for("agent-bundle/test-route-registry")]');
    expect(source).toContain('stateLoader: () => import(');
    expect(source).toContain('/src/state.ts');
    expect(JSON.parse(/manifest: JSON\.parse\((".*?")\),/u.exec(source)![1]!) as string)
      .toBe(JSON.stringify(manifest));
  });

  it('refuses a registry written by a different agent-bundle version', () => {
    expect(() => registerTestRoutes({ loaders: {}, manifest, version: 99 }))
      .toThrow('Incompatible Agent Bundle test registry version');
  });

  // The generated module assigns the realm global directly, so registerTestRoutes
  // never sees it; the version has to be refused where the helpers read it.
  it('refuses an incompatible registry the generated setup assigned directly', async () => {
    await withRealmRegistry({ loaders: {}, manifest, version: 99 }, () => {
      expect(() => testManifest()).toThrow('Incompatible Agent Bundle test registry version');
    });
  });

  it('refuses a version-1 manifest before a helper reads fields that version did not carry', async () => {
    const versionOneManifest = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== 'cliCommands' && key !== 'plugin'),
    );
    const error = await withRealmRegistry(
      { loaders: {}, manifest: versionOneManifest, version: 1 },
      async () => invokeCli(['--help']).catch((thrown: unknown) => thrown),
    );

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('manifest-unavailable');
    expect((error as AgentTestError).message).toContain('found 1');
    expect((error as AgentTestError).message).toContain('Install one agent-bundle version');
  });

  it('accepts a registry carrying the current manifest version', async () => {
    await withRealmRegistry(
      { loaders: {}, manifest, version: AGENT_TEST_REGISTRY_VERSION },
      () => expect(testManifest()).toBe(manifest),
    );
  });
});

describe('route loaders and the manifest that produced them', () => {
  const foreign: AgentBundleTestManifest = {
    ...manifest,
    digest: 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
    projectRoot: '/tmp/another-project',
  };

  const registryLoading = (loaded: string[]): unknown => ({
    loaders: {
      'tool:harness/echo': (): Promise<unknown> => {
        loaded.push('tool:harness/echo');
        return Promise.resolve({ default: () => null });
      },
    },
    manifest,
    version: AGENT_TEST_REGISTRY_VERSION,
  });

  it('refuses another manifest\'s route rather than loading the registered module for it', async () => {
    const loaded: string[] = [];
    const error = await withRealmRegistry(
      registryLoading(loaded),
      async () => renderRoute('tool:harness/echo', { manifest: foreign }).catch((thrown: unknown) => thrown),
    );

    expect(loaded).toEqual([]);
    expect((error as AgentTestError).code).toBe('manifest-unavailable');
    expect((error as AgentTestError).message).toContain('not the ones registered');
    expect((error as AgentTestError).message).toContain(foreign.digest);
    expect((error as AgentTestError).message).toContain(manifest.digest);
    expect((error as AgentTestError).message).toContain('bound to the manifest that produced them');
  });

  it('still resolves the loader for the manifest the registry was built from', async () => {
    const loaded: string[] = [];
    await withRealmRegistry(
      registryLoading(loaded),
      // The render itself needs the react-server pool; resolving the loader is
      // what this asserts, so any later renderer failure is irrelevant here.
      async () => renderRoute('tool:harness/echo', { manifest }).catch(() => undefined),
    );

    expect(loaded).toEqual(['tool:harness/echo']);
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
        Object.freeze({ kind: 'context', text: 'Recorded 2 files.' }),
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
      .toContainContext('Recorded 2 files.')
      .toHaveValue({ files: 2 })
      .toHaveNodeKinds(['result', 'markdown', 'text', 'context']);
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

  it('separates a document that emitted no value from one whose value is null', () => {
    const documentWith = (value: unknown): never => Object.freeze({
      root: Object.freeze({ children: Object.freeze([]), kind: 'result' }),
      status: 'success',
      version: 1,
      ...(value === undefined ? {} : { value }),
    }) as never;

    expectDocument(documentWith(undefined)).toHaveValue(undefined);
    expectDocument(documentWith(null)).toHaveValue(null);
    expect(() => expectDocument(documentWith(undefined)).toHaveValue(null)).toThrow('value differs');
    expect(() => expectDocument(documentWith(null)).toHaveValue(undefined)).toThrow('value differs');
    expect(() => expectDocument(documentWith(undefined)).toHaveValue({ files: 2 })).toThrow('value differs');
  });

  it('fails an unmet status, Markdown, text, and error assertion', () => {
    expect(() => expectDocument(document).toHaveStatus('failed')).toThrow('unexpected status');
    expect(() => expectDocument(document).toContainMarkdown('missing')).toThrow('no Markdown node');
    expect(() => expectDocument(document).toContainText('missing')).toThrow('no text node');
    expect(() => expectDocument(document).toContainContext('missing')).toThrow('no context node');
    expect(() => expectDocument(document).toHaveError()).toThrow('no matching error');
    expect(() => expectDocument(document).toHaveNodeKinds(['result'])).toThrow('node kinds differ');
  });

  it('matches image, audio, and resource fields without widening text assertions', () => {
    const rich = Object.freeze({
      root: Object.freeze({
        children: Object.freeze([
          Object.freeze({ data: 'image-data', kind: 'image', mimeType: 'image/png' }),
          Object.freeze({ data: 'audio-data', kind: 'audio', mimeType: 'audio/wav' }),
          Object.freeze({ kind: 'resource', mimeType: 'application/octet-stream', name: 'data.bin', uri: 'data:application/octet-stream;base64,AAE=' }),
        ]),
        kind: 'result',
      }),
      status: 'success',
      version: 1,
    }) as never;

    expectDocument(rich)
      .toContainImage({ data: 'image-data', mimeType: 'image/png' })
      .toContainAudio({ data: 'audio-data', mimeType: 'audio/wav' })
      .toContainResource({ mimeType: 'application/octet-stream', name: 'data.bin', uri: 'data:application/octet-stream;base64,AAE=' });
    expect(() => expectDocument(rich).toContainText('image-data')).toThrow('no text node');
    expect(() => expectDocument(rich).toContainImage({ mimeType: 'image/jpeg' })).toThrow('no image node matching');
    expect(() => expectDocument(rich).toContainAudio({ data: 'different' })).toThrow('no audio node matching');
    expect(() => expectDocument(rich).toContainResource({ name: 'different.bin' })).toThrow('no resource node matching');
  });
});

describe('render event matchers', () => {
  const frame = Object.freeze({ root: { children: [], kind: 'result' }, status: 'success', version: 1 });
  const event = (sequence: number, type: string, extra: Readonly<Record<string, unknown>> = {}) =>
    Object.freeze({ document: frame, sequence, type, ...extra });
  // A shell, two legitimate replaces for the same boundary, and a completion:
  // the #120 shape that a pinned exact-array assertion called a regression.
  const stream = Object.freeze([
    event(0, 'shell'),
    event(1, 'progress', { completed: 1, message: 'reading inventory', total: 2 }),
    event(2, 'replace', { boundaryId: 'b:1' }),
    event(3, 'replace', { boundaryId: 'b:1' }),
    event(4, 'progress', { completed: 2, message: 'inventory ready', total: 2 }),
    event(5, 'complete'),
  ]) as never;

  it('tolerates extra frames between the events the contract requires', () => {
    expectEvents(stream)
      .toContainSequence(['shell', 'replace', 'complete'])
      .toHaveMonotonicSequence()
      .toCompleteOnce()
      .toHaveNoErrors()
      .toBeBoundedBy(6)
      .toHaveProgress({ atMost: 2, messages: ['reading', 'ready'] });
  });

  it('still fails a missing, reordered, or over-budget frame', () => {
    expect(() => expectEvents(stream).toContainSequence(['complete', 'shell']))
      .toThrow('do not contain the expected sequence');
    expect(() => expectEvents(stream).toContainSequence(['shell', 'error']))
      .toThrow('"error"');
    expect(() => expectEvents(stream).toBeBoundedBy(3)).toThrow('more events than the bound');
    expect(() => expectEvents(stream).toHaveProgress({ messages: ['ready', 'reading'] }))
      .toThrow('in order');
  });

  it('rejects a repeated or regressed sequence number', () => {
    const regressed = Object.freeze([event(0, 'shell'), event(0, 'complete')]) as never;

    expect(() => expectEvents(regressed).toHaveMonotonicSequence())
      .toThrow('not strictly increasing');
  });

  it('prints the timeline and the route the events came from', () => {
    const subject = { events: stream, provenance: { kind: 'cli', proofLevel: 'cli-dispatch', routeId: 'cli:inventory', source: 'manifest', targets: ['claude'] } } as never;
    const error = (() => {
      try {
        expectEvents(subject).toHaveErrorCode('AB9001');
        return undefined;
      } catch (thrown: unknown) {
        return thrown as AgentTestError;
      }
    })();

    expect(error?.code).toBe('assertion-failed');
    expect(error?.message).toContain('0:shell 1:progress 2:replace 3:replace 4:progress 5:complete');
    expect(error?.message).toContain('cli:inventory');
    expect(error?.message).toContain('cli-dispatch (argv dispatched through the routed CLI shell in-process');
  });

  it('keeps the exact-array assertion available for a contract that needs it', () => {
    expectEvents([event(0, 'shell'), event(1, 'complete')] as never).toHaveTypes(['shell', 'complete']);
    expect(() => expectEvents(stream).toHaveTypes(['shell', 'complete'])).toThrow('toContainSequence tolerates');
  });
});

describe('the manifest a route-free project compiles', () => {
  it('reports no routes and no proof beyond the route-unit level', async () => {
    const empty: AgentBundleTestManifest = await compileTestManifest({
      root: resolve(import.meta.dirname, '../../../fixtures/integration/skills-only'),
    });

    expect(empty.routes).toEqual({});
    expect(empty.apps).toEqual({});
    expect(empty.proofLevel).toBe('route-unit');
    expect(empty.targets).toEqual(['portable']);
  });
});

describe('the harness package boundary', () => {
  const packageRoot = resolve(import.meta.dirname, '..');

  it('publishes the Node and browser harness subpaths', async () => {
    const declared = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dependencies: Readonly<Record<string, string>>;
      peerDependencies: Readonly<Record<string, string>>;
      exports: Readonly<Record<string, { import: string; types: string }>>;
      peerDependenciesMeta: Readonly<Record<string, { optional: boolean }>>;
    };

    expect(declared.exports['./rstest']).toEqual({ import: './dist/rstest.js', types: './dist/rstest/index.d.ts' });
    expect(declared.exports['./test']).toEqual({ import: './dist/test.js', types: './dist/test/index.d.ts' });
    expect(declared.exports['./test/browser']).toEqual({
      import: './dist/test/browser.js',
      types: './dist/test/browser.d.ts',
    });
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
      [
        'src/rstest/index.ts',
        'src/rstest/setup-module.ts',
        'src/test/cli.ts',
        'src/test/errors.ts',
        'src/test/events.ts',
        'src/test/index.ts',
        'src/test/manifest.ts',
        'src/test/matchers.ts',
        'src/test/mcp.ts',
        'src/test/packed.ts',
        'src/test/registry.ts',
        'src/test/render.ts',
        'src/test/target-capabilities.ts',
        'src/test/types.ts',
      ]
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
