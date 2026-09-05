import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { runNodeScript } from './support/run-node-script.ts';
import { build } from './support/build.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const configPath = '/workspace/agent-bundle.config.ts';

// One plugin root projecting every real host at once (#555): the old `plugin`
// composite target is gone, so a multi-host selection is the composition.
const compositeHosts = Object.freeze(['claude', 'codex', 'cursor']);

const bundleModel = Object.freeze({
  extensions: Object.freeze({}),
  hooks: Object.freeze([
    Object.freeze({
      event: 'sessionStart' as const,
      id: 'hook:session-start',
      name: 'session-start',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      source: '/workspace/src/hooks/session-start.ts',
      targets: compositeHosts,
      tools: Object.freeze([]),
    }),
    Object.freeze({
      event: 'afterTool' as const,
      id: 'hook:record-write',
      name: 'record-write',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      source: '/workspace/src/hooks/record-write.ts',
      targets: compositeHosts,
      tools: Object.freeze(['file.write' as const]),
    }),
  ]),
  marketplace: true as const,
  mcpServers: Object.freeze([
    Object.freeze({
      args: Object.freeze([`${pathTokens.pluginRoot}/mcp/server.mjs`]),
      command: 'node',
      cwd: pathTokens.pluginRoot,
      id: 'mcp:status',
      name: 'status',
      provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
      targets: compositeHosts,
      transport: 'stdio' as const,
    }),
  ]),
  metadata: Object.freeze({
    description: 'One bundle for every supported host.',
    id: 'plugin:bundle-example',
    name: 'bundle-example',
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }),
    version: '2.0.0',
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
        Object.freeze({ bytes: 8, relativePath: 'references/guide.md', source: '/workspace/src/skills/review/references/guide.md' }),
      ]),
      source: '/workspace/src/skills/review/SKILL.md',
      targets: compositeHosts,
    }),
  ]),
  targets: Object.freeze(compositeHosts.map((name) =>
    Object.freeze({ id: `target:${name}`, name, provenance: Object.freeze({ kind: 'config' as const, sourcePath: configPath }) }))),
} satisfies NormalizedPlugin);

// `build()` plans a multi-host root through the registry, so the tests do too.
const planBundle = (model: NormalizedPlugin) => createDefaultRegistry().root(compositeHosts).adapter.plan(model);

const writeContents = (model: NormalizedPlugin): Record<string, string> => Object.fromEntries(
  planBundle(model).entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]),
);

