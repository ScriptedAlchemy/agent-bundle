import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from './support/build.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const installFormats = addFormats as unknown as (target: Ajv2020) => void;

const plugin = Object.freeze({
  extensions: Object.freeze({}),
  hooks: Object.freeze([]),
  marketplace: true as const,
  mcpServers: Object.freeze([
    Object.freeze({
      args: Object.freeze(['--root', `${pathTokens.pluginRoot}/tools/server.mjs`]),
      command: 'node',
      cwd: pathTokens.pluginRoot,
      env: Object.freeze({ CACHE_DIR: 'cache' }),
      id: 'mcp:stdio',
      name: 'stdio',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
      targets: Object.freeze(['codex', 'claude']),
      transport: 'stdio' as const,
    }),
    Object.freeze({
      headers: Object.freeze({ Authorization: 'Bearer literal' }),
      id: 'mcp:http',
      name: 'http',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
      targets: Object.freeze(['codex', 'claude']),
      transport: 'streamable-http' as const,
      url: 'https://mcp.example.test/stream',
    }),
  ]),
  metadata: Object.freeze({
    description: 'Review code and explain findings.',
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
    version: '1.2.3',
  }),
  runtime: Object.freeze({ node: '22.12.0' }),
  scripts: Object.freeze([]),
  skills: Object.freeze([
    Object.freeze({
      body: '# Review\n',
      description: 'Review code and explain findings.',
      dir: '/workspace/skills/review',
      frontmatter: Object.freeze({ description: 'Review code and explain findings.', name: 'review' }),
      id: 'skill:review',
      name: 'review',
      provenance: Object.freeze({ kind: 'conventional' as const, sourcePath: '/workspace/skills/review/SKILL.md' }),
      resources: Object.freeze([
        Object.freeze({ bytes: 9, relativePath: 'SKILL.md', source: '/workspace/skills/review/SKILL.md' }),
        Object.freeze({ bytes: 3, relativePath: 'assets/icon.bin', source: '/workspace/skills/review/assets/icon.bin' }),
        Object.freeze({ bytes: 8, relativePath: 'references/guide.md', source: '/workspace/skills/review/references/guide.md' }),
      ]),
      source: '/workspace/skills/review/SKILL.md',
      targets: Object.freeze(['codex', 'claude']),
    }),
  ]),
  targets: Object.freeze([
    Object.freeze({ id: 'target:codex', name: 'codex', provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }) }),
    Object.freeze({ id: 'target:claude', name: 'claude', provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }) }),
  ]),
} satisfies NormalizedPlugin);

const planEntries = (model: NormalizedPlugin, target: 'codex' | 'claude') =>
  createDefaultRegistry().get(target).plan(model).entries;

const writeEntries = (model: NormalizedPlugin, target: 'codex' | 'claude') => {
  const entries = planEntries(model, target);
  return entries.filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write');
};

const writeContents = (model: NormalizedPlugin, target: 'codex' | 'claude') =>
  Object.fromEntries(writeEntries(model, target).map((entry) => [entry.relativePath, entry.content]));

const validateDocuments = async (
  target: 'codex' | 'claude',
  documents: Readonly<Record<string, string>>,
): Promise<void> => {
  const schemas = await Promise.all(
    ['plugin', 'mcp', 'marketplace'].map(async (name) => {
      const module = await import(`../src/adapters/schemas/${target}/${name}.schema.json`, {
        with: { type: 'json' },
      });
      return [name, module.default] as const;
    }),
  );
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const paths = target === 'codex'
    ? {
        marketplace: '.agents/plugins/marketplace.json',
        mcp: '.mcp.json',
        plugin: '.codex-plugin/plugin.json',
      }
    : {
        marketplace: '.claude-plugin/marketplace.json',
        mcp: '.mcp.json',
        plugin: '.claude-plugin/plugin.json',
      };

  for (const [name, schema] of schemas) {
    const valid = validator.compile(schema)(JSON.parse(documents[paths[name as keyof typeof paths]]!));
    expect(valid).toBe(true);
  }
};

