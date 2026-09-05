/**
 * Builds once, packs each public package once, and runs the packed pool
 * against the shared tarballs (tests/support/shared-pack.ts) with the
 * prebuilt seams set instead of every test file rebuilding the workspace for
 * itself. Build and pack run with NODE_ENV=production like the release
 * pipeline they stand in for; every child inherits the ambient environment
 * minus NODE_PATH. `--release` adds the release-boundary-only files (the
 * scaffolder template matrix) to the pool; remaining arguments pass through
 * to rstest.
 */
import { execFile as executeFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { packOutputFromJson } from './npm-pack-json.mjs';

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

// The packed package substitutes a wrapper that imports one extra private
// runtime sibling. The packed deleted-source stdio journey must still start
// after that sibling has crossed both package and artifact bundlers.
const buildExitCode = await run('pnpm', ['build'], {
  AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE: '1',
  NODE_ENV: 'production',
});
if (buildExitCode !== 0) process.exit(buildExitCode);

const packDirectory = await mkdtemp(join(tmpdir(), 'agent-bundle-shared-pack-'));
try {
  // [shared-pack key, packages/ directory, npm package name]; the pack entry
  // is selected by npm name so a workspace-aware `npm pack --json` that lists
  // sibling packages still yields the intended tarball.
  await Promise.all([
    ['agent-bundle', 'agent-bundle', 'agent-bundle'],
    ['create-agent-bundle', 'create-agent-bundle', 'create-agent-bundle'],
    ['markdown-stream', 'rsc-markdown-stream', 'rsc-markdown-stream'],
    ['runtime', 'rsc-runtime', '@agent-bundle/runtime'],
  ].map(async ([packageName, directory, npmName]) => {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: join(repositoryRoot, 'packages', directory),
      env: { ...environment, NODE_ENV: 'production' },
    });
    const packOutput = packOutputFromJson(stdout, npmName);
    await writeFile(
      join(packDirectory, `${packageName}.json`),
      `${JSON.stringify({ packOutput, tarball: join(packDirectory, packOutput.filename) })}\n`,
    );
  }));
  process.exitCode = await run('pnpm', ['exec', 'rstest', '--config', 'rstest.packed.config.ts', ...rstestArguments], {
    AGENT_BUNDLE_PACKAGE_PREBUILT: '1',
    ...(releasePool ? { AGENT_BUNDLE_PACKED_RELEASE: '1' } : {}),
    AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE: '1',
    AGENT_BUNDLE_SHARED_PACK_DIR: packDirectory,
    AGENT_BUNDLE_WORKBENCH_PREBUILT: '1',
  });
} finally {
  await rm(packDirectory, { force: true, recursive: true });
  const restoreExitCode = await run('pnpm', ['--filter', 'agent-bundle', 'build'], {
    AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE: '',
    NODE_ENV: 'production',
  });
  if (restoreExitCode !== 0) process.exitCode = restoreExitCode;
}
