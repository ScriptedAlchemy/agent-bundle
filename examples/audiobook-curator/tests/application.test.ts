import { describe, expect, it } from '@rstest/core';

import maybeFactoryConfig from '../agent-bundle.config.ts';
import { compileRouteGraph } from 'agent-bundle/api';
import { runCli } from '../src/cli.js';

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
    expect(Object.keys(config.scripts ?? {})).toEqual(['audiobook-curator']);
    expect(config.skills).toBeUndefined();

    const graph = await compileRouteGraph(root, config);
    expect(graph.diagnostics).toEqual([]);
    expect(graph.servers).toHaveLength(1);
    expect(graph.servers[0]).toMatchObject({ id: 'mcp:curator', mode: 'generated', name: 'curator' });
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'tool').map((route) => route.id.slice(route.id.lastIndexOf('/') + 1))).toEqual(toolNames);
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'resource').map((route) => route.id)).toEqual(['resource:curator/catalog']);
    expect(graph.servers[0]!.routes.filter((route) => route.kind === 'prompt').map((route) => route.id)).toEqual(['prompt:curator/curate']);
  });

  it('keeps the handwritten CLI compatibility path non-rendering through stage 3', async () => {
    const output: string[] = [];
    await expect(runCli(['--help'], { write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('inspect [--max-files N] <root>');
    expect(output.join('')).toContain('prepare [--apply] [--name FILE] --output DIR <source>');
  });
});
