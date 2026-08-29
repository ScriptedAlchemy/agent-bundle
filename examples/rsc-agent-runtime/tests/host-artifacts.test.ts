import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from '@rstest/core';

import { ensureExampleBuilt } from './support/ensure-built.js';

const exampleRoot = process.cwd();
const pluginsRoot = join(exampleRoot, 'dist/plugins');

const runPackageHosts = async (): Promise<void> => {
  await ensureExampleBuilt();
  const child = spawn(process.execPath, ['scripts/package-hosts.mjs'], { cwd: exampleRoot, stdio: 'pipe' });
  const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  expect(signal).toBeNull();
  expect(exitCode).toBe(0);
};

const runProductionBuild = async (): Promise<void> => {
  await rm(join(exampleRoot, 'dist/app'), { force: true, recursive: true });
  // Plant a leftover async chunk; the multi-environment build itself must remove stale app assets.
  const staleAsset = join(exampleRoot, 'dist/app/static/js/async/stale.js');
  await mkdir(dirname(staleAsset), { recursive: true });
  await writeFile(staleAsset, 'stale artifact', 'utf8');
  try {
    const child = spawn('npm', ['run', 'build'], { cwd: exampleRoot, stdio: 'pipe' });
    const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(exitCode).toBe(0);
    await expect(access(staleAsset)).rejects.toThrow();
  } finally {
    await rm(staleAsset, { force: true });
  }
};

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

const runtimeAssets = async (): Promise<string[]> => {
  const manifest = await readJson<{ allFiles: string[] }>(join(exampleRoot, 'dist/runtime/runtime-assets.json'));
  return manifest.allFiles.map((asset) => asset.replace(/^\//, ''));
};

const runDeclaredHook = async (
  command: string,
  environment: Readonly<Record<string, string>>,
  input: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }>> => {
  const child = spawn('/bin/sh', ['-c', command], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(input));
  const collect = (stream: Readable): Promise<string> => new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { text += chunk; });
    stream.once('error', reject);
    stream.once('end', () => resolve(text));
  });
  const [stdout, stderr, outcome] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
  ]);
  return Object.freeze({ exitCode: outcome[0], signal: outcome[1], stderr, stdout });
};

type ArtifactDigestEntry = Readonly<{
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}>;

