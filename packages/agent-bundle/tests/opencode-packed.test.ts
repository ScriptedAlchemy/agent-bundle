import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { sharedPackedTarball, npmInstallArguments } from './support/shared-pack.ts';
import { packedNativeEnvironment } from './support/packed-native-smoke.ts';
import { readOpenCodeVersion, runOpenCodeNativeAcceptance, assertCompiledOpenCodeMcp, writeOpenCodeFixture } from './support/opencode-host.ts';
import { removeTree } from './support/remove-tree.ts';

const execute = promisify(execFile);
const binary = process.env.AB_OPENCODE_NATIVE_BINARY ?? 'opencode';
process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;

it('loads a packed native V2 package through its generated package-bound installer and the pinned host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-packed-'));
  const consumer = join(root, 'consumer');
  const project = join(consumer, 'project');
  const artifact = join(project, 'artifact');
  const workspaceRoot = process.cwd();
  try {
    await mkdir(project, { recursive: true });
    const [agentBundle, runtime, markdownStream] = await Promise.all([
      sharedPackedTarball('agent-bundle'),
      sharedPackedTarball('runtime'),
      sharedPackedTarball('markdown-stream'),
    ]);
    await writeOpenCodeFixture(project);
    const environment = packedNativeEnvironment(process.env);
    await execute('npm', [
      'install',
      '--omit=dev',
      ...npmInstallArguments,
      agentBundle.tarball,
      runtime.tarball,
      markdownStream.tarball,
      'react@19.3.0',
      'react-dom@19.3.0',
      'zod@4.6.4',
    ], { cwd: project, env: environment, timeout: 180_000 });

    const cli = join(project, 'node_modules', 'agent-bundle', 'dist', 'cli.js');
    expect(isAbsolute(cli) && !cli.startsWith(workspaceRoot)).toBe(true);
    await execute(process.execPath, [cli, 'build', '--root', project, '--output', artifact], {
      cwd: project,
      env: environment,
      timeout: 120_000,
    });
    await execute(process.execPath, [cli, 'validate', '--root', project, '--artifact', artifact, '--strict', '--json'], {
      cwd: project,
      env: environment,
      timeout: 60_000,
    });

    const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly executables: {
        readonly bins: readonly { readonly name: string; readonly path: string }[];
        readonly mcpServers: readonly { readonly name: string; readonly launch?: { readonly entry: string } }[];
      };
    };
    const installBin = (await readdir(join(project, 'dist'), { recursive: true }))
      .map(String)
      .find((path) => path.endsWith('movie-library-install.js'));
    expect(installBin).toBeDefined();
    expect(await readOpenCodeVersion(binary)).toBe('2.2.6');

    await Promise.all([
      rm(join(project, 'src'), { force: true, recursive: true }),
      rm(join(project, 'node_modules'), { force: true, recursive: true }),
    ]);
    const installedOutput = await execute(process.execPath, [join(project, 'dist', installBin!), 'install', 'opencode', '--scope', 'project', '--json'], {
      cwd: project,
      env: environment,
      timeout: 60_000,
    });
    const installResult = JSON.parse(installedOutput.stdout) as { readonly destination: string; readonly state: string };
    expect(installResult).toMatchObject({
      destination: join(project, '.opencode', 'plugins', 'movie-library'),
      state: 'installed',
    });

    expect(await runOpenCodeNativeAcceptance({
      binary,
      pluginRoot: installResult.destination,
      workingDirectory: project,
    })).toMatchObject({
      promptResults: ['Use $& $$.', 'one / ten'],
      skill: 'movie-library',
    });
    const entry = manifest.executables.mcpServers.find((server) => server.name === 'library')?.launch?.entry;
    expect(entry).toBeDefined();
    expect(await assertCompiledOpenCodeMcp(join(installResult.destination, entry!), 'packed native MCP response')).toContain('native-echo');
  } finally {
    await removeTree(root);
  }
}, 240_000);
