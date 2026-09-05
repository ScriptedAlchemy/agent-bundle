import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect, it } from '@rstest/core';

import { cursorMarketplaceValidator } from '../src/adapters/cursor.ts';
import { isValidClaudeDependencyRange } from '../src/adapters/claude.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { emitPlanEntries } from '../src/build/emit.ts';
import { build } from './support/build.ts';
import { pathTokens, pluginRootEnvAnchor, type NormalizedPlugin } from '../src/core/types.ts';

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
      dir: '/workspace/src/skills/review',
      frontmatter: Object.freeze({ description: 'Review code and explain findings.', name: 'review' }),
      id: 'skill:review',
      name: 'review',
      provenance: Object.freeze({ kind: 'conventional' as const, sourcePath: '/workspace/src/skills/review/SKILL.md' }),
      resources: Object.freeze([
        Object.freeze({ bytes: 9, relativePath: 'SKILL.md', source: '/workspace/src/skills/review/SKILL.md' }),
        Object.freeze({ bytes: 3, relativePath: 'assets/icon.bin', source: '/workspace/src/skills/review/assets/icon.bin' }),
        Object.freeze({ bytes: 8, relativePath: 'references/guide.md', source: '/workspace/src/skills/review/references/guide.md' }),
      ]),
      source: '/workspace/src/skills/review/SKILL.md',
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

const withClaudeLsp = (
  model: NormalizedPlugin,
  lspServers: unknown,
  target = 'claude',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target,
      value: { lspServers },
    },
  },
});

const withClaudeUserConfig = (
  model: NormalizedPlugin,
  userConfig: unknown,
  target = 'claude',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/claude.config.ts' },
      target,
      value: { userConfig },
    },
  },
});

const withClaudeChannels = (
  model: NormalizedPlugin,
  channels: unknown,
  target = 'claude',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/channels.config.ts' },
      target,
      value: { channels },
    },
  },
});

const withClaudeBin = (
  model: NormalizedPlugin,
  files: NonNullable<NormalizedPlugin['hostBins']>[number]['files'],
  options: {
    readonly issue?: NonNullable<NormalizedPlugin['hostBins']>[number]['issue'];
    readonly source?: string;
    readonly target?: string;
  } = {},
): NormalizedPlugin => ({
  ...model,
  hostBins: [{
    files,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    source: options.source ?? '/workspace/tools',
    target: options.target ?? 'claude',
  }],
});

const withClaudePayloadDirectory = (
  model: NormalizedPlugin,
  field: 'hostOutputStyles' | 'hostWorkflows',
  files: NonNullable<NormalizedPlugin['hostOutputStyles']>[number]['files'],
  options: {
    readonly issue?: NonNullable<NormalizedPlugin['hostOutputStyles']>[number]['issue'];
    readonly source?: string;
    readonly target?: string;
  } = {},
): NormalizedPlugin => ({
  ...model,
  [field]: [{
    files,
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    source: options.source ?? (field === 'hostWorkflows' ? '/workspace/workflows' : '/workspace/styles'),
    target: options.target ?? 'claude',
  }],
});

const withClaudeSettings = (
  model: NormalizedPlugin,
  settings: unknown,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: { settings },
    },
  },
});

const withClaudeExperimental = (
  model: NormalizedPlugin,
  experimental: Readonly<{ readonly monitors?: unknown; readonly themes?: unknown }>,
  target = 'claude',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/experimental.config.ts' },
      target,
      value: experimental,
    },
  },
});

const withClaudeDependencies = (
  model: NormalizedPlugin,
  dependencies: unknown,
  target = 'claude',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/dependencies.config.ts' },
      target,
      value: { dependencies },
    },
  },
});

const withClaudeManifestMetadata = (
  model: NormalizedPlugin,
  manifestMetadata: Readonly<Record<string, unknown>>,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/manifest-metadata.config.ts' },
      target: 'claude',
      value: manifestMetadata,
    },
  },
});

const withCodexManifestMetadata = (
  model: NormalizedPlugin,
  manifestMetadata: Readonly<Record<string, unknown>>,
  target = 'codex',
): NormalizedPlugin => ({
  ...model,
  extensions: {
    codex: {
      id: 'extension:codex',
      key: 'codex',
      provenance: { kind: 'config', sourcePath: '/workspace/codex-manifest.config.ts' },
      target,
      value: manifestMetadata,
    },
  },
});

const withClaudeMarketplace = (
  model: NormalizedPlugin,
  marketplace: unknown,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/marketplace.config.ts' },
      target: 'claude',
      value: { marketplace },
    },
  },
});

const withCodexConfig = (
  model: NormalizedPlugin,
  value: Readonly<Record<string, unknown>>,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    codex: {
      id: 'extension:codex',
      key: 'codex',
      provenance: { kind: 'config', sourcePath: '/workspace/codex.config.ts' },
      target: 'codex',
      value,
    },
  },
});

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
  // Schema snapshot hashes are pinned by adapter-metadata.test.ts's rehash
  // test; this test pins the observed CLI versions and the redacted help text.
  const hosts = {
    claude: { version: '2.1.260' },
    codex: { version: '0.147.0' },
  } as const;

  for (const [host, expected] of Object.entries(hosts)) {
    const schemaRoot = new URL(`../src/adapters/schemas/${host}/`, import.meta.url);
    const contractRoot = new URL(`../fixtures/contracts/${host}/`, import.meta.url);
    const provenance = JSON.parse(await readFile(new URL('PROVENANCE.json', schemaRoot), 'utf8')) as {
      readonly observedCliVersion: string;
    };
    const contract = JSON.parse(await readFile(new URL('capabilities.json', contractRoot), 'utf8')) as {
      readonly observedCliVersion: string;
    };
    const help = await readFile(new URL('cli-help.txt', contractRoot), 'utf8');

    expect(provenance.observedCliVersion).toBe(expected.version);
    expect(contract.observedCliVersion).toBe(expected.version);
    expect(help).toContain(`version: ${expected.version}`);
    expect(help).not.toMatch(/(?:\/home\/|logged in|credential state|session id)/i);
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

it('lowers Claude commands with documented kebab-case frontmatter and body-only passthrough', () => {
  const model: NormalizedPlugin = {
    ...plugin,
    commands: [
      {
        body: 'Review the staged diff.\n',
        frontmatter: {
          allowedTools: ['Read', 'Grep'],
          argumentHint: '[path]',
          description: 'Review changes',
          disableModelInvocation: true,
          model: 'sonnet',
        },
        id: 'command:review',
        markdown: '---\ndescription: Review changes\ntargets:\n  - claude\n---\nReview the staged diff.\n',
        name: 'review',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/review.md' },
        source: '/workspace/src/commands/review.md',
        targets: ['claude'],
      },
      {
        body: '# Explain\n\nExplain this code.',
        frontmatter: {},
        id: 'command:explain',
        markdown: '# Explain\n\nExplain this code.',
        name: 'explain',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/explain.md' },
        source: '/workspace/src/commands/explain.md',
        targets: ['claude'],
      },
    ],
  };
  const documents = writeContents(model, 'claude');

  expect(documents['commands/review.md']).toBe([
    '---',
    'allowed-tools:',
    '  - Read',
    '  - Grep',
    'argument-hint: "[path]"',
    'description: Review changes',
    'disable-model-invocation: true',
    'model: sonnet',
    '---',
    'Review the staged diff.',
    '',
  ].join('\n'));
  expect(documents['commands/review.md']).not.toContain('targets:');
  expect(documents['commands/explain.md']).toBe('# Explain\n\nExplain this code.');
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('commands');

  const commandFree = planEntries(plugin, 'claude');
  expect(commandFree.some((entry) => entry.relativePath.startsWith('commands/'))).toBe(false);
});

it('emits validated Claude manifest metadata fields with extension provenance', async () => {
  const model = withClaudeManifestMetadata(plugin, {
    defaultEnabled: false,
    displayName: 'Review Tools',
    metadata: {
      catalog: 'security',
      entitlement: { tier: 'team' },
    },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(manifest).toMatchObject({
    kind: 'write',
    sourceInputs: [
      '/workspace/agent-bundle.config.ts',
      '/workspace/src/skills/review/SKILL.md',
      '/workspace/manifest-metadata.config.ts',
    ],
  });
  if (manifest?.kind !== 'write') throw new Error('Expected an emitted Claude plugin manifest.');
  expect(JSON.parse(manifest.content)).toMatchObject({
    defaultEnabled: false,
    displayName: 'Review Tools',
    metadata: {
      catalog: 'security',
      entitlement: { tier: 'team' },
    },
  });
  await validateDocuments('claude', writeContents(model, 'claude'));
});

it.each([
  {
    code: 'claude.manifest.displayName.invalid',
    declaration: { displayName: '   ' },
    label: 'a whitespace-only displayName',
  },
  {
    code: 'claude.manifest.metadata.invalid',
    declaration: { metadata: null },
    label: 'null metadata',
  },
  {
    code: 'claude.manifest.metadata.invalid',
    declaration: { metadata: [] },
    label: 'array metadata',
  },
  {
    code: 'claude.manifest.defaultEnabled.invalid',
    declaration: { defaultEnabled: 'false' },
    label: 'a non-boolean defaultEnabled',
  },
])('rejects $label without emitting Claude manifest metadata fields', ({ code, declaration }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeManifestMetadata(plugin, declaration));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
    target: 'claude',
  }));
  if (manifest?.kind !== 'write') throw new Error('Expected the base Claude plugin manifest.');
  const document = JSON.parse(manifest.content) as Record<string, unknown>;
  expect(document).not.toHaveProperty('defaultEnabled');
  expect(document).not.toHaveProperty('displayName');
  expect(document).not.toHaveProperty('metadata');
});

