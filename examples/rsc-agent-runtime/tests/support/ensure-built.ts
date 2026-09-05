import { execFile as executeFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);

const exampleRoot = process.cwd();

/** One probe per build output the dist-consuming tests spawn or read. */
const requiredArtifacts = [
  'dist/app/standalone.html',
  'dist/plugins/.claude-plugin/plugin.json',
  'dist/plugins/.codex-plugin/plugin.json',
  'dist/runtime/runtime-assets.json',
] as const;

let exampleBuild: Promise<void> | undefined;

/**
 * The demo's `test` script assumes `pnpm build` already produced `dist/`
 * (the `check` script runs the build first), but nothing enforces that. On a
 * fresh checkout a bare `pnpm test` fails in every dist-consuming file until
 * host-artifacts happens to run its full production build mid-suite, so the
 * suite's outcome depends on file ordering and leftover state. Build once
 * when any required artifact is missing to make `pnpm test` deterministic.
 */
export const ensureExampleBuilt = (): Promise<void> => exampleBuild ??= (async (): Promise<void> => {
  const probes = await Promise.allSettled(requiredArtifacts.map(async (artifact) => access(join(exampleRoot, artifact))));
  if (probes.every((probe) => probe.status === 'fulfilled')) return;
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build'], {
    cwd: exampleRoot,
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
})();
