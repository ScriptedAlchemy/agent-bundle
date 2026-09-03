import { execFile as executeFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isolatedCommandEnvironment } from '../../../../rstest.worker-isolation.ts';
import {
  packOutputFromJson,
  type PackOutput as SharedPackOutput,
} from '../../src/build/pack-inventory.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

export { packOutputFromJson };
export type { SharedPackOutput };

export interface SharedPack {
  /** The package's own `npm pack --json` entry recorded when the tarball was produced. */
  readonly packOutput: SharedPackOutput;
  readonly tarball: string;
}

export type SharedPackPackage = 'agent-bundle' | 'create-agent-bundle' | 'runtime';

/** packages/ directory and npm package name for each shared-pack key. */
const sharedPackPackages: Readonly<Record<SharedPackPackage, Readonly<{ directory: string; npmName: string }>>> = {
  'agent-bundle': { directory: 'agent-bundle', npmName: 'agent-bundle' },
  'create-agent-bundle': { directory: 'create-agent-bundle', npmName: 'create-agent-bundle' },
  runtime: { directory: 'rsc-runtime', npmName: '@agent-bundle/runtime' },
};

/**
 * NODE_PATH-free environment with per-command npm cache and tmp roots under
 * the worker's RSTEST_WORKER_ID directory (see rstest.worker-isolation.ts),
 * so concurrent workers never contend on shared npm or tmp state.
 */
export const installedEnvironment = (): NodeJS.ProcessEnv => isolatedCommandEnvironment();

/**
 * Canonical flags for installing a packed tarball into a consumer fixture.
 * They keep npm's default metadata staleness checks, so the install resolves
 * the tree a consumer would get today. That is the point of the proofs that
 * stand in for a real consumer — release-audit's production entrypoint walk,
 * the scaffolder template matrix, the native host smoke — and exact direct
 * pins do not make it free: transitive ranges still move underneath them, and
 * scripts/audit-packed-release.mjs audits the installed tree without ever
 * exercising it.
 */
export const npmInstallArguments = ['--ignore-scripts', '--no-audit', '--no-fund'] as const;

/**
 * The same flags for suites that only prove the packed tarball resolves,
 * imports, and runs, where the dependency tree is a means rather than the
 * subject. `--prefer-offline` serves cached registry metadata without
 * revalidating it: the tarball under test is always read from disk and
 * uncached dependencies are still fetched, so only the staleness round-trips
 * are skipped.
 */
export const cachedNpmInstallArguments = [...npmInstallArguments, '--prefer-offline'] as const;

const packs = new Map<SharedPackPackage, Promise<SharedPack>>();
let fallbackBuild: Promise<void> | undefined;

const packOnce = async (packageName: SharedPackPackage): Promise<SharedPack> => {
  const sharedDirectory = process.env['AGENT_BUNDLE_SHARED_PACK_DIR'];
  if (sharedDirectory !== undefined && sharedDirectory.length > 0) {
    return JSON.parse(await readFile(join(sharedDirectory, `${packageName}.json`), 'utf8')) as SharedPack;
  }
  // Ad-hoc single-file runs have no run-level tarball, so build once (unless
  // the caller marked the workspace dist prebuilt) and pack into a
  // per-process temporary directory that is dropped on exit. The build
  // promise is process-wide so concurrent callers share one build, and it
  // runs with NODE_ENV=production like the release pipeline the tarball
  // stands in for.
  if (process.env['AGENT_BUNDLE_PACKAGE_PREBUILT'] !== '1') {
    fallbackBuild ??= execFile('pnpm', ['build'], {
      cwd: workspaceRoot,
      env: { ...installedEnvironment(), NODE_ENV: 'production' },
    }).then(() => undefined);
    await fallbackBuild;
  }
  const destination = await mkdtemp(join(tmpdir(), 'agent-bundle-shared-pack-'));
  process.once('exit', () => {
    rmSync(destination, { force: true, recursive: true });
  });
  const { directory, npmName } = sharedPackPackages[packageName];
  const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: join(workspaceRoot, 'packages', directory),
    env: { ...installedEnvironment(), NODE_ENV: 'production' },
  });
  // Select by npm name: a workspace-aware `npm pack --json` can list sibling
  // packages, and the first entry is not necessarily this one.
  const packOutput = packOutputFromJson(stdout, npmName);
  return { packOutput, tarball: join(destination, packOutput.filename) };
};

/**
 * Run-level release tarball for a public package. `test:packed` builds and
 * `npm pack`s each package exactly once per run (scripts/run-packed-tests.mjs)
 * and shares the result through AGENT_BUNDLE_SHARED_PACK_DIR, so every
 * pack-and-install suite consumes the same tarball a release would publish
 * instead of re-packing (and previously rebuilding) per test file.
 */
export const sharedPackedTarball = (packageName: SharedPackPackage): Promise<SharedPack> => {
  const existing = packs.get(packageName);
  if (existing !== undefined) return existing;
  const created = packOnce(packageName);
  packs.set(packageName, created);
  return created;
};