it('pins host help, capabilities, and every schema snapshot to the supported CLI versions', async () => {
  const hosts = {
    claude: {
      hashes: {
        'hooks.schema.json': 'a122f0e3b83f8222186bfac6965795b75f8f50716c6d76b105864ac1a578306a',
        'marketplace.schema.json': 'eba6a3ab555d40926168adecf381f449d64f1b6a5635a53e67d730dd57d5faf7',
        'mcp.schema.json': '5c885bb78328a0f47e2bd769de653c6c9f4479ac79eba0dbcd4d4fdc011b4d17',
        'plugin.schema.json': '55f81e2b772afcdb4f9439b5ea09f0584257175d4ed953a0104261f1114d37cc',
      },
      version: '2.1.232',
    },
    codex: {
      hashes: {
        'hooks.schema.json': 'e42eef736997b9abb8f28b2ee9262f5c7b1f7f11d8289e9c25da8cc94a504eff',
        'marketplace.schema.json': '1d43c5ed19de401fb7455c5912e4c21113f6e387aef4c28d2eca121f7554c4e8',
        'mcp.schema.json': '75bd50f9fcb85c2e8d43bc132d61c172a02f28ea8bb77389816ae77b14a4257e',
        'plugin.schema.json': 'f6e8e7d2ecb48c50ffa850d1a8190ad85ceffec705b8f0f39bb44a1d10aca0d9',
      },
      version: '0.147.0',
    },
  } as const;

  for (const [host, expected] of Object.entries(hosts)) {
    const schemaRoot = new URL(`../src/adapters/schemas/${host}/`, import.meta.url);
    const contractRoot = new URL(`../fixtures/contracts/${host}/`, import.meta.url);
    const provenance = JSON.parse(await readFile(new URL('PROVENANCE.json', schemaRoot), 'utf8')) as {
      readonly observedCliVersion: string;
      readonly schemas: Record<string, { readonly sha256: string }>;
    };
    const contract = JSON.parse(await readFile(new URL('capabilities.json', contractRoot), 'utf8')) as {
      readonly observedCliVersion: string;
    };
    const help = await readFile(new URL('cli-help.txt', contractRoot), 'utf8');

    expect(provenance.observedCliVersion).toBe(expected.version);
    expect(contract.observedCliVersion).toBe(expected.version);
    expect(help).toContain(`version: ${expected.version}`);
    expect(help).not.toMatch(/(?:\/home\/|logged in|credential state|session id)/i);
    for (const [name, hash] of Object.entries(expected.hashes)) {
      const schema = await readFile(new URL(name, schemaRoot));
      expect(createHash('sha256').update(schema).digest('hex')).toBe(hash);
      expect(provenance.schemas[name]?.sha256).toBe(hash);
    }
  }

  const codexValidatorFixture = JSON.parse(
    await readFile(new URL('../fixtures/contracts/codex/marketplace-validator.json', import.meta.url), 'utf8'),
  ) as {
    readonly marketplace: { readonly interface: { readonly required: readonly string[] } };
    readonly observedCliVersion: string;
    readonly plugin: { readonly interface: { readonly required: readonly string[] } };
  };
  expect(codexValidatorFixture).toEqual({
    marketplace: { interface: { required: ['displayName'] } },
    observedCliVersion: '0.147.0',
    plugin: { interface: { required: ['displayName', 'developerName', 'capabilities', 'defaultPrompt'] } },
  });
});

it.each(['codex', 'claude'] as const)('copies project assets selected for %s and skips other hosts', (target) => {
  const assetProvenance = Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' });
  const entries = planEntries({
    ...plugin,
    assets: [
      {
        bytes: 6,
        id: 'asset:logo.svg',
        name: 'logo.svg',
        provenance: assetProvenance,
        relativePath: 'logo.svg',
        source: '/workspace/assets/logo.svg',
        targets: ['codex', 'claude'],
      },
      {
        bytes: 3,
        id: 'asset:other.png',
        name: 'other.png',
        provenance: assetProvenance,
        relativePath: 'other.png',
        source: '/workspace/assets/other.png',
        targets: ['portable'],
      },
    ],
  }, target);

  expect(entries.filter((entry) => entry.relativePath.startsWith('assets/'))).toEqual([{
    bytes: 6,
    kind: 'copy',
    relativePath: 'assets/logo.svg',
    source: '/workspace/assets/logo.svg',
    sourceInputs: ['/workspace/assets/logo.svg'],
  }]);
});

