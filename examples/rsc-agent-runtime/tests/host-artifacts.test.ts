import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@rstest/core';

const exampleRoot = process.cwd();
const pluginsRoot = join(exampleRoot, 'dist/plugins');

const runPackageHosts = async (): Promise<void> => {
  const child = spawn(process.execPath, ['scripts/package-hosts.mjs'], { cwd: exampleRoot, stdio: 'pipe' });
  const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  expect(signal).toBeNull();
  expect(exitCode).toBe(0);
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

const runtimeAssets = async (): Promise<string[]> => {
  const manifest = await readJson<{ allFiles: string[] }>(join(exampleRoot, 'dist/runtime/runtime-assets.json'));
  return manifest.allFiles.map((asset) => asset.replace(/^\//, ''));
};

test('materializes self-contained Claude and Codex native plugin artifacts', async () => {
  await runPackageHosts();
  const claudeRoot = join(pluginsRoot, 'claude');
  const codexRoot = join(pluginsRoot, 'codex');
  const claudeManifest = await readJson<{ name: string; version: string }>(join(claudeRoot, '.claude-plugin/plugin.json'));
  const codexManifest = await readJson<{
    interface: unknown;
    mcpServers: string;
    hooks: string;
    name: string;
    skills: string;
    version: string;
  }>(join(codexRoot, '.codex-plugin/plugin.json'));
  const claudeMcp = await readJson<{ mcpServers: Record<string, { args: string[] }> }>(join(claudeRoot, '.mcp.json'));
  const codexMcp = await readJson<{ mcpServers: Record<string, { args: string[]; cwd: string }> }>(join(codexRoot, '.mcp.json'));
  const claudeHooks = await readJson<{ hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>(
    join(claudeRoot, 'hooks/hooks.json'),
  );
  const codexHooks = await readJson<{ hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>(
    join(codexRoot, 'hooks/hooks.json'),
  );

  expect(claudeManifest).toMatchObject({ name: 'rsc-agent-runtime', version: '0.1.0' });
  expect(codexManifest).toMatchObject({
    hooks: './hooks/hooks.json',
    interface: expect.any(Object),
    mcpServers: './.mcp.json',
    name: 'rsc-agent-runtime',
    skills: './skills/',
    version: '0.1.0',
  });
  expect(claudeMcp.mcpServers['rsc-agent-runtime'].args).toContain('${CLAUDE_PLUGIN_ROOT}/runtime/mcp/stdio.js');
  expect(codexMcp.mcpServers['rsc-agent-runtime']).toMatchObject({ args: ['./runtime/mcp/stdio.js'], cwd: './' });
  expect(JSON.stringify(codexMcp)).not.toMatch(/PLUGIN_ROOT|PLUGIN_DATA|workspace/i);
  expect(claudeHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: 'Write|Edit' });
  expect(claudeHooks.hooks.PostToolUse[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}');
  expect(claudeHooks.hooks.PostToolUse[0].hooks[0].command).toContain('--host claude');
  expect(codexHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: 'apply_patch|Write|Edit' });
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('${PLUGIN_ROOT}');
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('--host codex');
  expect(JSON.stringify({ claudeMcp, claudeHooks, codexMcp, codexHooks })).not.toMatch(/api[ _-]?key/i);

  for (const root of [claudeRoot, codexRoot]) {
    const assets = await runtimeAssets();
    for (const asset of assets) {
      await access(join(root, 'runtime', asset));
    }
    await access(join(root, 'app/edit-timeline-v1.html'));
    const asyncChunk = assets.find((asset) => /^chunks\/.+\.js$/.test(asset));
    expect(asyncChunk).toBeDefined();
    expect((await stat(join(root, 'runtime', asyncChunk!))).isFile()).toBe(true);
  }
  for (const relative of ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills']) {
    await access(join(codexRoot, relative));
  }
});

test('runs the packaged MCP server after its artifact is isolated from the example dist directory', async () => {
  await runPackageHosts();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-isolated-'));
  const pluginRoot = join(temporaryRoot, 'claude');
  const stateFile = join(temporaryRoot, 'events.jsonl');
  await cp(join(pluginsRoot, 'claude'), pluginRoot, { recursive: true });
  await writeFile(stateFile, '', 'utf8');

  const client = new Client({ name: 'host-artifact-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    args: [join(pluginRoot, 'runtime/mcp/stdio.js')],
    command: process.execPath,
    env: { ...process.env, AGENT_RUNTIME_STATE_FILE: stateFile },
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    await expect(client.callTool({ arguments: {}, name: 'render_edit_timeline' })).resolves.toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { edits: [], stateVersion: 0 },
    });
  } finally {
    await client.close();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('keeps the published Agent Bundle package free of the supplemental RSC runtime', async () => {
  const packageRoot = join(exampleRoot, '../../packages/agent-bundle');
  const packageJson = await readJson<{ dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>(
    join(packageRoot, 'package.json'),
  );
  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };

  expect(allDependencies).not.toHaveProperty('react');
  expect(allDependencies).not.toHaveProperty('react-server-dom-rspack');
  expect(allDependencies).not.toHaveProperty('rsbuild-plugin-rsc');

  const sourceRoot = join(packageRoot, 'src');
  const sourceFiles = await readdir(sourceRoot, { recursive: true });
  for (const relative of sourceFiles) {
    if (typeof relative !== 'string' || !relative.endsWith('.ts')) continue;
    const source = await readFile(join(sourceRoot, relative), 'utf8');
    expect(source).not.toMatch(/examples\/rsc-agent-runtime|react-server-dom-rspack|rsbuild-plugin-rsc/);
  }
});
