import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

const runClaudeValidation = async (cwd: string, target: string): Promise<ClaudeValidation> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn('claude', ['plugin', 'validate', '--strict', target], {
      cwd,
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