it('plans byte-stable native Codex and Claude plugin trees from the same frozen model', async () => {
  const registry = createDefaultRegistry();
  expect(registry.names()).toEqual(['portable', 'codex', 'claude']);
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(Object.isFrozen(plugin)).toBe(true);

  const codex = planEntries(plugin, 'codex');
  const claude = planEntries(plugin, 'claude');
  expect(codex.map((entry) => entry.relativePath)).toEqual([
    '.agents/plugins/marketplace.json',
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'skills/review/SKILL.md',
    'skills/review/assets/icon.bin',
    'skills/review/references/guide.md',
  ]);
  expect(claude.map((entry) => entry.relativePath)).toEqual([
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'skills/review/SKILL.md',
    'skills/review/assets/icon.bin',
    'skills/review/references/guide.md',
  ]);
  expect(codex).toMatchObject([
    {
      content: '{"interface":{"displayName":"review-tools"},"name":"review-tools-marketplace","plugins":[{"category":"Productivity","name":"review-tools","policy":{"authentication":"ON_INSTALL","installation":"AVAILABLE"},"source":{"path":"./","source":"local"}}]}\n',
      kind: 'write',
      relativePath: '.agents/plugins/marketplace.json',
    },
    {
      content: '{"author":{"name":"review-tools"},"description":"Review code and explain findings.","interface":{"capabilities":["mcp","skills"],"category":"Productivity","defaultPrompt":["Help me use review-tools."],"developerName":"review-tools","displayName":"review-tools","longDescription":"Review code and explain findings.","shortDescription":"Review code and explain findings."},"mcpServers":"./.mcp.json","name":"review-tools","skills":"./skills/","version":"1.2.3"}\n',
      kind: 'write',
      relativePath: '.codex-plugin/plugin.json',
    },
    {
      content: '{"mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"streamable-http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","./tools/server.mjs"],"command":"node","cwd":"./","env":{"CACHE_DIR":"cache"},"type":"stdio"}}}\n',
      kind: 'write',
      relativePath: '.mcp.json',
    },
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/skills/review/references/guide.md' },
  ]);
  expect(claude).toMatchObject([
    {
      content: '{"description":"Review code and explain findings.","name":"review-tools-marketplace","owner":{"name":"review-tools"},"plugins":[{"description":"Review code and explain findings.","name":"review-tools","source":"./","version":"1.2.3"}]}\n',
      kind: 'write',
      relativePath: '.claude-plugin/marketplace.json',
    },
    {
      content: '{"author":{"name":"review-tools"},"description":"Review code and explain findings.","name":"review-tools","version":"1.2.3"}\n',
      kind: 'write',
      relativePath: '.claude-plugin/plugin.json',
    },
    {
      content: '{"mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","${CLAUDE_PLUGIN_ROOT}/tools/server.mjs"],"command":"node","cwd":"${CLAUDE_PLUGIN_ROOT}","env":{"CACHE_DIR":"cache"},"type":"stdio"}}}\n',
      kind: 'write',
      relativePath: '.mcp.json',
    },
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/skills/review/references/guide.md' },
  ]);
  expect(codex.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/agent-bundle.config.ts', '/workspace/skills/review/SKILL.md'],
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/skills/review/SKILL.md'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/assets/icon.bin'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/references/guide.md'],
  ]);
  expect(claude.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/agent-bundle.config.ts', '/workspace/skills/review/SKILL.md'],
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/skills/review/SKILL.md'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/assets/icon.bin'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/references/guide.md'],
  ]);
  await validateDocuments('codex', writeContents(plugin, 'codex'));
  await validateDocuments('claude', writeContents(plugin, 'claude'));
});