it('lays every host manifest over one shared plugin root', () => {
  const plan = planBundle(bundleModel);
  expect(plan.diagnostics).toEqual([]);
  const documents = writeContents(bundleModel);

  const claudePlugin = JSON.parse(documents['.claude-plugin/plugin.json']!) as Record<string, unknown>;
  expect(claudePlugin).toMatchObject({ name: 'bundle-example', version: '2.0.0' });
  // Claude Code auto-loads hooks/hooks.json and reports a manifest pointer at
  // the same file as a duplicate hooks file, so the manifest never names it.
  expect(claudePlugin).not.toHaveProperty('hooks');

  // Beside Claude Code, Codex reads its hooks and MCP documents through
  // manifest pointers at `.codex-plugin/`, leaving the conventional slots
  // (`hooks/hooks.json`, `.mcp.json`) to Claude Code.
  const codexPlugin = JSON.parse(documents['.codex-plugin/plugin.json']!) as Record<string, unknown>;
  expect(codexPlugin).toMatchObject({
    hooks: './.codex-plugin/hooks.json',
    mcpServers: './.codex-plugin/mcp.json',
    name: 'bundle-example',
    skills: './skills/',
  });

  const claudeMcp = JSON.parse(documents['.mcp.json']!) as {
    readonly mcpServers: Record<string, { readonly args: readonly string[]; readonly cwd?: string; readonly env?: Record<string, string> }>;
  };
  expect(claudeMcp.mcpServers['status']!.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs');
  expect(claudeMcp.mcpServers['status']).not.toHaveProperty('cwd');
  expect(claudeMcp.mcpServers['status']!.env).toEqual({ AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' });

  const codexMcp = JSON.parse(documents['.codex-plugin/mcp.json']!) as {
    readonly mcpServers: Record<string, { readonly args: readonly string[]; readonly cwd?: string; readonly env?: Record<string, string> }>;
  };
  expect(codexMcp.mcpServers['status']!.args[0]).toBe('./mcp/server.mjs');
  expect(codexMcp.mcpServers['status']!.cwd).toBe('./');
  expect(codexMcp.mcpServers['status']!.env).toEqual({ AGENT_BUNDLE_PLUGIN_ROOT: './' });

  // Both Claude-format documents reference the same host-detecting wrappers,
  // each with its own host's native tool matcher.
  const hooks = documents['hooks/hooks.json']!;
  expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs');
  expect(hooks).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/record-write.mjs');
  expect(hooks).toContain('^(?:Write|Edit)$');
  const codexHooks = documents['.codex-plugin/hooks.json']!;
  expect(codexHooks).toContain('hooks/session-start.mjs');
  expect(codexHooks).toContain('hooks/record-write.mjs');
  expect(codexHooks).toContain('apply_patch|Edit|Write');
  expect(documents).not.toHaveProperty('hooks/hooks-codex.json');

  expect(documents['.claude-plugin/marketplace.json']).toContain('bundle-example-marketplace');
  expect(documents['.agents/plugins/marketplace.json']).toContain('bundle-example-marketplace');
  expect(JSON.parse(documents['.cursor-plugin/marketplace.json']!)).toEqual({
    name: 'bundle-example-marketplace',
    owner: { name: 'bundle-example' },
    plugins: [{
      description: 'One bundle for every supported host.',
      name: 'bundle-example',
      source: './',
    }],
  });
  expect(documents['AGENTS.md']).toContain('multi-host agent plugin root');
  expect(documents['AGENTS.md']).toContain('Claude Code');
  expect(documents['AGENTS.md']).toContain('Codex');
  expect(documents['AGENTS.md']).toContain('Cursor');
  expect(documents['AGENTS.md']).toContain('See `INSTALL.md` for exact Claude Code, Codex, Cursor commands');
  expect(documents['AGENTS.md']).toContain('`node ./install.mjs`');
  expect(documents['AGENTS.md']).toContain('VS Code / GitHub Copilot');
  expect(documents['AGENTS.md']).toContain('share one host-detecting wrapper per hook');
  // One install surface for the whole root, with a section per selected host.
  expect(documents['INSTALL.md']).toContain('claude plugin install bundle-example@bundle-example-marketplace --scope user');
  expect(documents['INSTALL.md']).toContain('codex plugin add bundle-example@bundle-example-marketplace');
  expect(documents['INSTALL.md']).toContain('Cursor');
  expect(documents['install.mjs']).toContain("join(cursorRoot, 'plugins', 'local')");
  expect(plan.entries.filter((entry) => entry.relativePath === 'INSTALL.md')).toHaveLength(1);

  const cursorPlugin = JSON.parse(documents['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(cursorPlugin).toMatchObject({
    hooks: './hooks/hooks-cursor.json',
    mcpServers: './mcp.json',
    name: 'bundle-example',
    skills: './skills/',
    version: '2.0.0',
  });
  const cursorMcp = JSON.parse(documents['mcp.json']!) as {
    readonly mcpServers: Record<string, { readonly args: readonly string[]; readonly env?: Record<string, string> }>;
  };
  expect(cursorMcp.mcpServers['status']!.args[0]).toBe('${CURSOR_PLUGIN_ROOT}/mcp/server.mjs');
  expect(cursorMcp.mcpServers['status']).not.toHaveProperty('type');
  expect(cursorMcp.mcpServers['status']!.env).toEqual({ AGENT_BUNDLE_PLUGIN_ROOT: '${CURSOR_PLUGIN_ROOT}' });
  expect(JSON.parse(documents['hooks/hooks-cursor.json']!)).toEqual({
    hooks: {
      postToolUse: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/record-write.cursor.mjs"',
        matcher: '^Write$',
      }],
      sessionStart: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/session-start.cursor.mjs"' }],
    },
    version: 1,
  });
});

it('keeps the Claude marketplace overlay host-specific in the composite root', () => {
  const model: NormalizedPlugin = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config', sourcePath: configPath },
        target: 'claude',
        value: {
          marketplace: {
            allowCrossMarketplaceDependenciesOn: ['acme-shared'],
            owner: { email: 'plugins@example.test' },
            plugin: {
              relevance: { signals: { hosts: ['api.example.test'] } },
              source: {
                package: '@acme/bundle-example',
                source: 'npm',
                version: '^1.0.0',
              },
              strict: true,
            },
            renames: { 'legacy-bundle-example': 'bundle-example' },
          },
        },
      },
    },
  };
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.claude-plugin/marketplace.json']!)).toMatchObject({
    allowCrossMarketplaceDependenciesOn: ['acme-shared'],
    owner: { email: 'plugins@example.test', name: 'bundle-example' },
    plugins: [{
      name: 'bundle-example',
      relevance: { signals: { hosts: ['api.example.test'] } },
      source: {
        package: '@acme/bundle-example',
        source: 'npm',
        version: '^1.0.0',
      },
      strict: true,
    }],
    renames: { 'legacy-bundle-example': 'bundle-example' },
  });
  expect(JSON.parse(documents['.cursor-plugin/marketplace.json']!)).not.toHaveProperty(
    'allowCrossMarketplaceDependenciesOn',
  );
  expect(JSON.parse(documents['.agents/plugins/marketplace.json']!)).not.toHaveProperty(
    'allowCrossMarketplaceDependenciesOn',
  );
});

