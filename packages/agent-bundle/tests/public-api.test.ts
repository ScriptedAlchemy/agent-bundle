import { execFile as executeFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import {
  defineConfig,
  pathTokens,
  type AgentBundleConfig,
  type ArtifactOutputProvenance,
  type NormalizedConfigExtension,
  type NormalizedPlugin,
} from '../src/index.ts';
import { runCli } from '../src/cli.ts';
import type {
  AgentBundleConfig as ConfigEntryAgentBundleConfig,
  AgentBundleDevConfig,
  AgentBundleDevRuntimeConfig,
} from '../src/config/index.ts';
import { defineConfig as defineConfigFromConfigEntry } from '../src/config/index.ts';
import type {
  CreateDevRuntimeProvider,
  DevRuntimeProvider,
} from '../src/api.ts';
import { writeFixtureManifest } from './support/manifest.ts';

interface PackageManifest {
  bin: {
    'agent-bundle': string;
  };
  engines?: {
    node?: string;
  };
  exports: Record<string, { import: string; types: string }>;
  version: string;
}

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
let buildPromise: Promise<void> | undefined;

const buildPackage = async (): Promise<void> => {
  buildPromise ??= execFile('npm', ['run', 'build'], {
    cwd: workspaceRoot,
  }).then(() => undefined);
  await buildPromise;
};

const readPackageManifest = async (): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;

const createBuildProject = async (root: string): Promise<{ readonly output: string; readonly project: string }> => {
  const project = join(root, 'manifest-version-project');
  const output = join(project, 'manifest-version-artifact');
  await mkdir(join(project, 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(project, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'manifest-version-fixture', version: '1.0.0' }, targets: ['portable'] };\n",
    ),
    writeFile(
      join(project, 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
  ]);
  return { output, project };
};

const producerFrom = async (output: string): Promise<{ readonly name: string; readonly version: string }> => {
  const manifest = JSON.parse(
    await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'),
  ) as { readonly producer: { readonly name: string; readonly version: string } };
  return manifest.producer;
};

it('keeps package output filenames stable', async () => {
  const config = (await import('../../../rslib.config.ts')).default;
  expect(config).toMatchObject({ output: { filenameHash: false } });
});

it('preserves a synchronous config and exposes opaque path tokens', () => {
  const config = { plugin: { name: 'demo', version: '1.0.0' } };
  expect(defineConfig(config)).toBe(config);
  expect(pathTokens).toEqual({
    pluginRoot: 'agent-bundle:path:plugin-root',
    pluginData: 'agent-bundle:path:plugin-data',
    workspaceRoot: 'agent-bundle:path:workspace-root',
  });
});

it('exposes the same typed config factory from the config entrypoint', () => {
  const config = {
    plugin: { name: 'config-entrypoint', version: '1.0.0' },
  } satisfies ConfigEntryAgentBundleConfig;

  expect(defineConfigFromConfigEntry).toBe(defineConfig);
  expect(defineConfigFromConfigEntry(config)).toBe(config);
});

it('exposes an optional author-facing development runtime declaration', () => {
  const runtime = {
    provider: './src/dev/provider.ts',
  } satisfies AgentBundleDevRuntimeConfig;
  const dev = { runtime } satisfies AgentBundleDevConfig;
  const config = {
    dev,
    plugin: { name: 'runtime-contract', version: '1.0.0' },
  } satisfies AgentBundleConfig;

  const providerFactory: CreateDevRuntimeProvider | undefined = undefined;
  const provider: DevRuntimeProvider | undefined = undefined;

  expect(defineConfig(config)).toBe(config);
  expect(config.dev?.runtime?.provider).toBe('./src/dev/provider.ts');
  expect(providerFactory).toBeUndefined();
  expect(provider).toBeUndefined();
});

it('exposes bundled adapter extension and normalized-extension types from the root import', () => {
  const config = {
    claude: { nativeHooks: './claude-hooks.json' },
    codex: { nativeHooks: './codex-hooks.json' },
    plugin: { name: 'typed-extension-fixture', version: '1.0.0' },
    portable: { compatibility: 'portable-v1' },
  } satisfies AgentBundleConfig;
  const extension: NormalizedConfigExtension = {
    id: 'extension:portable',
    key: 'portable',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    target: 'portable',
    value: config.portable,
  };
  const model = {
    extensions: { portable: extension },
  } satisfies Pick<NormalizedPlugin, 'extensions'>;

  expect(model.extensions.portable.key).toBe('portable');
});

it('exposes immutable output provenance types from the root import', () => {
  const output: ArtifactOutputProvenance = {
    kind: 'bundle',
    path: 'portable/scripts/greeting.mjs',
    sourceInputs: ['skills/review/scripts/greeting.ts'],
  };

  expect(output.kind).toBe('bundle');
});

it('loads every public subpath and reports the package version', async () => {
  await expect(import('../src/api.ts')).resolves.toBeDefined();
  await expect(import('../src/config/index.ts')).resolves.toBeDefined();
  await expect(import('../src/eval/index.ts')).resolves.toBeDefined();
  await expect(runCli(['--version'])).resolves.toBe(0);
});

it('publishes directly executable built entrypoints with declarations', async () => {
  await buildPackage();

  const manifest = await readPackageManifest();
  expect(manifest.engines?.node).toBe('>=22.19.0');

  for (const entrypoint of Object.values(manifest.exports)) {
    await expect(access(join(packageRoot, entrypoint.import))).resolves.toBeUndefined();
    await expect(access(join(packageRoot, entrypoint.types))).resolves.toBeUndefined();
  }

  const distFiles = await readdir(join(packageRoot, 'dist'));
  expect(distFiles.filter((file) => file.endsWith('.js')).every((file) => !/-[a-f0-9]{8,}\.js$/i.test(file))).toBe(true);

  const rootEntrypoint = await import('agent-bundle');
  await expect(import('agent-bundle/api')).resolves.toBeDefined();
  const configEntrypoint = await import('agent-bundle/config');
  await expect(import('agent-bundle/eval')).resolves.toBeDefined();
  expect(configEntrypoint.defineConfig).toBe(rootEntrypoint.defineConfig);

  const binPath = join(packageRoot, manifest.bin['agent-bundle']);
  const binSource = await readFile(binPath, 'utf8');
  expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);

  const { stdout } = await execFile(binPath, ['--version']);
  expect(stdout).toBe(`${manifest.version}\n`);
});

