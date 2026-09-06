import { readFile } from 'node:fs/promises';
import { expect, it } from '@rstest/core';

import { TargetRegistry, createDefaultRegistry } from '../src/adapters/registry.ts';
import { clientCompatibilityFrom } from '../src/adapters/capability-state.ts';
import capabilityTable from '../src/adapters/capabilities/portable-1.0.0.json' with { type: 'json' };
import { portableAdapter } from '../src/adapters/portable.ts';
import { sha256Hex } from '../src/core/digest.ts';
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
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [
    {
      body: 'Use the included resource.\n',
      description: 'A skill with every discovered file.',
      dir: '/workspace/src/skills/reporter',
      frontmatter: { description: 'A skill with every discovered file.', name: 'reporter' },
      id: 'skill:reporter',
      name: 'reporter',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/skills/reporter/SKILL.md' },
      resources: [
        {
          bytes: 23,
          relativePath: 'SKILL.md',
          source: '/workspace/src/skills/reporter/SKILL.md',
        },
        {
          bytes: 12,
          relativePath: 'references/guide.md',
          source: '/workspace/src/skills/reporter/references/guide.md',
        },
      ],
      source: '/workspace/src/skills/reporter/SKILL.md',
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
  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor']);
  expect(plan.diagnostics).toEqual([]);
  const pluginEntries = plan.entries.filter((entry) =>
    entry.relativePath !== 'INSTALL.md' && entry.relativePath !== 'install.mjs');
  expect(pluginEntries).toMatchObject([
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
      source: '/workspace/src/skills/reporter/SKILL.md',
    },
    {
      bytes: 12,
      kind: 'copy',
      relativePath: 'skills/reporter/references/guide.md',
      source: '/workspace/src/skills/reporter/references/guide.md',
    },
  ]);
  expect(pluginEntries.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/src/skills/reporter/SKILL.md'],
    ['/workspace/src/skills/reporter/SKILL.md', '/workspace/src/skills/reporter/references/guide.md'],
  ]);
});

const portableExtension = (value: unknown): NormalizedPlugin['extensions'] => ({
  portable: {
    id: 'extension:portable',
    key: 'portable',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    target: 'portable',
    value,
  },
});

