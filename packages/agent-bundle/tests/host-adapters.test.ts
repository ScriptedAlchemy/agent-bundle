import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect, it } from '@rstest/core';

import { cursorMarketplaceValidator } from '../src/adapters/cursor.ts';
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
    claude: { version: '2.1.250' },
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
        provenance: { kind: 'conventional', sourcePath: '/workspace/commands/review.md' },
        source: '/workspace/commands/review.md',
        targets: ['claude'],
      },
      {
        body: '# Explain\n\nExplain this code.',
        frontmatter: {},
        id: 'command:explain',
        markdown: '# Explain\n\nExplain this code.',
        name: 'explain',
        provenance: { kind: 'conventional', sourcePath: '/workspace/commands/explain.md' },
        source: '/workspace/commands/explain.md',
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

it('plans byte-stable native Codex and Claude plugin trees from the same frozen model', async () => {
  const registry = createDefaultRegistry();
  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor', 'plugin']);
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
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/skills/review/references/guide.md' },
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
      content: '{"mcpServers":{"http":{"headers":{"Authorization":"Bearer literal"},"type":"http","url":"https://mcp.example.test/stream"},"stdio":{"args":["--root","${CLAUDE_PLUGIN_ROOT}/tools/server.mjs"],"command":"node","cwd":"${CLAUDE_PLUGIN_ROOT}","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}","CACHE_DIR":"cache"},"type":"stdio"}}}\n',
      kind: 'write',
      relativePath: '.mcp.json',
    },
    { bytes: 9, kind: 'copy', relativePath: 'skills/review/SKILL.md', source: '/workspace/skills/review/SKILL.md' },
    { bytes: 3, kind: 'copy', relativePath: 'skills/review/assets/icon.bin', source: '/workspace/skills/review/assets/icon.bin' },
    { bytes: 8, kind: 'copy', relativePath: 'skills/review/references/guide.md', source: '/workspace/skills/review/references/guide.md' },
  ]);
  expect(codexPluginEntries.map((entry) => entry.sourceInputs)).toEqual([
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/agent-bundle.config.ts', '/workspace/skills/review/SKILL.md'],
    ['/workspace/agent-bundle.config.ts'],
    ['/workspace/skills/review/SKILL.md'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/assets/icon.bin'],
    ['/workspace/skills/review/SKILL.md', '/workspace/skills/review/references/guide.md'],
  ]);
  expect(claudePluginEntries.map((entry) => entry.sourceInputs)).toEqual([
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

it('anchors compiled Claude MCP entries with absolute arguments, plugin-root cwd, and the env anchor', () => {
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
  // The absolute entry path stays as the hedge against Claude Code ignoring
  // cwd at runtime; cwd is emitted anyway as schema-valid future-proofing,
  // and the env anchor is the guaranteed working-directory-independent root.
  expect(document.mcpServers.stdio).toMatchObject({
    args: ['${CLAUDE_PLUGIN_ROOT}/mcp/compiled-server.mjs'],
    cwd: '${CLAUDE_PLUGIN_ROOT}',
    env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}', CACHE_DIR: 'cache' },
  });
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
      extensionToLanguage: { '.ts': `typescript-${pathTokens.pluginRoot}` },
      initializationOptions: { token: pathTokens.pluginData },
      maxRestarts: 3,
      restartOnCrash: true,
      settings: { token: pathTokens.workspaceRoot },
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
      extensionToLanguage: { '.ts': `typescript-${pathTokens.pluginRoot}` },
      initializationOptions: { token: pathTokens.pluginData },
      maxRestarts: 3,
      restartOnCrash: true,
      settings: { token: pathTokens.workspaceRoot },
      shutdownTimeout: 2_000,
      startupTimeout: 5_000,
      transport: 'socket',
      workspaceFolder: '${CLAUDE_PROJECT_DIR}/packages',
    },
  });
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('lspServers');
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
    content: '{"mcpServers":{"workspace":{"args":["${CLAUDE_PROJECT_DIR}/tool"],"command":"${CLAUDE_PLUGIN_ROOT}","cwd":"${CLAUDE_PLUGIN_DATA}","env":{"AGENT_BUNDLE_PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}","WORKSPACE":"${CLAUDE_PROJECT_DIR}"},"type":"stdio"}}}\n',
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
    'INSTALL.md',
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
