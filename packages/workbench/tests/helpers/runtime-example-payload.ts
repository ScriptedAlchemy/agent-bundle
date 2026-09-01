import { execFile as executeFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const runtimeExample = join(workspaceRoot, 'examples', 'rsc-agent-runtime');

/** The example's prebuilt payload directories its declared artifacts package. */
export const runtimeExamplePayloads = ['app', 'runtime'] as const;

/**
 * The rsc-agent-runtime example declares its Rsbuild output trees as prebuilt
 * payloads, so the workbench dev artifact epoch needs them to exist. Build
 * them once when absent (Rsbuild only — the framework packaging step is what
 * the fixtures exercise live).
 *
 * This must not run concurrently with itself: two racing builds write the
 * same `examples/rsc-agent-runtime/dist` tree, and a fixture copying that
 * tree mid-build ships a torn payload. The integration pool therefore runs it
 * once in the orchestrator via `globalSetup` (rstest.integration.setup.ts)
 * before any worker starts; the per-fixture call in
 * runtime-playground-fixture.ts is then a warm no-op and only builds when a
 * file is run through a single-worker config with a cold tree.
 */
export const ensureRuntimeExamplePayload = async (): Promise<void> => {
  const probes = await Promise.allSettled(runtimeExamplePayloads.map(async (payload) =>
    access(join(runtimeExample, 'dist', payload))));
  if (probes.every((probe) => probe.status === 'fulfilled')) return;
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('pnpm', ['--filter', '@agent-bundle/rsc-agent-runtime-demo', 'exec', 'rsbuild', 'build', '--mode', 'production'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
    maxBuffer: 64 * 1024 * 1024,
  });
};
