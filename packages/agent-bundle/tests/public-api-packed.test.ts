import { execFile as executeFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, expect, it } from '@rstest/core';

import { isolatedCommandEnvironment } from '../../../rstest.worker-isolation.ts';
import { isErrno } from '../src/core/errors.ts';
import { writeFixtureManifest } from './support/manifest.ts';
import { cachedNpmInstallArguments, linkWorkspaceTypes, sharedPackedTarball } from './support/shared-pack.ts';

interface PackageManifest {
  bin: {
    'agent-bundle': string;
  };
  version: string;
}

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');

const readPackageManifest = async (): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;

const createBuildProject = async (root: string): Promise<{ readonly output: string; readonly project: string }> => {
  const project = join(root, 'manifest-version-project');
  const output = join(project, 'manifest-version-artifact');
  await mkdir(join(project, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(project, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'manifest-version-fixture', version: '1.0.0' }, targets: ['portable'] };\n",
    ),
    writeFile(
      join(project, 'src', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
  ]);
  return { output, project };
};

/** One installed copy of a package: where npm placed it and which version it is. */
interface InstalledCopy {
  readonly name: string;
  /** Directory relative to the consumer's `node_modules`, so a nested duplicate names its host. */
  readonly path: string;
  readonly version: string;
}

/**
 * Every copy of the packages `selected` names anywhere under a consumer's
 * `node_modules`, nested duplicates included: npm hoists one version of a
 * package and nests the others beneath whichever dependency pinned them, so
 * a second engine version shows up as
 * `@rslib/core/node_modules/@rsbuild/core`, never at the top level.
 */
const installedCopies = async (nodeModules: string, selected: (name: string) => boolean): Promise<readonly InstalledCopy[]> => {
  const copies: InstalledCopy[] = [];
  const visitPackage = async (name: string, directory: string): Promise<void> => {
    if (selected(name)) {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { readonly version: string };
      copies.push({ name, path: relative(nodeModules, directory), version: manifest.version });
    }
    await visitNodeModules(join(directory, 'node_modules'));
  };
  const visitNodeModules = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!entry.name.startsWith('@')) {
        await visitPackage(entry.name, join(directory, entry.name));
        continue;
      }
      for (const scoped of await readdir(join(directory, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) await visitPackage(`${entry.name}/${scoped.name}`, join(directory, entry.name, scoped.name));
      }
    }
  };
  await visitNodeModules(nodeModules);
  return copies.sort((left, right) => left.path.localeCompare(right.path));
};

const producerFrom = async (output: string): Promise<{ readonly name: string; readonly version: string }> => {
  const manifest = JSON.parse(
    await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'),
  ) as { readonly producer: { readonly name: string; readonly version: string } };
  return manifest.producer;
};

/**
 * Warms this worker's npm cache with the packed tarball's full dependency
 * tree once, so the three consumer installs below are cache-backed
 * (`--prefer-offline` then serves every tarball and metadata record from
 * disk). The download is the one network-bound step in this file: about
 * 180 MB of registry tarballs, and a CI runner's npm cache is empty at job
 * start (pnpm/setup caches only the pnpm store), so the Release gates and
 * Verify jobs always pay it exactly once here, never inside a test's 30 s
 * budget. The budget below covers that cold download on a slow runner
 * network; a warm worker cache finishes in a few seconds.
 */
beforeAll(async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');
  const warmRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-npm-warm-'));
  try {
    await writeFile(join(warmRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm', ['install', ...cachedNpmInstallArguments, tarball],
      { cwd: warmRoot, env: isolatedCommandEnvironment() },
    );
  } finally {
    await rm(warmRoot, { force: true, recursive: true });
  }
}, 180_000);

