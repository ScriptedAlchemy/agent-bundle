import { execFile as executeFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect } from '@rstest/core';

import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from '../../../agent-bundle/tests/support/shared-pack.ts';

const execFile = promisify(executeFile);

interface PackedFixture {
  readonly frameworkTarball: string;
  readonly root: string;
  readonly runnerRoot: string;
  readonly scaffolderBin: string;
}

/**
 * Take the run-level agent-bundle and create-agent-bundle release tarballs
 * (packed once per `test:packed` run — see tests/support/shared-pack.ts),
 * then install the scaffolder tarball into a clean runner project. Every
 * template test drives the installed bin and pins the framework with
 * `--framework-version file:<tarball>`, so the run never depends on
 * pkg.pr.new. Each test file gets its own fixture instance (rstest isolates
 * files), so register `cleanupScaffoldFixture` in an `afterAll` per file.
 */
const packFixture = async (): Promise<PackedFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-e2e-'));
  const [{ tarball: frameworkTarball }, { tarball: scaffolderTarball }, { tarball: runtimeTarball }] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('create-agent-bundle'),
    sharedPackedTarball('runtime'),
  ]);
  const pairedRuntimeTarball = join(
    dirname(frameworkTarball),
    basename(frameworkTarball).replace(/^agent-bundle-/u, 'agent-bundle-runtime-'),
  );
  await copyFile(runtimeTarball, pairedRuntimeTarball);

  const runnerRoot = join(root, 'runner');
  await mkdir(runnerRoot, { recursive: true });
  await writeFile(join(runnerRoot, 'package.json'), '{"name":"scaffold-runner","type":"module","private":true}\n');
  await execFile('npm', ['install', ...cachedNpmInstallArguments, scaffolderTarball], {
    cwd: runnerRoot,
    env: installedEnvironment(),
  });
  return {
    frameworkTarball,
    root,
    runnerRoot,
    scaffolderBin: join(runnerRoot, 'node_modules', '.bin', 'create-agent-bundle'),
  };
};

let fixturePromise: Promise<PackedFixture> | undefined;
const fixture = (): Promise<PackedFixture> => {
  fixturePromise ??= packFixture();
  return fixturePromise;
};

export const cleanupScaffoldFixture = async (): Promise<void> => {
  if (fixturePromise === undefined) return;
  const { root } = await fixturePromise;
  await rm(root, { force: true, recursive: true });
};

export const scaffoldProject = async (
  template: string,
  projectName: string,
  extraArguments: readonly string[],
): Promise<string> => {
  const { frameworkTarball, runnerRoot, scaffolderBin } = await fixture();
  await execFile(scaffolderBin, [
    projectName,
    '--template', template,
    '--targets', 'portable,codex,claude',
    '--package-manager', 'npm',
    '--framework-version', `file:${frameworkTarball}`,
    ...extraArguments,
  ], { cwd: runnerRoot, env: installedEnvironment() });
  return join(runnerRoot, projectName);
};

export const scaffoldProjectWithMismatchedRuntime = async (projectName: string): Promise<void> => {
  const { frameworkTarball, root, runnerRoot, scaffolderBin } = await fixture();
  const mismatchedDirectory = join(root, 'mismatched-pair');
  const mismatchedFramework = join(mismatchedDirectory, 'agent-bundle-mismatched.tgz');
  const mismatchedRuntime = join(mismatchedDirectory, 'agent-bundle-runtime-mismatched.tgz');
  await mkdir(mismatchedDirectory, { recursive: true });
  await Promise.all([
    copyFile(frameworkTarball, mismatchedFramework),
    copyFile(frameworkTarball, mismatchedRuntime),
  ]);

  await execFile(scaffolderBin, [
    projectName,
    '--template', 'mcp-server',
    '--targets', 'portable',
    '--package-manager', 'npm',
    '--framework-version', `file:${mismatchedFramework}`,
    '--no-install',
  ], { cwd: runnerRoot, env: installedEnvironment() });
};

export const npmRun = async (projectRoot: string, script: string): Promise<void> => {
  await execFile('npm', ['run', script], { cwd: projectRoot, env: installedEnvironment() });
};

/** Zero diagnostics — including the informational AB473x migration nudges. */
export const expectCleanValidate = async (projectRoot: string): Promise<void> => {
  const cli = join(projectRoot, 'node_modules', '.bin', 'agent-bundle');
  const { stdout } = await execFile(cli, ['validate', '--json', '--root', projectRoot], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });
  const validated = JSON.parse(stdout) as { readonly diagnostics: readonly unknown[] };
  expect(validated.diagnostics).toEqual([]);
};