it('emits every Agent Plugins 1.0.0 §5.4 metadata field and §5.6 extensions from the portable config extension', () => {
  const plan = portableAdapter.plan({
    ...plugin(),
    extensions: portableExtension({
      author: { email: 'team@example.com', name: 'Example Team', url: 'https://example.com/team' },
      extensions: { 'com.example.client': { setting: true }, 'org.example-tools.ide': {} },
      homepage: 'https://docs.example.com/plugin',
      keywords: ['reports', 'summaries'],
      license: 'MIT',
      repository: 'https://github.com/example/plugin',
    }),
  });
  const manifest = plan.entries.find((entry) => entry.relativePath === 'plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(manifest).toMatchObject({ kind: 'write', sourceInputs: ['/workspace/agent-bundle.config.ts'] });
  expect(JSON.parse((manifest as Extract<typeof manifest, { readonly kind: 'write' }>).content)).toEqual({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    author: { email: 'team@example.com', name: 'Example Team', url: 'https://example.com/team' },
    description: 'A portable test plugin',
    extensions: { 'com.example.client': { setting: true }, 'org.example-tools.ide': {} },
    homepage: 'https://docs.example.com/plugin',
    keywords: ['reports', 'summaries'],
    license: 'MIT',
    name: 'portable-test',
    repository: 'https://github.com/example/plugin',
    version: '1.2.3',
  });
});

it('leaves plugin.json byte-identical to the pre-metadata contract when no portable metadata is declared', () => {
  const bare = portableAdapter.plan(plugin());
  const emptyExtension = portableAdapter.plan({ ...plugin(), extensions: portableExtension({}) });
  const expected =
    '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","description":"A portable test plugin","name":"portable-test","version":"1.2.3"}\n';

  for (const plan of [bare, emptyExtension]) {
    expect(plan.diagnostics).toEqual([]);
    expect(plan.entries.find((entry) => entry.relativePath === 'plugin.json')).toMatchObject({ content: expected });
  }
});

it('refuses malformed portable manifest metadata with one field-scoped diagnostic each', () => {
  const plan = portableAdapter.plan({
    ...plugin(),
    extensions: portableExtension({
      author: { email: 'not-an-email', name: '  ', role: 'maintainer', url: 'ftp://example.com' },
      extensions: { 'no-dot-namespace': {}, 'com.example.client': 'not an object' },
      homepage: 'docs.example.com',
      keywords: ['reports', ''],
      license: '',
      repository: 'git@github.com:example/plugin.git',
    }),
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.manifest.author.invalid',
    'portable.manifest.author.name.invalid',
    'portable.manifest.author.email.invalid',
    'portable.manifest.author.url.invalid',
    'portable.manifest.homepage.invalid',
    'portable.manifest.repository.invalid',
    'portable.manifest.license.invalid',
    'portable.manifest.keywords.invalid',
    'portable.manifest.extensions.invalid',
    'portable.manifest.extensions.invalid',
  ]);
  expect(plan.diagnostics.every((diagnostic) =>
    diagnostic.severity === 'error' && diagnostic.target === 'portable' && typeof diagnostic.recovery === 'string')).toBe(true);
  // Invalid fields never reach the manifest; the required identity still does.
  const manifest = plan.entries.find((entry) => entry.relativePath === 'plugin.json');
  expect(JSON.parse((manifest as Extract<typeof manifest, { readonly kind: 'write' }>).content)).toEqual({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    description: 'A portable test plugin',
    name: 'portable-test',
    version: '1.2.3',
  });
});

it('declares an honest capability row for every Agent Plugins 1.0.0 feature', () => {
  const { capabilities } = createDefaultRegistry().get('portable');

  expect(capabilities.skills).toMatchObject({ state: 'supported' });
  expect(capabilities.mcp).toMatchObject({ state: 'supported' });
  expect(capabilities.manifestMetadata).toMatchObject({ evidence: { target: 'portable' }, state: 'supported' });
  expect(capabilities.manifestExtensions).toMatchObject({ evidence: { target: 'portable' }, state: 'supported' });
  for (const [name, fragment] of [
    ['extensionDirectories', '§8.2'],
    ['mcpLegacySse', '§7.2.1'],
    ['hooks', 'hooks'],
    ['commands', 'commands'],
    ['rules', 'rules'],
    ['marketplace', 'marketplace'],
    ['install', 'profile'],
  ] as const) {
    expect(capabilities[name]).toMatchObject({ reason: expect.stringContaining(fragment), state: 'unavailable' });
  }
  expect(capabilities.extensionDirectories).toMatchObject({ reason: expect.stringContaining('2026-09-02') });
  expect(capabilities.mcpLegacySse).toMatchObject({ reason: expect.stringContaining('2026-09-02') });
});

it('rejects non-object portable author and extensions values', () => {
  const plan = portableAdapter.plan({
    ...plugin(),
    extensions: portableExtension({ author: 'Example Team', extensions: ['com.example.client'] }),
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'portable.manifest.author.invalid',
    'portable.manifest.extensions.invalid',
  ]);
});

it('copies project assets selected for portable and skips assets scoped to other targets', () => {
  const assetProvenance = { kind: 'conventional' as const, sourcePath: '/workspace/agent-bundle.config.ts' };
  const plan = portableAdapter.plan({
    ...plugin(),
    assets: [
      {
        bytes: 6,
        id: 'asset:logo.svg',
        name: 'logo.svg',
        provenance: assetProvenance,
        relativePath: 'logo.svg',
        source: '/workspace/assets/logo.svg',
        targets: ['portable'],
      },
      {
        bytes: 3,
        id: 'asset:claude-only.png',
        name: 'claude-only.png',
        provenance: assetProvenance,
        relativePath: 'claude-only.png',
        source: '/workspace/assets/claude-only.png',
        targets: ['claude'],
      },
    ],
  });

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.filter((entry) => entry.relativePath.startsWith('assets/'))).toEqual([{
    bytes: 6,
    kind: 'copy',
    relativePath: 'assets/logo.svg',
    source: '/workspace/assets/logo.svg',
    sourceInputs: ['/workspace/assets/logo.svg'],
  }]);
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
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"streamable-http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","${PLUGIN_ROOT}/tool"],"command":"node","cwd":"${PLUGIN_DATA}/cache","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${PLUGIN_ROOT}","CACHE_DIR":"${PLUGIN_DATA}/cache"},"type":"stdio"}}}\n',
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

  expect(plan.diagnostics).toEqual([{
    code: 'AB4339',
    message: 'MCP server "events" uses unsupported transport "sse".',
    severity: 'error',
    sourcePath: '/workspace/agent-bundle.config.ts',
  }]);
  expect(plan.entries.some((entry) => entry.relativePath === 'mcp.json')).toBe(false);
});