it('emits Cursor logo and omits it from Claude and Codex manifests', () => {
  const model: NormalizedPlugin = {
    ...bundleModel,
    metadata: {
      ...bundleModel.metadata,
      logo: {
        bytes: 64,
        path: 'assets/docs/media/logo.svg',
        source: '/workspace/docs/media/logo.svg',
      },
    },
  };
  const plan = planBundle(model);
  expect(plan.diagnostics).toEqual([]);
  const documents = writeContents(model);
  const claudePlugin = JSON.parse(documents['.claude-plugin/plugin.json']!) as Record<string, unknown>;
  const codexPlugin = JSON.parse(documents['.codex-plugin/plugin.json']!) as Record<string, unknown>;
  const cursorPlugin = JSON.parse(documents['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(claudePlugin).not.toHaveProperty('logo');
  expect(codexPlugin).not.toHaveProperty('logo');
  expect(cursorPlugin.logo).toBe('./assets/docs/media/logo.svg');
  expect(plan.entries).toContainEqual(expect.objectContaining({
    kind: 'copy',
    relativePath: 'assets/docs/media/logo.svg',
    source: '/workspace/docs/media/logo.svg',
  }));
});

it('relocates Codex subagent hooks beside Claude Code through the manifest pointer', () => {
  const model: NormalizedPlugin = {
    ...bundleModel,
    hooks: [
      {
        ...bundleModel.hooks[0]!,
        event: 'agentStart',
        id: 'hook:agent-start',
        name: 'agent-start',
        source: '/workspace/src/hooks/agent-start.ts',
      },
      {
        ...bundleModel.hooks[0]!,
        event: 'agentStop',
        id: 'hook:agent-stop',
        name: 'agent-stop',
        source: '/workspace/src/hooks/agent-stop.ts',
      },
    ],
  };
  const documents = writeContents(model);
  const codexManifest = JSON.parse(documents['.codex-plugin/plugin.json']!) as Record<string, unknown>;
  const claudeHooks = JSON.parse(documents['hooks/hooks.json']!) as {
    readonly hooks: Readonly<Record<string, readonly unknown[]>>;
  };
  const codexHooks = JSON.parse(documents['.codex-plugin/hooks.json']!) as {
    readonly hooks: Readonly<Record<string, readonly unknown[]>>;
  };

  // Claude Code owns the conventional hooks/hooks.json, so Codex reads its
  // own document through the manifest pointer; both name the same wrappers.
  expect(codexManifest).toHaveProperty('hooks', './.codex-plugin/hooks.json');
  expect(claudeHooks.hooks.SubagentStart).toHaveLength(1);
  expect(claudeHooks.hooks.SubagentStop).toHaveLength(1);
  expect(codexHooks.hooks.SubagentStart).toHaveLength(1);
  expect(codexHooks.hooks.SubagentStop).toHaveLength(1);
  expect(documents['.codex-plugin/hooks.json']).toContain('hooks/agent-start.mjs');
  expect(documents['.codex-plugin/hooks.json']).toContain('hooks/agent-stop.mjs');
});

it('emits Claude-only LSP configuration at the shared composite root', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: configPath },
        target: 'claude',
        value: {
          lspServers: {
            typescript: {
              command: 'typescript-language-server',
              extensionToLanguage: { '.ts': 'typescript' },
            },
          },
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.lsp.json']!)).toEqual({
    typescript: {
      command: 'typescript-language-server',
      extensionToLanguage: { '.ts': 'typescript' },
    },
  });
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('lspServers');
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('lspServers');
  expect(documents['AGENTS.md']).toContain('## Language servers');
  expect(documents['AGENTS.md']).toContain('must install the language server binary separately');
  expect(documents['AGENTS.md']).toContain('/plugin');
  expect(documents['AGENTS.md']).toContain('claude --debug');
});