it('writes the package version as the producer of a built CLI manifest', async () => {
  await buildPackage();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-built-manifest-'));
  const manifest = await readPackageManifest();
  try {
    const project = await createBuildProject(root);
    const binPath = join(packageRoot, manifest.bin['agent-bundle']);
    await execFile(binPath, ['build', '--root', project.project, '--output', project.output], { cwd: project.project });

    await expect(producerFrom(project.output)).resolves.toEqual({
      name: 'agent-bundle',
      version: manifest.version,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('writes the package version as the producer of a packed CLI manifest', async () => {
  await buildPackage();

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-manifest-'));
  const manifest = await readPackageManifest();
  try {
    const { stdout: packedOutput } = await execFile(
      'npm', ['pack', '--json', '--pack-destination', consumerRoot], { cwd: packageRoot },
    );
    const [packed] = JSON.parse(packedOutput) as Array<{ filename: string }>;
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(consumerRoot, packed.filename)],
      { cwd: consumerRoot },
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

it('imports the externalized config entry from a packed npm consumer', async () => {
  await buildPackage();

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-consumer-'));
  try {
    const { stdout: packedOutput } = await execFile(
      'npm',
      ['pack', '--json', '--pack-destination', consumerRoot],
      { cwd: packageRoot },
    );
    const [packed] = JSON.parse(packedOutput) as Array<{ filename: string }>;
    const tarball = join(consumerRoot, packed.filename);

    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      { cwd: consumerRoot },
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
      ], { cwd: consumerRoot }),
    ).resolves.toMatchObject({ stderr: '', stdout: '' });
    await symlink(
      join(workspaceRoot, 'node_modules', '@types'),
      join(consumerRoot, 'node_modules', '@types'),
      'dir',
    );
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
    await expect(execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noEmit',
      '--strict',
      '--target', 'es2022',
      '--types', 'node',
      'config.mts',
    ], { cwd: consumerRoot })).resolves.toMatchObject({ stderr: '', stdout: '' });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 15_000);

it('keeps bundled config extension types in emitted root declarations', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-root-types-'));
  try {
    const emittedPackageRoot = join(consumerRoot, 'node_modules', 'agent-bundle');
    await mkdir(emittedPackageRoot, { recursive: true });
    await symlink(
      join(workspaceRoot, 'node_modules', '@modelcontextprotocol'),
      join(consumerRoot, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await symlink(
      join(workspaceRoot, 'node_modules', '@types'),
      join(consumerRoot, 'node_modules', '@types'),
      'dir',
    );
    await writeFile(join(emittedPackageRoot, 'package.json'), JSON.stringify({
      exports: { '.': { types: './dist/index.d.ts' } },
      name: 'agent-bundle',
      type: 'module',
    }));
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--declaration',
      '--emitDeclarationOnly',
      '--ignoreConfig',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noCheck',
      '--outDir', join(emittedPackageRoot, 'dist'),
      '--target', 'es2022',
      join(packageRoot, 'src', 'index.ts'),
    ], { cwd: workspaceRoot });
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(consumerRoot, 'config.mts'), [
      "import type { AgentBundleConfig } from 'agent-bundle';",
      '',
      'const config: AgentBundleConfig = {',
      "  claude: { nativeHooks: './claude-hooks.json' },",
      "  codex: { nativeHooks: './codex-hooks.json' },",
      "  plugin: { name: 'packed-root-types', version: '1.0.0' },",
      "  portable: { compatibility: 'v1' },",
      '};',
      '',
      'const claudeHook: string | undefined = config.claude?.nativeHooks;',
      'const codexHook: string | undefined = config.codex?.nativeHooks;',
      'const portableValue: unknown = config.portable?.compatibility;',
      'void [claudeHook, codexHook, portableValue];',
      '',
    ].join('\n'));

    await expect(execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noEmit',
      '--strict',
      '--target', 'es2022',
      '--types', 'node',
      'config.mts',
    ], { cwd: consumerRoot })).resolves.toMatchObject({ stderr: '', stdout: '' });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

it('invokes a prebuilt MCP server from a clean packed consumer', async () => {
  await buildPackage();

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-consumer-'));
  try {
    const artifact = join(consumerRoot, 'artifact');
    await mkdir(join(artifact, 'portable'), { recursive: true });
    await writeFile(
      join(artifact, 'server.mjs'),
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
    await writeFile(join(artifact, 'portable', 'plugin.json'), '{"name":"packed-fixture","version":"1.0.0"}\n');
    await writeFile(
      join(artifact, 'portable', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          fixture: {
            args: ['../server.mjs'],
            command: process.execPath,
            cwd: '${PLUGIN_ROOT}',
            type: 'stdio',
          },
        },
      })}\n`,
    );
    await writeFixtureManifest({ artifactRoot: artifact, targets: ['portable'] });

    const { stdout: packedOutput } = await execFile(
      'npm',
      ['pack', '--json', '--pack-destination', consumerRoot],
      { cwd: packageRoot },
    );
    const [packed] = JSON.parse(packedOutput) as Array<{ filename: string }>;
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(consumerRoot, packed.filename)],
      { cwd: consumerRoot },
    );
    const { stdout } = await execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      [
        "import { McpService } from 'agent-bundle/api';",
        "const result = await new McpService().invoke({ artifact: './artifact', input: {}, server: 'fixture', target: 'portable', tool: 'inspect' });",
        'console.log(JSON.stringify(result));',
      ].join('\n'),
    ], { cwd: consumerRoot });
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
