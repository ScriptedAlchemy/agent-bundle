import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { portableAdapter } from '../src/adapters/portable.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';

const plugin = (): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  metadata: {
    description: 'A portable test plugin',
    id: 'plugin:portable-test',
    name: 'portable-test',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    version: '1.2.3',
  },
  mcpServers: [],
  scripts: [],
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

const testAdapterMetadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

it('rejects duplicate adapter config-extension keys and freezes the registry snapshot', () => {
  const adapter = (name: string): TargetAdapter => ({
    capabilities: {},
    configExtension: { key: 'example' },
    metadata: testAdapterMetadata,
    name,
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  });
  const registry = new TargetRegistry().register(adapter('first'));
  const extensions = (registry as unknown as {
    configExtensions(): readonly Readonly<{ key: string; target: string }>[];
  }).configExtensions();

  expect(extensions).toEqual([{ key: 'example', target: 'first' }]);
  expect(Object.isFrozen(extensions)).toBe(true);
  expect(Object.isFrozen(extensions[0])).toBe(true);
  expect(() => registry.register(adapter('second'))).toThrow('example');
});

it('plans a schema-valid skills-only plugin with every discovered resource', () => {
  const registry = createDefaultRegistry();
  const adapter = registry.get('portable');
  const plan = adapter.plan(plugin());

  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(registry.names()).toEqual(['portable', 'codex', 'claude']);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries).toMatchObject([
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
  expect(plan.entries.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/skills/reporter/SKILL.md'],
    ['/workspace/skills/reporter/SKILL.md', '/workspace/skills/reporter/references/guide.md'],
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
  ];
  const plan = createDefaultRegistry().get('portable').plan({ ...model, mcpServers });
  const mcp = plan.entries.find(
    (entry) => entry.kind === 'write' && entry.relativePath === 'mcp.json',
  );

  expect(plan.diagnostics).toEqual([]);
  expect(mcp).toEqual({
    content:
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"streamable-http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","${PLUGIN_ROOT}/tool"],"command":"node","cwd":"${PLUGIN_DATA}/cache","env":{"CACHE_DIR":"${PLUGIN_DATA}/cache"},"type":"stdio"}}}\n',
    kind: 'write',
    relativePath: 'mcp.json',
    sourceInputs: ['/workspace/agent-bundle.config.ts'],
  });
});

it('rejects a hostile normalized legacy MCP transport without emitting an MCP document', () => {
  const model = {
    ...plugin(),
    mcpServers: [{
      id: 'mcp:events',
      name: 'events',
      provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: ['portable'],
      transport: 'sse' as unknown as 'streamable-http',
      url: 'https://mcp.example.test/events',
    }],
  } satisfies NormalizedPlugin;
  const adapter = createDefaultRegistry().get('portable');
  const plan = adapter.plan(model);

  expect(adapter.validateModel(model)).toEqual([{
    code: 'AB4339',
    message: 'MCP server "events" uses unsupported transport "sse".',
    severity: 'error',
    sourcePath: '/workspace/agent-bundle.config.ts',
  }]);
  expect(plan.diagnostics).toEqual(adapter.validateModel(model));
  expect(plan.entries.some((entry) => entry.relativePath === 'mcp.json')).toBe(false);
});

it('preserves a valid MCP server named __proto__', () => {
  const plan = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    mcpServers: [
      {
        command: 'node',
        id: 'mcp:proto',
        name: '__proto__',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'stdio',
      },
    ],
  });

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.find((entry) => entry.relativePath === 'mcp.json')).toEqual({
    content:
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"__proto__":{"command":"node","type":"stdio"}}}\n',
    kind: 'write',
    relativePath: 'mcp.json',
    sourceInputs: ['/workspace/agent-bundle.config.ts'],
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

it('reports tokens forbidden in portable URLs, headers, cwd, and environment values', () => {
  const plan = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    mcpServers: [
      {
        id: 'mcp:url',
        name: 'url',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'streamable-http',
        url: 'agent-bundle:path:plugin-root/api',
      },
      {
        headers: { 'agent-bundle:path:plugin-data': 'literal' },
        id: 'mcp:header-key',
        name: 'header-key',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'streamable-http',
        url: 'https://mcp.example.test/headers',
      },
      {
        headers: { Authorization: 'agent-bundle:path:plugin-root' },
        id: 'mcp:header-value',
        name: 'header-value',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'streamable-http',
        url: 'https://mcp.example.test/headers',
      },
      {
        command: 'node',
        cwd: 'agent-bundle:path:workspace-root/cache',
        env: { CACHE_DIR: 'agent-bundle:path:workspace-root/cache' },
        id: 'mcp:workspace',
        name: 'workspace',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['portable'],
        transport: 'stdio',
      },
    ],
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.mcp.token.url',
    'portable.mcp.token.headers',
    'portable.mcp.token.headers',
    'portable.mcp.token.workspace-root',
    'portable.mcp.token.workspace-root',
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
  const bothInvalid = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    metadata: { ...plugin().metadata, name: 'Portable Plugin' },
    mcpServers: [
      {
        command: 'node',
        cwd: 'not-portable-relative',
        id: 'mcp:both-invalid',
        name: 'both-invalid',
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
  expect(bothInvalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.schema.plugin',
    'portable.schema.mcp',
  ]);
});

it('rejects duplicate adapters without exposing mutable registry snapshots', () => {
  const registry = createDefaultRegistry();
  const names = registry.names() as string[];
  const defaults = registry.defaultTargetNames() as string[];

  expect(() => registry.register(portableAdapter)).toThrow('already registered');
  expect(() => names.push('other')).toThrow();
  expect(() => defaults.push('other')).toThrow();
  expect(registry.names()).toEqual(['portable', 'codex', 'claude']);
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