it.each(['codex', 'claude'] as const)(
  'rejects a hostile normalized legacy MCP transport without emitting %s MCP configuration',
  (target) => {
    const model = {
      ...plugin,
      mcpServers: [{
        id: 'mcp:events',
        name: 'events',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: [target],
        transport: 'sse' as unknown as 'streamable-http',
        url: 'https://mcp.example.test/events',
      }],
    } satisfies NormalizedPlugin;
    const adapter = createDefaultRegistry().get(target);
    const plan = adapter.plan(model);

    expect(plan.diagnostics).toEqual([{
      code: 'AB4339',
      message: 'MCP server "events" uses unsupported transport "sse".',
      severity: 'error',
      sourcePath: '/workspace/agent-bundle.config.ts',
    }]);
    expect(plan.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
  },
);

it.each(['codex', 'claude'] as const)(
  'snapshots a changing MCP transport once per direct %s plan',
  (target) => {
    const alternatingServer = () => {
      let reads = 0;
      const server = {
        command: 'node',
        id: 'mcp:events',
        name: 'events',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: [target],
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
    const adapter = createDefaultRegistry().get(target);
    const planned = alternatingServer();
    const plan = adapter.plan({ ...plugin, mcpServers: [planned.server] });
    const mcp = plan.entries.find((entry) => entry.kind === 'write' && entry.relativePath === '.mcp.json');
    const validated = alternatingServer();

    expect(plan.diagnostics).toEqual([]);
    expect(JSON.parse((mcp as Extract<typeof mcp, { readonly kind: 'write' }>).content)).toMatchObject({
      mcpServers: { events: { command: 'node', type: 'stdio' } },
    });
    expect(planned.reads()).toBe(1);
    expect(adapter.plan({ ...plugin, mcpServers: [validated.server] }).diagnostics).toEqual([]);
    expect(validated.reads()).toBe(1);
  },
);

it.each(['codex', 'claude'] as const)(
  'contains an unreadable proxy transport as a direct %s model diagnostic',
  (target) => {
    const server = new Proxy({
      id: 'mcp:events',
      name: 'events',
      provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: [target],
      transport: 'stdio' as const,
    }, {
      get: (value, property, receiver) => {
        if (property === 'transport') throw new Error('unreadable transport');
        return Reflect.get(value, property, receiver);
      },
    }) as NormalizedPlugin['mcpServers'][number];
    const adapter = createDefaultRegistry().get(target);
    const model = { ...plugin, mcpServers: [server] };

    expect(adapter.plan(model).diagnostics).toEqual([expect.objectContaining({ code: 'AB4339' })]);
  },
);

it('keeps Codex plugin and marketplace interface validator contracts separate', () => {
  const documents = writeContents(plugin, 'codex');
  const pluginManifest = JSON.parse(documents['.codex-plugin/plugin.json']!) as {
    readonly interface: Record<string, unknown>;
  };
  const marketplace = JSON.parse(documents['.agents/plugins/marketplace.json']!) as {
    readonly interface: Record<string, unknown>;
  };

  expect(pluginManifest.interface).toMatchObject({
    capabilities: ['mcp', 'skills'],
    defaultPrompt: ['Help me use review-tools.'],
    developerName: 'review-tools',
  });
  expect(marketplace.interface).toEqual({ displayName: 'review-tools' });
});

it('records every selected component provenance for generated host documents', () => {
  const model = {
    ...plugin,
    hooks: [{
      event: 'sessionStart' as const,
      id: 'hook:session-start',
      name: 'session-start',
      provenance: { kind: 'config' as const, sourcePath: '/inputs/hook.config.ts' },
      source: '/inputs/hook-handler.ts',
      targets: ['codex', 'claude'],
      tools: [],
    }],
    mcpServers: plugin.mcpServers.map((server) => ({
      ...server,
      provenance: { kind: 'config' as const, sourcePath: '/inputs/mcp.config.ts' },
    })),
    metadata: {
      ...plugin.metadata,
      provenance: { kind: 'config' as const, sourcePath: '/inputs/plugin.config.ts' },
    },
    skills: plugin.skills.map((skill) => ({
      ...skill,
      provenance: { kind: 'conventional' as const, sourcePath: '/inputs/skills/review/SKILL.md' },
      source: '/inputs/skills/review/SKILL.md',
    })),
    targets: plugin.targets.map((target) => ({
      ...target,
      provenance: { kind: 'config' as const, sourcePath: `/inputs/${target.name}.target.ts` },
    })),
  } satisfies NormalizedPlugin;

  for (const target of ['codex', 'claude'] as const) {
    const byPath = Object.fromEntries(planEntries(model, target).map((entry) => [entry.relativePath, entry]));
    const common = [
      '/inputs/plugin.config.ts',
      `/inputs/${target}.target.ts`,
      '/inputs/mcp.config.ts',
      '/inputs/hook.config.ts',
      '/inputs/skills/review/SKILL.md',
    ];
    expect(byPath[target === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json']?.sourceInputs).toEqual(common);
    expect(byPath['.mcp.json']?.sourceInputs).toEqual([
      `/inputs/${target}.target.ts`,
      '/inputs/mcp.config.ts',
    ]);
    expect(byPath['hooks/hooks.json']?.sourceInputs).toEqual([
      `/inputs/${target}.target.ts`,
      '/inputs/hook.config.ts',
    ]);
    expect(byPath[target === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json']?.sourceInputs).toEqual([
      '/inputs/plugin.config.ts',
      `/inputs/${target}.target.ts`,
    ]);
  }
});

it('applies only native path-token semantics and surfaces exact capability diagnostics', () => {
  const codex = createDefaultRegistry().get('codex').plan({
    ...plugin,
    mcpServers: [
      {
        command: `prefix-${pathTokens.pluginRoot}`,
        id: 'mcp:embedded-root',
        name: 'embedded-root',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['codex'],
        transport: 'stdio',
      },
      {
        command: 'node',
        cwd: pathTokens.pluginRoot,
        env: { DATA: pathTokens.pluginData },
        id: 'mcp:data',
        name: 'data',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['codex'],
        transport: 'stdio',
      },
    ],
  });
  expect(codex.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'codex.mcp.token.plugin-root.embedded.command',
    'codex.mcp.token.plugin-data.env.DATA',
  ]);

  const claude = createDefaultRegistry().get('claude').plan({
    ...plugin,
    mcpServers: [
      {
        args: [`${pathTokens.workspaceRoot}/tool`],
        command: pathTokens.pluginRoot,
        cwd: pathTokens.pluginData,
        env: { WORKSPACE: pathTokens.workspaceRoot },
        id: 'mcp:workspace',
        name: 'workspace',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['claude'],
        transport: 'stdio',
      },
      {
        headers: { [pathTokens.pluginRoot]: 'literal' },
        id: 'mcp:header-key',
        name: 'header-key',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['claude'],
        transport: 'streamable-http',
        url: `https://mcp.example.test/${pathTokens.workspaceRoot}`,
      },
    ],
  });
  expect(claude.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'claude.mcp.token.headers.key',
  ]);
  expect(claude.entries.find((entry) => entry.relativePath === '.mcp.json')).toEqual({
    content: '{"mcpServers":{"workspace":{"args":["${CLAUDE_PROJECT_DIR}/tool"],"command":"${CLAUDE_PLUGIN_ROOT}","cwd":"${CLAUDE_PLUGIN_DATA}","env":{"WORKSPACE":"${CLAUDE_PROJECT_DIR}"},"type":"stdio"}}}\n',
    kind: 'write',
    relativePath: '.mcp.json',
    sourceInputs: ['/workspace/agent-bundle.config.ts'],
  });
});

it('requires an explicit plugin-root cwd before Codex can map leading root tokens to relative paths', () => {
  const plan = createDefaultRegistry().get('codex').plan({
    ...plugin,
    mcpServers: [{
      args: [`${pathTokens.pluginRoot}/tool`],
      command: `${pathTokens.pluginRoot}/bin/server`,
      env: { TOOL: `${pathTokens.pluginRoot}/env` },
      id: 'mcp:missing-root-cwd',
      name: 'missing-root-cwd',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: ['codex'],
      transport: 'stdio',
    }],
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'codex.mcp.token.plugin-root.cwd.required.command',
    'codex.mcp.token.plugin-root.cwd.required.args[0]',
    'codex.mcp.token.plugin-root.cwd.required.env.TOOL',
  ]);
  expect(plan.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
});

it('rejects Codex plugin-root paths that escape the explicit relative cwd', () => {
  const plan = createDefaultRegistry().get('codex').plan({
    ...plugin,
    mcpServers: [{
      command: `${pathTokens.pluginRoot}/../escape`,
      cwd: pathTokens.pluginRoot,
      id: 'mcp:escaped-root',
      name: 'escaped-root',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      targets: ['codex'],
      transport: 'stdio',
    }],
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'codex.mcp.token.plugin-root.escape.command',
  ]);
  expect(plan.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
});

it('rejects Claude path tokens in environment keys while expanding values in a valid server', () => {
  const plan = createDefaultRegistry().get('claude').plan({
    ...plugin,
    mcpServers: [
      {
        command: 'node',
        env: {
          DATA: pathTokens.pluginData,
          ROOT: pathTokens.pluginRoot,
          WORKSPACE: pathTokens.workspaceRoot,
        },
        id: 'mcp:valid-env',
        name: 'valid-env',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['claude'],
        transport: 'stdio',
      },
      {
        command: 'node',
        env: { [`PREFIX_${pathTokens.pluginRoot}`]: 'literal' },
        id: 'mcp:invalid-env-key',
        name: 'invalid-env-key',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['claude'],
        transport: 'stdio',
      },
    ],
  });

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['claude.mcp.token.env.key']);
  expect(plan.entries.find((entry) => entry.relativePath === '.mcp.json')).toEqual({
    content: '{"mcpServers":{"valid-env":{"command":"node","env":{"DATA":"${CLAUDE_PLUGIN_DATA}","ROOT":"${CLAUDE_PLUGIN_ROOT}","WORKSPACE":"${CLAUDE_PROJECT_DIR}"},"type":"stdio"}}}\n',
    kind: 'write',
    relativePath: '.mcp.json',
    sourceInputs: ['/workspace/agent-bundle.config.ts'],
  });
});

it('reports malformed remote MCP URLs through independently validated host schemas', () => {
  const invalidUrlServer = (target: 'codex' | 'claude') => ({
    id: `mcp:${target}-invalid-url`,
    name: `${target}-invalid-url`,
    provenance: { kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' },
    targets: [target],
    transport: 'streamable-http' as const,
    url: 'not a URL',
  });
  const codex = createDefaultRegistry().get('codex').plan({ ...plugin, mcpServers: [invalidUrlServer('codex')] });
  const claude = createDefaultRegistry().get('claude').plan({ ...plugin, mcpServers: [invalidUrlServer('claude')] });

  expect(codex.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['codex.schema.mcp']);
  expect(claude.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['claude.schema.mcp']);
  expect(codex.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
  expect(claude.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
});

it('filters host components and builds portable, Codex, and Claude target roots', async () => {
  const filtered = {
    ...plugin,
    mcpServers: plugin.mcpServers.map((server) => ({ ...server, targets: ['claude'] })),
    skills: plugin.skills.map((skill) => ({ ...skill, targets: ['claude'] })),
    targets: [plugin.targets[0]!],
  } satisfies NormalizedPlugin;
  const filteredPlan = createDefaultRegistry().get('codex').plan(filtered);
  expect(filteredPlan.entries.map((entry) => entry.relativePath)).toEqual([
    '.agents/plugins/marketplace.json',
    '.codex-plugin/plugin.json',
  ]);

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-adapter-'));
  const outputRoot = join(root, 'dist');
  const skillRoot = join(root, 'skills', 'review');
  const skillMarkdown = '---\nname: review\ndescription: Review code and explain findings.\n---\n# Review\n';
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
    writeFile(join(skillRoot, 'SKILL.md'), skillMarkdown),
    writeFile(join(skillRoot, 'references', 'guide.md'), '# Guide\n'),
  ]);
  const model: NormalizedPlugin = {
    ...plugin,
    hooks: [],
    metadata: {
      ...plugin.metadata,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    },
    skills: [{
      ...plugin.skills[0]!,
      dir: skillRoot,
      provenance: { kind: 'conventional', sourcePath: join(skillRoot, 'SKILL.md') },
      resources: [
        { bytes: Buffer.byteLength(skillMarkdown), relativePath: 'SKILL.md', source: join(skillRoot, 'SKILL.md') },
        { bytes: 8, relativePath: 'references/guide.md', source: join(skillRoot, 'references', 'guide.md') },
      ],
      source: join(skillRoot, 'SKILL.md'),
      targets: ['portable', 'codex', 'claude'],
    }],
    mcpServers: [],
    targets: [
      { id: 'target:portable', name: 'portable', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
      { id: 'target:codex', name: 'codex', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
      { id: 'target:claude', name: 'claude', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
    ],
  };

  try {
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await expect(readFile(join(outputRoot, 'portable', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    await expect(readFile(join(outputRoot, 'codex', '.codex-plugin', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    await expect(readFile(join(outputRoot, 'claude', '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    const manifest = JSON.parse(await readFile(join(outputRoot, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly path: string }[];
      readonly targets: readonly { readonly name: string }[];
    };
    expect(manifest.targets.map(({ name }) => name)).toEqual(['claude', 'codex', 'portable']);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'portable/plugin.json',
      'codex/.codex-plugin/plugin.json',
      'claude/.claude-plugin/plugin.json',
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
