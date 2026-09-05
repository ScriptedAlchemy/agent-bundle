import { describe, expect, it } from '@rstest/core';

import type { RouteManifest } from '../src/contracts/routes.ts';
import { applicationNodeRefForRouteId } from '../src/dev/routes/application-node.ts';
import {
  applicationLeafForRouteId,
  applicationLeaves,
  applicationTreeForManifest,
  filterApplicationTree,
  findApplicationLeaf,
  firstApplicationLeaf,
} from '../src/dev/routes/application-tree.ts';

const route = (
  id: string,
  kind: RouteManifest['events'][number]['kind'],
  source: string,
  extra: Partial<RouteManifest['events'][number]> = {},
): RouteManifest['events'][number] => ({
  config: [],
  id,
  kind,
  provenance: { kind: 'conventional' },
  source,
  ...extra,
});

const manifest: RouteManifest = {
  cli: {
    commands: [{
      aliases: [],
      description: 'Audit a library',
      exitCode: 'zero',
      options: [],
      path: ['library', 'audit'],
      routeId: 'cli:library/audit',
    }],
    mode: 'generated',
    routes: [route('cli:library/audit', 'cli', 'src/cli/library/audit.ts')],
  },
  diagnostics: [{ code: 'AB4801', message: 'Fixture diagnostic.', severity: 'warning' }],
  digest: 'd'.repeat(64),
  events: [
    route('event:tool/before', 'event-route', 'src/events/tool/before.ts', { event: 'tool/before' }),
  ],
  providers: [],
  scripts: [
    route('script:zeta', 'script', 'src/scripts/zeta.ts'),
    route('script:alpha', 'script', 'src/scripts/alpha.ts'),
  ],
  servers: [
    {
      id: 'mcp:zeta',
      mode: 'generated',
      name: 'zeta',
      routes: [route('tool:zeta/z-last', 'tool', 'src/mcp/zeta/tools/z-last.ts')],
    },
    {
      id: 'mcp:alpha',
      mode: 'generated',
      name: 'alpha',
      routes: [
        route('tool:alpha/z-tool', 'tool', 'src/mcp/alpha/tools/z-tool.ts'),
        route('tool:alpha/a-tool', 'tool', 'src/mcp/alpha/tools/a-tool.ts', {
          description: 'Alpha tool',
          inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
        }),
        route('resource:alpha/catalog', 'resource', 'src/mcp/alpha/resources/catalog.ts'),
        route('prompt:alpha/recommend', 'prompt', 'src/mcp/alpha/prompts/recommend.ts'),
        route('app:alpha/dashboard', 'app', 'src/mcp/alpha/apps/dashboard.ts'),
      ],
    },
  ],
  sourceRevision: 'r'.repeat(64),
};

const tree = () => applicationTreeForManifest({
  inspection: {
    hooks: [{
      event: 'session/start',
      id: 'hook:configured',
      name: 'configured-hook',
      path: 'hooks/configured.mjs',
      target: 'claude',
    }, {
      event: 'session/start',
      id: 'hook:configured-codex',
      name: 'configured-hook',
      path: 'codex/hooks/configured.mjs',
      target: 'codex',
    }],
    mcpServers: [{ kind: 'stdio', name: 'external', target: 'portable' }],
    scripts: [
      { id: 'script:configured', name: 'configured', target: 'portable' },
      { id: 'script:configured-claude', name: 'configured', target: 'claude' },
    ],
  },
  manifest,
  skills: [
    { id: 'skill:zeta', label: 'Zeta skill', source: 'skills/zeta/SKILL.md' },
    { id: 'skill:alpha', label: 'Alpha skill', source: 'skills/alpha/SKILL.md' },
  ],
  state: 'fresh',
});