it('emits Claude userConfig from the composite root only into the Claude manifest', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/claude.config.ts' },
        target: 'claude',
        value: {
          userConfig: {
            workspace: {
              description: 'Workspace directory.',
              required: true,
              title: 'Workspace',
              type: 'directory',
            },
          },
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).toMatchObject({
    userConfig: {
      workspace: {
        description: 'Workspace directory.',
        required: true,
        title: 'Workspace',
        type: 'directory',
      },
    },
  });
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('userConfig');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('userConfig');
  expect(plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json')?.sourceInputs)
    .toContain('/workspace/claude.config.ts');
});

it('emits Claude manifest metadata from the composite root only into the Claude manifest', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/claude-metadata.config.ts' },
        target: 'claude',
        value: {
          defaultEnabled: false,
          displayName: 'Bundle Example',
          metadata: { catalog: 'internal' },
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).toMatchObject({
    defaultEnabled: false,
    displayName: 'Bundle Example',
    metadata: { catalog: 'internal' },
  });
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('defaultEnabled');
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('displayName');
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('metadata');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('defaultEnabled');
  // Cursor owns an independent generic displayName and must not inherit the
  // Claude extension's human-readable value.
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).toHaveProperty('displayName', 'bundle-example');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('metadata');
  expect(plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json')?.sourceInputs)
    .toContain('/workspace/claude-metadata.config.ts');
});

it('emits Claude channels from the composite root only into the Claude manifest', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: '/workspace/channels.config.ts' },
        target: 'claude',
        value: {
          channels: [{
            server: 'status',
            userConfig: {
              webhook_secret: {
                description: 'Webhook signing secret.',
                sensitive: true,
                title: 'Webhook secret',
                type: 'string',
              },
            },
          }],
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);
  const claudeManifest = JSON.parse(documents['.claude-plugin/plugin.json']!) as Record<string, unknown>;

  expect(plan.diagnostics).toEqual([]);
  expect(claudeManifest.channels).toEqual([{
    server: 'status',
    userConfig: {
      webhook_secret: {
        description: 'Webhook signing secret.',
        sensitive: true,
        title: 'Webhook secret',
        type: 'string',
      },
    },
  }]);
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('channels');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('channels');
  expect(plan.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json')?.sourceInputs)
    .toContain('/workspace/channels.config.ts');
});

it('emits the Claude bin directory at the composite root', () => {
  const model: NormalizedPlugin = {
    ...bundleModel,
    hostBins: [{
      files: [{
        bytes: 37,
        executable: true,
        relativePath: 'review-tool',
        source: '/workspace/tools/review-tool',
      }],
      provenance: { kind: 'config', sourcePath: configPath },
      source: '/workspace/tools',
      target: 'claude',
    }],
  };
  const plan = planBundle(model);

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.filter((entry) => entry.relativePath.startsWith('bin/'))).toEqual([{
    bytes: 37,
    kind: 'copy',
    prebuilt: true,
    relativePath: 'bin/review-tool',
    source: '/workspace/tools/review-tool',
    sourceInputs: [configPath, '/workspace/tools/review-tool'],
  }]);
  expect(writeContents(model)['AGENTS.md']).toContain('`bin/`');
});

