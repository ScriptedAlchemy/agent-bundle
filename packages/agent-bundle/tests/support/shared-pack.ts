import { execFile as executeFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

export interface SharedPackOutput {
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

export interface SharedPack {
  /** First `npm pack --json` entry recorded when the tarball was produced. */
  readonly packOutput: SharedPackOutput;
  readonly tarball: string;
}

export type SharedPackPackage = 'agent-bundle' | 'create-agent-bundle';

export const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

/**
 * Canonical flags for installing a packed tarball into a consumer fixture.
 * `--prefer-offline` serves cached registry metadata without revalidating it:
 * the tarball under test is always read from disk, and uncached dependencies
 * are still fetched, so only the staleness round-trips are skipped. The
 * release audit (scripts/audit-packed-release.mjs) deliberately does not use
 * these flags — its install feeds `npm audit`/`npm audit signatures`, which
 * must resolve against live registry metadata.
 */
export const npmInstallArguments = ['--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'] as const;

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
  const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: join(workspaceRoot, 'packages', packageName),
    env: { ...installedEnvironment(), NODE_ENV: 'production' },
  });
  const [packOutput] = JSON.parse(stdout) as [SharedPackOutput];
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
