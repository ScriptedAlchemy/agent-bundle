import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { codexAdapter } from '../src/adapters/codex.ts';
import { emitPlanEntries } from '../src/build/emit.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const nativeIt = process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1' ? it : it.skip;

interface ClaudeValidation {
  readonly code: number | null;
  readonly output: string;
}

interface CodexValidation {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const runClaude = async (
  cwd: string,
  args: readonly string[],
  configDir?: string,
): Promise<ClaudeValidation> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn('claude', args, {
      cwd,
      ...(configDir === undefined
        ? {}
        : { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, output }));
  });

const runClaudeValidation = async (cwd: string, target: string): Promise<ClaudeValidation> =>
  runClaude(cwd, ['plugin', 'validate', '--strict', target]);

const runCodex = async (
  cwd: string,
  args: readonly string[],
  codexHome: string,
): Promise<CodexValidation> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn('codex', args, {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stderr, stdout }));
  });

const model: NormalizedPlugin = {
  extensions: {},
  hooks: [],
  marketplace: true,
  mcpServers: [],
  metadata: {
    description: 'Review code and explain findings.',
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    version: '1.2.3',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:claude',
    name: 'claude',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
  }],
};

const withClaudeSettings = (settings: unknown): NormalizedPlugin => ({
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
  experimental: Readonly<{ readonly monitors?: unknown; readonly themes?: unknown }>,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: experimental,
    },
  },
});

const withClaudeDependencies = (dependencies: unknown): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: { dependencies },
    },
  },
});

const withClaudeMarketplace = (marketplace: unknown): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: { marketplace },
    },
  },
});

const withClaudeManifestMetadata = (
  manifestMetadata: Readonly<Record<string, unknown>>,
): NormalizedPlugin => ({
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: manifestMetadata,
    },
  },
});

const channelModel: NormalizedPlugin = {
  ...model,
  extensions: {
    claude: {
      id: 'extension:claude',
      key: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      target: 'claude',
      value: {
        channels: [{
          server: 'telegram',
          userConfig: {
            bot_token: {
              description: 'Telegram bot token.',
              sensitive: true,
              title: 'Bot token',
              type: 'string',
            },
          },
        }],
      },
    },
  },
  mcpServers: [{
    command: 'node',
    id: 'mcp:telegram',
    name: 'telegram',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    targets: ['claude'],
    transport: 'stdio',
  }],
};

const writeClaudeArtifact = async (
  root: string,
  planned: NormalizedPlugin,
): Promise<readonly string[]> => {
  const written: string[] = [];
  for (const entry of claudeAdapter.plan(planned).entries) {
    if (entry.kind !== 'write') continue;
    const output = join(root, entry.relativePath);
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, entry.content);
    written.push(entry.relativePath);
  }
  return written;
};