it('emits Claude workflows and output styles at the composite root', () => {
  const model: NormalizedPlugin = {
    ...bundleModel,
    hostOutputStyles: [{
      files: [{
        bytes: 72,
        executable: false,
        relativePath: 'terse.md',
        source: '/workspace/styles/terse.md',
      }],
      provenance: { kind: 'config', sourcePath: configPath },
      source: '/workspace/styles',
      target: 'claude',
    }],
    hostWorkflows: [{
      files: [{
        bytes: 48,
        executable: false,
        relativePath: 'release-audit.js',
        source: '/workspace/workflows/release-audit.js',
      }],
      provenance: { kind: 'config', sourcePath: configPath },
      source: '/workspace/workflows',
      target: 'claude',
    }],
  };
  const plan = planBundle(model);

  expect(plan.diagnostics).toEqual([]);
  expect(plan.entries.filter((entry) =>
    entry.relativePath.startsWith('workflows/') || entry.relativePath.startsWith('output-styles/'))).toEqual([
    {
      bytes: 72,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'output-styles/terse.md',
      source: '/workspace/styles/terse.md',
      sourceInputs: [configPath, '/workspace/styles/terse.md'],
    },
    {
      bytes: 48,
      kind: 'copy',
      prebuilt: true,
      relativePath: 'workflows/release-audit.js',
      source: '/workspace/workflows/release-audit.js',
      sourceInputs: [configPath, '/workspace/workflows/release-audit.js'],
    },
  ]);
  expect(writeContents(model)['AGENTS.md']).toContain('`workflows/`');
  expect(writeContents(model)['AGENTS.md']).toContain('`output-styles/`');
});

it('emits Claude-only plugin default settings at the shared composite root', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: configPath },
        target: 'claude',
        value: {
          settings: {
            subagentStatusLine: { command: 'node scripts/rows.mjs', type: 'command' },
          },
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['settings.json']!)).toEqual({
    subagentStatusLine: { command: 'node scripts/rows.mjs', type: 'command' },
  });
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('settings');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('settings');
  expect(documents['AGENTS.md']).toContain('- `settings.json` — Claude Code default configuration');
});

it('emits Claude-only experimental themes and monitors at the shared composite root', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: configPath },
        target: 'claude',
        value: {
          monitors: [{
            command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs',
            description: 'Watch the review queue.',
            name: 'review-queue',
            when: 'on-skill-invoke:review',
          }],
          themes: {
            dracula: {
              base: 'dark',
              overrides: { claude: '#bd93f9', error: '#ff5555' },
            },
          },
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([expect.objectContaining({
    code: 'claude.monitors.availability',
    severity: 'warning',
    target: 'claude',
  })]);
  expect(JSON.parse(documents['themes/dracula.json']!)).toEqual({
    base: 'dark',
    name: 'dracula',
    overrides: { claude: '#bd93f9', error: '#ff5555' },
  });
  expect(JSON.parse(documents['monitors/monitors.json']!)).toEqual([{
    command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs',
    description: 'Watch the review queue.',
    name: 'review-queue',
    when: 'on-skill-invoke:review',
  }]);
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('experimental');
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('experimental');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('experimental');
});

it('emits Claude-only dependencies at the composite root', () => {
  const model = {
    ...bundleModel,
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config' as const, sourcePath: configPath },
        target: 'claude',
        value: {
          dependencies: [
            { marketplace: 'acme-shared', name: 'audit-logger' },
            { marketplace: 'acme-shared', name: 'policy-kit', version: '^2.0' },
          ],
        },
      },
    },
  } satisfies NormalizedPlugin;
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!).dependencies).toEqual([
    { marketplace: 'acme-shared', name: 'audit-logger' },
    { marketplace: 'acme-shared', name: 'policy-kit', version: '^2.0' },
  ]);
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('dependencies');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('dependencies');
});

