import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, test } from '@rstest/core';

import { emitRuntimeArtifacts } from '../src/build/emit-artifacts.js';

test('declares every executable and contained runtime asset in the runtime manifest', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-manifest-'));
  const runtimeAssets = ['hook/index.js', 'rsc/index.js', 'mcp/stdio.js', 'mcp/http.js', 'chunks/101.js'];

  try {
    for (const asset of runtimeAssets) {
      const target = join(runtimeRoot, asset);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'artifact', 'utf8');
    }
    await writeFile(join(runtimeRoot, 'runtime-assets.json'), JSON.stringify({ allFiles: runtimeAssets.map((asset) => `/${asset}`) }), 'utf8');

    await emitRuntimeArtifacts(runtimeRoot);

    const manifest = JSON.parse(await readFile(join(runtimeRoot, 'agent-runtime.manifest.json'), 'utf8')) as {
      executables: Array<{ name: string; path: string }>;
      runtimeAssets: string[];
    };
    expect(manifest.executables).toEqual([
      { name: 'hook', path: 'hook/index.js' },
      { name: 'rsc-worker', path: 'rsc/index.js' },
      { name: 'stdio', path: 'mcp/stdio.js' },
      { name: 'http', path: 'mcp/http.js' },
    ]);
    expect(manifest.runtimeAssets).toEqual(runtimeAssets);
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test('rejects a runtime asset that escapes the manifest root', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-manifest-'));
  try {
    await writeFile(join(runtimeRoot, 'runtime-assets.json'), JSON.stringify({ allFiles: ['../outside.js'] }), 'utf8');
    await expect(emitRuntimeArtifacts(runtimeRoot)).rejects.toThrow('Runtime asset escapes its root');
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});
