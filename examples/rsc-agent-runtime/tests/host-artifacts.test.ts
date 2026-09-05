import { createFileRuntimeKernel } from '../src/runtime/state-file.js';
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
  // Packaging must be independently rerunnable against the current dist trees.
  const child = spawn('pnpm', ['exec', 'agent-bundle', 'build', '--json', '--output', 'dist/plugins'], {
    cwd: exampleRoot,
    stdio: 'pipe',
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const [exitCode, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
  expect(signal).toBeNull();
  expect(exitCode, Buffer.concat(stderr).toString('utf8')).toBe(0);
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
  // One plugin root serves every selected host (#555): Claude Code owns the
  // conventional documents, Codex beside it reads its own through manifest
  // pointers under .codex-plugin/.
  const claudeRoot = pluginsRoot;
  const codexRoot = pluginsRoot;
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
  const codexMcp = await readJson<{ mcpServers: Record<string, { args: string[]; cwd: string }> }>(join(codexRoot, '.codex-plugin/mcp.json'));
  const claudeHooks = await readJson<{ hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>(
    join(claudeRoot, 'hooks/hooks.json'),
  );
  const codexHooks = await readJson<{ hooks: { PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>(
    join(codexRoot, '.codex-plugin/hooks.json'),
  );

  // The generated identity is the config's `plugin` block.
  expect(claudeManifest).toMatchObject({ name: 'rsc-agent-runtime-demo', version: '1.0.0' });
  expect(codexManifest).toMatchObject({
    hooks: './.codex-plugin/hooks.json',
    interface: expect.any(Object),
    mcpServers: './.codex-plugin/mcp.json',
    name: 'rsc-agent-runtime-demo',
    skills: './skills/',
    version: '1.0.0',
  });
  // The stable prebuilt entry paths the workers and manual flows pin.
  expect(claudeMcp.mcpServers['timeline'].args).toContain('${CLAUDE_PLUGIN_ROOT}/runtime/mcp/stdio.js');
  expect(codexMcp.mcpServers['timeline']).toMatchObject({ args: ['./runtime/mcp/stdio.js'], cwd: './' });
  // Codex has no path-token interpolation: no `${...}` token may survive into
  // its document. (The AGENT_BUNDLE_PLUGIN_ROOT env anchor is a plain
  // variable name, not a host token.)
  expect(JSON.stringify(codexMcp)).not.toMatch(/\$\{|workspace/i);
  expect(claudeHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: '^(?:Write|Edit)$' });
  expect(claudeHooks.hooks.PostToolUse[0].hooks[0].command).toContain('${CLAUDE_PLUGIN_ROOT}');
  expect(claudeHooks.hooks.PostToolUse[0].hooks[0].command).toContain('hooks/event-route-tool-after.mjs');
  expect(codexHooks.hooks.PostToolUse[0]).toMatchObject({ matcher: '^(?:apply_patch|Edit|Write)$' });
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('${PLUGIN_ROOT}');
  expect(codexHooks.hooks.PostToolUse[0].hooks[0].command).toContain('hooks/event-route-tool-after.mjs');
  expect(JSON.stringify({ claudeMcp, claudeHooks, codexMcp, codexHooks })).not.toMatch(/api[ _-]?key/i);

  const runtimeRoot = join(exampleRoot, 'dist/runtime');
  const runtimeDigest = await artifactDigest(runtimeRoot);
  expect(await artifactDigest(join(pluginsRoot, 'runtime'))).toEqual(runtimeDigest);

  const assets = await runtimeAssets();
  expect(assets.some((asset) => /^chunks\/.+\.js$/u.test(asset))).toBe(true);
  for (const root of [pluginsRoot]) {
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
  // A skill-less plugin emits no `skills/` directory, while the manifest's
  // `./skills/` pointer stays — as in every framework-built Codex artifact.
  for (const relative of ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', '.codex-plugin/mcp.json', '.codex-plugin/hooks.json']) {
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
  for (const appRoot of [join(exampleRoot, 'dist/app'), join(pluginsRoot, 'app')]) {
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
  const pluginRoot = join(temporaryRoot, 'plugin');
  const stateFile = join(temporaryRoot, 'state.sqlite');
  await cp(pluginsRoot, pluginRoot, { recursive: true });
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

test('replays schema-conformance fixtures through each packaged native event route', async () => {
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
      const stateFile = join(temporaryRoot, `${host}-state.sqlite`);
      // Claude Code reads the conventional document; Codex beside it reads its
      // own under .codex-plugin/ (#555). Both name the one shared wrapper.
      const manifestPath = join(pluginRoot, host === 'claude' ? 'hooks/hooks.json' : '.codex-plugin/hooks.json');
      const rootVariable = host === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT';
      const filename = `${host}-note.txt`;
      await cp(pluginsRoot, pluginRoot, { recursive: true });
      const manifest = await readJson<{ hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } }>(manifestPath);
      const command = manifest.hooks.PostToolUse[0]?.hooks[0]?.command;
      expect(command).toBeTypeOf('string');
      // These checked-in payloads establish schema conformance only; replay
      // through a local command is not evidence of commercial-host dispatch.
      const input = await readJson<Record<string, unknown>>(
        join(exampleRoot, `tests/fixtures/events/${host}-post-tool-use.json`),
      );
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
        join(pluginRoot, 'hooks/event-route-tool-after.mjs'),
      ]);
      const recorded = await createFileRuntimeKernel({ stateFile }).readSnapshot();
      expect(recorded.edits.map((edit) => edit.host)).toEqual([host]);
      expect(command).toBe(`node "\${${rootVariable}}/hooks/event-route-tool-after.mjs"`);
      expect(command).not.toMatch(/(?:api[ _-]?key|echo|printenv|AGENT_RUNTIME_)/iu);
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test('keeps the published Agent Bundle package free of the supplemental RSC runtime', async () => {
  const packageRoot = join(exampleRoot, '../../packages/agent-bundle');
  const packageJson = await readJson<{ dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }>(
    join(packageRoot, 'package.json'),
  );
  // Install-cost guard: hook-only consumers must never be forced to install
  // the RSC runtime stack. Optional peers (declared for the #103 test
  // harness) add no install cost, so they are allowed only when
  // peerDependenciesMeta marks them optional.
  const requiredDependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
  for (const name of ['react', 'react-server-dom-rspack', 'rsbuild-plugin-rsc']) {
    expect(requiredDependencies).not.toHaveProperty(name);
    if (packageJson.peerDependencies?.[name] !== undefined) {
      expect(packageJson.peerDependenciesMeta?.[name]?.optional, `${name} peer must be optional`).toBe(true);
    }
  }

  const sourceRoot = join(packageRoot, 'src');
  const sourceFiles = await readdir(sourceRoot, { recursive: true });
  for (const relative of sourceFiles) {
    if (typeof relative !== 'string' || !relative.endsWith('.ts')) continue;
    const source = await readFile(join(sourceRoot, relative), 'utf8');
    expect(source).not.toMatch(/examples\/rsc-agent-runtime|react-server-dom-rspack|rsbuild-plugin-rsc/);
  }
});