it('emits each shared surface exactly once with no duplicate artifact paths', () => {
  const plan = planBundle(bundleModel);
  const paths = plan.entries.map((entry) => entry.relativePath);
  expect(paths.filter((path) => path === 'skills/review/SKILL.md')).toHaveLength(1);
  expect(paths.filter((path) => path === 'skills/review/references/guide.md')).toHaveLength(1);
  expect(new Set(paths).size).toBe(paths.length);

  // One host-detecting wrapper per hook for Claude Code and Codex, one
  // dedicated Cursor wrapper per hook; every wrapper records the hosts it serves.
  const hookEntries = plan.hookEntries ?? [];
  expect(hookEntries.map((entry) => entry.relativePath).sort()).toEqual([
    'hooks/record-write.cursor.mjs',
    'hooks/record-write.mjs',
    'hooks/session-start.cursor.mjs',
    'hooks/session-start.mjs',
  ]);
  expect(Object.fromEntries(hookEntries.map((entry) => [entry.relativePath, [...(entry.hosts ?? [])].sort()]))).toEqual({
    'hooks/record-write.cursor.mjs': ['cursor'],
    'hooks/record-write.mjs': ['claude', 'codex'],
    'hooks/session-start.cursor.mjs': ['cursor'],
    'hooks/session-start.mjs': ['claude', 'codex'],
  });
  expect(new Set(hookEntries.map((entry) => entry.artifactTarget))).toEqual(new Set(['claude+codex+cursor']));
});

it('emits Cursor-only rules once at the shared root and documents the honest host boundary', () => {
  const markdown = '---\ndescription: Keep changes focused\n---\nStay focused.';
  const model: NormalizedPlugin = {
    ...bundleModel,
    rules: [{
      body: 'Stay focused.',
      emittedMarkdown: markdown,
      frontmatter: { description: 'Keep changes focused' },
      id: 'rule:focused',
      markdown,
      name: 'focused',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/rules/focused.mdc' },
      source: '/workspace/src/rules/focused.mdc',
      targets: ['cursor'],
    }],
  };
  const plan = planBundle(model);
  const documents = writeContents(model);
  const paths = plan.entries.map((entry) => entry.relativePath);

  expect(plan.diagnostics).toEqual([]);
  expect(paths.filter((path) => path === 'rules/focused.mdc')).toHaveLength(1);
  expect(documents['rules/focused.mdc']).toBe(markdown);
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).toMatchObject({ rules: './rules/' });
  expect(JSON.parse(documents['.claude-plugin/plugin.json']!)).not.toHaveProperty('rules');
  expect(JSON.parse(documents['.codex-plugin/plugin.json']!)).not.toHaveProperty('rules');
  expect(documents['AGENTS.md']).toContain('- `rules/` — Cursor rules (`.mdc`). Cursor only.');

  const ruleFree = planBundle(bundleModel);
  expect(ruleFree.entries.some((entry) => entry.relativePath.startsWith('rules/'))).toBe(false);
  expect(writeContents(bundleModel)['AGENTS.md']).not.toContain('`rules/`');
  expect(JSON.parse(writeContents(bundleModel)['.cursor-plugin/plugin.json']!)).not.toHaveProperty('rules');
});

it('emits Claude-format commands without pointing Cursor at the shared directory', () => {
  const command = {
    body: 'Review the staged diff.\n',
    frontmatter: {
      argumentHint: '[path]',
      description: 'Review changes',
    },
    id: 'command:review',
    markdown: '---\ndescription: Review changes\nargumentHint: "[path]"\n---\nReview the staged diff.\n',
    name: 'review',
    provenance: { kind: 'conventional' as const, sourcePath: '/workspace/src/commands/review.md' },
    source: '/workspace/src/commands/review.md',
  };
  const model: NormalizedPlugin = { ...bundleModel, commands: [{ ...command, targets: ['claude'] }] };
  const plan = planBundle(model);
  const documents = writeContents(model);

  expect(plan.diagnostics).toEqual([]);
  expect(documents['commands/review.md']).toBe([
    '---',
    'argument-hint: "[path]"',
    'description: Review changes',
    '---',
    'Review the staged diff.',
    '',
  ].join('\n'));
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).not.toHaveProperty('commands');
  expect(documents['AGENTS.md']).toContain('- `commands/` — Claude Code command prompts. Claude Code only.');

  // Cursor reads plain Markdown prompts from the same commands/ directory, so
  // a command cannot select Cursor beside Claude Code in one root (AB4104).
  const overlapping = planBundle({ ...bundleModel, commands: [{ ...command, targets: ['claude', 'cursor'] }] });
  expect(overlapping.diagnostics).toEqual([expect.objectContaining({
    code: 'AB4104',
    severity: 'error',
    sourcePath: '/workspace/src/commands/review.md',
  })]);
  expect(overlapping.entries).toEqual([]);

  const commandFree = planBundle(bundleModel);
  expect(commandFree.entries.some((entry) => entry.relativePath.startsWith('commands/'))).toBe(false);
  expect(writeContents(bundleModel)['AGENTS.md']).not.toContain('`commands/`');
  expect(JSON.parse(writeContents(bundleModel)['.cursor-plugin/plugin.json']!)).not.toHaveProperty('commands');
});