it('pins the closed Claude manifest metadata schema while keeping metadata free-form', async () => {
  const schema = (await import('../src/adapters/schemas/claude/plugin.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    author: { name: 'Agent Bundle' },
    description: 'Claude manifest metadata schema fixture.',
    name: 'claude-metadata-fixture',
    version: '1.0.0',
  };

  expect(validate({
    ...manifest,
    defaultEnabled: false,
    displayName: 'Claude Metadata Fixture',
    metadata: { catalog: 'security', nested: { rank: 1 }, tags: ['review'] },
  }), JSON.stringify(validate.errors)).toBe(true);
  for (const declaration of [
    { displayName: '' },
    { metadata: null },
    { metadata: [] },
    { defaultEnabled: 'false' },
    { homepage: 'https://example.test' },
    // Host-supported custom paths stay outside the generator-owned schema.
    { commands: './custom/deploy.md' },
  ]) {
    expect(validate({ ...manifest, ...declaration })).toBe(false);
  }
});

it('enriches the generated Claude marketplace with the complete authored catalog overlay', async () => {
  const model = withClaudeMarketplace(plugin, {
    $schema: 'https://example.test/claude-marketplace.schema.json',
    allowCrossMarketplaceDependenciesOn: ['acme-shared'],
    description: 'Acme review plugins.',
    metadata: {
      description: 'Legacy catalog description.',
      pluginRoot: './plugins',
      version: 'catalog-v2',
    },
    name: 'acme-review-tools',
    owner: {
      email: 'plugins@example.test',
      name: 'Acme Developer Experience',
      url: 'https://example.test/developer-experience',
    },
    plugin: {
      author: {
        email: 'review-tools@example.test',
        name: 'Review Tools Team',
        url: 'https://example.test/review-tools',
      },
      category: 'Developer Tools',
      defaultEnabled: false,
      description: 'Acme-specific code review automation.',
      displayName: 'Acme Review Tools',
      homepage: 'https://example.test/review-tools',
      keywords: ['review', 'security'],
      license: 'MIT',
      metadata: { catalogId: 'review-tools', tier: 'team' },
      relevance: {
        signals: {
          cli: ['git'],
          cwd: ['packages/review'],
          filesRead: ['**/*.ts'],
          hosts: ['api.example.test'],
          manifestDeps: [{
            file: '[/\\\\]package\\.json$',
            pattern: '"agent-bundle"\\s*:',
          }],
        },
        topic: 'Code review',
      },
      repository: 'https://github.com/acme/review-tools',
      strict: false,
      tags: ['code-quality'],
      version: 'catalog-v2',
    },
    renames: {
      'legacy-review-tools': 'review-tools',
      'removed-review-tools': null,
    },
    version: '2',
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const marketplace = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/marketplace.json');

  expect(plan.diagnostics).toEqual([]);
  expect(marketplace).toMatchObject({
    kind: 'write',
    sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/marketplace.config.ts'],
  });
  if (marketplace?.kind !== 'write') throw new Error('Expected an emitted Claude marketplace manifest.');
  expect(JSON.parse(marketplace.content)).toEqual({
    $schema: 'https://example.test/claude-marketplace.schema.json',
    allowCrossMarketplaceDependenciesOn: ['acme-shared'],
    description: 'Acme review plugins.',
    metadata: {
      description: 'Legacy catalog description.',
      pluginRoot: './plugins',
      version: 'catalog-v2',
    },
    name: 'acme-review-tools',
    owner: {
      email: 'plugins@example.test',
      name: 'Acme Developer Experience',
      url: 'https://example.test/developer-experience',
    },
    plugins: [{
      author: {
        email: 'review-tools@example.test',
        name: 'Review Tools Team',
        url: 'https://example.test/review-tools',
      },
      category: 'Developer Tools',
      defaultEnabled: false,
      description: 'Acme-specific code review automation.',
      displayName: 'Acme Review Tools',
      homepage: 'https://example.test/review-tools',
      keywords: ['review', 'security'],
      license: 'MIT',
      metadata: { catalogId: 'review-tools', tier: 'team' },
      name: 'review-tools',
      relevance: {
        signals: {
          cli: ['git'],
          cwd: ['packages/review'],
          filesRead: ['**/*.ts'],
          hosts: ['api.example.test'],
          manifestDeps: [{
            file: '[/\\\\]package\\.json$',
            pattern: '"agent-bundle"\\s*:',
          }],
        },
        topic: 'Code review',
      },
      repository: 'https://github.com/acme/review-tools',
      source: './',
      strict: false,
      tags: ['code-quality'],
      version: 'catalog-v2',
    }],
    renames: {
      'legacy-review-tools': 'review-tools',
      'removed-review-tools': null,
    },
    version: '2',
  });
  await validateDocuments('claude', writeContents(model, 'claude'));
});

it('counts Claude marketplace relevance topics by Unicode code point', () => {
  const topic = '😀'.repeat(64);
  const model = withClaudeMarketplace(plugin, {
    plugin: { relevance: { signals: { cli: ['git'] }, topic } },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(
    writeContents(model, 'claude')['.claude-plugin/marketplace.json']!,
  ).plugins[0].relevance.topic).toBe(topic);
});

it.each([
  ['./plugins/review-tools', undefined],
  ['review-tools', { pluginRoot: './plugins' }],
  [{ source: 'github', repo: 'acme/review-tools', ref: 'v1', sha: 'a'.repeat(40) }, undefined],
  [{ source: 'url', url: 'git@example.test:acme/review-tools.git', ref: 'main', sha: 'b'.repeat(40) }, undefined],
  [{
    source: 'git-subdir',
    url: 'acme/review-tools',
    path: 'plugins/review-tools',
    ref: 'main',
    sha: 'c'.repeat(40),
  }, undefined],
  [{
    source: 'npm',
    package: '@acme/review-tools',
    version: '^1.2.3',
    registry: 'https://npm.example.test',
  }, undefined],
  [{
    source: 'archive',
    url: 'https://artifacts.example.test/review-tools.zip',
    sha256: 'd'.repeat(64),
  }, undefined],
  [{ source: 'archive', url: 'https://artifacts.example.test' }, undefined],
  [{ source: 'command', command: 'review-tools plugin-path', timeout: 120, mode: 'copy' }, undefined],
  [{ source: 'command', command: 'review-tools plugin-path', mode: 'link' }, undefined],
] as const)('emits an authored Claude marketplace plugin source %#', (source, metadata) => {
  const marketplace = {
    ...(metadata === undefined ? {} : { metadata }),
    plugin: { source },
  };
  const document = writeContents(withClaudeMarketplace(plugin, marketplace), 'claude');

  expect(JSON.parse(document['.claude-plugin/marketplace.json']!)).toMatchObject({
    plugins: [{ source }],
  });
});

it.each([
  {
    code: 'claude.marketplace.plugin.source.relative.invalid',
    marketplace: { plugin: { source: './plugin\\..\\outside' } },
  },
  {
    code: 'claude.marketplace.metadata.pluginRoot.invalid',
    marketplace: {
      metadata: { pluginRoot: './plugins\\..\\outside' },
      plugin: { source: 'review-tools' },
    },
  },
])('rejects backslash traversal in Claude marketplace relative paths %#', ({ code, marketplace }) => {
  const model = withClaudeMarketplace(plugin, marketplace);
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    message: expect.stringMatching(/stays? inside the marketplace/u),
  }));
  expect(writeContents(model, 'claude')['.claude-plugin/marketplace.json']).toBeUndefined();
});

it('accepts archive entry authentication only for an archive source', () => {
  const source = {
    source: 'archive',
    url: 'https://artifacts.example.test/review-tools.zip',
    sha256: 'e'.repeat(64),
  };
  const document = writeContents(withClaudeMarketplace(plugin, {
    plugin: {
      headers: { Authorization: 'Bearer catalog-token' },
      headersHelper: '/opt/bin/mint-plugin-token',
      source,
      strict: false,
    },
  }), 'claude');

  expect(JSON.parse(document['.claude-plugin/marketplace.json']!)).toMatchObject({
    plugins: [{
      headers: { Authorization: 'Bearer catalog-token' },
      headersHelper: '/opt/bin/mint-plugin-token',
      source,
      strict: false,
    }],
  });
});

it.each([
  {
    code: 'claude.marketplace.declaration.invalid',
    marketplace: [],
  },
  {
    code: 'claude.marketplace.field.unknown',
    marketplace: { unknown: true },
  },
  {
    code: 'claude.marketplace.name.invalid',
    marketplace: { name: 'Not Valid' },
  },
  {
    code: 'claude.marketplace.name.reserved',
    marketplace: { name: 'claude-plugins-official' },
  },
  {
    code: 'claude.marketplace.owner.invalid',
    marketplace: { owner: [] },
  },
  {
    code: 'claude.marketplace.owner.email.invalid',
    marketplace: { owner: { email: 'not-an-email' } },
  },
  {
    code: 'claude.marketplace.allowCrossMarketplaceDependenciesOn.invalid',
    marketplace: { allowCrossMarketplaceDependenciesOn: [] },
  },
  {
    code: 'claude.marketplace.renames.invalid',
    marketplace: { renames: { 'Legacy Plugin': 'review-tools' } },
  },
  {
    code: 'claude.marketplace.plugin.field.unknown',
    marketplace: { plugin: { unknown: true } },
  },
  {
    code: 'claude.marketplace.plugin.headers.inapplicable',
    marketplace: { plugin: { headers: { Authorization: 'Bearer catalog-token' } } },
  },
  {
    code: 'claude.marketplace.plugin.headersHelper.inapplicable',
    marketplace: { plugin: { headersHelper: './scripts/headers.sh', strict: false } },
  },
  {
    code: 'claude.marketplace.plugin.source.invalid',
    marketplace: { plugin: { source: [] } },
  },
  {
    code: 'claude.marketplace.plugin.source.relative.invalid',
    marketplace: { plugin: { source: './../outside' } },
  },
  {
    code: 'claude.marketplace.plugin.source.relative.invalid',
    marketplace: { plugin: { source: 'review-tools' } },
  },
  {
    code: 'claude.marketplace.plugin.source.form.invalid',
    marketplace: { plugin: { source: { source: 'other' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.field.unknown',
    marketplace: { plugin: { source: { source: 'github', repo: 'acme/review-tools', depth: 1 } } },
  },
  {
    code: 'claude.marketplace.plugin.source.repo.invalid',
    marketplace: { plugin: { source: { source: 'github', repo: 'not-a-repository' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.url.invalid',
    marketplace: { plugin: { source: { source: 'url', url: 'ftp://example.test/plugin.git' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.path.invalid',
    marketplace: { plugin: { source: { source: 'git-subdir', url: 'acme/repo', path: '../plugin' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.ref.invalid',
    marketplace: { plugin: { source: { source: 'github', repo: 'acme/repo', ref: '' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.sha.invalid',
    marketplace: { plugin: { source: { source: 'github', repo: 'acme/repo', sha: 'abc123' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.package.invalid',
    marketplace: { plugin: { source: { source: 'npm', package: '@acme' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.version.invalid',
    marketplace: { plugin: { source: { source: 'npm', package: '@acme/review-tools', version: 'latest' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.registry.invalid',
    marketplace: { plugin: { source: { source: 'npm', package: '@acme/review-tools', registry: 'npm.example.test' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.url.invalid',
    marketplace: { plugin: { source: { source: 'archive', url: 'http://artifacts.example.test/plugin.zip' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.url.invalid',
    marketplace: { plugin: { source: { source: 'archive', url: 'https://169.254.169.254/plugin.zip' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.sha256.invalid',
    marketplace: { plugin: { source: { source: 'archive', url: 'https://example.test/plugin.zip', sha256: 'abc123' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.command.invalid',
    marketplace: { plugin: { source: { source: 'command', command: '   ' } } },
  },
  {
    code: 'claude.marketplace.plugin.source.timeout.invalid',
    marketplace: { plugin: { source: { source: 'command', command: 'plugin-path', timeout: 601 } } },
  },
  {
    code: 'claude.marketplace.plugin.source.mode.invalid',
    marketplace: { plugin: { source: { source: 'command', command: 'plugin-path', mode: 'move' } } },
  },
  {
    code: 'claude.marketplace.plugin.headers.invalid',
    marketplace: { plugin: { source: { source: 'archive', url: 'https://example.test/plugin.zip' }, headers: {} } },
  },
  {
    code: 'claude.marketplace.plugin.headersHelper.invalid',
    marketplace: {
      plugin: {
        source: { source: 'archive', url: 'https://example.test/plugin.zip' },
        headersHelper: '',
        strict: false,
      },
    },
  },
  {
    code: 'claude.marketplace.plugin.headersHelper.strict',
    marketplace: {
      plugin: {
        source: { source: 'archive', url: 'https://example.test/plugin.zip' },
        headersHelper: 'mint-token',
        strict: true,
      },
    },
  },
  {
    code: 'claude.marketplace.plugin.relevance.invalid',
    marketplace: { plugin: { relevance: { signals: {} } } },
  },
  {
    code: 'claude.marketplace.plugin.relevance.hosts.invalid',
    marketplace: { plugin: { relevance: { signals: { hosts: ['https://api.example.test/path'] } } } },
  },
])('rejects malformed authored Claude marketplace input with $code', ({ code, marketplace }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeMarketplace(plugin, marketplace));
  const document = writeContents(withClaudeMarketplace(plugin, marketplace), 'claude');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.stringMatching(/then rebuild\.$/u),
    severity: 'error',
    target: 'claude',
  }));
  expect(document['.claude-plugin/marketplace.json']).toBeUndefined();
});

it('pins the full closed Claude marketplace schema with the documented source matrix', async () => {
  const schema = (await import('../src/adapters/schemas/claude/marketplace.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    name: 'review-tools-marketplace',
    owner: { email: 'plugins@example.test', name: 'Review Tools', url: 'https://example.test' },
    plugins: [{
      headersHelper: './scripts/headers.sh',
      name: 'review-tools',
      relevance: { signals: { hosts: ['api.example.test'] }, topic: 'Review' },
      source: { source: 'archive', url: 'https://artifacts.example.test/review-tools.zip' },
      strict: false,
    }],
  };

  expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  const sourcePlugin = {
    name: manifest.plugins[0].name,
    relevance: manifest.plugins[0].relevance,
  };
  for (const source of [
    './plugins/review-tools',
    { source: 'github', repo: 'acme/review-tools', ref: 'main', sha: 'a'.repeat(40) },
    { source: 'url', url: 'https://git.example.test/acme/review-tools.git', sha: 'b'.repeat(40) },
    { source: 'git-subdir', url: 'acme/monorepo', path: 'plugins/review-tools' },
    { source: 'npm', package: '@acme/review-tools', version: '~1.2.3', registry: 'https://npm.example.test' },
    { source: 'archive', url: 'https://artifacts.example.test/review-tools.zip', sha256: 'c'.repeat(64) },
    { source: 'archive', url: 'https://artifacts.example.test' },
    { source: 'command', command: 'review-tools plugin-path', timeout: 60, mode: 'link' },
  ]) {
    expect(validate({
      ...manifest,
      plugins: [{ ...sourcePlugin, source }],
    }), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const invalid of [
    { ...manifest, unknown: true },
    { ...manifest, owner: { ...manifest.owner, unknown: true } },
    { ...manifest, plugins: [{ ...manifest.plugins[0], unknown: true }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: 'review-tools' }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: './../outside' }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: './plugin\\..\\outside' }] },
    { ...manifest, metadata: { pluginRoot: './plugins\\..\\outside' } },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'archive', url: 'https://localhost' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'archive', url: 'https://localhost/plugin.zip' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'archive', url: 'https://metadata' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'archive', url: 'https://metadata/plugin.zip' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'github', repo: 'acme/review-tools', extra: true } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'archive', url: 'https://example.test/plugin.zip', sha256: 'bad' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], source: { source: 'command', command: 'plugin-path', mode: 'move' } }] },
    { ...manifest, plugins: [{ ...manifest.plugins[0], relevance: { signals: { unknown: ['value'] } } }] },
  ]) {
    expect(validate(invalid)).toBe(false);
  }
});

it('emits validated Codex manifest package metadata with extension provenance', async () => {
  const model = withCodexManifestMetadata(plugin, {
    author: {
      email: 'plugins@example.test',
      name: 'Review Tools Team',
      url: 'https://example.test/review-tools',
    },
    homepage: 'https://example.test/review-tools/docs',
    keywords: ['review', 'security'],
    license: 'MIT',
    repository: 'https://github.com/example/review-tools',
  });
  const plan = createDefaultRegistry().get('codex').plan(model);
  const manifest = plan.entries.find((entry) => entry.relativePath === '.codex-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(manifest).toMatchObject({
    kind: 'write',
    sourceInputs: [
      '/workspace/agent-bundle.config.ts',
      '/workspace/src/skills/review/SKILL.md',
      '/workspace/codex-manifest.config.ts',
    ],
  });
  if (manifest?.kind !== 'write') throw new Error('Expected an emitted Codex plugin manifest.');
  expect(JSON.parse(manifest.content)).toMatchObject({
    author: {
      email: 'plugins@example.test',
      name: 'Review Tools Team',
      url: 'https://example.test/review-tools',
    },
    homepage: 'https://example.test/review-tools/docs',
    keywords: ['review', 'security'],
    license: 'MIT',
    repository: 'https://github.com/example/review-tools',
  });
  await validateDocuments('codex', writeContents(model, 'codex'));
});

it.each([
  {
    code: 'codex.manifest.author.invalid',
    declaration: { author: null },
    label: 'a null author',
  },
  {
    code: 'codex.manifest.author.invalid',
    declaration: { author: { name: 'Review Tools', unknown: true } },
    label: 'an author with an unknown field',
  },
  {
    code: 'codex.manifest.author.name.invalid',
    declaration: { author: { email: 'plugins@example.test' } },
    label: 'an author without a name',
  },
  {
    code: 'codex.manifest.author.name.invalid',
    declaration: { author: { name: '   ' } },
    label: 'a whitespace-only author name',
  },
  {
    code: 'codex.manifest.author.email.invalid',
    declaration: { author: { email: 'not-an-email', name: 'Review Tools' } },
    label: 'an invalid author email',
  },
  {
    code: 'codex.manifest.author.url.invalid',
    declaration: { author: { name: 'Review Tools', url: './profile' } },
    label: 'a relative author URL',
  },
  {
    code: 'codex.manifest.homepage.invalid',
    declaration: { homepage: './docs' },
    label: 'a relative homepage',
  },
  {
    code: 'codex.manifest.repository.invalid',
    declaration: { repository: 7 },
    label: 'a non-string repository',
  },
  {
    code: 'codex.manifest.license.invalid',
    declaration: { license: '   ' },
    label: 'a whitespace-only license',
  },
  {
    code: 'codex.manifest.keywords.invalid',
    declaration: { keywords: 'review' },
    label: 'non-array keywords',
  },
  {
    code: 'codex.manifest.keywords.invalid',
    declaration: { keywords: ['review', '   '] },
    label: 'keywords with an empty entry',
  },
])('rejects $label without emitting authored Codex manifest metadata', ({ code, declaration }) => {
  const plan = createDefaultRegistry().get('codex').plan(withCodexManifestMetadata(plugin, declaration));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.codex-plugin/plugin.json');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
    target: 'codex',
  }));
  if (manifest?.kind !== 'write') throw new Error('Expected the base Codex plugin manifest.');
  const document = JSON.parse(manifest.content) as Record<string, unknown>;
  expect(document.author).toEqual({ name: 'review-tools' });
  expect(document).not.toHaveProperty('homepage');
  expect(document).not.toHaveProperty('repository');
  expect(document).not.toHaveProperty('license');
  expect(document).not.toHaveProperty('keywords');
});

it('admits documented Codex component path and inline manifest forms', async () => {
  const schema = (await import('../src/adapters/schemas/codex/plugin.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    author: { name: 'Review Tools' },
    description: 'Codex path-form schema fixture.',
    interface: {
      capabilities: ['skills'],
      category: 'Productivity',
      defaultPrompt: ['Review this repository.'],
      developerName: 'Review Tools',
      displayName: 'Review Tools',
      longDescription: 'Review this repository with reusable workflows.',
      shortDescription: 'Repository review workflows.',
    },
    name: 'codex-path-fixture',
    version: '1.0.0',
  };
  const hookDocument = {
    hooks: {
      SessionStart: [{
        hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/start.mjs"', type: 'command' }],
      }],
    },
  };

  for (const componentFields of [
    { mcpServers: './config/mcp.json' },
    { hooks: './custom/hooks.json', mcpServers: './config/mcp.json', skills: './workflows/' },
    { hooks: ['./hooks/start.json', './hooks/tools.json'], skills: './skills/' },
    { hooks: hookDocument, mcpServers: { docs: { type: 'http', url: 'https://example.test/mcp' } }, skills: './skills/' },
    { hooks: [hookDocument], skills: './skills/' },
    {
      interface: {
        ...manifest.interface,
        composerIcon: './assets/icon.png',
        logo: './assets/logo.png',
        screenshots: ['./assets/overview.png', './assets/nested/detail.png'],
      },
      skills: './skills/',
    },
  ]) {
    expect(validate({ ...manifest, ...componentFields }), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const invalid of [
    { hooks: '../hooks.json', skills: './skills/' },
    { hooks: ['./hooks.json', '../outside.json'], skills: './skills/' },
    // Embedded line terminators must not hide a parent-directory segment from
    // the traversal lookahead (#364 review).
    { hooks: './hooks\n/../../outside.json', skills: './skills/' },
    { hooks: ['./hooks\r/../outside.json'], skills: './skills/' },
    { mcpServers: './mcp\u2028/../outside.json', skills: './skills/' },
    { skills: './skills\u2029/../../outside/' },
    { interface: { ...manifest.interface, logo: './assets\n/../../outside.png' }, skills: './skills/' },
    { interface: { ...manifest.interface, composerIcon: './icon\u2028/../../outside.png' }, skills: './skills/' },
    { interface: { ...manifest.interface, screenshots: ['./assets/../outside.png'] }, skills: './skills/' },
    { interface: { ...manifest.interface, screenshots: ['./assets/..\\..\\outside.png'] }, skills: './skills/' },
    { hooks: [], skills: './skills/' },
    { hooks: [{ description: 'missing hooks map' }], skills: './skills/' },
    { mcpServers: '../.mcp.json', skills: './skills/' },
    { mcpServers: { docs: 'not-an-object' }, skills: './skills/' },
    { skills: '../skills/' },
    { skills: ['./skills/'] },
    // Line terminators must not let a parent segment slip past the containment lookahead.
    { skills: './x\n/../../outside/' },
    { hooks: './x\r\n/../../outside.json', skills: './skills/' },
    { mcpServers: './x\u2028/../../outside.json', skills: './skills/' },
    { skills: './skills\u0000/' },
    { interface: { ...manifest.interface, logo: './x\n/../../outside.png' }, skills: './skills/' },
    { interface: { ...manifest.interface, composerIcon: './x\u2029/../../outside.png' }, skills: './skills/' },
  ]) {
    expect(validate({ ...manifest, ...invalid }), JSON.stringify(invalid)).toBe(false);
  }
});

it('plans byte-stable native Codex and Claude plugin trees from the same frozen model', async () => {
  const registry = createDefaultRegistry();
  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor']);
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(Object.isFrozen(plugin)).toBe(true);

  const codex = planEntries(plugin, 'codex');
  const claude = planEntries(plugin, 'claude');
  const codexPluginEntries = codex.filter((entry) => entry.relativePath !== 'INSTALL.md');
  const claudePluginEntries = claude.filter((entry) => entry.relativePath !== 'INSTALL.md');
  expect(codex.map((entry) => entry.relativePath)).toEqual([
    '.agents/plugins/marketplace.json',
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'INSTALL.md',
    'skills/review/SKILL.md',
    'skills/review/assets/icon.bin',
    'skills/review/references/guide.md',
  ]);
  expect(claude.map((entry) => entry.relativePath)).toEqual([
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    '.mcp.json',
    'INSTALL.md',
    'skills/review/SKILL.md',
    'skills/review/assets/icon.bin',
    'skills/review/references/guide.md',
  ]);
  expect(codexPluginEntries).toMatchObject([
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
      content: '{"mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"streamable-http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","./tools/server.mjs"],"command":"node","cwd":"./","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"./","CACHE_DIR":"cache"},"type":"stdio"}}}\n',
      kind: 'write',
      relativePath: '.mcp.json',
    },
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/src/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/src/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/src/skills/review/references/guide.md' },
  ]);
  expect(claudePluginEntries).toMatchObject([
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
      content: '{"mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","${CLAUDE_PLUGIN_ROOT}/tools/server.mjs"],"command":"node","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}","CACHE_DIR":"cache"},"type":"stdio"}}}\n',
      kind: 'write',
      relativePath: '.mcp.json',
    },
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/src/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/src/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/src/skills/review/references/guide.md' },
  ]);
  expect(codexPluginEntries.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/agent-bundle.config.ts', '/workspace/src/skills/review/SKILL.md'],
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/src/skills/review/SKILL.md'],
    ['/workspace/src/skills/review/SKILL.md', '/workspace/src/skills/review/assets/icon.bin'],
    ['/workspace/src/skills/review/SKILL.md', '/workspace/src/skills/review/references/guide.md'],
  ]);
  expect(claudePluginEntries.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/agent-bundle.config.ts', '/workspace/src/skills/review/SKILL.md'],
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/src/skills/review/SKILL.md'],
    ['/workspace/src/skills/review/SKILL.md', '/workspace/src/skills/review/assets/icon.bin'],
    ['/workspace/src/skills/review/SKILL.md', '/workspace/src/skills/review/references/guide.md'],
  ]);
  await validateDocuments('codex', writeContents(plugin, 'codex'));
  await validateDocuments('claude', writeContents(plugin, 'claude'));
});

it('emits a schema-valid Cursor marketplace document', () => {
  const model: NormalizedPlugin = {
    ...plugin,
    mcpServers: [],
    skills: [],
    targets: [{
      id: 'target:cursor',
      name: 'cursor',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    }],
  };
  const plan = createDefaultRegistry().get('cursor').plan(model);
  const marketplace = plan.entries.find((entry) => entry.relativePath === '.cursor-plugin/marketplace.json');

  expect(plan.diagnostics).toEqual([]);
  expect(marketplace).toMatchObject({
    content: '{"name":"review-tools-marketplace","owner":{"name":"review-tools"},"plugins":[{"description":"Review code and explain findings.","name":"review-tools","source":"./"}]}\n',
    kind: 'write',
  });
  if (marketplace?.kind !== 'write') throw new Error('Expected an emitted Cursor marketplace document.');
  expect(cursorMarketplaceValidator(JSON.parse(marketplace.content))).toBe(true);
});

it('diagnoses a plain Cursor workspaceOpen hook instead of lowering a session-scoped wrapper', () => {
  const model: NormalizedPlugin = {
    ...plugin,
    hooks: [{
      event: 'workspaceOpen',
      id: 'hook:workspace-open',
      name: 'workspace-open',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      source: '/workspace/src/hooks/workspace-open.ts',
      targets: ['cursor'],
      tools: [],
    }],
    marketplace: undefined,
    mcpServers: [],
    skills: [],
    targets: [{
      id: 'target:cursor',
      name: 'cursor',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    }],
  };
  const plan = createDefaultRegistry().get('cursor').plan(model);

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code: 'cursor.hook.event.workspace-open',
    message: expect.stringContaining('cannot map canonical hook event "workspaceOpen"'),
  }));
  expect(plan.entries.some((entry) => entry.relativePath === 'hooks/hooks.json')).toBe(false);
});

it('plans a Cursor workspace/open event route without enabling the plain hook vocabulary', () => {
  const model: NormalizedPlugin = {
    ...plugin,
    hooks: [{
      event: 'workspaceOpen',
      eventRoute: { event: 'workspace/open', fallback: 'none', runtime: 'shared' },
      id: 'hook:event-route:workspace-open',
      name: 'event-route-workspace-open',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/events/workspace/open.tsx' },
      source: '/workspace/src/events/workspace/open.tsx',
      targets: ['cursor'],
      tools: [],
    }],
    marketplace: undefined,
    mcpServers: [],
    skills: [],
    targets: [{
      id: 'target:cursor',
      name: 'cursor',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    }],
  };
  const plan = createDefaultRegistry().get('cursor').plan(model);
  const hooks = plan.entries.find((entry) => entry.relativePath === 'hooks/hooks.json');

  expect(plan.diagnostics).toEqual([]);
  expect(hooks?.kind).toBe('write');
  expect(JSON.parse(hooks?.kind === 'write' ? hooks.content : '{}')).toEqual({
    hooks: {
      workspaceOpen: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/event-route-workspace-open.mjs"',
      }],
    },
    version: 1,
  });
  expect(plan.hookEntries).toContainEqual(expect.objectContaining({
    nativeEvent: 'workspaceOpen',
    relativePath: 'hooks/event-route-workspace-open.mjs',
    target: 'cursor',
  }));
});

it('anchors compiled Claude MCP entries with absolute arguments and the env anchor', () => {
  const compiled = {
    ...plugin,
    mcpServers: Object.freeze([Object.freeze({
      ...plugin.mcpServers[0],
      args: Object.freeze(['mcp/compiled-server.mjs']),
      source: '/workspace/server.ts',
    })]),
  } satisfies NormalizedPlugin;
  const entry = planEntries(compiled, 'claude').find((candidate) => candidate.relativePath === '.mcp.json');
  expect(entry?.kind).toBe('write');
  const document = JSON.parse(entry?.kind === 'write' ? entry.content : '{}') as {
    mcpServers: Record<string, { args?: string[]; cwd?: string; env?: Record<string, string> }>;
  };
  // Claude's placeholder table does not substitute MCP cwd. The absolute
  // entry path and env anchor keep the generated server independent of cwd.
  expect(document.mcpServers.stdio).toMatchObject({
    args: ['${CLAUDE_PLUGIN_ROOT}/mcp/compiled-server.mjs'],
    env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}', CACHE_DIR: 'cache' },
  });
  expect(document.mcpServers.stdio).not.toHaveProperty('cwd');
});

it('emits Claude LSP configuration and expands only the four documented token fields', () => {
  const model = withClaudeLsp(plugin, {
    typescript: {
      args: [
        `--plugin=${pathTokens.pluginRoot}`,
        `--data=${pathTokens.pluginData}`,
        `--workspace=${pathTokens.workspaceRoot}`,
      ],
      command: `${pathTokens.pluginRoot}/bin/typescript-language-server`,
      diagnostics: false,
      env: {
        DATA: `${pathTokens.pluginData}/lsp`,
        ROOT: pathTokens.pluginRoot,
        WORKSPACE: pathTokens.workspaceRoot,
      },
      extensionToLanguage: { '.ts': 'typescript' },
      initializationOptions: { token: 'literal' },
      maxRestarts: 3,
      restartOnCrash: true,
      settings: { token: 'literal' },
      shutdownTimeout: 2_000,
      startupTimeout: 5_000,
      transport: 'socket',
      workspaceFolder: `${pathTokens.workspaceRoot}/packages`,
    },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const documents = writeContents(model, 'claude');

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.lsp.json']!)).toEqual({
    typescript: {
      args: [
        '--plugin=${CLAUDE_PLUGIN_ROOT}',
        '--data=${CLAUDE_PLUGIN_DATA}',
        '--workspace=${CLAUDE_PROJECT_DIR}',
      ],
      command: '${CLAUDE_PLUGIN_ROOT}/bin/typescript-language-server',
      diagnostics: false,
      env: {
        DATA: '${CLAUDE_PLUGIN_DATA}/lsp',
        ROOT: '${CLAUDE_PLUGIN_ROOT}',
        WORKSPACE: '${CLAUDE_PROJECT_DIR}',
      },
      extensionToLanguage: { '.ts': 'typescript' },
      initializationOptions: { token: 'literal' },
      maxRestarts: 3,
      restartOnCrash: true,
      settings: { token: 'literal' },
      shutdownTimeout: 2_000,
      startupTimeout: 5_000,
      transport: 'socket',
      workspaceFolder: '${CLAUDE_PROJECT_DIR}/packages',
    },
  });
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('lspServers');
});

it('rejects Claude path substitutions in undocumented LSP fields', () => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeLsp(plugin, {
    typescript: {
      command: 'typescript-language-server',
      extensionToLanguage: { '.ts': `typescript-${pathTokens.pluginRoot}` },
      initializationOptions: { data: '${CLAUDE_PLUGIN_DATA}' },
    },
  }));

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'claude.substitution.token.unsupported',
    'claude.substitution.token.unsupported',
  ]);
  expect(plan.entries.some((entry) => entry.relativePath === '.lsp.json')).toBe(false);
});

it('emits sorted, allowlisted Claude userConfig declarations with config provenance', () => {
  const model = withClaudeUserConfig(plugin, {
    z_count: {
      default: 3,
      description: 'Maximum findings.',
      max: 10,
      min: 1,
      required: true,
      title: 'Finding limit',
      type: 'number',
    },
    api_token: {
      description: 'API authentication token.',
      sensitive: true,
      title: 'API token',
      type: 'string',
    },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(manifest).toMatchObject({
    kind: 'write',
    sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/src/skills/review/SKILL.md', '/workspace/claude.config.ts'],
  });
  if (manifest?.kind !== 'write') throw new Error('Expected an emitted Claude plugin manifest.');
  expect(JSON.parse(manifest.content).userConfig).toEqual({
    api_token: {
      description: 'API authentication token.',
      sensitive: true,
      title: 'API token',
      type: 'string',
    },
    z_count: {
      default: 3,
      description: 'Maximum findings.',
      max: 10,
      min: 1,
      required: true,
      title: 'Finding limit',
      type: 'number',
    },
  });
  expect(manifest.content.indexOf('"api_token"')).toBeLessThan(manifest.content.indexOf('"z_count"'));
});

it.each([
  {
    code: 'claude.userConfig.declaration.invalid',
    label: 'an empty declaration',
    userConfig: {},
  },
  {
    code: 'claude.userConfig.option.invalid',
    label: 'a non-object option',
    userConfig: { token: 'string' },
  },
  {
    code: 'claude.userConfig.key.invalid',
    label: 'an invalid identifier',
    userConfig: { 'api-token': { description: 'Token.', title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.key.collision',
    label: 'environment-variable keys that collide after uppercasing',
    userConfig: {
      ApiKey: { description: 'First.', title: 'First', type: 'string' },
      APIKEY: { description: 'Second.', title: 'Second', type: 'string' },
    },
  },
  {
    code: 'claude.userConfig.field.unknown',
    label: 'an unknown option field',
    userConfig: { token: { description: 'Token.', title: 'Token', type: 'string', typo: true } },
  },
  {
    code: 'claude.userConfig.type.invalid',
    label: 'an unsupported type',
    userConfig: { token: { description: 'Token.', title: 'Token', type: 'secret' } },
  },
  {
    code: 'claude.userConfig.title.required',
    label: 'an empty title',
    userConfig: { token: { description: 'Token.', title: '', type: 'string' } },
  },
  {
    code: 'claude.userConfig.description.required',
    label: 'a missing description',
    userConfig: { token: { title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.sensitive.invalid',
    label: 'a non-boolean sensitive flag',
    userConfig: { token: { description: 'Token.', sensitive: 'yes', title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.required.invalid',
    label: 'a non-boolean required flag',
    userConfig: { token: { description: 'Token.', required: 1, title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.multiple.invalid',
    label: 'multiple on a non-string option',
    userConfig: { count: { description: 'Count.', multiple: true, title: 'Count', type: 'number' } },
  },
  {
    code: 'claude.userConfig.multiple.invalid',
    label: 'a non-boolean multiple flag',
    userConfig: { token: { description: 'Token.', multiple: 'yes', title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.min.invalid',
    label: 'min on a non-number option',
    userConfig: { token: { description: 'Token.', min: 1, title: 'Token', type: 'string' } },
  },
  {
    code: 'claude.userConfig.max.invalid',
    label: 'a non-number max bound',
    userConfig: { count: { description: 'Count.', max: 'ten', title: 'Count', type: 'number' } },
  },
  {
    code: 'claude.userConfig.bounds.invalid',
    label: 'inverted numeric bounds',
    userConfig: { count: { description: 'Count.', max: 1, min: 2, title: 'Count', type: 'number' } },
  },
  {
    code: 'claude.userConfig.default.invalid',
    label: 'a string-array default without multiple',
    userConfig: { tags: { default: ['one'], description: 'Tags.', title: 'Tags', type: 'string' } },
  },
  {
    code: 'claude.userConfig.default.invalid',
    label: 'a scalar string default with multiple',
    userConfig: { tags: { default: 'one', description: 'Tags.', multiple: true, title: 'Tags', type: 'string' } },
  },
  {
    code: 'claude.userConfig.default.invalid',
    label: 'a numeric default outside bounds',
    userConfig: { count: { default: 11, description: 'Count.', max: 10, title: 'Count', type: 'number' } },
  },
  {
    code: 'claude.userConfig.default.invalid',
    label: 'a mismatched file default',
    userConfig: { file: { default: false, description: 'File.', title: 'File', type: 'file' } },
  },
  {
    code: 'claude.userConfig.sensitive.default',
    label: 'a sensitive option with a manifest default',
    userConfig: { token: { default: 'secret', description: 'Token.', sensitive: true, title: 'Token', type: 'string' } },
  },
])('rejects $label without emitting userConfig', ({ code, userConfig }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeUserConfig(plugin, userConfig));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
  }));
  if (manifest?.kind !== 'write') throw new Error('Expected the base Claude plugin manifest.');
  expect(JSON.parse(manifest.content)).not.toHaveProperty('userConfig');
});

it('pins the closed Claude userConfig manifest schema', async () => {
  const schema = (await import('../src/adapters/schemas/claude/plugin.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    author: { name: 'Agent Bundle' },
    description: 'Claude userConfig schema fixture.',
    name: 'claude-user-config-fixture',
    version: '1.0.0',
  };
  const option = { description: 'API token.', title: 'API token', type: 'string' };

  expect(validate({ ...manifest, userConfig: { api_token: option } })).toBe(true);
  for (const userConfig of [
    {},
    { 'api-token': option },
    { token: { ...option, unknown: true } },
    { token: { description: 'Missing title.', type: 'string' } },
    { token: { ...option, type: 'secret' } },
  ]) {
    expect(validate({ ...manifest, userConfig })).toBe(false);
  }
});

it('emits Claude channels bound to planned MCP servers with per-channel sensitive userConfig', () => {
  const model = withClaudeChannels(plugin, [
    {
      server: 'stdio',
      userConfig: {
        bot_token: {
          description: 'Telegram bot token.',
          sensitive: true,
          title: 'Bot token',
          type: 'string',
        },
      },
    },
    { server: 'stdio' },
    { server: 'http' },
  ]);
  const plan = createDefaultRegistry().get('claude').plan(model);
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(manifest).toMatchObject({
    kind: 'write',
    sourceInputs: expect.arrayContaining(['/workspace/channels.config.ts']),
  });
  if (manifest?.kind !== 'write') throw new Error('Expected an emitted Claude plugin manifest.');
  expect(JSON.parse(manifest.content).channels).toEqual([
    {
      server: 'stdio',
      userConfig: {
        bot_token: {
          description: 'Telegram bot token.',
          sensitive: true,
          title: 'Bot token',
          type: 'string',
        },
      },
    },
    { server: 'stdio' },
    { server: 'http' },
  ]);
});

it.each([
  { channels: [], code: 'claude.channels.declaration.invalid', label: 'an empty channels declaration' },
  { channels: ['stdio'], code: 'claude.channels.entry.invalid', label: 'a non-object channel entry' },
  { channels: [{ server: 'stdio', typo: true }], code: 'claude.channels.field.unknown', label: 'an unknown channel field' },
  { channels: [{}], code: 'claude.channels.server.required', label: 'a missing channel server' },
  { channels: [{ server: '' }], code: 'claude.channels.server.required', label: 'an empty channel server' },
  { channels: [{ server: 'missing' }], code: 'claude.channels.server.unknown', label: 'a channel bound to an undeclared MCP server' },
  { channels: [{ server: 'stdio', userConfig: {} }], code: 'claude.channels.userConfig.invalid', label: 'an empty per-channel userConfig' },
  {
    channels: [{
      server: 'stdio',
      userConfig: { 'bot-token': { description: 'Token.', title: 'Token', type: 'string' } },
    }],
    code: 'claude.channels.key.invalid',
    label: 'an invalid per-channel option key',
  },
  {
    channels: [{
      server: 'stdio',
      userConfig: {
        BotToken: { description: 'First.', title: 'First', type: 'string' },
        BOTTOKEN: { description: 'Second.', title: 'Second', type: 'string' },
      },
    }],
    code: 'claude.channels.key.collision',
    label: 'per-channel environment keys that collide after uppercasing',
  },
  {
    channels: [{
      server: 'stdio',
      userConfig: { bot_token: { description: 'Token.', title: 'Token', type: 'secret' } },
    }],
    code: 'claude.channels[0].userConfig.type.invalid',
    label: 'an invalid per-channel option declaration',
  },
])('rejects $label without emitting channels', ({ channels, code }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeChannels(plugin, channels));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
  }));
  if (manifest?.kind !== 'write') throw new Error('Expected the base Claude plugin manifest.');
  expect(JSON.parse(manifest.content)).not.toHaveProperty('channels');
});

it('rejects channels when no Claude MCP servers are planned', () => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeChannels({
    ...plugin,
    mcpServers: [],
  }, [{ server: 'stdio' }]));

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code: 'claude.channels.server.unknown',
    message: expect.stringContaining('no plugin MCP servers'),
  }));
});

it('rejects a channel when its MCP server prevents the MCP document from emitting', () => {
  const invalidMcpModel = {
    ...plugin,
    mcpServers: plugin.mcpServers.map((server) =>
      server.name === 'http' ? { ...server, url: 'not a URL' } : server),
  } satisfies NormalizedPlugin;
  const plan = createDefaultRegistry().get('claude').plan(withClaudeChannels(
    invalidMcpModel,
    [{ server: 'http' }],
  ));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'claude.schema.mcp',
    'claude.channels.server.unknown',
  ]);
  expect(plan.entries.some((entry) => entry.relativePath === '.mcp.json')).toBe(false);
  if (manifest?.kind !== 'write') throw new Error('Expected the base Claude plugin manifest.');
  expect(JSON.parse(manifest.content)).not.toHaveProperty('channels');
});

it('pins the closed Claude channels manifest schema', async () => {
  const schema = (await import('../src/adapters/schemas/claude/plugin.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    author: { name: 'Agent Bundle' },
    description: 'Claude channels schema fixture.',
    name: 'claude-channels-fixture',
    version: '1.0.0',
  };
  const option = {
    description: 'Telegram bot token.',
    sensitive: true,
    title: 'Bot token',
    type: 'string',
  };

  expect(validate({
    ...manifest,
    channels: [{ server: 'telegram', userConfig: { bot_token: option } }],
  })).toBe(true);
  for (const channels of [
    [],
    [{}],
    [{ server: '' }],
    [{ server: 'telegram', unknown: true }],
    [{ server: 'telegram', userConfig: {} }],
    [{ server: 'telegram', userConfig: { 'bot-token': option } }],
  ]) {
    expect(validate({ ...manifest, channels })).toBe(false);
  }
});

it('plans Claude bin files as byte-faithful prebuilt copies with complete provenance', () => {
  const model = withClaudeBin(plugin, [
    {
      bytes: 37,
      executable: true,
      relativePath: 'review-tool',
      source: '/workspace/tools/review-tool',
    },
    {
      bytes: 12,
      executable: false,
      relativePath: 'lib/config.json',
      source: '/workspace/tools/lib/config.json',
    },
  ]);
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.filter((entry) => entry.relativePath.startsWith('bin/'))).toEqual([
    {
      bytes: 12,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'bin/lib/config.json',
      source: '/workspace/tools/lib/config.json',
      sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/tools/lib/config.json'],
    },
    {
      bytes: 37,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'bin/review-tool',
      source: '/workspace/tools/review-tool',
      sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/tools/review-tool'],
    },
  ]);
});

it.each([
  {
    code: 'claude.bin.directory.missing',
    issue: 'missing' as const,
    recovery: 'Create the configured Claude bin directory and add at least one executable, then rebuild.',
  },
  {
    code: 'claude.bin.directory.empty',
    issue: 'empty' as const,
    recovery: 'Add at least one file to the configured Claude bin directory, then rebuild.',
  },
])('diagnoses a Claude bin directory that is $issue without emitting it', ({ code, issue, recovery }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeBin(plugin, [], { issue }));

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({ code, recovery, severity: 'error' }));
  expect(plan.entries.some((entry) => entry.relativePath.startsWith('bin/'))).toBe(false);
});

it('requires every top-level Claude bin file to be executable while allowing nested support files', () => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeBin(plugin, [
    {
      bytes: 12,
      executable: false,
      relativePath: 'review-tool',
      source: '/workspace/tools/review-tool',
    },
    {
      bytes: 12,
      executable: false,
      relativePath: 'lib/config.json',
      source: '/workspace/tools/lib/config.json',
    },
  ]));

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code: 'claude.bin.executable.required',
    recovery: 'Run chmod +x on every top-level file in the configured Claude bin directory, then rebuild.',
    severity: 'error',
  }));
  expect(plan.entries.some((entry) => entry.relativePath.startsWith('bin/'))).toBe(false);
});

it('preserves the executable mode when emitting a Claude bin copy entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-bin-'));
  const source = join(root, 'authored', 'review-tool');
  const output = join(root, 'output');
  await mkdir(join(root, 'authored'), { recursive: true });
  await writeFile(source, '#!/usr/bin/env sh\nprintf "reviewed\\n"\n');
  await chmod(source, 0o751);

  try {
    const plan = createDefaultRegistry().get('claude').plan(withClaudeBin(plugin, [{
      bytes: (await stat(source)).size,
      executable: true,
      relativePath: 'review-tool',
      source,
    }], { source: join(root, 'authored') }));
    await emitPlanEntries({
      entries: plan.entries.filter((entry) => entry.relativePath.startsWith('bin/')),
      root: output,
    });

    expect((await stat(join(output, 'bin', 'review-tool'))).mode & 0o777).toBe(0o751);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('plans Claude workflow and output-style files as byte-faithful prebuilt copies without manifest path fields', () => {
  const withWorkflows = withClaudePayloadDirectory(plugin, 'hostWorkflows', [{
    bytes: 48,
    executable: false,
    relativePath: 'release-audit.js',
    source: '/workspace/workflows/release-audit.js',
  }]);
  const model = withClaudePayloadDirectory(withWorkflows, 'hostOutputStyles', [{
    bytes: 72,
    executable: false,
    relativePath: 'terse.md',
    source: '/workspace/styles/terse.md',
  }]);
  const plan = createDefaultRegistry().get('claude').plan(model);
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.filter((entry) =>
    entry.relativePath.startsWith('workflows/') || entry.relativePath.startsWith('output-styles/'))).toEqual([
    {
      bytes: 72,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'output-styles/terse.md',
      source: '/workspace/styles/terse.md',
      sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/styles/terse.md'],
    },
    {
      bytes: 48,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'workflows/release-audit.js',
      source: '/workspace/workflows/release-audit.js',
      sourceInputs: ['/workspace/agent-bundle.config.ts', '/workspace/workflows/release-audit.js'],
    },
  ]);
  if (manifest?.kind !== 'write') throw new Error('Expected the Claude plugin manifest.');
  expect(JSON.parse(manifest.content)).not.toHaveProperty('workflows');
  expect(JSON.parse(manifest.content)).not.toHaveProperty('outputStyles');
});

it.each([
  {
    code: 'claude.workflows.directory.missing',
    field: 'hostWorkflows' as const,
    issue: 'missing' as const,
  },
  {
    code: 'claude.workflows.directory.invalid',
    field: 'hostWorkflows' as const,
    issue: 'not-directory' as const,
  },
  {
    code: 'claude.workflows.directory.outside',
    field: 'hostWorkflows' as const,
    issue: 'outside' as const,
  },
  {
    code: 'claude.workflows.source.error',
    field: 'hostWorkflows' as const,
    issue: 'source-error' as const,
  },
  {
    code: 'claude.workflows.source.invalid',
    field: 'hostWorkflows' as const,
    issue: 'source-invalid' as const,
  },
  {
    code: 'claude.outputStyles.directory.empty',
    field: 'hostOutputStyles' as const,
    issue: 'empty' as const,
  },
])('diagnoses $code without emitting the declared payload directory', ({ code, field, issue }) => {
  const plan = createDefaultRegistry().get('claude').plan(
    withClaudePayloadDirectory(plugin, field, [], { issue }),
  );

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
  }));
  expect(plan.entries.some((entry) =>
    entry.relativePath.startsWith('workflows/') || entry.relativePath.startsWith('output-styles/'))).toBe(false);
});

