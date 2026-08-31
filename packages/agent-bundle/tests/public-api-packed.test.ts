import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { isolatedCommandEnvironment } from '../../../rstest.worker-isolation.ts';
import { writeFixtureManifest } from './support/manifest.ts';
import { npmInstallArguments, sharedPackedTarball } from './support/shared-pack.ts';

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

it('writes the package version as the producer of a packed CLI manifest', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-manifest-'));
  const manifest = await readPackageManifest();
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm', ['install', ...npmInstallArguments, tarball],
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

it('imports the externalized config entry from a packed npm consumer', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-consumer-'));
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', ...npmInstallArguments, tarball],
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
    ], { cwd: consumerRoot, env: isolatedCommandEnvironment() })).resolves.toMatchObject({ stderr: '', stdout: '' });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

it('invokes a prebuilt MCP server from a clean packed consumer', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-consumer-'));
  try {
    const artifact = join(consumerRoot, 'artifact');
    await mkdir(join(artifact, 'portable', 'mcp'), { recursive: true });
    await writeFile(
      join(artifact, 'portable', 'mcp', 'server.mjs'),
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
      join(artifact, 'portable', 'plugin.json'),
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"packed-fixture","version":"1.0.0"}\n',
    );
    await writeFile(
      join(artifact, 'portable', 'mcp.json'),
      `${JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          fixture: {
            args: ['mcp/server.mjs'],
            command: process.execPath,
            cwd: '${PLUGIN_ROOT}',
            type: 'stdio',
          },
        },
      })}\n`,
    );
    await writeFixtureManifest({ artifactRoot: artifact, targets: ['portable'] });
    await expect(readFile(join(artifact, 'agent-bundle.hooks.json'), 'utf8')).resolves.toBe(
      '{"hooks":[]}\n',
    );

    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await execFile(
      'npm',
      ['install', ...npmInstallArguments, tarball],
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
