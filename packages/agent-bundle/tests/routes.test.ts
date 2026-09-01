import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { inspect, validate } from '../src/api.ts';
import { discoverProject } from '../src/config/index.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';

const routeModule = 'export default async () => null;\n';

const fixtureConfig = (body: string): string => [
  'export default {',
  "  plugin: { name: 'routes-fixture', version: '1.0.0' },",
  "  targets: ['portable'],",
  body,
  '};',
  '',
].join('\n');

const minimalConfig = { plugin: { name: 'routes-fixture', version: '1.0.0' } };

it('compiles an immutable route graph from every conventional root', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/cli/doctor.tsx': routeModule,
      'src/events/file/saved.tsx': routeModule,
      'src/mcp/curator/apps/dashboard.tsx': routeModule,
      'src/mcp/curator/prompts/curate.tsx': routeModule,
      'src/mcp/curator/resources/catalog.ts': routeModule,
      'src/mcp/curator/tools/inspect.tsx': routeModule,
      'src/mcp/other/tools/convert.ts': routeModule,
      'src/providers/git-worktree.ts': routeModule,
      'src/scripts/rebuild-index.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, minimalConfig);
    const graph = discovered.routeGraph;
    expect(graph).toBeDefined();
    expect(graph!.diagnostics).toEqual([]);
    expect(graph!.servers).toEqual(['curator', 'other']);
    expect(graph!.routes.map((route) => [route.kind, route.id, route.serverId])).toEqual([
      ['cli', 'cli/doctor', undefined],
      ['event-route', 'events/file/saved', undefined],
      ['app', 'mcp/curator/apps/dashboard', 'curator'],
      ['prompt', 'mcp/curator/prompts/curate', 'curator'],
      ['resource', 'mcp/curator/resources/catalog', 'curator'],
      ['tool', 'mcp/curator/tools/inspect', 'curator'],
      ['tool', 'mcp/other/tools/convert', 'other'],
      ['provider', 'providers/git-worktree', undefined],
      ['script', 'scripts/rebuild-index', undefined],
    ]);
    const tool = graph!.routes.find((route) => route.id === 'mcp/curator/tools/inspect')!;
    expect(tool.source).toBe(join(fixture.root, 'src/mcp/curator/tools/inspect.tsx'));
    expect(tool.config).toEqual({});
    expect(tool.provenance).toEqual({
      conventionalRoot: 'src/mcp/curator/tools',
      kind: 'conventional',
      relativePath: 'src/mcp/curator/tools/inspect.tsx',
    });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph!.routes)).toBe(true);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.config)).toBe(true);
    expect(Object.isFrozen(tool.provenance)).toBe(true);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('bounds discovery: private, ignored, declaration, claimed, and non-route files never become routes', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      '.gitignore': 'src/scripts/generated.ts\n',
      'src/cli.ts': 'export const main = async () => 0;\n',
      // Deeply nested tool files and loose server files are not route shapes.
      'src/mcp/curator/tools/nested/too-deep.ts': routeModule,
      'src/mcp/curator/shared.ts': 'export const shared = true;\n',
      'src/providers/_private.ts': routeModule,
      'src/providers/kinds.d.ts': 'export type Kind = string;\n',
      'src/scripts/generated.ts': routeModule,
      'src/scripts/release.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    // The explicit scripts declaration claims release.ts: config always wins,
    // so the module belongs to the declaration, not the route convention.
    const discovered = await discoverProject(fixture.root, {
      ...minimalConfig,
      scripts: { release: './src/scripts/release.ts' },
    });
    expect(discovered.routeGraph).toBeUndefined();
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports AB4800 when a server has both route modules and a conventional entry file', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/mcp/curator.ts': 'export default () => null;\n',
      'src/mcp/curator/tools/inspect.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, minimalConfig);
    expect(discovered.routeGraph?.diagnostics).toMatchObject([{
      code: 'AB4800',
      severity: 'error',
      sourcePath: join(fixture.root, 'src/mcp/curator.ts'),
    }]);
    // The graph still lists the discovered route; the diagnostic gates use.
    expect(discovered.routeGraph?.routes.map((route) => route.id)).toEqual(['mcp/curator/tools/inspect']);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports AB4801 when a route-mode server is also declared in configuration', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig("  mcp: { servers: { curator: { url: 'https://example.test/mcp' } } },"),
    files: {
      'src/mcp/curator/tools/inspect.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, {
      ...minimalConfig,
      mcp: { servers: { curator: { url: 'https://example.test/mcp' } } },
    });
    expect(discovered.routeGraph?.diagnostics).toMatchObject([{
      code: 'AB4801',
      severity: 'error',
    }]);
    // End to end: source validation carries the mode conflict as an error.
    const validated = await validate({ root: fixture.root });
    expect(validated.diagnostics.filter((diagnostic) => diagnostic.code === 'AB4801')).toHaveLength(1);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports AB4802 when routed CLI commands coexist with the src/cli.ts convention', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/cli.ts': 'export const main = async () => 0;\n',
      'src/cli/doctor.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, minimalConfig);
    expect(discovered.routeGraph?.diagnostics).toMatchObject([{
      code: 'AB4802',
      severity: 'error',
      sourcePath: join(fixture.root, 'src/cli.ts'),
    }]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports AB4803 for duplicate route ids and keeps the first module', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/scripts/index-library.ts': routeModule,
      'src/scripts/index-library.tsx': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, minimalConfig);
    expect(discovered.routeGraph?.diagnostics).toMatchObject([{
      code: 'AB4803',
      severity: 'error',
      sourcePath: join(fixture.root, 'src/scripts/index-library.tsx'),
    }]);
    expect(discovered.routeGraph?.routes.map((route) => route.provenance.relativePath))
      .toEqual(['src/scripts/index-library.ts']);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports AB4804 for unsafe route path segments', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/scripts/bad name.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const discovered = await discoverProject(fixture.root, minimalConfig);
    expect(discovered.routeGraph?.diagnostics).toMatchObject([{
      code: 'AB4804',
      severity: 'error',
      sourcePath: join(fixture.root, 'src/scripts/bad name.ts'),
    }]);
    expect(discovered.routeGraph?.routes).toEqual([]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('inspect exposes the route graph behind the routes focus', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/mcp/curator/tools/inspect.tsx': routeModule,
      'src/scripts/rebuild-index.ts': routeModule,
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const result = await inspect({ focus: 'routes', root: fixture.root });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('expected a ready inspection');
    expect(result.selected?.routes?.servers).toEqual(['curator']);
    expect(result.selected?.routes?.routes.map((route) => route.id)).toEqual([
      'mcp/curator/tools/inspect',
      'scripts/rebuild-index',
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('inspect returns the empty route graph for a project without route modules', async () => {
  const fixture = await createProjectFixture({
    config: fixtureConfig(''),
    files: {
      'src/index.ts': 'export const library = true;\n',
    },
    prefix: 'agent-bundle-routes-',
  });
  try {
    const result = await inspect({ focus: 'routes', root: fixture.root });
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('expected a ready inspection');
    expect(result.selected?.routes).toEqual({ diagnostics: [], routes: [], servers: [] });
  } finally {
    await removeProjectFixture(fixture.root);
  }
});
