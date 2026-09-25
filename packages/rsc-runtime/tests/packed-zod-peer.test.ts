import { execFile as executeFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';

import runtimeManifest from '../package.json' with { type: 'json' };
import {
  cachedNpmInstallArguments,
  installedEnvironment,
  packOutputFromJson,
  sharedPackedTarball,
} from '../../agent-bundle/tests/support/shared-pack.ts';
import { removeTree } from '../../agent-bundle/tests/support/remove-tree.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const tscBin = join(workspaceRoot, 'node_modules', '.bin', 'tsc');

const consumerZod = '4.6.5';
const nestedZod = '4.5.4';
const defineStateSource = [
  "import { defineState } from '@agent-bundle/runtime/state';",
  "import { z } from 'zod';",
  '',
  'export default defineState({',
  "  id: 'zod-peer/counter',",
  "  lifetime: 'process',",
  '  initial: { count: 0 },',
  '  schema: z.object({ count: z.number() }),',
  '  events: { tick: z.object({}) },',
  '  reduce: (state) => state,',
  '});',
  '',
].join('\n');

const defineStateTsconfig = `${JSON.stringify({
  compilerOptions: {
    module: 'nodenext',
    moduleResolution: 'nodenext',
    noEmit: true,
    pretty: false,
    skipLibCheck: false,
    strict: true,
    target: 'es2022',
    types: [],
  },
  files: ['state.ts'],
}, null, 2)}\n`;

interface InstalledRuntimeManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly name: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

interface ZodCopy {
  readonly path: string;
  readonly version: string;
}

const execFileOutput = (error: unknown): { readonly stderr: string; readonly stdout: string } => {
  if (error === null || typeof error !== 'object') {
    return { stderr: String(error), stdout: '' };
  }
  return {
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
  };
};

const installedZodCopies = async (nodeModules: string): Promise<readonly ZodCopy[]> => {
  let entries: Dirent[];
  try {
    entries = await readdir(nodeModules, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const copies = await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || entry.name !== 'package.json' || basename(entry.parentPath) !== 'zod') {
      return [];
    }
    return [(async (): Promise<ZodCopy | undefined> => {
      const manifest = JSON.parse(await readFile(join(entry.parentPath, 'package.json'), 'utf8')) as {
        readonly name?: string;
        readonly version: string;
      };
      if (manifest.name !== 'zod') return undefined;
      return { path: relative(nodeModules, entry.parentPath), version: manifest.version };
    })()];
  }));
  return copies
    .filter((copy): copy is ZodCopy => copy !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
};

const writeDefineStateConsumer = async (consumer: string): Promise<void> => {
  await Promise.all([
    writeFile(join(consumer, 'package.json'), '{"name":"runtime-zod-peer-consumer","private":true,"type":"module"}\n'),
    writeFile(join(consumer, 'state.ts'), defineStateSource),
    writeFile(join(consumer, 'tsconfig.json'), defineStateTsconfig),
  ]);
};

const installRuntimeConsumer = async (
  consumer: string,
  runtimeTarball: string,
): Promise<void> => {
  await writeDefineStateConsumer(consumer);
  await execFile('npm', [
    'install',
    ...cachedNpmInstallArguments,
    runtimeTarball,
    `react@${runtimeManifest.devDependencies.react}`,
    `react-dom@${runtimeManifest.devDependencies['react-dom']}`,
    `zod@${consumerZod}`,
  ], { cwd: consumer, env: installedEnvironment() });
};

const typecheckDefineState = async (
  consumer: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly output: string }> => {
  try {
    const result = await execFile(tscBin, ['-p', 'tsconfig.json'], {
      cwd: consumer,
      env: installedEnvironment(),
    });
    if (result.stdout === '' && result.stderr === '') return { ok: true };
    return { ok: false, output: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const { stderr, stdout } = execFileOutput(error);
    return { ok: false, output: `${stdout}\n${stderr}` };
  }
};

const packNestedZodRuntime = async (runtimeTarball: string, destination: string): Promise<string> => {
  await mkdir(destination, { recursive: true });
  await execFile('tar', ['-xzf', runtimeTarball, '-C', destination]);
  const root = join(destination, 'package');
  const manifestPath = join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as InstalledRuntimeManifest;
  const peerDependencies = Object.fromEntries(
    Object.entries(manifest.peerDependencies).filter(([name]) => name !== 'zod'),
  );
  const rewritten = {
    ...manifest,
    dependencies: { ...manifest.dependencies, zod: nestedZod },
    peerDependencies,
  };
  await writeFile(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: root,
    env: installedEnvironment(),
  });
  return join(destination, packOutputFromJson(stdout, rewritten.name).filename);
};

/**
 * #793: `@agent-bundle/runtime` used to pin `zod@4.5.4` as a regular
 * dependency. Zod 4 brands `ZodType` by `_zod.version.minor`, so a consumer
 * on `zod@4.6.x` could not pass any schema to `defineState`. The packed
 * peer install must share one physical copy and typecheck; restoring the
 * exact nested dependency must reproduce the brand error.
 */
describe.sequential('packed @agent-bundle/runtime zod peer', () => {
  it('typechecks a consumer zod@4.6.5 defineState schema against one physical peer install', async () => {
    const runtime = await sharedPackedTarball('runtime');
    const consumer = await mkdtemp(join(tmpdir(), 'runtime-zod-peer-'));
    try {
      await installRuntimeConsumer(consumer, runtime.tarball);

      const installed = join(consumer, 'node_modules', '@agent-bundle', 'runtime');
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as InstalledRuntimeManifest;
      expect(manifest.peerDependencies.zod).toBe(runtimeManifest.peerDependencies.zod);
      expect(manifest.dependencies).not.toHaveProperty('zod');
      expect(await installedZodCopies(join(consumer, 'node_modules'))).toEqual([
        { path: 'zod', version: consumerZod },
      ]);

      const typecheck = await typecheckDefineState(consumer);
      if (!typecheck.ok) {
        throw new Error(`Packed defineState typecheck failed.\n${typecheck.output}`);
      }
    } finally {
      await removeTree(consumer);
    }
  }, 180_000);

  it('reproduces the cross-minor brand error when the packed runtime depends on zod@4.5.4 exactly', async () => {
    const runtime = await sharedPackedTarball('runtime');
    const workspace = await mkdtemp(join(tmpdir(), 'runtime-zod-nested-'));
    const consumer = join(workspace, 'consumer');
    try {
      await mkdir(consumer);
      const nestedTarball = await packNestedZodRuntime(runtime.tarball, join(workspace, 'nested-runtime'));
      await installRuntimeConsumer(consumer, nestedTarball);

      expect(await installedZodCopies(join(consumer, 'node_modules'))).toEqual([
        { path: '@agent-bundle/runtime/node_modules/zod', version: nestedZod },
        { path: 'zod', version: consumerZod },
      ]);

      const typecheck = await typecheckDefineState(consumer);
      expect(typecheck.ok).toBe(false);
      if (typecheck.ok) throw new Error('expected the nested 4.5.4 copy to fail defineState typecheck');
      expect(typecheck.output).toContain("Type '6' is not assignable to type '5'");
      expect(typecheck.output).toContain('_zod.version.minor');
    } finally {
      await removeTree(workspace);
    }
  }, 180_000);
});
