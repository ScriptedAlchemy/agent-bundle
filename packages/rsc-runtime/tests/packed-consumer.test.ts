import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'rsc-runtime');

it('packs and imports every public value from an isolated consumer', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rsc-runtime-consumer-'));
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-rsc-runtime-tarball-'));

  try {
    await execFile('pnpm', ['--filter', '@agent-bundle/rsc-runtime', 'build'], { cwd: workspaceRoot });
    const { stdout } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      tarballRoot,
    ], { cwd: packageRoot });
    const [{ filename }] = JSON.parse(stdout) as Array<{ readonly filename: string }>;
    await writeFile(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
    await execFile('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(tarballRoot, filename),
      'react@19.2.8',
    ], { cwd: consumerRoot });

    const installedRoot = await realpath(join(consumerRoot, 'node_modules', '@agent-bundle', 'rsc-runtime'));
    expect(installedRoot.startsWith(workspaceRoot)).toBe(false);
    const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')) as {
      readonly exports?: unknown;
      readonly files?: readonly string[];
    };
    expect(manifest.files).toEqual(['dist', 'README.md']);
    expect(manifest.exports).toEqual({ '.': { import: './dist/index.js', types: './dist/index.d.ts' } });

    await writeFile(join(consumerRoot, 'verify.mjs'), [
      "import { createElement } from 'react';",
      "import { Hook, Mcp, createRscRequestContext, lowerHookResult, lowerMcpResult } from '@agent-bundle/rsc-runtime';",
      "if (![Hook, Mcp, createRscRequestContext, lowerHookResult, lowerMcpResult].every(Boolean)) process.exit(2);",
      "const hook = lowerHookResult(createElement(Hook.Result, null, createElement(Hook.AdditionalContext, null, 'packed')));",
      "const mcp = lowerMcpResult(createElement(Mcp.Result, { structuredContent: { packed: true } }, createElement(Mcp.Text, null, 'packed')));",
      "console.log(JSON.stringify({ hook, mcp }));",
      '',
    ].join('\n'));
    const { stdout: verified } = await execFile(process.execPath, ['verify.mjs'], { cwd: consumerRoot });
    expect(JSON.parse(verified)).toMatchObject({
      hook: { hookSpecificOutput: { additionalContext: 'packed' } },
      mcp: { content: [{ text: 'packed', type: 'text' }], structuredContent: { packed: true } },
    });
  } finally {
    await Promise.all([
      rm(consumerRoot, { force: true, recursive: true }),
      rm(tarballRoot, { force: true, recursive: true }),
    ]);
  }
}, 60_000);
