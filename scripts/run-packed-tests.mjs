/**
 * Builds once, packs each public package once with `pnpm pack` (the packer
 * `changeset publish` ships through, scripts/pnpm-pack.mjs), and runs the
 * packed pool against the shared tarballs (tests/support/shared-pack.ts)
 * with the prebuilt seams set instead of every test file rebuilding the
 * workspace for itself. Build and pack run with NODE_ENV=production like the
 * release pipeline they stand in for; every child inherits the ambient
 * environment minus NODE_PATH. `--release` adds the release-boundary-only
 * files (the scaffolder template matrix) to the pool; remaining arguments
 * pass through to rstest.
 */
import { execFile as executeFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { pnpmPack } from './pnpm-pack.mjs';
import { digestTree } from './tree-snapshot.mjs';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { NODE_PATH: _nodePath, ...environment } = process.env;
const releasePool = process.argv.includes('--release');
const rstestArguments = process.argv.slice(2).filter((argument) => argument !== '--release');

const run = (command, args, extraEnvironment = {}) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...environment, ...extraEnvironment },
    stdio: 'inherit',
  });
  child.once('error', rejectPromise);
  child.once('exit', (code, signal) => {
    resolvePromise(signal === null ? (code ?? 1) : 1);
  });
});

const buildExitCode = await run('pnpm', ['build'], { NODE_ENV: 'production' });
if (buildExitCode !== 0) process.exit(buildExitCode);
const publishableDist = join(repositoryRoot, 'packages', 'agent-bundle', 'dist');
const publishableDistBeforePackedTests = await digestTree(publishableDist);

const packDirectory = await mkdtemp(join(tmpdir(), 'agent-bundle-shared-pack-'));
try {
  const sharedPacks = new Map();
  // [shared-pack key, packages/ directory]
  await Promise.all([
    ['agent-bundle', 'agent-bundle'],
    ['create-agent-bundle', 'create-agent-bundle'],
    ['markdown-stream', 'rsc-markdown-stream'],
    ['runtime', 'rsc-runtime'],
  ].map(async ([packageName, directory]) => {
    const pack = await pnpmPack({
      cwd: join(repositoryRoot, 'packages', directory),
      destination: packDirectory,
      env: { ...environment, NODE_ENV: 'production' },
    });
    sharedPacks.set(packageName, pack);
    await writeFile(join(packDirectory, `${packageName}.json`), `${JSON.stringify(pack)}\n`);
  }));
  const binConsumer = join(packDirectory, 'bin-consumer');
  await mkdir(binConsumer);
  await writeFile(join(binConsumer, 'package.json'), '{"private":true}\n');
  const binPackages = ['agent-bundle', 'create-agent-bundle'];
  await execFile('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
    ...binPackages.map((name) => sharedPacks.get(name).tarball),
  ], { cwd: binConsumer, env: environment });
  for (const packageName of binPackages) {
    const packageDocument = JSON.parse(await readFile(join(binConsumer, 'node_modules', packageName, 'package.json'), 'utf8'));
    const bins = typeof packageDocument.bin === 'string'
      ? [[packageDocument.name.replace(/^@[^/]+\//u, ''), packageDocument.bin]]
      : Object.entries(packageDocument.bin ?? {});
    for (const [name] of bins) {
      const executable = join(binConsumer, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
      await execFile(executable, ['--help'], { cwd: binConsumer, env: environment });
    }
  }
  // Build the synthetic private sibling into a separate package image. The
  // normal dist and shared release tarball above remain the publish candidate.
  const fixtureDist = join(packDirectory, 'runtime-rebundle-dist');
  await execFile(join(repositoryRoot, 'node_modules', '.bin', 'rslib'), [
    'build',
    '--config',
    join(repositoryRoot, 'packages', 'agent-bundle', 'rslib.config.ts'),
    '--dist-path',
    fixtureDist,
  ], {
    cwd: repositoryRoot,
    env: {
      ...environment,
      AGENT_BUNDLE_RSLIB_CACHE_DIRECTORY: join(packDirectory, 'runtime-rebundle-cache'),
      AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE: '1',
      NODE_ENV: 'production',
    },
  });
  const fixturePackage = join(packDirectory, 'runtime-rebundle-package');
  await mkdir(fixturePackage);
  const agentBundlePackageRoot = join(repositoryRoot, 'packages', 'agent-bundle');
  const agentBundleManifest = JSON.parse(await readFile(join(agentBundlePackageRoot, 'package.json'), 'utf8'));
  await Promise.all(['package.json', ...agentBundleManifest.files.filter((name) => name !== 'dist')].map((name) => cp(
    join(agentBundlePackageRoot, name),
    join(fixturePackage, name),
    { recursive: true },
  )));
  await cp(fixtureDist, join(fixturePackage, 'dist'), { recursive: true });
  const fixturePackDirectory = join(packDirectory, 'runtime-rebundle-pack');
  await mkdir(fixturePackDirectory);
  const fixturePack = await pnpmPack({
    cwd: fixturePackage,
    destination: fixturePackDirectory,
    env: { ...environment, NODE_ENV: 'production' },
  });
  await writeFile(
    join(packDirectory, 'agent-bundle-runtime-rebundle.json'),
    `${JSON.stringify({ ...fixturePack, variant: 'runtime-rebundle' })}\n`,
  );
  process.exitCode = await run('pnpm', ['exec', 'rstest', '--config', 'rstest.packed.config.ts', ...rstestArguments], {
    AGENT_BUNDLE_PACKAGE_PREBUILT: '1',
    ...(releasePool ? { AGENT_BUNDLE_PACKED_RELEASE: '1' } : {}),
    AGENT_BUNDLE_SHARED_PACK_DIR: packDirectory,
    AGENT_BUNDLE_WORKBENCH_PREBUILT: '1',
  });
} finally {
  try {
    const publishableDistAfterPackedTests = await digestTree(publishableDist);
    if (publishableDistAfterPackedTests !== publishableDistBeforePackedTests) {
      console.error(
        'test:packed changed packages/agent-bundle/dist; packed fixtures must use isolated output and tarball directories.',
      );
      process.exitCode = 1;
    }
  } finally {
    await rm(packDirectory, { force: true, recursive: true });
  }
}
