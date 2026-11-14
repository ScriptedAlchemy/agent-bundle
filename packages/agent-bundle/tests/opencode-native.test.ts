import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, validate } from '../src/api.ts';
import { installBundle } from '../src/install/install.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import {
  assertCompiledOpenCodeMcp,
  readOpenCodeVersion,
  runOpenCodeNativeAcceptance,
  writeOpenCodeFixture,
} from './support/opencode-host.ts';
import { removeTree } from './support/remove-tree.ts';

const binary = process.env.AB_OPENCODE_NATIVE_BINARY ?? 'opencode';
const available = spawnSync(binary, ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0 ? it : it.skip;

process.env.PATH = `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`;

available('builds and loads a conventional movie-library-shaped plugin through OpenCode V2 and its package-bound installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-native-integration-'));
  const project = join(root, 'consumer-project');
  const artifact = join(project, 'artifact');
  await mkdir(project, { recursive: true });
  try {
    await writeOpenCodeFixture(project);
    await mkdir(join(project, 'node_modules', '@agent-bundle'), { recursive: true });
    for (const [source, destination] of [
      [join(process.cwd(), 'packages', 'agent-bundle'), 'agent-bundle'],
      [join(process.cwd(), 'packages', 'rsc-runtime'), join('@agent-bundle', 'runtime')],
      [join(process.cwd(), 'packages', 'rsc-markdown-stream'), 'rsc-markdown-stream'],
      [join(agentBundleNodeModules, 'zod'), 'zod'],
      [join(agentBundleNodeModules, 'react'), 'react'],
      [join(agentBundleNodeModules, 'react-dom'), 'react-dom'],
    ] as const) {
      await symlink(source, join(project, 'node_modules', destination), 'dir');
    }
    const prepared = await validate({ root: project, targets: ['opencode'] });
    expect(prepared.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    await build({
      hostValidation: true,
      output: artifact,
      root: project,
      targets: ['opencode'],
    });
    const validation = await validate({
      artifact,
      hostValidation: true,
      root: project,
      strict: true,
    });
    expect(validation.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    expect(validation.hostValidation).toEqual([
      expect.objectContaining({ host: 'opencode', status: 'passed', version: await readOpenCodeVersion(binary) }),
    ]);

    expect(await runOpenCodeNativeAcceptance({
      binary,
      pluginRoot: artifact,
      workingDirectory: artifact,
    })).toMatchObject({
      promptResults: ['Use $& $$.', 'one / ten'],
      skill: 'movie-library',
    });
    const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly executables: {
        readonly mcpServers: readonly { readonly name: string; readonly launch?: { readonly entry: string } }[];
      };
    };
    const entry = manifest.executables.mcpServers.find((server) => server.name === 'library')?.launch?.entry;
    expect(entry).toBeDefined();
    const toolNames = await assertCompiledOpenCodeMcp(join(artifact, entry!), 'native MCP response');
    expect(toolNames).toContain('native-echo');

    const installed = await installBundle({
      from: artifact,
      home: join(root, 'home'),
      host: 'opencode',
      projectRoot: project,
      scope: 'project',
    });
    expect(installed).toMatchObject({
      destination: join(project, '.opencode', 'plugins', 'movie-library'),
      host: 'opencode',
      state: 'installed',
    });
    expect(await runOpenCodeNativeAcceptance({
      binary,
      pluginRoot: installed.destination!,
      workingDirectory: project,
    })).toMatchObject({
      promptResults: ['Use $& $$.', 'one / ten'],
      skill: 'movie-library',
    });
    expect((await installBundle({
      from: artifact,
      home: join(root, 'home'),
      host: 'opencode',
      projectRoot: project,
      scope: 'project',
    })).state).toBe('already-installed');
  } finally {
    await removeTree(root);
  }
}, 180_000);
