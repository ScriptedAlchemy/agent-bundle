import { describe, expect, it } from '@rstest/core';

import maybeFactoryConfig from '../agent-bundle.config.ts';
import { compileRouteGraph } from 'agent-bundle/api';

if (typeof maybeFactoryConfig === 'function') throw new Error('expected a static config object');
const config = maybeFactoryConfig;
const root = new URL('..', import.meta.url).pathname;

const toolNames = [
  'apply_audiobook_chapters',
  'apply_audiobook_metadata',
  'audit_audiobook',
  'audit_library',
  'cache_audible_edition',
  'convert_audiobook',
  'identify_audible_sample',
  'inspect_sources',
  'inventory_sources',
  'prepare_audiobook',
  'review_curation_shelf',
  'search_audible',
  'select_audible_edition',
  'select_sources',
  'verify_audible_sample',
  'verify_with_whisper',
];

describe('audiobook curator filesystem application', () => {
  it('derives the complete MCP server from route modules and no server config', async () => {
    expect(config.targets).toEqual(['claude', 'codex']);
    expect(config.mcp).toBeUndefined();
    // The manual CLI dispatcher and its explicit `scripts` shipping are
    // retired (#102 stage 3); the routed src/cli/ commands feed the package
    // executable instead.
    expect(config.scripts).toBeUndefined();
    expect(config.skills).toBeUndefined();

    const graph = await compileRouteGraph(root, config);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.servers).toHaveLength(1);
    expect(graph.servers[0]).toMatchObject({ id: 'mcp:curator', mode: 'generated', name: 'curator' });
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'tool').map((route) => route.id.slice(route.id.lastIndexOf('/') + 1))).toEqual(toolNames);
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'resource').map((route) => route.id)).toEqual(['resource:curator/catalog']);
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'prompt').map((route) => route.id)).toEqual(['prompt:curator/curate']);
  });

  it('derives the complete routed CLI and projected MCP toolset', async () => {
    const graph = await compileRouteGraph(root, config);
    expect(graph.cli).toMatchObject({ mode: 'generated' });
    expect(graph.cli!.commands).toHaveLength(32);
    const customCommands = graph.cli!.commands!.filter((command) => command.mcp === undefined);
    const projectedCommands = graph.cli!.commands!.filter((command) => command.mcp !== undefined);
    expect(customCommands).toHaveLength(16);
    expect(projectedCommands.map((command) => command.path.join(' '))).toEqual(
      toolNames.map((tool) => `curator ${tool}`),
    );
    expect(customCommands.filter((command) => command.rendered).map((command) => command.path.join(' ')))
      .toEqual(['audible-search', 'audit', 'convert', 'inventory', 'library-audit', 'select', 'shelf']);
    expect(projectedCommands.every((command) => command.rendered)).toBe(true);
  });
});
