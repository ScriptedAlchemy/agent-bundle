import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { emitPlanEntries } from '../src/build/emit.ts';
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

nativeIt('accepts an emitted Claude plugin with bin under strict native validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-marketplace-'));
  const sourceRoot = join(root, 'authored-bin');
  const source = join(sourceRoot, 'review-tool');
  const outputRoot = join(root, 'plugin');
  const executable = '#!/usr/bin/env sh\nprintf "reviewed\\n"\n';
  const model: NormalizedPlugin = {
    extensions: {},
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

  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(source, executable);
    await chmod(source, 0o751);
    await emitPlanEntries({ entries: claudeAdapter.plan(model).entries, root: outputRoot });
    await expect(runClaudeValidation(
      outputRoot,
      join(outputRoot, '.claude-plugin', 'marketplace.json'),
    )).resolves.toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
