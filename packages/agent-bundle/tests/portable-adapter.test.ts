import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { portableAdapter } from '../src/adapters/portable.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const plugin = (): NormalizedPlugin => ({
  metadata: {
    description: 'A portable test plugin',
    id: 'plugin:portable-test',
    name: 'portable-test',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    version: '1.2.3',
  },
  mcpServers: [],
  skills: [
    {
      body: 'Use the included resource.\n',
      description: 'A skill with every discovered file.',
      dir: '/workspace/skills/reporter',
      frontmatter: { description: 'A skill with every discovered file.', name: 'reporter' },
      id: 'skill:reporter',
      name: 'reporter',
      provenance: { kind: 'conventional', sourcePath: '/workspace/skills/reporter/SKILL.md' },
      resources: [
        {
          bytes: 23,
          relativePath: 'SKILL.md',
          source: '/workspace/skills/reporter/SKILL.md',
        },
        {
          bytes: 12,
          relativePath: 'references/guide.md',
          source: '/workspace/skills/reporter/references/guide.md',
        },
      ],
      source: '/workspace/skills/reporter/SKILL.md',
      targets: ['portable'],
    },
  ],
  targets: [
    {
      id: 'target:portable',
      name: 'portable',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    },
  ],
});

it('plans a schema-valid skills-only plugin with every discovered resource', () => {
  const registry = createDefaultRegistry();
  const adapter = registry.get('portable');
  const plan = adapter.plan(plugin());

  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(registry.names()).toEqual(['portable']);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries).toEqual([
    {
      content:
        '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"A portable test plugin","name":"portable-test","version":"1.2.3"}\n',
      kind: 'write',
      relativePath: 'plugin.json',
    },
    {
      bytes: 23,
      kind: 'copy',
      relativePath: 'skills/reporter/SKILL.md',
      source: '/workspace/skills/reporter/SKILL.md',
    },
    {
      bytes: 12,
      kind: 'copy',
      relativePath: 'skills/reporter/references/guide.md',
      source: '/workspace/skills/reporter/references/guide.md',
    },
  ]);
});

it('plans portable MCP server variants with tokens expanded only where portable supports them', () => {
  const model = plugin();
  const mcpServers = [
    {
        args: ['--root', 'agent-bundle:path:plugin-root/tool'],
        command: 'node',
        cwd: 'agent-bundle:path:plugin-data/cache',
        env: { CACHE_DIR: 'agent-bundle:path:plugin-data/cache' },
        id: 'mcp:stdio',
        name: 'stdio',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'stdio' as const,
    },
    {
        headers: { Authorization: 'Bearer literal' },
        id: 'mcp:http',
        name: 'http',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'streamable-http' as const,
        url: 'https://mcp.example.test/stream',
    },
    {
        id: 'mcp:sse',
        name: 'sse',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'sse' as const,
        url: 'https://mcp.example.test/sse',
    },
  ];
  const plan = createDefaultRegistry().get('portable').plan({ ...model, mcpServers });
  const mcp = plan.entries.find(
    (entry) => entry.kind === 'write' && entry.relativePath === 'mcp.json',
  );

  expect(plan.diagnostics).toEqual([]);
  expect(mcp).toEqual({
    content:
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"streamable-http","url":"https://mcp.example.test/stream"},"sse":{"type":"sse","url":"https://mcp.example.test/sse"},"stdio":{"args":["--root","${PLUGIN_ROOT}/tool"],"command":"node","cwd":"${PLUGIN_DATA}/cache","env":{"CACHE_DIR":"${PLUGIN_DATA}/cache"},"type":"stdio"}}}\n',
    kind: 'write',
    relativePath: 'mcp.json',
  });
});

it('reports unsupported portable token locations instead of silently preserving them', () => {
  const model = plugin();
  const mcpServers = [
    {
        args: ['agent-bundle:path:workspace-root'],
        command: 'agent-bundle:path:plugin-root/bin',
        env: { 'agent-bundle:path:plugin-data': 'value' },
        id: 'mcp:invalid',
        name: 'invalid',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'stdio' as const,
    },
  ];
  const plan = createDefaultRegistry().get('portable').plan({ ...model, mcpServers });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.mcp.token.workspace-root',
    'portable.mcp.token.command',
    'portable.mcp.token.env-key',
  ]);
});

it('validates the vendored schemas while planning manifests', () => {
  const invalidPlugin = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    metadata: { ...plugin().metadata, name: 'Portable Plugin' },
  });
  const invalidMcp = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    mcpServers: [
      {
        command: 'node',
        cwd: 'not-portable-relative',
        id: 'mcp:invalid-cwd',
        name: 'invalid-cwd',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'stdio',
      },
    ],
  });

  expect(invalidPlugin.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.schema.plugin',
  ]);
  expect(invalidMcp.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.schema.mcp',
  ]);
  expect(invalidMcp.entries.some((entry) => entry.relativePath === 'mcp.json')).toBe(false);
});

it('rejects duplicate adapters without exposing mutable registry snapshots', () => {
  const registry = createDefaultRegistry();
  const names = registry.names() as string[];
  const defaults = registry.defaultTargetNames() as string[];

  expect(() => registry.register(portableAdapter)).toThrow('already registered');
  expect(() => names.push('other')).toThrow();
  expect(() => defaults.push('other')).toThrow();
  expect(registry.names()).toEqual(['portable']);
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(Object.isFrozen(registry.get('portable').capabilities)).toBe(true);
  expect(new TargetRegistry().has('portable')).toBe(false);
});

it('ships the pinned schema snapshots recorded in provenance', async () => {
  const schemaRoot = new URL('../src/adapters/schemas/portable/', import.meta.url);
  const provenance = JSON.parse(
    await readFile(new URL('PROVENANCE.json', schemaRoot), 'utf8'),
  ) as { readonly schemas: Record<string, { readonly sha256: string }> };

  for (const [name, expectedHash] of Object.entries({
    'mcp.schema.json': '6539175bfcdf43085855183e86da40ea94b166547a72b47ae9a0a390516d3acb',
    'plugin.schema.json': '0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883',
  })) {
    const content = await readFile(new URL(name, schemaRoot));
    expect(createHash('sha256').update(content).digest('hex')).toBe(expectedHash);
    expect(provenance.schemas[name]?.sha256).toBe(expectedHash);
  }
});
