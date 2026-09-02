import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { emitPlanEntries } from '../src/build/emit.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const nativeIt = process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1' ? it : it.skip;

interface ClaudeValidation {
  readonly code: number | null;
  readonly output: string;
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

nativeIt('accepts emitted Claude experimental themes and monitors under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-experimental-'));

  try {
    const written = await writeClaudeArtifact(root, withClaudeExperimental({
      monitors: [{
        command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs',
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
      'audit-logger',
      { name: 'secrets-vault', version: '~2.1.0' },
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
