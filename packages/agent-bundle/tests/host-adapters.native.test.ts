import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';

const nativeIt = process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1' ? it : it.skip;

const runClaudeValidation = async (cwd: string, marketplace: string): Promise<number | null> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn('claude', ['plugin', 'validate', '--strict', marketplace], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });

nativeIt('accepts the emitted Claude marketplace under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-'));
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
    scripts: [],
    skills: [],
    targets: [{
      id: 'target:claude',
      name: 'claude',
      provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    }],
  };

  try {
    for (const entry of claudeAdapter.plan(model).entries) {
      if (entry.kind !== 'write') continue;
      const output = join(root, entry.relativePath);
      await mkdir(join(output, '..'), { recursive: true });
      await writeFile(output, entry.content);
    }
    await expect(runClaudeValidation(root, join(root, '.claude-plugin', 'marketplace.json'))).resolves.toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