it('bakes runtime host detection into the universal wrapper source', () => {
  const plan = planBundle(bundleModel);
  const wrapper = (plan.hookEntries ?? []).find((entry) => entry.relativePath === 'hooks/session-start.mjs');
  expect(wrapper?.virtualSource).toContain('process.env.PLUGIN_ROOT === undefined ? "claude" : "codex"');
  expect(wrapper?.virtualSource).toContain('AGENT_BUNDLE_HOOK_HOST');
});

it('reports a bundle-target conflict instead of silently overwriting an entry', () => {
  // Two skills whose resources collide at the same artifact path with different sources.
  const model: NormalizedPlugin = {
    ...bundleModel,
    marketplace: undefined,
    mcpServers: [],
    skills: [
      bundleModel.skills[0]!,
      {
        ...bundleModel.skills[0]!,
        id: 'skill:review-shadow',
        provenance: { kind: 'explicit', sourcePath: '/workspace/other/review/SKILL.md' },
        resources: [{ bytes: 5, relativePath: 'SKILL.md', source: '/workspace/other/review/SKILL.md' }],
        source: '/workspace/other/review/SKILL.md',
      },
    ],
  };
  const plan = planBundle(model);
  expect(plan.diagnostics).toEqual([expect.objectContaining({ code: 'AB4105', severity: 'error' })]);
  expect(plan.entries.filter((entry) => entry.relativePath === 'skills/review/SKILL.md')).toHaveLength(1);
});