describe('application tree derivation', () => {
  it('covers every route kind in fixed group and subgroup order', () => {
    const result = tree();

    expect(result.groups.map((group) => group.kind)).toEqual([
      'mcp', 'events', 'cli', 'scripts', 'skills',
    ]);
    const mcp = result.groups[0]!;
    expect(mcp.kind).toBe('mcp');
    if (mcp.kind !== 'mcp') throw new Error('Expected MCP group.');
    expect(mcp.servers.map((server) => server.server)).toEqual(['alpha', 'external', 'zeta']);
    expect(mcp.servers[0]!.subgroups.map((group) => group.label)).toEqual([
      'Tools', 'Resources', 'Prompts', 'Apps',
    ]);
    expect(mcp.servers[0]!.subgroups[0]!.leaves.map((leaf) => leaf.label)).toEqual([
      'a-tool', 'z-tool',
    ]);
    expect(mcp.servers[0]!.subgroups.map((group) => group.leaves[0]!.execution)).toEqual([
      'invoke', 'invoke', 'invoke', 'preview',
    ]);
    expect(result.groups.some((group) => group.kind === 'rules')).toBe(false);
    expect(result.diagnostics).toEqual(manifest.diagnostics);
  });

  it('adds skills and configured-only hooks and scripts as document leaves', () => {
    const result = tree();
    const leaves = applicationLeaves(result);

    expect(leaves.filter((leaf) => leaf.ref.kind === 'skill').map((leaf) => leaf.label)).toEqual([
      'Alpha skill', 'Zeta skill',
    ]);
    const configuredHook = leaves.find((leaf) => leaf.ref.kind === 'event' && leaf.ref.event === 'session/start');
    expect(configuredHook).toMatchObject({
      description: 'configured in agent-bundle.config, no route module',
      execution: 'document',
    });
    expect(configuredHook?.routeId).toBeUndefined();
    const configuredScript = leaves.find((leaf) => leaf.ref.kind === 'script' && leaf.ref.name === 'configured');
    expect(configuredScript).toMatchObject({
      description: 'configured in agent-bundle.config, no route module',
      execution: 'document',
    });
    expect(configuredScript?.routeId).toBeUndefined();
    expect(leaves.filter((leaf) => leaf.ref.kind === 'event' && leaf.ref.event === 'session/start')).toHaveLength(1);
    expect(leaves.filter((leaf) => leaf.ref.kind === 'script' && leaf.ref.name === 'configured')).toHaveLength(1);
    expect(leaves.find((leaf) => leaf.ref.kind === 'skill' && leaf.ref.id === 'skill:alpha')).toMatchObject({
      execution: 'document',
      source: 'skills/alpha/SKILL.md',
    });
  });

  it('round trips every route id through the shared application node reference', () => {
    const result = tree();
    for (const leaf of applicationLeaves(result).filter((candidate) => candidate.routeId !== undefined)) {
      const ref = applicationNodeRefForRouteId(leaf.routeId!);
      expect(ref).toBeDefined();
      expect(findApplicationLeaf(result, ref!)).toBe(leaf);
      expect(applicationLeafForRouteId(result, leaf.routeId!)).toBe(leaf);
    }
    expect(applicationLeafForRouteId(result, 'tool:missing/nope')).toBeUndefined();
    expect(findApplicationLeaf(result, { kind: 'skill', id: 'missing' })).toBeUndefined();
  });

  it('filters case-insensitively while preserving structure and state', () => {
    const original = tree();
    const result = filterApplicationTree(original, 'A-TOOL');

    expect(applicationLeaves(result).map((leaf) => leaf.label)).toEqual(['a-tool']);
    expect(result.groups.map((group) => group.kind)).toEqual(['mcp']);
    expect(result.state).toBe('fresh');
    expect(result.leafCount).toBe(1);
    expect(firstApplicationLeaf(result)?.label).toBe('a-tool');
    expect(filterApplicationTree(original, '   ')).toBe(original);
  });

  it('omits empty groups and returns no first leaf for an empty tree', () => {
    const empty = applicationTreeForManifest({
      manifest: { ...manifest, cli: undefined, events: [], scripts: [], servers: [] },
      state: 'unavailable',
      message: 'Manifest unavailable.',
    });

    expect(empty.groups).toEqual([]);
    expect(empty.leafCount).toBe(0);
    expect(empty.message).toBe('Manifest unavailable.');
    expect(firstApplicationLeaf(empty)).toBeUndefined();
  });
});
