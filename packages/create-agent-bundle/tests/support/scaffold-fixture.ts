import { execFile as executeFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect } from '@rstest/core';

import {
  cachedNpmInstallArguments,
  installedEnvironment,
  npmInstallArguments,
  sharedPackedTarball,
} from '../../../agent-bundle/tests/support/shared-pack.ts';

const execFile = promisify(executeFile);

interface PackedFixture {
  readonly frameworkTarball: string;
  readonly markdownStreamTarball: string;
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
  const [
    { tarball: frameworkTarball },
    { tarball: scaffolderTarball },
    { tarball: runtimeTarball },
    { tarball: markdownStreamTarball },
  ] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('create-agent-bundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
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
    markdownStreamTarball,
    root,
    runnerRoot,
    scaffolderBin: join(runnerRoot, 'node_modules', '.bin', 'create-agent-bundle'),
  };
};

/**
 * `npm install` for a scaffolded project whose template pins the paired
 * local runtime tarball. That runtime depends on `rsc-markdown-stream` by
 * exact version, which the registry cannot serve until this repository
 * publishes it, so the run-level tarball is offered in the same install and
 * npm dedupes the runtime's edge onto it. `--no-save` leaves the scaffolded
 * manifest exactly as the scaffolder wrote it: a real consumer declares
 * nothing extra.
 */
export const installScaffoldedProject = async (projectRoot: string): Promise<void> => {
  const { markdownStreamTarball } = await fixture();
  await execFile('npm', ['install', ...npmInstallArguments, '--no-save', markdownStreamTarball], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });
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

/**
 * Runs one project script and returns its combined output, so a caller can
 * assert on what the script reported instead of on its silence.
 */
export const npmRun = async (projectRoot: string, script: string): Promise<string> => {
  const { stderr, stdout } = await execFile('npm', ['run', script], {
    cwd: projectRoot,
    env: installedEnvironment(),
  });
  return `${stdout}${stderr}`;
};

/**
 * Rstest's `json` report for one pool of a scaffolded project, run through
 * the project's own npm script with the reporter requested on the command
 * line. The default reporter's prose is not a contract: it expands per-test
 * lines only for single-file runs, and under an AI-agent environment Rstest
 * swaps in the `md` reporter altogether (which is where a `"failedTests"`
 * key used to come from). A failing pool exits non-zero with its report
 * already written, and the report names the failing test where the exit code
 * alone would not, so a non-zero exit is read rather than thrown.
 */
interface PoolReport {
  readonly files: readonly { readonly status: string }[];
  readonly status: 'fail' | 'pass';
  readonly summary: { readonly failedTests: number };
  readonly tests: readonly { readonly name: string; readonly status: string }[];
}

const poolReport = async (projectRoot: string, script: string): Promise<PoolReport> => {
  const stdout = await execFile('npm', ['run', script, '--', '--reporter=json'], {
    cwd: projectRoot,
    env: installedEnvironment(),
  }).then((result) => result.stdout, (error: unknown) => {
    const failed = error as { readonly stdout?: string };
    if (typeof failed.stdout !== 'string') throw error;
    return failed.stdout;
  });
  // npm's script banner and Rstest's own precede the report on stdout; the
  // report is the only thing there that opens a line with `{`.
  const start = stdout.search(/^\{$/mu);
  if (start === -1) throw new Error(`\`npm run ${script}\` wrote no Rstest JSON report:\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as PoolReport;
};

/**
 * The pool passed and ran the named tests. Failing entries come first — a
 * test's, then a file's, for a file that failed before it had tests — because
 * they carry the error where the counts would only say that something
 * failed. The names catch a dropped or empty pool, which Rstest reports as
 * `fail` with zero tests — and `failedTests: 0`.
 */
export const expectPassedPool = async (
  projectRoot: string,
  script: string,
  testNames: readonly string[],
): Promise<void> => {
  const report = await poolReport(projectRoot, script);
  expect(report.tests.filter((test) => test.status === 'fail')).toEqual([]);
  expect(report.files.filter((file) => file.status === 'fail')).toEqual([]);
  expect(report.tests.map((test) => test.name)).toEqual(expect.arrayContaining([...testNames]));
  expect(report).toMatchObject({ status: 'pass', summary: { failedTests: 0 } });
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