it('builds the composite plugin root on disk with a compiled universal hook wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-plugin-bundle-'));
  const outputRoot = join(root, 'dist');
  const skillRoot = join(root, 'src', 'skills', 'review');
  const skillMarkdown = '---\nname: review\ndescription: Review code and explain findings.\n---\n\n# Review\n';
  await mkdir(join(skillRoot, 'references'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
    writeFile(join(skillRoot, 'SKILL.md'), skillMarkdown),
    writeFile(join(skillRoot, 'references', 'guide.md'), '# Guide\n'),
  ]);
  const hookSource = join(root, 'src', 'hooks', 'session-start.ts');
  await mkdir(join(root, 'src', 'hooks'), { recursive: true });
  await writeFile(hookSource, "export default (event: unknown, context: { target: string }) => ({ additionalContext: `host:${context.target}`, outcome: 'continue' as const });\n");
  const model: NormalizedPlugin = {
    ...bundleModel,
    hooks: [{
      ...bundleModel.hooks[0]!,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: hookSource,
    }],
    mcpServers: [],
    metadata: {
      ...bundleModel.metadata,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    },
    skills: [{
      ...bundleModel.skills[0]!,
      dir: skillRoot,
      provenance: { kind: 'conventional', sourcePath: join(skillRoot, 'SKILL.md') },
      resources: [
        { bytes: Buffer.byteLength(skillMarkdown), relativePath: 'SKILL.md', source: join(skillRoot, 'SKILL.md') },
        { bytes: 8, relativePath: 'references/guide.md', source: join(skillRoot, 'references', 'guide.md') },
      ],
      source: join(skillRoot, 'SKILL.md'),
    }],
    targets: compositeHosts.map((name) => ({
      id: `target:${name}`,
      name,
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    })),
  };

  try {
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    // Every host manifest and compiled file lives directly at the output root.
    const bundleRoot = outputRoot;
    const claudePlugin = JSON.parse(await readFile(join(bundleRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    expect(claudePlugin).toMatchObject({ name: 'bundle-example' });
    expect(claudePlugin).not.toHaveProperty('hooks');
    const codexPlugin = JSON.parse(await readFile(join(bundleRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>;
    expect(codexPlugin).toMatchObject({ hooks: './.codex-plugin/hooks.json', skills: './skills/' });
    await expect(readFile(join(bundleRoot, 'AGENTS.md'), 'utf8')).resolves.toContain('multi-host agent plugin root');
    await expect(readFile(join(bundleRoot, 'INSTALL.md'), 'utf8')).resolves.toContain('claude plugin install bundle-example');
    await expect(readFile(join(bundleRoot, 'skills', 'review', 'SKILL.md'), 'utf8')).resolves.toBe(skillMarkdown);
    await expect(readFile(join(bundleRoot, 'hooks', 'hooks.json'), 'utf8')).resolves.toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs');
    await expect(readFile(join(bundleRoot, '.codex-plugin', 'hooks.json'), 'utf8')).resolves.toContain('hooks/session-start.mjs');
    const wrapper = join(bundleRoot, 'hooks', 'session-start.mjs');
    const nativeInput = JSON.stringify({
      cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup', transcript_path: '/workspace/transcript.json',
    });
    // Codex documents exporting PLUGIN_ROOT into hook processes; Claude does not.
    expect(process.env['PLUGIN_ROOT']).toBeUndefined();
    await expect(runNodeScript({ args: [wrapper], env: { PLUGIN_ROOT: '/plugin' }, input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:codex'),
    });
    await expect(runNodeScript({ args: [wrapper], input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:claude'),
    });
    await expect(runNodeScript({ args: [wrapper], env: { AGENT_BUNDLE_HOOK_HOST: 'codex' }, input: nativeInput })).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('host:codex'),
    });
    // The Cursor wrapper speaks Cursor's own envelope: session ids over
    // conversation fields in, snake_case additional_context out.
    const cursorWrapper = join(bundleRoot, 'hooks', 'session-start.cursor.mjs');
    const cursorInput = JSON.stringify({
      composer_mode: 'agent', conversation_id: 'conv-1', cursor_version: '2.4.1', hook_event_name: 'sessionStart',
      is_background_agent: false, session_id: 'conv-1', transcript_path: null, workspace_roots: ['/workspace'],
    });
    const cursorRun = await runNodeScript({ args: [cursorWrapper], input: cursorInput });
    expect(cursorRun.code).toBe(0);
    expect(JSON.parse(cursorRun.stdout) as Record<string, unknown>).toEqual({ additional_context: 'host:cursor' });
    const manifest = JSON.parse(await readFile(join(outputRoot, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly { readonly path: string }[];
      readonly targets: readonly { readonly name: string }[];
    };
    expect(manifest.targets.map(({ name }) => name)).toEqual(['claude', 'codex', 'cursor']);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json',
      '.codex-plugin/hooks.json',
      '.codex-plugin/plugin.json',
      '.cursor-plugin/marketplace.json',
      '.cursor-plugin/plugin.json',
      'AGENTS.md',
      'INSTALL.md',
      'hooks/hooks-cursor.json',
      'hooks/hooks.json',
      'hooks/session-start.cursor.mjs',
      'hooks/session-start.mjs',
      'skills/review/SKILL.md',
    ]));
    expect(manifest.files.some((file) => file.path.startsWith('plugin/') || file.path.startsWith('claude/'))).toBe(false);
    // The hook index lists the shared wrapper once per host it serves.
    const hookIndex = JSON.parse(await readFile(join(outputRoot, 'agent-bundle.hooks.json'), 'utf8')) as {
      readonly hooks: readonly { readonly path: string; readonly target: string }[];
    };
    expect(hookIndex.hooks.map(({ path, target }) => ({ path, target }))).toEqual([
      { path: 'hooks/session-start.mjs', target: 'claude' },
      { path: 'hooks/session-start.mjs', target: 'codex' },
      { path: 'hooks/session-start.cursor.mjs', target: 'cursor' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);