it('snapshots a changing MCP transport once per portable plan', () => {
  const alternatingServer = () => {
    let reads = 0;
    const server = {
      command: 'node',
      id: 'mcp:events',
      name: 'events',
      provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: ['portable'],
      url: 'https://mcp.example.test/events',
    };
    Object.defineProperty(server, 'transport', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'stdio' : 'sse';
      },
    });
    return { reads: () => reads, server: server as unknown as NormalizedPlugin['mcpServers'][number] };
  };
  const adapter = createDefaultRegistry().get('portable');
  const planned = alternatingServer();
  const plan = adapter.plan({ ...plugin(), mcpServers: [planned.server] });
  const mcp = plan.entries.find((entry) => entry.kind === 'write' && entry.relativePath === 'mcp.json');
  const validated = alternatingServer();

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse((mcp as Extract<typeof mcp, { readonly kind: 'write' }>).content)).toMatchObject({
    mcpServers: { events: { command: 'node', type: 'stdio' } },
  });
  expect(planned.reads()).toBe(1);
  expect(adapter.plan({ ...plugin(), mcpServers: [validated.server] }).diagnostics).toEqual([]);
  expect(validated.reads()).toBe(1);
});

it('contains an unreadable proxy transport as a portable model diagnostic', () => {
  const server = new Proxy({
    id: 'mcp:events',
    name: 'events',
    provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
    targets: ['portable'],
    transport: 'stdio' as const,
  }, {
    get: (target, property, receiver) => {
      if (property === 'transport') throw new Error('unreadable transport');
      return Reflect.get(target, property, receiver);
    },
  }) as NormalizedPlugin['mcpServers'][number];
  const adapter = createDefaultRegistry().get('portable');
  const model = { ...plugin(), mcpServers: [server] };

  expect(adapter.plan(model).diagnostics).toEqual([expect.objectContaining({ code: 'AB4339' })]);
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
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"__proto__":{"command":"node","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${PLUGIN_ROOT}"},"type":"stdio"}}}\n',
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