it('rejects non-Markdown Claude output-style files without applying executable requirements', () => {
  const plan = createDefaultRegistry().get('claude').plan(
    withClaudePayloadDirectory(plugin, 'hostOutputStyles', [
      {
        bytes: 12,
        executable: true,
        relativePath: 'nested/terse.md',
        source: '/workspace/styles/nested/terse.md',
      },
      {
        bytes: 12,
        executable: false,
        relativePath: 'README.txt',
        source: '/workspace/styles/README.txt',
      },
    ]),
  );

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code: 'claude.outputStyles.file.invalid',
    recovery: expect.stringContaining('.md'),
    severity: 'error',
  }));
  expect(plan.entries.some((entry) => entry.relativePath.startsWith('output-styles/'))).toBe(false);
});

it('pins all documented Claude plugin-manifest LSP declaration forms', async () => {
  const schema = (await import('../src/adapters/schemas/claude/plugin.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);
  const manifest = {
    author: { name: 'Agent Bundle' },
    description: 'Claude LSP schema fixture.',
    name: 'claude-lsp-fixture',
    version: '1.0.0',
  };
  const server = {
    command: 'typescript-language-server',
    extensionToLanguage: { '.ts': 'typescript' },
  };

  for (const lspServers of [
    './.lsp.json',
    ['./.lsp.json', './language-servers.json'],
    { typescript: server },
  ]) {
    expect(validate({ ...manifest, lspServers })).toBe(true);
  }
  for (const lspServers of [
    '',
    [],
    [1],
    {},
    { typescript: { extensionToLanguage: { '.ts': 'typescript' } } },
    { typescript: { command: 'typescript-language-server' } },
    { typescript: { ...server, transport: 'pipe' } },
    { typescript: { ...server, undocumented: true } },
  ]) {
    expect(validate({ ...manifest, lspServers })).toBe(false);
  }
});

it.each([
  {
    code: 'claude.lsp.declaration.invalid',
    label: 'an empty declaration',
    lspServers: [],
  },
  {
    code: 'claude.lsp.server.invalid',
    label: 'a non-object server',
    lspServers: { typescript: './typescript-lsp.json' },
  },
  {
    code: 'claude.lsp.field.unknown',
    label: 'an unknown server field',
    lspServers: {
      typescript: {
        command: 'typescript-language-server',
        extensionToLanguage: { '.ts': 'typescript' },
        undocumented: true,
      },
    },
  },
  {
    code: 'claude.lsp.command.required',
    label: 'a missing command',
    lspServers: { typescript: { extensionToLanguage: { '.ts': 'typescript' } } },
  },
  {
    code: 'claude.lsp.extensions.required',
    label: 'an empty extension map',
    lspServers: { typescript: { command: 'typescript-language-server', extensionToLanguage: {} } },
  },
  {
    code: 'claude.lsp.token.env.key',
    label: 'a tokenized environment key',
    lspServers: {
      typescript: {
        command: 'typescript-language-server',
        env: { [`PREFIX_${pathTokens.pluginRoot}`]: 'literal' },
        extensionToLanguage: { '.ts': 'typescript' },
      },
    },
  },
  {
    code: 'claude.schema.lsp',
    label: 'a schema-invalid optional field',
    lspServers: {
      typescript: {
        command: 'typescript-language-server',
        extensionToLanguage: { '.ts': 'typescript' },
        maxRestarts: -1,
      },
    },
  },
])('rejects $label without emitting Claude LSP configuration', ({ code, lspServers }) => {
  const model = withClaudeLsp(plugin, lspServers);
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(plan.entries.some((entry) => entry.relativePath === '.lsp.json')).toBe(false);
});

it('withholds Claude LSP configuration when two servers claim one extension', () => {
  const model = withClaudeLsp(plugin, {
    first: {
      command: 'first-language-server',
      extensionToLanguage: { '.ts': 'typescript' },
    },
    second: {
      command: 'second-language-server',
      extensionToLanguage: { '.ts': 'typescript' },
    },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
    'claude.lsp.extension.conflict',
  ]);
  expect(plan.entries.some((entry) => entry.relativePath === '.lsp.json')).toBe(false);
});

it('emits Claude plugin default settings at the plugin root with the declaring config as its input', () => {
  const model = withClaudeSettings(plugin, {
    agent: 'security-reviewer',
    subagentStatusLine: { command: '~/.claude/subagent-statusline.sh', type: 'command' },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const documents = writeContents(model, 'claude');
  const entry = plan.entries.find((candidate) => candidate.relativePath === 'settings.json');

  expect(JSON.parse(documents['settings.json']!)).toEqual({
    agent: 'security-reviewer',
    subagentStatusLine: { command: '~/.claude/subagent-statusline.sh', type: 'command' },
  });
  expect(entry?.sourceInputs).toEqual(['/workspace/agent-bundle.config.ts']);
  // The manifest keeps no `settings` pointer: settings.json is discovered by
  // convention and takes priority over manifest `settings` anyway.
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('settings');
  // Declaring `agent` is shippable host configuration, so the deferred
  // plugin-agents component is a warning rather than a build failure.
  expect(plan.diagnostics).toEqual([{
    code: 'claude.settings.agent.deferred',
    message: expect.stringContaining('agents component stays deferred'),
    severity: 'warning',
    target: 'claude',
  }]);
});

it('emits a Claude subagent status line alone without any diagnostic', () => {
  const model = withClaudeSettings(plugin, {
    subagentStatusLine: { command: 'node scripts/rows.mjs', type: 'command' },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(writeContents(model, 'claude')['settings.json']!)).toEqual({
    subagentStatusLine: { command: 'node scripts/rows.mjs', type: 'command' },
  });
});

it('emits no Claude settings document when the host config declares none', () => {
  const plan = createDefaultRegistry().get('claude').plan(plugin);

  expect(plan.entries.some((entry) => entry.relativePath === 'settings.json')).toBe(false);
});

it('emits validated Claude themes and monitors at their default experimental locations', () => {
  const model = withClaudeExperimental(plugin, {
    monitors: [{
      command: `node ${pathTokens.pluginRoot}/scripts/watch.mjs`,
      description: 'Watch the review queue.',
      name: 'review-queue',
      when: 'on-skill-invoke:review',
    }],
    themes: {
      dracula: {
        base: 'dark',
        overrides: {
          claude: '#bd93f9',
          error: '#ff5555',
          success: '#50fa7b',
        },
      },
      paper: { base: 'light', name: 'Paper' },
    },
  });
  const plan = createDefaultRegistry().get('claude').plan(model);
  const documents = writeContents(model, 'claude');

  expect(JSON.parse(documents['themes/dracula.json']!)).toEqual({
    base: 'dark',
    name: 'dracula',
    overrides: {
      claude: '#bd93f9',
      error: '#ff5555',
      success: '#50fa7b',
    },
  });
  expect(JSON.parse(documents['themes/paper.json']!)).toEqual({ base: 'light', name: 'Paper' });
  expect(JSON.parse(documents['monitors/monitors.json']!)).toEqual([{
    command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs',
    description: 'Watch the review queue.',
    name: 'review-queue',
    when: 'on-skill-invoke:review',
  }]);
  for (const path of ['themes/dracula.json', 'themes/paper.json', 'monitors/monitors.json']) {
    expect(plan.entries.find((entry) => entry.relativePath === path)?.sourceInputs)
      .toEqual(['/workspace/agent-bundle.config.ts', '/workspace/experimental.config.ts']);
  }
  const manifest = JSON.parse(documents['.claude-plugin/plugin.json']!);
  expect(manifest).not.toHaveProperty('themes');
  expect(manifest).not.toHaveProperty('monitors');
  expect(manifest).not.toHaveProperty('experimental');
  expect(plan.diagnostics).toEqual([{
    code: 'claude.monitors.availability',
    message: expect.stringContaining('interactive CLI sessions'),
    severity: 'warning',
    target: 'claude',
  }]);
});

it.each([
  { code: 'claude.themes.declaration.invalid', label: 'a non-object themes declaration', themes: [] },
  { code: 'claude.themes.declaration.invalid', label: 'an empty themes declaration', themes: {} },
  { code: 'claude.themes.key.invalid', label: 'an unsafe theme file stem', themes: { '../escape': { base: 'dark' } } },
  { code: 'claude.themes.entry.invalid', label: 'a non-object theme declaration', themes: { dark: 'dark' } },
  { code: 'claude.themes.field.unknown', label: 'an unknown theme field', themes: { dark: { base: 'dark', typo: true } } },
  { code: 'claude.themes.base.required', label: 'a missing theme base', themes: { dark: { name: 'Dark' } } },
  { code: 'claude.themes.base.required', label: 'an empty theme base', themes: { dark: { base: '' } } },
  { code: 'claude.themes.base.invalid', label: 'an unknown theme base preset', themes: { dark: { base: 'drak' } } },
  { code: 'claude.themes.name.invalid', label: 'an empty theme display name', themes: { dark: { base: 'dark', name: '' } } },
  { code: 'claude.themes.overrides.invalid', label: 'a non-object overrides map', themes: { dark: { base: 'dark', overrides: [] } } },
  { code: 'claude.themes.overrides.value.invalid', label: 'a non-string override', themes: { dark: { base: 'dark', overrides: { error: 7 } } } },
  { code: 'claude.themes.overrides.value.invalid', label: 'an empty override', themes: { dark: { base: 'dark', overrides: { error: '' } } } },
])('rejects $label without emitting Claude themes', ({ code, themes }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeExperimental(plugin, { themes }));

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(plan.entries.some((entry) => entry.relativePath.startsWith('themes/'))).toBe(false);
});

it.each([
  { code: 'claude.monitors.declaration.invalid', label: 'a non-array monitors declaration', monitors: {} },
  { code: 'claude.monitors.declaration.invalid', label: 'an empty monitors declaration', monitors: [] },
  { code: 'claude.monitors.entry.invalid', label: 'a non-object monitor entry', monitors: ['watch'] },
  { code: 'claude.monitors.field.unknown', label: 'an unknown monitor field', monitors: [{ command: 'watch', description: 'Watch.', name: 'watch', typo: true }] },
  { code: 'claude.monitors.name.required', label: 'a missing monitor name', monitors: [{ command: 'watch', description: 'Watch.' }] },
  { code: 'claude.monitors.name.duplicate', label: 'a duplicate monitor name', monitors: [
    { command: 'watch-a', description: 'Watch A.', name: 'watch' },
    { command: 'watch-b', description: 'Watch B.', name: 'watch' },
  ] },
  { code: 'claude.monitors.command.required', label: 'an empty monitor command', monitors: [{ command: '', description: 'Watch.', name: 'watch' }] },
  { code: 'claude.monitors.command.userConfig', label: 'a user config substitution', monitors: [{ command: 'watch ${user_config.token}', description: 'Watch.', name: 'watch' }] },
  { code: 'claude.monitors.description.required', label: 'an empty monitor description', monitors: [{ command: 'watch', description: '', name: 'watch' }] },
  { code: 'claude.monitors.when.invalid', label: 'an unsupported monitor trigger', monitors: [{ command: 'watch', description: 'Watch.', name: 'watch', when: 'session-start' }] },
  { code: 'claude.monitors.when.invalid', label: 'an empty skill trigger', monitors: [{ command: 'watch', description: 'Watch.', name: 'watch', when: 'on-skill-invoke:' }] },
  { code: 'claude.monitors.when.invalid', label: 'a trigger for a missing plugin skill', monitors: [{ command: 'watch', description: 'Watch.', name: 'watch', when: 'on-skill-invoke:missing' }] },
])('rejects $label without emitting Claude monitors', ({ code, monitors }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeExperimental(plugin, { monitors }));

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(plan.entries.some((entry) => entry.relativePath === 'monitors/monitors.json')).toBe(false);
});

it('pins and registers the closed Claude theme and monitor schemas', async () => {
  const [themeModule, monitorsModule] = await Promise.all([
    import('../src/adapters/schemas/claude/theme.schema.json', { with: { type: 'json' } }),
    import('../src/adapters/schemas/claude/monitors.schema.json', { with: { type: 'json' } }),
  ]);
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validateTheme = validator.compile(themeModule.default);
  const validateMonitors = validator.compile(monitorsModule.default);

  expect(validateTheme({ base: 'dark', name: 'Dracula', overrides: { claude: '#bd93f9' } })).toBe(true);
  expect(validateTheme({ base: 'light', name: 'Paper' })).toBe(true);
  expect(validateTheme({ base: 'drak', name: 'Typo' })).toBe(false);
  expect(validateTheme({ base: 'dark', typo: true })).toBe(false);
  expect(validateTheme({ name: 'No base' })).toBe(false);
  expect(validateTheme({ base: 'dark', overrides: { error: 7 } })).toBe(false);
  expect(validateMonitors([{ command: 'watch', description: 'Watch.', name: 'watch' }])).toBe(true);
  expect(validateMonitors([])).toBe(false);
  expect(validateMonitors([{ description: 'Watch.', name: 'watch' }])).toBe(false);
  expect(validateMonitors([{ command: 'watch', description: 'Watch.', name: 'watch', when: 'later' }])).toBe(false);

  const validation = createDefaultRegistry().artifactValidation('claude');
  expect(validation.documents).toContainEqual({ path: 'themes/*.json', required: false, schema: 'theme' });
  expect(validation.documents).toContainEqual({ path: 'monitors/monitors.json', required: false, schema: 'monitors' });
  expect(validation.schemas.find((schema) => schema.name === 'theme')
    ?.validate({ base: 'dark', name: 'Dracula' })).toEqual([]);
  expect(validation.schemas.find((schema) => schema.name === 'monitors')
    ?.validate([{ command: 'watch', description: 'Watch.', name: 'watch' }])).toEqual([]);
});

it('emits Claude plugin dependencies in authored order with closed object keys and extension provenance', async () => {
  const model = withClaudeDependencies(plugin, [
    { marketplace: 'acme-shared', name: 'review-tools', version: '*' },
    { marketplace: 'acme-shared', version: '~2.1.0', name: 'secrets-vault' },
    { marketplace: 'acme-shared', name: 'policy-kit', version: '^2.0.0-0' },
  ]);
  const plan = createDefaultRegistry().get('claude').plan(model);
  const entry = plan.entries.find((candidate) => candidate.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toEqual([]);
  expect(entry?.kind).toBe('write');
  if (entry?.kind !== 'write') throw new Error('Expected an emitted Claude plugin manifest.');
  expect(JSON.parse(entry.content).dependencies).toEqual([
    { marketplace: 'acme-shared', name: 'review-tools', version: '*' },
    { marketplace: 'acme-shared', name: 'secrets-vault', version: '~2.1.0' },
    { marketplace: 'acme-shared', name: 'policy-kit', version: '^2.0.0-0' },
  ]);
  expect(entry.sourceInputs).toContain('/workspace/dependencies.config.ts');
  await validateDocuments('claude', writeContents(model, 'claude'));
});

it.each([
  { dependencies: [], code: 'claude.dependencies.declaration.invalid', label: 'an empty array' },
  { dependencies: [7], code: 'claude.dependencies.entry.invalid', label: 'a non-string non-object entry' },
  { dependencies: [''], code: 'claude.dependencies.entry.invalid', label: 'an empty string entry' },
  { dependencies: [{}], code: 'claude.dependencies.name.required', label: 'an object without a name' },
  { dependencies: [{ name: '', version: '^2.0' }], code: 'claude.dependencies.name.required', label: 'an empty object name' },
  { dependencies: [{ name: 'audit-logger', source: './audit' }], code: 'claude.dependencies.field.unknown', label: 'an unknown object field' },
  { dependencies: ['Audit Logger'], code: 'claude.dependencies.name.invalid', label: 'an implausible plugin name' },
  { dependencies: ['audit-logger', { name: 'audit-logger' }], code: 'claude.dependencies.duplicate', label: 'a duplicate same-marketplace name' },
  {
    dependencies: [
      { marketplace: 'acme-shared', name: 'audit-logger' },
      { marketplace: 'acme-shared', name: 'audit-logger', version: '^2.0' },
    ],
    code: 'claude.dependencies.duplicate',
    label: 'a duplicate cross-marketplace name',
  },
  { dependencies: ['review-tools'], code: 'claude.dependencies.self', label: 'a self dependency' },
  { dependencies: ['audit-logger'], code: 'claude.dependencies.unresolved', label: 'an unresolvable bare-name dependency' },
  { dependencies: [{ name: 'audit-logger', version: '^2.0' }], code: 'claude.dependencies.unresolved', label: 'an unresolvable same-marketplace dependency object' },
  { dependencies: [{ name: 'audit-logger', version: 'latest' }], code: 'claude.dependencies.version.invalid', label: 'an invalid version range' },
  { dependencies: [{ marketplace: '', name: 'audit-logger' }], code: 'claude.dependencies.marketplace.invalid', label: 'an empty marketplace' },
  { dependencies: [{ marketplace: 7, name: 'audit-logger' }], code: 'claude.dependencies.marketplace.invalid', label: 'a non-string marketplace' },
])('rejects $label before emitting Claude dependencies', ({ dependencies, code }) => {
  const plan = createDefaultRegistry().get('claude').plan(withClaudeDependencies(plugin, dependencies));
  const manifest = plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json');

  expect(plan.diagnostics).toContainEqual(expect.objectContaining({
    code,
    recovery: expect.any(String),
    severity: 'error',
  }));
  if (manifest?.kind === 'write') {
    expect(JSON.parse(manifest.content)).not.toHaveProperty('dependencies');
  }
});

it.each([
  '~2.1.0',
  '^2.0',
  '>=1.4',
  '=2.1.0',
  '*',
  'x',
  'X',
  '2.x',
  '1.2.3 - 2.0.0',
  '>=2.0 <3.0',
  '^2.0.0-0',
  '^1.0 || >=2.0 <3.0',
])('accepts documented Claude dependency semver range %s', (range) => {
  expect(isValidClaudeDependencyRange(range)).toBe(true);
});

it.each(['', 'latest', '^', 'not-a-range', '>=', '||', '<= >', '1.x.3', '^2.0.0-01'])(
  'rejects malformed Claude dependency semver range %s',
  (range) => {
    expect(isValidClaudeDependencyRange(range)).toBe(false);
  },
);

it.each([
  {
    code: 'claude.settings.declaration.invalid',
    label: 'a non-object declaration',
    settings: './settings.json',
  },
  {
    code: 'claude.settings.declaration.invalid',
    label: 'an empty declaration',
    settings: {},
  },
  {
    code: 'claude.settings.field.unknown',
    label: 'an unknown settings key',
    settings: { agent: 'security-reviewer', statusLine: { command: 'row.sh', type: 'command' } },
  },
  {
    code: 'claude.settings.agent.invalid',
    label: 'an empty agent name',
    settings: { agent: '' },
  },
  {
    code: 'claude.settings.agent.invalid',
    label: 'a non-string agent',
    settings: { agent: 7 },
  },
  {
    code: 'claude.settings.token.unsupported',
    label: 'a tokenized agent name',
    settings: { agent: `${pathTokens.pluginRoot}/agents/reviewer.md` },
  },
  {
    code: 'claude.settings.statusline.invalid',
    label: 'a non-object subagent status line',
    settings: { subagentStatusLine: './rows.sh' },
  },
  {
    code: 'claude.settings.statusline.field.unknown',
    label: 'the statusLine-only padding field',
    settings: { subagentStatusLine: { command: 'rows.sh', padding: 0, type: 'command' } },
  },
  {
    code: 'claude.settings.statusline.type.invalid',
    label: 'an undocumented subagent status line type',
    settings: { subagentStatusLine: { command: 'rows.sh', type: 'inline' } },
  },
  {
    code: 'claude.settings.statusline.command.required',
    label: 'a missing subagent status line command',
    settings: { subagentStatusLine: { type: 'command' } },
  },
  {
    code: 'claude.settings.token.unsupported',
    label: 'a tokenized subagent status line command',
    settings: { subagentStatusLine: { command: `${pathTokens.pluginRoot}/rows.sh`, type: 'command' } },
  },
])('rejects $label without emitting Claude settings', ({ code, settings }) => {
  const model = withClaudeSettings(plugin, settings);
  const plan = createDefaultRegistry().get('claude').plan(model);

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(plan.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  expect(plan.entries.some((entry) => entry.relativePath === 'settings.json')).toBe(false);
});

it('pins the closed Claude plugin settings schema to the two documented keys', async () => {
  const schema = (await import('../src/adapters/schemas/claude/settings.schema.json', {
    with: { type: 'json' },
  })).default;
  const validator = new Ajv2020({ allErrors: true, strict: false });
  installFormats(validator);
  const validate = validator.compile(schema);

  for (const settings of [
    { agent: 'security-reviewer' },
    { subagentStatusLine: { command: '~/.claude/subagent-statusline.sh', type: 'command' } },
    { agent: 'security-reviewer', subagentStatusLine: { command: 'rows.sh', type: 'command' } },
  ]) {
    expect(validate(settings), JSON.stringify(validate.errors)).toBe(true);
  }
  for (const settings of [
    // An empty document declares no default configuration at all.
    {},
    { agent: '' },
    { agent: 7 },
    { statusLine: { command: 'rows.sh', type: 'command' } },
    { subagentStatusLine: 'rows.sh' },
    { subagentStatusLine: { type: 'command' } },
    { subagentStatusLine: { command: '', type: 'command' } },
    { subagentStatusLine: { command: 'rows.sh', type: 'inline' } },
    // `padding` is documented for the user statusLine, not for a plugin default.
    { subagentStatusLine: { command: 'rows.sh', padding: 0, type: 'command' } },
  ]) {
    expect(validate(settings)).toBe(false);
  }
});

it('registers the Claude settings document against its pinned schema contract', () => {
  const validation = createDefaultRegistry().artifactValidation('claude');
  const settingsSchema = validation.schemas.find((schema) => schema.name === 'settings');

  expect(validation.documents).toContainEqual({ path: 'settings.json', required: false, schema: 'settings' });
  expect(settingsSchema?.validate({ agent: 'security-reviewer' })).toEqual([]);
  expect(settingsSchema?.validate({ agent: 'security-reviewer', statusLine: {} })).toEqual([
    expect.objectContaining({ instancePath: '' }),
  ]);
});

it.each(['codex', 'claude'] as const)(
  'keeps a user-declared plugin-root env anchor over the injected %s value',
  (target) => {
    const overridden = {
      ...plugin,
      mcpServers: Object.freeze([Object.freeze({
        ...plugin.mcpServers[0]!,
        env: Object.freeze({ [pluginRootEnvAnchor]: 'declared-root' }),
      })]),
    } satisfies NormalizedPlugin;
    const entry = planEntries(overridden, target).find((candidate) => candidate.relativePath === '.mcp.json');
    const document = JSON.parse(entry?.kind === 'write' ? entry.content : '{}') as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(document.mcpServers.stdio?.env).toEqual({ [pluginRootEnvAnchor]: 'declared-root' });
  },
);

it('omits the Codex env anchor when a stdio server has no plugin-root cwd to resolve it against', () => {
  const unanchored = {
    ...plugin,
    mcpServers: Object.freeze([Object.freeze({
      args: Object.freeze(['serve']),
      command: 'external-tool',
      env: Object.freeze({ CACHE_DIR: 'cache' }),
      id: 'mcp:external',
      name: 'external',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/workspace/agent-bundle.config.ts' }),
      targets: Object.freeze(['codex', 'claude']),
      transport: 'stdio' as const,
    })]),
  } satisfies NormalizedPlugin;
  const read = (target: 'codex' | 'claude') => {
    const entry = planEntries(unanchored, target).find((candidate) => candidate.relativePath === '.mcp.json');
    return (JSON.parse(entry?.kind === 'write' ? entry.content : '{}') as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    }).mcpServers.external?.env;
  };
  expect(read('codex')).toEqual({ CACHE_DIR: 'cache' });
  expect(read('claude')).toEqual({ [pluginRootEnvAnchor]: '${CLAUDE_PLUGIN_ROOT}', CACHE_DIR: 'cache' });
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

it('emits every authored Codex interface field without changing marketplace metadata', () => {
  const plan = createDefaultRegistry().get('codex').plan(withCodexConfig(plugin, {
    interface: {
      brandColor: '#10A37F',
      capabilities: ['Interactive', 'Write'],
      category: 'Developer Tools',
      composerIcon: './assets/composer.png',
      defaultPrompt: ['Review this change.', 'Explain this repository.'],
      developerName: 'Agent Bundle',
      displayName: 'Review Tools',
      logo: './assets/logo.png',
      logoDark: './assets/logo-dark.png',
      longDescription: 'Review code and explain findings with repository context.',
      privacyPolicyURL: 'https://example.test/privacy',
      screenshots: ['./assets/overview.png', './assets/details.png'],
      shortDescription: 'Repository-aware code review',
      termsOfServiceURL: 'http://example.test/terms',
      websiteURL: 'https://example.test/review-tools',
    },
  }));
  const byPath = Object.fromEntries(plan.entries.map((entry) => [entry.relativePath, entry]));
  const manifestEntry = byPath['.codex-plugin/plugin.json'];
  const marketplaceEntry = byPath['.agents/plugins/marketplace.json'];

  expect(plan.diagnostics).toEqual([]);
  expect(manifestEntry).toMatchObject({
    kind: 'write',
    sourceInputs: expect.arrayContaining([
      '/workspace/agent-bundle.config.ts',
      '/workspace/codex.config.ts',
    ]),
  });
  if (manifestEntry?.kind !== 'write') throw new Error('Expected an emitted Codex plugin manifest.');
  expect(JSON.parse(manifestEntry.content).interface).toEqual({
    brandColor: '#10A37F',
    capabilities: ['Interactive', 'Write'],
    category: 'Developer Tools',
    composerIcon: './assets/composer.png',
    defaultPrompt: ['Review this change.', 'Explain this repository.'],
    developerName: 'Agent Bundle',
    displayName: 'Review Tools',
    logo: './assets/logo.png',
    logoDark: './assets/logo-dark.png',
    longDescription: 'Review code and explain findings with repository context.',
    privacyPolicyURL: 'https://example.test/privacy',
    screenshots: ['./assets/overview.png', './assets/details.png'],
    shortDescription: 'Repository-aware code review',
    termsOfServiceURL: 'http://example.test/terms',
    websiteURL: 'https://example.test/review-tools',
  });
  expect(marketplaceEntry).toMatchObject({ kind: 'write' });
  if (marketplaceEntry?.kind !== 'write') throw new Error('Expected an emitted Codex marketplace.');
  expect(JSON.parse(marketplaceEntry.content).interface).toEqual({ displayName: 'review-tools' });
});

it.each([
  { code: 'codex.interface.invalid', value: [] },
  { code: 'codex.interface.field.unknown', value: { typo: true } },
  { code: 'codex.interface.display-name.invalid', value: { displayName: '' } },
  { code: 'codex.interface.display-name.invalid', value: { displayName: '   ' } },
  { code: 'codex.interface.short-description.invalid', value: { shortDescription: 7 } },
  { code: 'codex.interface.long-description.invalid', value: { longDescription: '' } },
  { code: 'codex.interface.developer-name.invalid', value: { developerName: null } },
  { code: 'codex.interface.category.invalid', value: { category: '' } },
  { code: 'codex.interface.capabilities.invalid', value: { capabilities: 'Write' } },
  { code: 'codex.interface.capabilities.item.invalid', value: { capabilities: ['Write', ''] } },
  { code: 'codex.interface.website-url.invalid', value: { websiteURL: 'file:///tmp/site' } },
  { code: 'codex.interface.privacy-policy-url.invalid', value: { privacyPolicyURL: '/privacy' } },
  { code: 'codex.interface.terms-of-service-url.invalid', value: { termsOfServiceURL: 'mailto:legal@example.test' } },
  { code: 'codex.interface.default-prompt.invalid', value: { defaultPrompt: [] } },
  { code: 'codex.interface.default-prompt.invalid', value: { defaultPrompt: ['One', 'Two', 'Three', 'Four'] } },
  { code: 'codex.interface.default-prompt.item.invalid', value: { defaultPrompt: [''] } },
  { code: 'codex.interface.default-prompt.item.invalid', value: { defaultPrompt: ['x'.repeat(129)] } },
  { code: 'codex.interface.brand-color.invalid', value: { brandColor: 'green' } },
  { code: 'codex.interface.composer-icon.invalid', value: { composerIcon: '/tmp/icon.png' } },
  { code: 'codex.interface.logo.invalid', value: { logo: './../outside.png' } },
  { code: 'codex.interface.logo-dark.invalid', value: { logoDark: 'https://example.test/logo.png' } },
  { code: 'codex.interface.screenshots.invalid', value: { screenshots: './assets/screenshot.png' } },
  { code: 'codex.interface.screenshots.item.invalid', value: { screenshots: ['./assets/screenshot.jpg'] } },
] as const)('rejects invalid authored Codex interface input with $code', ({ code, value }) => {
  const plan = createDefaultRegistry().get('codex').plan(withCodexConfig(plugin, { interface: value }));

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
});

it('emits registered MCP app mappings as the documented compatibility document', () => {
  const plan = createDefaultRegistry().get('codex').plan(withCodexConfig(plugin, {
    apps: {
      notion: { id: 'plugin_asdk_app_0123456789abcdef' },
      search: { id: 'connector_search' },
    },
  }));
  const byPath = Object.fromEntries(plan.entries.map((entry) => [entry.relativePath, entry]));
  const manifestEntry = byPath['.codex-plugin/plugin.json'];

  expect(plan.diagnostics).toEqual([]);
  expect(byPath['.app.json']).toEqual({
    content: '{"apps":{"notion":{"id":"plugin_asdk_app_0123456789abcdef"},"search":{"id":"connector_search"}}}\n',
    kind: 'write',
    relativePath: '.app.json',
    sourceInputs: ['/workspace/codex.config.ts'],
  });
  if (manifestEntry?.kind !== 'write') throw new Error('Expected an emitted Codex plugin manifest.');
  expect(JSON.parse(manifestEntry.content).apps).toBe('./.app.json');
  expect(manifestEntry.sourceInputs).toContain('/workspace/codex.config.ts');
});

it.each([
  { code: 'codex.apps.invalid', value: [] },
  { code: 'codex.apps.invalid', value: {} },
  { code: 'codex.apps.name.invalid', value: { '': { id: 'connector_search' } } },
  { code: 'codex.apps.name.invalid', value: { '   ': { id: 'connector_search' } } },
  { code: 'codex.apps.entry.invalid', value: { search: 'connector_search' } },
  { code: 'codex.apps.entry.invalid', value: { search: { id: 'connector_search', typo: true } } },
  { code: 'codex.apps.id.invalid', value: { search: { id: '' } } },
  { code: 'codex.apps.id.invalid', value: { search: { id: '   ' } } },
] as const)('rejects invalid authored Codex app mappings with $code', ({ code, value }) => {
  const plan = createDefaultRegistry().get('codex').plan(withCodexConfig(plugin, { apps: value }));

  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  expect(plan.entries.some((entry) => entry.relativePath === '.app.json')).toBe(false);
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
      provenance: { kind: 'conventional' as const, sourcePath: '/inputs/src/skills/review/SKILL.md' },
      source: '/inputs/src/skills/review/SKILL.md',
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
      '/inputs/src/skills/review/SKILL.md',
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

it('accepts Claude path tokens only in the documented MCP fields and rejects stdio cwd', () => {
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
        cwd: '/workspace',
        env: { WORKSPACE: pathTokens.workspaceRoot },
        id: 'mcp:workspace',
        name: 'workspace',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        targets: ['claude'],
        transport: 'stdio',
      },
      {
        command: 'node',
        cwd: pathTokens.pluginData,
        id: 'mcp:unsupported-cwd',
        name: 'unsupported-cwd',
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
    'claude.substitution.token.unsupported',
    'claude.mcp.token.headers.key',
  ]);
  expect(claude.entries.find((entry) => entry.relativePath === '.mcp.json')).toEqual({
    content: '{"mcpServers":{"workspace":{"args":["${CLAUDE_PROJECT_DIR}/tool"],"command":"${CLAUDE_PLUGIN_ROOT}","cwd":"/workspace","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}","WORKSPACE":"${CLAUDE_PROJECT_DIR}"},"type":"stdio"}}}\n',
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
    content: '{"mcpServers":{"valid-env":{"command":"node","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}","DATA":"${CLAUDE_PLUGIN_DATA}","ROOT":"${CLAUDE_PLUGIN_ROOT}","WORKSPACE":"${CLAUDE_PROJECT_DIR}"},"type":"stdio"}}}\n',
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

it('filters host components and builds one root projecting portable, Codex, and Claude', async () => {
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
    'INSTALL.md',
  ]);

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-adapter-'));
  const outputRoot = join(root, 'dist');
  const skillRoot = join(root, 'src', 'skills', 'review');
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
    // One root: Claude Code and Codex manifests live at the root; the Agent
    // Plugins pack beside other hosts is the namespaced `portable/` view.
    await expect(readFile(join(outputRoot, 'portable', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    await expect(readFile(join(outputRoot, '.codex-plugin', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    await expect(readFile(join(outputRoot, '.claude-plugin', 'plugin.json'), 'utf8')).resolves.toContain('review-tools');
    await expect(readFile(join(outputRoot, 'skills', 'review', 'SKILL.md'), 'utf8')).resolves.toBe(skillMarkdown);
    await expect(readFile(join(outputRoot, 'portable', 'skills', 'review', 'SKILL.md'), 'utf8')).resolves.toBe(skillMarkdown);
    const manifest = JSON.parse(await readFile(join(outputRoot, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly path: string }[];
      readonly targets: readonly { readonly name: string }[];
    };
    expect(manifest.targets.map(({ name }) => name)).toEqual(['claude', 'codex', 'portable']);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'portable/plugin.json',
      '.codex-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      'AGENTS.md',
      'INSTALL.md',
    ]));
    expect(manifest.files.some((file) => file.path.startsWith('codex/') || file.path.startsWith('claude/'))).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