it('writes the package version as the producer of a packed CLI manifest', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-manifest-'));
  const manifest = await readPackageManifest();
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm', ['install', ...cachedNpmInstallArguments, tarball],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );

    const project = await createBuildProject(consumerRoot);
    const packedCli = join(
      consumerRoot,
      'node_modules',
      'agent-bundle',
      manifest.bin['agent-bundle'],
    );
    await execFile(process.execPath, [packedCli, 'build', '--root', project.project, '--output', project.output], {
      cwd: consumerRoot,
    });

    await expect(producerFrom(project.output)).resolves.toEqual({
      name: 'agent-bundle',
      version: manifest.version,
    });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

/**
 * The compiler (`@rslib/core`) and MCP Apps (`@rsbuild/core`) must run one
 * Rspack: a consumer that installs the tarball gets exactly one
 * `@rspack/core`, one native `@rspack/binding-<platform>` of the same
 * version, one `@rsbuild/core`, and one `@rslib/core`. Two engines is what
 * a mismatched `@rslib/core` / `@rsbuild/core` pair produces (#566), and it
 * costs every consumer a second native binding download.
 */
it('installs one Rspack engine into a packed consumer', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-engine-'));
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm', ['install', ...cachedNpmInstallArguments, tarball],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );

    const engine = await installedCopies(
      join(consumerRoot, 'node_modules'),
      (name) => name === '@rspack/core' || name.startsWith('@rspack/binding-') || name === '@rsbuild/core' || name === '@rslib/core',
    );
    const installed = (name: string): readonly InstalledCopy[] => engine.filter((copy) => copy.name === name);
    const bindings = engine.filter((copy) => copy.name.startsWith('@rspack/binding-'));
    const report = engine.map((copy) => `${copy.path}@${copy.version}`).join('\n');

    expect(installed('@rspack/core'), report).toHaveLength(1);
    expect(installed('@rsbuild/core'), report).toHaveLength(1);
    expect(installed('@rslib/core'), report).toHaveLength(1);
    expect(bindings, report).toHaveLength(1);
    expect(bindings[0]!.version, report).toBe(installed('@rspack/core')[0]!.version);
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

it('imports the externalized config entry from a packed npm consumer', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-consumer-'));
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', ...cachedNpmInstallArguments, tarball],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );

    expect((await stat(join(packageRoot, 'dist/config.js'))).size).toBeLessThan(
      100_000,
    );
    await expect(
      execFile(process.execPath, [
        '--input-type=module',
        '--eval',
        [
          "import { defineConfig as rootDefineConfig } from 'agent-bundle';",
          "import { defineConfig } from 'agent-bundle/config';",
          'if (defineConfig !== rootDefineConfig) throw new Error(\'config factory identity mismatch\');',
        ].join('\n'),
      ], { cwd: consumerRoot, env: isolatedCommandEnvironment() }),
    ).resolves.toMatchObject({ stderr: '', stdout: '' });
    await linkWorkspaceTypes(consumerRoot);
    await writeFile(join(consumerRoot, 'config.mts'), [
      "import { defineConfig, type AgentBundleConfig } from 'agent-bundle/config';",
      '',
      'const config: AgentBundleConfig = {',
      "  claude: { nativeHooks: './claude-hooks.json' },",
      "  codex: { nativeHooks: './codex-hooks.json' },",
      "  plugin: { name: 'packed-config-types', version: '1.0.0' },",
      "  portable: { compatibility: 'v1' },",
      '};',
      '',
      'const claudeHook: string | undefined = config.claude?.nativeHooks;',
      'const codexHook: string | undefined = config.codex?.nativeHooks;',
      'const portableConfig: { readonly [key: string]: unknown } | undefined = config.portable;',
      'void defineConfig(config);',
      'void [claudeHook, codexHook, portableConfig];',
      '',
    ].join('\n'));
    try {
      const typecheck = await execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
        '--module', 'nodenext',
        '--moduleResolution', 'nodenext',
        '--noEmit',
        '--strict',
        '--target', 'es2022',
        '--types', 'node',
        'config.mts',
      ], { cwd: consumerRoot, env: isolatedCommandEnvironment() });
      expect(typecheck).toMatchObject({ stderr: '', stdout: '' });
    } catch (error) {
      const stdout = error !== null && typeof error === 'object' && 'stdout' in error
        ? String(error.stdout)
        : '';
      const stderr = error !== null && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr)
        : '';
      throw new Error(`Packed config typecheck failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
    }
    // The aliased artifact runtime's declarations must stay self-contained
    // for a consumer without the optional runtime peer's `notices` subpath
    // (#99 close-out): its notice binding is spelled locally, so no public or
    // aliased declaration resolves through `@agent-bundle/runtime/notices`.
    const installedDist = join(consumerRoot, 'node_modules', 'agent-bundle', 'dist');
    // Module specifiers only: a doc comment may name the subpath, an import may not.
    const noticesSpecifier = /(?:from\s*|import\(\s*)['"]@agent-bundle\/runtime\/notices(?:\/[^'"]*)?['"]/u;
    for (const declaration of ['mcp-server-runtime.d.ts', 'api.d.ts', 'index.d.ts', 'adapters/notice-delivery.d.ts', 'adapters/types.d.ts']) {
      const text = await readFile(join(installedDist, declaration), 'utf8');
      expect(text, declaration).not.toMatch(noticesSpecifier);
    }
    const aliasedRuntime = await readFile(join(installedDist, 'mcp-server-runtime.d.ts'), 'utf8');
    expect(aliasedRuntime).toContain('GeneratedNoticeDeliveryBinding');
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

it('invokes a prebuilt MCP server from a clean packed consumer', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-consumer-'));
  try {
    const artifact = join(consumerRoot, 'artifact');
    await mkdir(join(artifact, 'mcp'), { recursive: true });
    await writeFile(
      join(artifact, 'mcp', 'server.mjs'),
      [
        "let buffer = '';",
        'const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: \'2.0\', id, result })}\\n`);',
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        "  for (let newline; (newline = buffer.indexOf('\\n')) >= 0;) {",
        '    const line = buffer.slice(0, newline).trim();',
        '    buffer = buffer.slice(newline + 1);',
        '    if (!line) continue;',
        '    const request = JSON.parse(line);',
        "    if (request.method === 'initialize') send(request.id, { capabilities: { tools: {} }, protocolVersion: request.params.protocolVersion, serverInfo: { name: 'packed-fixture', version: '1.0.0' } });",
        "    if (request.method === 'tools/list') send(request.id, { tools: [{ description: 'Packed fixture', inputSchema: { properties: {}, type: 'object' }, name: 'inspect' }] });",
        "    if (request.method === 'tools/call') send(request.id, { content: [{ text: 'packed result', type: 'text' }], structuredContent: { packed: true } });",
        '  }',
        '});',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(artifact, 'plugin.json'),
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"packed-fixture","version":"1.0.0"}\n',
    );
    await writeFile(
      join(artifact, 'mcp.json'),
      `${JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          fixture: {
            args: ['mcp/server.mjs'],
            // Bare executable name, as the compiler emits: Agent Plugins §7.2.1
            // forbids absolute command paths and the build now fails closed.
            command: 'node',
            cwd: '${PLUGIN_ROOT}',
            type: 'stdio',
          },
        },
      })}\n`,
    );
    await Promise.all([
      writeFile(join(artifact, 'INSTALL.md'), '# Install packed-fixture\n'),
      writeFile(join(artifact, 'install.mjs'), '#!/usr/bin/env node\n'),
    ]);
    await writeFixtureManifest({ artifactRoot: artifact, targets: ['portable'] });
    await expect(readFile(join(artifact, 'agent-bundle.hooks.json'), 'utf8')).resolves.toBe(
      '{"hooks":[]}\n',
    );

    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', ...cachedNpmInstallArguments, tarball],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );
    const { stdout } = await execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      [
        "import { McpService } from 'agent-bundle/api';",
        "const result = await new McpService().invoke({ artifact: './artifact', input: {}, server: 'fixture', target: 'portable', tool: 'inspect' });",
        'console.log(JSON.stringify(result));',
      ].join('\n'),
    ], { cwd: consumerRoot, env: isolatedCommandEnvironment() });
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        content: [{ text: 'packed result', type: 'text' }],
        structuredContent: { packed: true },
      },
      server: { name: 'packed-fixture', version: '1.0.0' },
    });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);
