import { execFile as executeFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { NODE_PATH: _nodePath, ...environment } = process.env;

/**
 * Packs each public package once and runs the packed pool against the shared
 * tarballs (tests/support/shared-pack.ts). The caller (`test:packed`) builds
 * first, so the pool also runs with the prebuilt seams set instead of every
 * test file rebuilding the workspace for itself.
 */
const packDirectory = await mkdtemp(join(tmpdir(), 'agent-bundle-shared-pack-'));
try {
  for (const packageName of ['agent-bundle', 'create-agent-bundle']) {
    const { stdout } = await execFile('npm', ['pack', '--json', '--pack-destination', packDirectory], {
      cwd: join(repositoryRoot, 'packages', packageName),
      env: environment,
    });
    const [packOutput] = JSON.parse(stdout);
    await writeFile(
      join(packDirectory, `${packageName}.json`),
      `${JSON.stringify({ packOutput, tarball: join(packDirectory, packOutput.filename) })}\n`,
    );
  }
  process.exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('pnpm', ['exec', 'rstest', '--config', 'rstest.packed.config.ts', ...process.argv.slice(2)], {
      cwd: repositoryRoot,
      env: {
        ...environment,
        AGENT_BUNDLE_PACKAGE_PREBUILT: '1',
        AGENT_BUNDLE_SHARED_PACK_DIR: packDirectory,
        AGENT_BUNDLE_WORKBENCH_PREBUILT: '1',
      },
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      resolvePromise(signal === null ? (code ?? 1) : 1);
    });
  });
} finally {
  await rm(packDirectory, { force: true, recursive: true });
}
