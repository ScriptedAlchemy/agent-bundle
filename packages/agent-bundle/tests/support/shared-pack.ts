import { execFile as executeFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isolatedCommandEnvironment } from '../../../../rstest.worker-isolation.ts';
import { pnpmPack, type PnpmPackOutput as SharedPackOutput } from '../../../../scripts/pnpm-pack.mjs';
import { packOutputFromJson } from '../../src/build/pack-inventory.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

export { packOutputFromJson };
export type { SharedPackOutput };

export interface SharedPack {
  /** The package's own `pnpm pack --json` entry recorded when the tarball was produced. */
  readonly packOutput: SharedPackOutput;
  readonly tarball: string;
  readonly variant?: 'runtime-rebundle';
}

export type SharedPackPackage =
  | 'agent-bundle'
  | 'agent-bundle-runtime-rebundle'
  | 'create-agent-bundle'
  | 'markdown-stream'
  | 'runtime';

/** packages/ directory for each shared-pack key. */
const sharedPackDirectories: Readonly<Record<SharedPackPackage, string>> = {
  'agent-bundle': 'agent-bundle',
  'agent-bundle-runtime-rebundle': 'agent-bundle',
  'create-agent-bundle': 'create-agent-bundle',
  // `@agent-bundle/runtime` declares it `workspace:^`, which the packer ships
  // as the caret of the workspace version; a consumer that installs the
  // runtime tarball needs this one alongside until that version is on the
  // registry (npm dedupes the runtime's edge onto it).
  'markdown-stream': 'rsc-markdown-stream',
  runtime: 'rsc-runtime',
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
 * stand in for a real consumer — the scaffolder template matrix, the native
 * host smoke — and exact direct pins do not make it free: transitive ranges
 * still move underneath them.
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

/**
 * Link the workspace's `typescript` and ambient `@types/*` packages into a
 * consumer fixture so declaration generation resolves them from the consumer
 * project, exactly like a real devDependency install. Entries the packed
 * install already brought (an `agent-bundle` install carries `@types/ws` and
 * `@types/node` through `@effect/platform-node`) are left as installed;
 * `EEXIST` on any of them is not a fixture failure.
 */
export const linkWorkspaceTypes = async (
  consumerRoot: string,
  options: Readonly<{ readonly typescript?: boolean }> = {},
): Promise<void> => {
  const source = join(workspaceRoot, 'node_modules');
  const target = join(consumerRoot, 'node_modules');
  await mkdir(join(target, '@types'), { recursive: true });
  const link = async (relativePath: string): Promise<void> => {
    try {
      await symlink(join(source, relativePath), join(target, relativePath), 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  };
  const types = await readdir(join(source, '@types'));
  await Promise.all([
    ...(options.typescript === true ? [link('typescript')] : []),
    ...types.map((name) => link(join('@types', name))),
  ]);
};

const packs = new Map<SharedPackPackage, Promise<SharedPack>>();
let fallbackBuild: Promise<void> | undefined;

const packOnce = async (packageName: SharedPackPackage): Promise<SharedPack> => {
  const sharedDirectory = process.env['AGENT_BUNDLE_SHARED_PACK_DIR'];
  if (sharedDirectory !== undefined && sharedDirectory.length > 0) {
    return JSON.parse(await readFile(join(sharedDirectory, `${packageName}.json`), 'utf8')) as SharedPack;
  }
  if (packageName === 'agent-bundle-runtime-rebundle') {
    throw new Error('The runtime re-bundle fixture is prepared by `pnpm test:packed`; run the packed pool through that script.');
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
  return pnpmPack({
    cwd: join(workspaceRoot, 'packages', sharedPackDirectories[packageName]),
    destination,
    env: { ...installedEnvironment(), NODE_ENV: 'production' },
  });
};

/**
 * Run-level release tarball for a public package. `test:packed` builds and
 * `pnpm pack`s each package exactly once per run (scripts/run-packed-tests.mjs;
 * pnpm's packer rather than npm's because `pnpm publish` is what ships, and
 * it rewrites `workspace:` ranges — scripts/pnpm-pack.mjs) and shares the
 * result through AGENT_BUNDLE_SHARED_PACK_DIR, so every pack-and-install
 * suite consumes the same tarball a release would publish instead of
 * re-packing (and previously rebuilding) per test file.
 */
export const sharedPackedTarball = (packageName: SharedPackPackage): Promise<SharedPack> => {
  const existing = packs.get(packageName);
  if (existing !== undefined) return existing;
  const created = packOnce(packageName);
  packs.set(packageName, created);
  return created;
};