it('fails closed at plan time on Agent Plugins 1.0.0 normative MCP rules the schema cannot express', () => {
  const provenance = { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' };
  const plan = createDefaultRegistry().get('portable').plan({
    ...plugin(),
    mcpServers: [
      { command: 'bin/server', id: 'mcp:path', name: 'path-command', provenance, targets: ['portable'], transport: 'stdio' },
      { command: 'bun run', id: 'mcp:space', name: 'spaced-command', provenance, targets: ['portable'], transport: 'stdio' },
      {
        command: 'node',
        cwd: 'agent-bundle:path:plugin-root/../elsewhere',
        id: 'mcp:cwd',
        name: 'escaping-cwd',
        provenance,
        targets: ['portable'],
        transport: 'stdio',
      },
      {
        command: 'node',
        cwd: './safe\\..\\..\\outside',
        id: 'mcp:cwd-backslash',
        name: 'backslash-cwd',
        provenance,
        targets: ['portable'],
        transport: 'stdio',
      },
      { command: './bin\\..\\..\\outside', id: 'mcp:cmd-backslash', name: 'backslash-command', provenance, targets: ['portable'], transport: 'stdio' },
      { command: './../anchor/server', id: 'mcp:anchor', name: 'anchor-collision', provenance, targets: ['portable'], transport: 'stdio' },
      {
        command: 'node',
        cwd: 'agent-bundle:path:plugin-root/../anchor',
        id: 'mcp:anchor-cwd',
        name: 'anchor-cwd',
        provenance,
        targets: ['portable'],
        transport: 'stdio',
      },
      { command: 'C:\\tools\\server.exe', id: 'mcp:win-abs', name: 'windows-absolute', provenance, targets: ['portable'], transport: 'stdio' },
      { command: 'C:server', id: 'mcp:win-drive', name: 'windows-drive-relative', provenance, targets: ['portable'], transport: 'stdio' },
      {
        command: 'node',
        env: { '${PLUGIN_ROOT}': 'literal' },
        id: 'mcp:env',
        name: 'placeholder-env-key',
        provenance,
        targets: ['portable'],
        transport: 'stdio',
      },
      { id: 'mcp:http', name: 'plain-http', provenance, targets: ['portable'], transport: 'streamable-http', url: 'http://mcp.example.test/mcp' },
      {
        headers: { 'X-Tenant': 'a', 'x-tenant': 'b', 'X-Trace': 'a\u0001b' },
        id: 'mcp:headers',
        name: 'bad-headers',
        provenance,
        targets: ['portable'],
        transport: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
      { command: 'node', id: 'mcp:ok', name: 'ok', provenance, targets: ['portable'], transport: 'stdio' },
    ],
  });

  expect(plan.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.message])).toEqual([
    ['portable.mcp.command.standard', 'Portable MCP server "path-command" command "bin/server" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.command.standard', 'Portable MCP server "spaced-command" command "bun run" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.cwd.standard', 'Portable MCP server "escaping-cwd" cwd "${PLUGIN_ROOT}/../elsewhere" escapes its plugin root after resolution (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.cwd.standard', 'Portable MCP server "backslash-cwd" cwd "./safe\\\\..\\\\..\\\\outside" must use forward-slash separators without backslashes or NUL so every consuming platform resolves it identically (Agent Plugins 1.0.0 §4.1).'],
    ['portable.mcp.command.standard', 'Portable MCP server "backslash-command" command "./bin\\\\..\\\\..\\\\outside" escapes the plugin root (Agent Plugins 1.0.0 §4.1).'],
    ['portable.mcp.command.standard', 'Portable MCP server "anchor-collision" command "./../anchor/server" escapes the plugin root (Agent Plugins 1.0.0 §4.1).'],
    ['portable.mcp.cwd.standard', 'Portable MCP server "anchor-cwd" cwd "${PLUGIN_ROOT}/../anchor" escapes its plugin root after resolution (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.command.standard', 'Portable MCP server "windows-absolute" command "C:\\\\tools\\\\server.exe" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.command.standard', 'Portable MCP server "windows-drive-relative" command "C:server" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.env.standard', 'Portable MCP server "placeholder-env-key" env key "${PLUGIN_ROOT}" contains an Agent Plugins placeholder, but expansion never applies to env keys (Agent Plugins 1.0.0 §9.2).'],
    ['portable.mcp.url.standard', 'Portable MCP server "plain-http" url uses plain HTTP against non-loopback host "mcp.example.test"; non-loopback endpoints must use HTTPS (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.headers.standard', 'Portable MCP server "bad-headers" headers/x-tenant repeats header "X-Tenant" under different casing; header names are case-insensitive (Agent Plugins 1.0.0 §7.2.1).'],
    ['portable.mcp.headers.standard', 'Portable MCP server "bad-headers" headers/X-Trace is not a valid HTTP header field value: only visible ASCII, space, horizontal tab and obs-text bytes are allowed (Agent Plugins 1.0.0 §7.2.1).'],
  ]);
  expect(plan.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  const mcp = plan.entries.find((entry) => entry.kind === 'write' && entry.relativePath === 'mcp.json');
  expect(JSON.parse((mcp as Extract<typeof mcp, { readonly kind: 'write' }>).content)).toEqual({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { ok: { command: 'node', env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}' }, type: 'stdio' } },
  });
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
  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor']);
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(Object.isFrozen(registry.get('portable').capabilities)).toBe(true);
  expect(new TargetRegistry().has('portable')).toBe(false);
});

/**
 * Effective discovery for every recorded third-party client (#693-#714): the
 * paths its record claims it reads are paths this projection really emits, and
 * the manifests that would shadow them are absent from a portable-only build.
 */
it('emits the artifact paths every recorded client reads, and none of the manifests that shadow them', () => {
  const model = plugin();
  const plan = createDefaultRegistry().get('portable').plan({
    ...model,
    mcpServers: [{
      args: ['./mcp/serve.mjs'],
      command: 'node',
      id: 'mcp:stdio',
      name: 'stdio',
      provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: ['portable'],
      transport: 'stdio' as const,
    }],
  });
  const emitted = plan.entries.map((entry) => entry.relativePath);
  const clients = clientCompatibilityFrom('portable', capabilityTable.clients);

  expect(clients.map((client) => client.id)).toEqual(
    ['antigravity', 'devin-cli', 'grok-build', 'openclaw', 'qoder-cli'],
  );
  for (const client of clients) {
    for (const required of client.discovery.required) {
      expect(
        emitted.some((path) => path === required || path.startsWith(`${required}/`)),
        `${client.id} reads ${required}`,
      ).toBe(true);
    }
    for (const shadow of client.discovery.shadowedBy) {
      expect(emitted, `${client.id} is shadowed by ${shadow.path}`).not.toContain(shadow.path);
    }
  }
  // A client recorded at no tier names no path, so nothing about it can pass by accident.
  expect(clients.find((client) => client.id === 'antigravity')?.discovery.required).toEqual([]);
});

it('refuses a client record that claims a tier its own rows do not support', () => {
  const record = (overrides: Record<string, unknown>) => ({
    demo: {
      discovery: { evidence: ['2026-09-06: read from the vendor docs.'], required: ['skills'] },
      issue: 1,
      name: 'Demo',
      observed: 'docs retrieved 2026-09-06',
      surfaces: {
        hooks: { reason: '2026-09-06: no hooks document is emitted.', state: 'unavailable' },
        manifest: { reason: '2026-09-06: the root manifest is not read.', state: 'unavailable' },
        mcp: { reason: '2026-09-06: no MCP file is read.', state: 'unavailable' },
        placeholders: { reason: '2026-09-06: no placeholder expansion is documented.', state: 'unavailable' },
        skills: { evidence: ['2026-09-06: skills/ is a documented discovery root.'], state: 'supported' },
      },
      tier: 'skills',
      ...overrides,
    },
  });

  expect(() => clientCompatibilityFrom('portable', record({}))).not.toThrow();
  expect(() => clientCompatibilityFrom('portable', record({ tier: 'agent-plugins' })))
    .toThrow(/without reading plugin\.json as a manifest it loads/u);
  expect(() => clientCompatibilityFrom('portable', record({ tier: 'none' })))
    .toThrow(/while recording a path or surface it reads/u);
  expect(() => clientCompatibilityFrom('portable', record({ tier: 'native' })))
    .toThrow(/Unsupported tier "native"/u);
  // A tier is held to the paths as well as the rows: a client recorded at the
  // skills tier that names another path has not recorded the tree it reads.
  expect(() => clientCompatibilityFrom('portable', record({
    discovery: { evidence: ['2026-09-06: read from the vendor docs.'], required: ['mcp.json'] },
  }))).toThrow(/without reading the skill tree/u);
  // An install block is refused without a source, without actions, and without
  // exactly one action whose declared role is the install itself (#721 review).
  expect(() => clientCompatibilityFrom('portable', record({ install: { actions: [] } })))
    .toThrow(/install block with source undefined/u);
  expect(() => clientCompatibilityFrom('portable', record({ install: { actions: [], source: 'local-directory' } })))
    .toThrow(/install block with no actions/u);
  expect(() => clientCompatibilityFrom('portable', record({
    install: { actions: [{ command: 'demo plugins validate <plugin directory>', role: 'verify' }], source: 'local-directory' },
  }))).toThrow(/without exactly one install action/u);
  expect(() => clientCompatibilityFrom('portable', record({
    install: { actions: [{ command: 'demo plugins add <plugin directory>', role: 'add' }], source: 'local-directory' },
  }))).toThrow(/install action with role "add"/u);
  // A shadow takes named surfaces; it never silently replaces the whole root.
  expect(() => clientCompatibilityFrom('portable', record({
    discovery: {
      evidence: ['2026-09-06: read from the vendor docs.'],
      required: ['skills'],
      shadowedBy: [{ path: '.mcp.json' }],
    },
  }))).toThrow(/without naming the surfaces it takes/u);
  // A path that only resolves on one platform is not an artifact-relative path.
  expect(() => clientCompatibilityFrom('portable', record({
    discovery: { evidence: ['2026-09-06: read from the vendor docs.'], required: ['skills\\review'] },
  }))).toThrow(/other than artifact-relative paths/u);
  // Naming a path the client reads is a claim, so it carries its own dated note.
  expect(() => clientCompatibilityFrom('portable', record({ discovery: { required: ['skills'] } })))
    .toThrow(/no dated evidence that it reads or shadows them/u);
  // A degraded surface records the part that does load, not only the narrowing.
  expect(() => clientCompatibilityFrom('portable', record({
    surfaces: {
      hooks: { reason: '2026-09-06: no hooks document is emitted.', state: 'unavailable' },
      manifest: { reason: '2026-09-06: the root manifest is not read.', state: 'unavailable' },
      mcp: { reason: '2026-09-06: no MCP file is read.', state: 'unavailable' },
      placeholders: { reason: '2026-09-06: no placeholder expansion is documented.', state: 'unavailable' },
      skills: { reason: '2026-09-06: only the first skill loads.', state: 'degraded' },
    },
  }))).toThrow(/degraded without evidence of the part it does load/u);
});

it('refuses an undated or silent client record', () => {
  const surfaces = {
    hooks: { reason: '2026-09-06: no hooks document is emitted.', state: 'unavailable' },
    manifest: { evidence: ['2026-09-06: the root manifest loads.'], state: 'supported' },
    mcp: { evidence: ['2026-09-06: mcp.json loads.'], state: 'supported' },
    placeholders: { evidence: ['2026-09-06: ${PLUGIN_ROOT} expands.'], state: 'supported' },
    skills: { evidence: ['2026-09-06: skills/ loads.'], state: 'supported' },
  };
  const base = {
    discovery: { evidence: ['2026-09-06: read from the vendor docs.'], required: ['plugin.json'] },
    issue: 2,
    name: 'Demo',
    observed: 'docs retrieved 2026-09-06',
    surfaces,
    tier: 'agent-plugins',
  };

  expect(() => clientCompatibilityFrom('portable', { demo: { ...base, observed: 'latest' } }))
    .toThrow(/no dated observation/u);
  expect(() => clientCompatibilityFrom('portable', {
    demo: { ...base, surfaces: { ...surfaces, hooks: { reason: 'no hooks', state: 'unavailable' } } },
  })).toThrow(/without a dated reason/u);
  expect(() => clientCompatibilityFrom('portable', {
    demo: { ...base, surfaces: { ...surfaces, mcp: { state: 'supported' } } },
  })).toThrow(/supported without evidence/u);
  expect(() => clientCompatibilityFrom('portable', {
    demo: { ...base, surfaces: Object.fromEntries(Object.entries(surfaces).filter(([key]) => key !== 'mcp')) },
  })).toThrow(/silent about its mcp surface/u);
  expect(() => clientCompatibilityFrom('portable', {
    demo: { ...base, discovery: { ...base.discovery, required: ['../escape'] } },
  })).toThrow(/artifact-relative paths/u);
  expect(() => clientCompatibilityFrom('portable', { 'Demo Client': base }))
    .toThrow(/not a kebab-case id/u);
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
    expect(sha256Hex(content)).toBe(expectedHash);
    expect(provenance.schemas[name]?.sha256).toBe(expectedHash);
  }
});