nativeIt('registers an emitted Codex plugin carrying authored package metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-manifest-metadata-'));
  const pluginRoot = join(root, 'plugin');
  const codexHome = join(root, 'codex-home');
  const metadataModel: NormalizedPlugin = {
    ...model,
    extensions: {
      codex: {
        id: 'extension:codex',
        key: 'codex',
        provenance: { kind: 'config', sourcePath: '/workspace/codex.config.ts' },
        target: 'codex',
        value: {
          author: {
            email: 'plugins@example.test',
            name: 'Review Tools Team',
            url: 'https://example.test/review-tools',
          },
          homepage: 'https://example.test/review-tools/docs',
          keywords: ['review', 'security'],
          license: 'MIT',
          repository: 'https://github.com/example/review-tools',
        },
      },
    },
  };

  try {
    await Promise.all([
      mkdir(pluginRoot, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    const plan = codexAdapter.plan(metadataModel);
    expect(plan.diagnostics).toEqual([]);
    await emitPlanEntries({ entries: plan.entries, root: pluginRoot });

    const version = await runCodex(root, ['--version'], codexHome);
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout).toContain('0.147.0');
    const marketplace = await runCodex(
      root,
      ['plugin', 'marketplace', 'add', pluginRoot],
      codexHome,
    );
    expect(marketplace.code, marketplace.stderr).toBe(0);
    const installed = await runCodex(
      root,
      ['plugin', 'add', 'review-tools@review-tools-marketplace', '--json'],
      codexHome,
    );
    expect(installed.code, installed.stderr).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ name: 'review-tools' });
    const listed = await runCodex(root, ['plugin', 'list', '--json'], codexHome);
    expect(listed.code, listed.stderr).toBe(0);
    const listedDocument = JSON.parse(listed.stdout) as {
      readonly installed: readonly Record<string, unknown>[];
    };
    expect(listedDocument).toMatchObject({
      available: [],
      installed: [{
        enabled: true,
        installed: true,
        marketplaceName: 'review-tools-marketplace',
        name: 'review-tools',
        pluginId: 'review-tools@review-tools-marketplace',
        version: '1.2.3',
      }],
    });
    expect(listedDocument.installed[0]).not.toHaveProperty('author');
    expect(listedDocument.installed[0]).not.toHaveProperty('homepage');
    expect(listedDocument.installed[0]).not.toHaveProperty('keywords');
    expect(listedDocument.installed[0]).not.toHaveProperty('license');
    expect(listedDocument.installed[0]).not.toHaveProperty('repository');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('installs and lists an emitted Codex plugin carrying the complete interface block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-interface-'));
  const pluginRoot = join(root, 'plugin');
  const codexHome = join(root, 'codex-home');
  const interfaceModel: NormalizedPlugin = {
    ...model,
    extensions: {
      codex: {
        id: 'extension:codex',
        key: 'codex',
        provenance: { kind: 'config', sourcePath: '/workspace/codex.config.ts' },
        target: 'codex',
        value: {
          interface: {
            brandColor: '#10A37F',
            capabilities: ['Interactive'],
            category: 'Developer Tools',
            composerIcon: './assets/icon.png',
            defaultPrompt: ['Review this repository.'],
            developerName: 'Agent Bundle',
            displayName: 'Review Tools',
            logo: './assets/logo.png',
            longDescription: 'Review code and explain findings with repository context.',
            privacyPolicyURL: 'https://example.test/privacy',
            screenshots: ['./assets/overview.png'],
            shortDescription: 'Repository-aware code review',
            termsOfServiceURL: 'https://example.test/terms',
            websiteURL: 'https://example.test/review-tools',
          },
        },
      },
    },
  };

  try {
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(pluginRoot, 'assets'), { recursive: true }),
    ]);
    const plan = codexAdapter.plan(interfaceModel);
    expect(plan.diagnostics).toEqual([]);
    await emitPlanEntries({ entries: plan.entries, root: pluginRoot });
    await Promise.all([
      writeFile(join(pluginRoot, 'assets', 'icon.png'), 'native icon proof\n'),
      writeFile(join(pluginRoot, 'assets', 'logo.png'), 'native logo proof\n'),
      writeFile(join(pluginRoot, 'assets', 'overview.png'), 'native screenshot proof\n'),
    ]);

    // The pinned CLI publishes no plugin validate subcommand; install and
    // list are the honest native acceptance probes for the interface block.
    const pluginHelp = await runCodex(root, ['plugin', '--help'], codexHome);
    expect(pluginHelp.code, pluginHelp.stderr).toBe(0);
    expect(`${pluginHelp.stdout}${pluginHelp.stderr}`).not.toMatch(/\bvalidate\b/u);

    const marketplace = await runCodex(
      root,
      ['plugin', 'marketplace', 'add', pluginRoot],
      codexHome,
    );
    expect(marketplace.code, marketplace.stderr).toBe(0);
    const added = await runCodex(
      root,
      ['plugin', 'add', 'review-tools@review-tools-marketplace'],
      codexHome,
    );
    expect(added.code, added.stderr).toBe(0);
    const listed = await runCodex(root, ['plugin', 'list'], codexHome);
    expect(listed.code, listed.stderr).toBe(0);
    expect(`${listed.stdout}${listed.stderr}`).toContain('review-tools');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('pins Claude plugin and marketplace lifecycle command help', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-lifecycle-help-'));

  try {
    const [version, pluginHelp, marketplaceHelp] = await Promise.all([
      runClaude(root, ['--version'], root),
      runClaude(root, ['plugin', '--help'], root),
      runClaude(root, ['plugin', 'marketplace', '--help'], root),
    ]);

    expect(version.code, version.output).toBe(0);
    expect(version.output).toContain('2.1.257');
    expect(pluginHelp.code, pluginHelp.output).toBe(0);
    for (const command of [
      'details',
      'disable',
      'enable',
      'init|new',
      'install|i',
      'list',
      'marketplace',
      'prune|autoremove',
      'tag',
      'uninstall|remove',
      'update',
    ]) {
      expect(pluginHelp.output).toContain(command);
    }
    expect(pluginHelp.output).toContain('restart required to apply');
    expect(marketplaceHelp.code, marketplaceHelp.output).toBe(0);
    for (const command of ['add', 'list', 'remove|rm', 'update']) {
      expect(marketplaceHelp.output).toContain(command);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('adds, lists, and removes a marketplace only in an isolated config directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-lifecycle-'));
  const marketplaceRoot = join(root, 'marketplace');
  const pluginRoot = join(marketplaceRoot, 'plugin');
  const configRoot = join(root, 'config');
  const marketplaceName = 'agent-bundle-native-policy';

  try {
    await Promise.all([
      mkdir(join(marketplaceRoot, '.claude-plugin'), { recursive: true }),
      mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true }),
      mkdir(configRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        `${JSON.stringify({
          name: marketplaceName,
          owner: { name: 'agent-bundle' },
          plugins: [{
            description: 'Native lifecycle proof.',
            name: 'native-policy-proof',
            source: './plugin',
            version: '1.0.0',
          }],
        })}\n`,
      ),
      writeFile(
        join(pluginRoot, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({
          description: 'Native lifecycle proof.',
          name: 'native-policy-proof',
          version: '1.0.0',
        })}\n`,
      ),
    ]);

    const added = await runClaude(root, ['plugin', 'marketplace', 'add', marketplaceRoot], configRoot);
    expect(added.code, added.output).toBe(0);
    const listed = await runClaude(root, ['plugin', 'marketplace', 'list'], configRoot);
    expect(listed.code, listed.output).toBe(0);
    expect(listed.output).toContain(marketplaceName);
    const removed = await runClaude(root, ['plugin', 'marketplace', 'remove', marketplaceName], configRoot);
    expect(removed.code, removed.output).toBe(0);
    const listedAfterRemoval = await runClaude(root, ['plugin', 'marketplace', 'list'], configRoot);
    expect(listedAfterRemoval.code, listedAfterRemoval.output).toBe(0);
    expect(listedAfterRemoval.output).not.toContain(marketplaceName);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts the emitted Claude marketplace under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-'));

  try {
    await writeClaudeArtifact(root, model);
    const validation = await runClaudeValidation(root, join(root, '.claude-plugin', 'marketplace.json'));
    expect(validation.code, validation.output).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records that strict validation accepts package metadata without running the dependency install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-package-validation-'));

  try {
    await writeClaudeArtifact(root, model);
    await Promise.all([
      writeFile(join(root, 'package.json'), `${JSON.stringify({
        dependencies: { 'native-validation-proof': '1.0.0' },
        name: 'native-package-proof',
        version: '1.0.0',
      })}\n`),
      writeFile(join(root, 'package-lock.json'), `${JSON.stringify({
        lockfileVersion: 3,
        name: 'native-package-proof',
        packages: {
          '': {
            dependencies: { 'native-validation-proof': '1.0.0' },
            name: 'native-package-proof',
            version: '1.0.0',
          },
        },
        requires: true,
        version: '1.0.0',
      })}\n`),
    ]);
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('package.json');
    expect(validation.output).not.toContain('package-lock.json');
    await expect(access(join(root, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records that strict validation does not catch a path-escaping plugin symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-symlink-validation-'));
  const externalSkill = `${root}-outside-skill`;

  try {
    await writeClaudeArtifact(root, model);
    await mkdir(externalSkill, { recursive: true });
    await writeFile(
      join(externalSkill, 'SKILL.md'),
      '---\nname: outside-skill\ndescription: Lives outside the plugin root.\n---\nOutside.\n',
    );
    await mkdir(join(root, 'skills'), { recursive: true });
    await symlink(externalSkill, join(root, 'skills', 'outside-skill'), 'dir');
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('outside-skill');
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(externalSkill, { force: true, recursive: true }),
    ]);
  }
});

nativeIt('accepts the enriched Claude marketplace under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-enriched-'));

  try {
    await writeClaudeArtifact(root, withClaudeMarketplace({
      allowCrossMarketplaceDependenciesOn: ['acme-shared'],
      metadata: { pluginRoot: './plugins' },
      owner: {
        email: 'plugins@example.test',
        url: 'https://example.test/plugins',
      },
      plugin: {
        author: {
          email: 'review-tools@example.test',
          name: 'Review Tools Team',
          url: 'https://example.test/review-tools',
        },
        category: 'Developer Tools',
        defaultEnabled: false,
        displayName: 'Review Tools',
        metadata: { catalogId: 'review-tools' },
        relevance: {
          signals: {
            cli: ['git'],
            hosts: ['api.example.test'],
          },
          topic: 'Code review',
        },
        strict: true,
        tags: ['review'],
      },
      renames: { 'legacy-review-tools': 'review-tools' },
      version: '2',
    }));
    const validation = await runClaudeValidation(
      root,
      join(root, '.claude-plugin', 'marketplace.json'),
    );

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts every documented Claude marketplace plugin source form', async () => {
  const sources = [
    {
      label: 'github',
      plugin: {
        source: {
          source: 'github',
          repo: 'acme/review-tools',
          ref: 'v1.2.3',
          sha: 'a'.repeat(40),
        },
      },
    },
    {
      label: 'git-url',
      plugin: {
        source: {
          source: 'url',
          url: 'https://git.example.test/acme/review-tools.git',
          ref: 'main',
          sha: 'b'.repeat(40),
        },
      },
    },
    {
      label: 'git-subdir',
      plugin: {
        source: {
          source: 'git-subdir',
          url: 'acme/monorepo',
          path: 'plugins/review-tools',
          ref: 'main',
          sha: 'c'.repeat(40),
        },
      },
    },
    {
      label: 'npm',
      plugin: {
        source: {
          source: 'npm',
          package: '@acme/review-tools',
          version: '^1.2.3',
          registry: 'https://npm.example.test',
        },
      },
    },
    {
      label: 'archive',
      plugin: {
        headers: { Authorization: 'Bearer native-test-token' },
        headersHelper: 'printf \'{}\'',
        source: {
          source: 'archive',
          url: 'https://artifacts.example.test/review-tools.zip',
          sha256: 'd'.repeat(64),
        },
        strict: false,
      },
    },
    {
      label: 'command-copy',
      plugin: {
        source: {
          source: 'command',
          command: 'review-tools plugin-path',
          timeout: 120,
          mode: 'copy',
        },
      },
    },
    {
      label: 'command-link',
      plugin: {
        source: {
          source: 'command',
          command: 'review-tools plugin-path',
          mode: 'link',
        },
      },
    },
  ] as const;

  for (const { label, plugin } of sources) {
    const root = await mkdtemp(join(tmpdir(), `agent-bundle-claude-source-${label}-`));
    try {
      await writeClaudeArtifact(root, withClaudeMarketplace({ plugin }));
      const validation = await runClaudeValidation(
        root,
        join(root, '.claude-plugin', 'marketplace.json'),
      );

      expect(validation.code, `${label}: ${validation.output}`).toBe(0);
      expect(validation.output).toContain('Validation passed');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

nativeIt('records which source constraints strict Claude marketplace validation enforces', async () => {
  const cases = [
    {
      expectedCode: 1,
      label: 'short github sha',
      output: 'full 40-character lowercase git commit SHA',
      source: { source: 'github', repo: 'acme/review-tools', sha: 'abc123' },
    },
    {
      expectedCode: 1,
      label: 'insecure archive URL',
      output: 'Archive URLs must use https://',
      source: { source: 'archive', url: 'http://artifacts.example.test/review-tools.zip' },
    },
    {
      expectedCode: 0,
      label: 'unreachable archive URL',
      output: 'Validation passed',
      source: { source: 'archive', url: 'https://does-not-exist.invalid/review-tools.zip' },
    },
    {
      expectedCode: 0,
      label: 'failing command',
      output: 'Validation passed',
      source: { source: 'command', command: 'exit 9' },
    },
    {
      expectedCode: 1,
      label: 'unknown command mode',
      output: 'plugins.0.source: Invalid input',
      source: { source: 'command', command: 'review-tools plugin-path', mode: 'move' },
    },
  ] as const;

  for (const { expectedCode, label, output, source } of cases) {
    const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-source-negative-'));
    try {
      await writeClaudeArtifact(root, model);
      const marketplacePath = join(root, '.claude-plugin', 'marketplace.json');
      const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8')) as {
        plugins: Record<string, unknown>[];
      };
      marketplace.plugins[0]!['source'] = source;
      await writeFile(marketplacePath, `${JSON.stringify(marketplace)}\n`);
      const validation = await runClaudeValidation(root, marketplacePath);

      expect(validation.code, `${label}: ${validation.output}`).toBe(expectedCode);
      expect(validation.output).toContain(output);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

nativeIt('records whether strict native validation enforces marketplace allowlist entry names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-allowlist-invalid-'));

  try {
    await writeClaudeArtifact(root, model);
    const marketplacePath = join(root, '.claude-plugin', 'marketplace.json');
    const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8')) as Record<string, unknown>;
    marketplace['allowCrossMarketplaceDependenciesOn'] = [''];
    await writeFile(marketplacePath, `${JSON.stringify(marketplace)}\n`);
    const validation = await runClaudeValidation(root, marketplacePath);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('allowCrossMarketplaceDependenciesOn');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records that strict native validation rejects archive authentication on a relative source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-relative-auth-'));

  try {
    await writeClaudeArtifact(root, model);
    const marketplacePath = join(root, '.claude-plugin', 'marketplace.json');
    const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8')) as {
      plugins: Record<string, unknown>[];
    };
    marketplace.plugins[0]!['headers'] = { Authorization: 'Bearer test-token' };
    marketplace.plugins[0]!['headersHelper'] = 'printf \'{}\'';
    marketplace.plugins[0]!['strict'] = false;
    await writeFile(marketplacePath, `${JSON.stringify(marketplace)}\n`);
    const validation = await runClaudeValidation(root, marketplacePath);

    // The fields are documented only for archive downloads. The host reports
    // their inapplicability as a warning, and --strict promotes that warning
    // to failure; URL-capable sources remain a separate follow-up.
    expect(validation.code).not.toBe(0);
    expect(validation.output).toContain('headersHelper');
    expect(validation.output).toContain('only apply to "archive" sources');
    expect(validation.output).toContain('--strict treats warnings as errors');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts an emitted Claude artifact whose plugin root carries settings.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-settings-'));

  try {
    const written = await writeClaudeArtifact(root, withClaudeSettings({
      agent: 'security-reviewer',
      subagentStatusLine: { command: 'node scripts/rows.mjs', type: 'command' },
    }));
    expect(written).toContain('settings.json');

    // Both documented validation entry points: the marketplace manifest and
    // the plugin directory itself.
    for (const target of [join(root, '.claude-plugin', 'marketplace.json'), root]) {
      const validation = await runClaudeValidation(root, target);
      expect(validation.code, validation.output).toBe(0);
      expect(validation.output).toContain('Validation passed');
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records that strict native validation never inspects plugin settings.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-settings-invalid-'));

  try {
    await writeClaudeArtifact(root, model);
    // Deliberately malformed against the documented two-key contract: an
    // empty `agent`, the user-scope-only `statusLine` key, and `padding`,
    // which is documented for `statusLine` alone.
    await writeFile(
      join(root, 'settings.json'),
      '{"agent":"","statusLine":{"type":"command","command":"rows.sh"},"padding":3}\n',
    );
    const validation = await runClaudeValidation(root, root);

    // The host validator ignores settings.json even under --strict, so the
    // compiler's own claude.settings.* diagnostics are the only guard an
    // author gets before the plugin is enabled in a session.
    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).not.toContain('settings.json');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records strict native validation behavior for documented and security-sensitive plugin agent fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-agents-'));
  const cases = [
    {
      fileName: 'test-agent.md',
      frontmatter: [
        'name: test-agent',
        'description: Exercises every documented plugin-agent field.',
        'model: inherit',
        'effort: high',
        'maxTurns: 3',
        'tools:',
        '  - Read',
        'disallowedTools:',
        '  - Write',
        'skills:',
        '  - review',
        'memory: project',
        'background: true',
        'isolation: worktree',
      ],
      label: 'documented fields',
    },
    {
      fileName: 'security-sensitive.md',
      frontmatter: [
        'name: security-sensitive',
        'description: Probes plugin-agent fields that the host security contract ignores.',
        'hooks: {}',
        'mcpServers: []',
        'permissionMode: bypassPermissions',
      ],
      label: 'security-sensitive fields',
    },
  ] as const;

  try {
    for (const { fileName, frontmatter, label } of cases) {
      const caseRoot = join(root, fileName.replace('.md', ''));
      const configRoot = join(caseRoot, 'config');
      const pluginRoot = join(caseRoot, 'plugin');
      await writeClaudeArtifact(pluginRoot, model);
      await Promise.all([
        mkdir(join(pluginRoot, 'agents'), { recursive: true }),
        mkdir(configRoot, { recursive: true }),
      ]);
      await writeFile(
        join(pluginRoot, 'agents', fileName),
        `---\n${frontmatter.join('\n')}\n---\n\nInspect the repository and report findings.\n`,
      );

      const validation = await runClaude(
        pluginRoot,
        ['plugin', 'validate', '--strict', pluginRoot],
        configRoot,
      );

      expect(validation.code, `${label}: ${validation.output}`).toBe(0);
      expect(validation.output).toContain('Validation passed');
      if (label === 'security-sensitive fields') {
        expect(validation.output).not.toContain('hooks');
        expect(validation.output).not.toContain('mcpServers');
        expect(validation.output).not.toContain('permissionMode');
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude experimental themes and monitors under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-experimental-'));

  try {
    const written = await writeClaudeArtifact(root, withClaudeExperimental({
      monitors: [{
        command: `node ${pathTokens.pluginRoot}/scripts/watch.mjs`,
        description: 'Watch the review queue.',
        name: 'review-queue',
        when: 'always',
      }],
      themes: {
        dracula: {
          base: 'dark',
          overrides: { claude: '#bd93f9', error: '#ff5555' },
        },
      },
    }));
    expect(written).toEqual(expect.arrayContaining([
      'monitors/monitors.json',
      'themes/dracula.json',
    ]));
    expect(JSON.parse(
      await readFile(join(root, 'monitors', 'monitors.json'), 'utf8'),
    )[0].command).toBe('node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs');
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records whether strict native validation inspects monitors/monitors.json contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-monitors-invalid-'));

  try {
    await writeClaudeArtifact(root, model);
    await mkdir(join(root, 'monitors'), { recursive: true });
    await writeFile(
      join(root, 'monitors', 'monitors.json'),
      '[{"name":"missing-command","description":"Missing its required command."}]\n',
    );
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('monitors.json');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records whether strict native validation inspects plugin theme contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-theme-invalid-'));

  try {
    await writeClaudeArtifact(root, model);
    await mkdir(join(root, 'themes'), { recursive: true });
    await writeFile(
      join(root, 'themes', 'invalid.json'),
      '{"name":"Missing base","overrides":{"error":7},"typo":true}\n',
    );
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('invalid.json');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records that strict native validation rejects the deprecated top-level monitors key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-monitors-top-level-'));

  try {
    await writeClaudeArtifact(root, model);
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['monitors'] = './monitors/monitors.json';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const validation = await runClaudeValidation(root, root);

    expect(validation.code).not.toBe(0);
    expect(validation.output).toContain('monitors');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts an emitted Claude plugin with bin under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-bin-'));
  const sourceRoot = join(root, 'authored-bin');
  const source = join(sourceRoot, 'review-tool');
  const outputRoot = join(root, 'plugin');
  const executable = '#!/usr/bin/env sh\nprintf "reviewed\\n"\n';
  const binModel: NormalizedPlugin = {
    ...model,
    hostBins: [{
      files: [{
        bytes: Buffer.byteLength(executable),
        executable: true,
        relativePath: 'review-tool',
        source,
      }],
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      source: sourceRoot,
      target: 'claude',
    }],
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(source, executable);
    await chmod(source, 0o751);
    await emitPlanEntries({ entries: claudeAdapter.plan(binModel).entries, root: outputRoot });
    const validation = await runClaudeValidation(
      outputRoot,
      join(outputRoot, '.claude-plugin', 'marketplace.json'),
    );
    expect(validation.code, validation.output).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude workflows and output styles under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-workflows-output-styles-'));
  const sourceRoot = join(root, 'authored');
  const workflowsRoot = join(sourceRoot, 'workflows');
  const outputStylesRoot = join(sourceRoot, 'styles');
  const workflowSource = join(workflowsRoot, 'release-audit.js');
  const outputStyleSource = join(outputStylesRoot, 'terse.md');
  const outputRoot = join(root, 'plugin');
  const workflow = 'export default async function releaseAudit() {}\n';
  const outputStyle = '---\nname: Terse\ndescription: Be concise\n---\n\nBe concise.\n';
  const payloadModel: NormalizedPlugin = {
    ...model,
    hostOutputStyles: [{
      files: [{
        bytes: Buffer.byteLength(outputStyle),
        executable: false,
        relativePath: 'terse.md',
        source: outputStyleSource,
      }],
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      source: outputStylesRoot,
      target: 'claude',
    }],
    hostWorkflows: [{
      files: [{
        bytes: Buffer.byteLength(workflow),
        executable: false,
        relativePath: 'release-audit.js',
        source: workflowSource,
      }],
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      source: workflowsRoot,
      target: 'claude',
    }],
  };

  try {
    await Promise.all([
      mkdir(workflowsRoot, { recursive: true }),
      mkdir(outputStylesRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(workflowSource, workflow),
      writeFile(outputStyleSource, outputStyle),
    ]);
    await emitPlanEntries({ entries: claudeAdapter.plan(payloadModel).entries, root: outputRoot });
    expect(await readFile(join(outputRoot, 'workflows', 'release-audit.js'), 'utf8')).toBe(workflow);
    expect(await readFile(join(outputRoot, 'output-styles', 'terse.md'), 'utf8')).toBe(outputStyle);
    const validation = await runClaudeValidation(outputRoot, outputRoot);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records whether strict native validation inspects output-style frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-output-style-frontmatter-'));
  const outputRoot = join(root, 'plugin');

  try {
    await writeClaudeArtifact(outputRoot, model);
    await mkdir(join(outputRoot, 'output-styles'), { recursive: true });
    await writeFile(join(outputRoot, 'output-styles', 'missing-frontmatter.md'), 'Be concise.\n');
    const validation = await runClaudeValidation(outputRoot, outputRoot);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).not.toContain('missing-frontmatter.md');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude userConfig under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-user-config-'));
  const outputRoot = join(root, 'plugin');
  const model: NormalizedPlugin = {
    extensions: {
      claude: {
        id: 'extension:claude',
        key: 'claude',
        provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
        target: 'claude',
        value: {
          userConfig: {
            api_token: {
              description: 'API authentication token.',
              sensitive: true,
              title: 'API token',
              type: 'string',
            },
            retries: {
              default: 3,
              description: 'Maximum retry count.',
              max: 5,
              min: 0,
              title: 'Retries',
              type: 'number',
            },
          },
        },
      },
    },
    hooks: [],
    marketplace: true,
    mcpServers: [],
    metadata: {
      description: 'Validate Claude user configuration.',
      id: 'plugin:user-config-proof',
      name: 'user-config-proof',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
      version: '1.0.0',
    },
    runtime: { node: '22.12.0' },
    scripts: [],
    skills: [],
    targets: [{
      id: 'target:claude',
      name: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    }],
  };

  try {
    const plan = claudeAdapter.plan(model);
    expect(plan.diagnostics).toEqual([]);
    await emitPlanEntries({ entries: plan.entries, root: outputRoot });
    const result = await runClaudeValidation(
      outputRoot,
      join(outputRoot, '.claude-plugin', 'marketplace.json'),
    );
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude channels bound to a plugin MCP server under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-channels-'));

  try {
    const written = await writeClaudeArtifact(root, channelModel);
    expect(written).toContain('.mcp.json');
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('records whether strict native validation catches a dangling Claude channel server binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-channels-dangling-'));

  try {
    await writeClaudeArtifact(root, channelModel);
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['channels'] = [{ server: 'missing' }];
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const validation = await runClaudeValidation(root, root);

    // Claude Code 2.1.257 validates the channel declaration shape but does
    // not cross-check `server` against the sibling .mcp.json keys.
    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
    expect(validation.output).not.toContain('missing');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude plugin dependencies under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-dependencies-'));

  try {
    await writeClaudeArtifact(root, withClaudeDependencies([
      { marketplace: 'acme-shared', name: 'audit-logger' },
      { marketplace: 'acme-shared', name: 'secrets-vault', version: '~2.1.0' },
    ]));
    const validation = await runClaudeValidation(root, root);

    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts emitted Claude manifest metadata fields under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-manifest-metadata-'));

  try {
    await writeClaudeArtifact(root, withClaudeManifestMetadata({
      defaultEnabled: false,
      displayName: 'Review Tools',
      metadata: { catalog: 'security', entitlement: { tier: 'team' } },
    }));
    const manifest = JSON.parse(
      await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      defaultEnabled: false,
      displayName: 'Review Tools',
      metadata: { catalog: 'security', entitlement: { tier: 'team' } },
    });

    const validation = await runClaudeValidation(root, root);
    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('accepts a custom flat command path without a default commands directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-custom-command-path-'));

  try {
    const written = await writeClaudeArtifact(root, model);
    expect(written.some((path) => path.startsWith('commands/'))).toBe(false);
    await mkdir(join(root, 'custom'), { recursive: true });
    await writeFile(
      join(root, 'custom', 'deploy.md'),
      '---\ndescription: Deploy the current project.\n---\nDeploy the current project.\n',
    );
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, commands: './custom/deploy.md' })}\n`);

    const validation = await runClaudeValidation(root, root);
    expect(validation.code, validation.output).toBe(0);
    expect(validation.output).toContain('Validation passed');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