const artifactDigest = async (root: string): Promise<readonly ArtifactDigestEntry[]> => {
  const entries = (await readdir(root, { recursive: true }))
    .filter((entry): entry is string => typeof entry === 'string')
    .sort();
  const digest: ArtifactDigestEntry[] = [];
  for (const path of entries) {
    const absolutePath = join(root, path);
    if (!(await stat(absolutePath)).isFile()) continue;
    const content = await readFile(absolutePath);
    digest.push({
      bytes: content.byteLength,
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return digest;
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
  expect(codexHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: 'apply_patch' });
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('${PLUGIN_ROOT}');
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('--host codex');
  expect(JSON.stringify({ claudeMcp, claudeHooks, codexMcp, codexHooks })).not.toMatch(/api[ _-]?key/i);

  const runtimeRoot = join(exampleRoot, 'dist/runtime');
  const runtimeDigest = await artifactDigest(runtimeRoot);
  expect(await artifactDigest(join(claudeRoot, 'runtime'))).toEqual(runtimeDigest);
  expect(await artifactDigest(join(codexRoot, 'runtime'))).toEqual(runtimeDigest);

  const assets = await runtimeAssets();
  expect(assets.some((asset) => /^chunks\/.+\.js$/u.test(asset))).toBe(true);
  for (const root of [claudeRoot, codexRoot]) {
    for (const asset of assets) {
      await access(join(root, 'runtime', asset));
    }
    const asyncChunk = assets.find((asset) => /^chunks\/.+\.js$/.test(asset));
    expect(asyncChunk).toBeDefined();
    expect((await stat(join(root, 'runtime', asyncChunk!))).isFile()).toBe(true);
  }
  for (const relative of ['dist/app/edit-timeline-v1.html', 'dist/app/standalone.html']) {
    const appHtml = await readFile(join(exampleRoot, relative), 'utf8');
    expect(appHtml).not.toMatch(/<script[^>]+src=|<link[^>]+rel=["']stylesheet["']/iu);
  }
  for (const relative of ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.mcp.json', 'hooks/hooks.json', 'skills']) {
    await access(join(codexRoot, relative));
  }
});

test('keeps fresh production App legal payload names stable and package-identical', async () => {
  await runProductionBuild();
  const appDigest = await artifactDigest(join(exampleRoot, 'dist/app'));
  expect(appDigest.map((entry) => entry.path)).toEqual([
    'edit-timeline-v1.html',
    'lib-react.js.LICENSE.txt',
    'standalone.html',
  ]);
  const legalNotice = appDigest.find((entry) => entry.path === 'lib-react.js.LICENSE.txt');
  expect(legalNotice).toMatchObject({ path: 'lib-react.js.LICENSE.txt' });
  const legalNoticeContent = await readFile(join(exampleRoot, 'dist/app/lib-react.js.LICENSE.txt'), 'utf8');
  expect(legalNoticeContent).toContain('LICENSE file');

  for (const entry of appDigest) {
    expect(entry.path).not.toMatch(/(?:^|\/)[^/]*\.[a-f\d]{8,}\.(?:js|css)(?:\.LICENSE\.txt)?$/iu);
  }
  for (const appRoot of [join(exampleRoot, 'dist/app'), ...['claude', 'codex'].map((host) => join(pluginsRoot, host, 'app'))]) {
    const payload = await artifactDigest(appRoot);
    expect(payload).toEqual(appDigest);
    let legalReferences = 0;
    for (const artifact of payload.filter((entry) => /\.(?:css|html|js)$/iu.test(entry.path))) {
      const source = await readFile(join(appRoot, artifact.path), 'utf8');
      for (const match of source.matchAll(/\/\*!\s*LICENSE:\s*([^*\r\n]+?)\s*\*\//gu)) {
        legalReferences += 1;
        const target = normalize(join(dirname(artifact.path), match[1]!.trim()));
        expect(target).not.toMatch(/^(?:\.\.\/|\/)/u);
        expect(payload.some((entry) => entry.path === target)).toBe(true);
        expect(await readFile(join(appRoot, target), 'utf8')).toBe(legalNoticeContent);
      }
      if (artifact.path.endsWith('.html')) {
        expect(source).toContain('<script');
        expect(source).toContain('<style');
        expect(source).not.toMatch(/<script[^>]+src=|<link[^>]+rel=["']stylesheet["']/iu);
      }
    }
    expect(legalReferences).toBeGreaterThan(0);
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

test('runs each packaged native hook from one shell argv path when its plugin root contains spaces and metacharacters', async () => {
  await runPackageHosts();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-hook-root-'));
  try {
    const nodeBin = join(temporaryRoot, 'bin');
    const argvFile = join(temporaryRoot, 'hook-argv.bin');
    await mkdir(nodeBin);
    await writeFile(join(nodeBin, 'node'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$AGENT_RUNTIME_HOOK_ARGV_FILE"\nexec "$AGENT_RUNTIME_NODE" "$@"\n', 'utf8');
    await chmod(join(nodeBin, 'node'), 0o755);

    for (const host of ['claude', 'codex'] as const) {
      const pluginRoot = join(temporaryRoot, `${host} plugin root ; ordinary`);
      const workspace = join(temporaryRoot, `${host}-workspace`);
      const stateFile = join(temporaryRoot, `${host}-events.jsonl`);
      const manifestPath = join(pluginRoot, 'hooks/hooks.json');
      const rootVariable = host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT';
      const filename = `${host}-note.txt`;
      await cp(join(pluginsRoot, host), pluginRoot, { recursive: true });
      await mkdir(workspace);
      const manifest = await readJson<{ hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } }>(manifestPath);
      const command = manifest.hooks.PostToolUse[0]?.hooks[0]?.command;
      expect(command).toBeTypeOf('string');
      const input = host === 'claude'
        ? {
            cwd: workspace,
            hook_event_name: 'PostToolUse',
            session_id: `${host}-session`,
            tool_input: { file_path: join(workspace, filename) },
            tool_name: 'Write',
            tool_use_id: `${host}-tool`,
          }
        : {
            cwd: workspace,
            event_id: `${host}-event`,
            hook_event_name: 'PostToolUse',
            session_id: `${host}-session`,
            tool_input: { command: `*** Begin Patch\n*** Add File: ${filename}\n+recorded\n*** End Patch` },
            tool_name: 'apply_patch',
          };
      const result = await runDeclaredHook(command!, {
        [rootVariable]: pluginRoot,
        AGENT_RUNTIME_HOOK_ARGV_FILE: argvFile,
        AGENT_RUNTIME_NODE: process.execPath,
        AGENT_RUNTIME_STATE_FILE: stateFile,
        PATH: `${nodeBin}:${process.env.PATH ?? ''}`,
      }, input);

      expect(result.signal).toBeNull();
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          additionalContext: `Recorded ${filename} from ${host}. Shared state now contains 1 edit.`,
          hookEventName: 'PostToolUse',
        },
      });
      expect((await readFile(argvFile)).toString('utf8').split('\0').filter(Boolean)).toEqual([
        join(pluginRoot, 'runtime/hook/index.js'), '--host', host,
      ]);
      expect((await readFile(stateFile, 'utf8')).trim()).toContain(`"host":"${host}"`);
      expect(command).toBe(`node "\${${rootVariable}}/runtime/hook/index.js" --host ${host}`);
      expect(command).not.toMatch(/(?:api[ _-]?key|echo|printenv|AGENT_RUNTIME_)/iu);
    }
  } finally {
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
