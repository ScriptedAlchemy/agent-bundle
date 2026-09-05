import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

import { checkDistFreshness, runtimeExampleBuildOutputs } from '../../../../scripts/dist-freshness.mjs';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

/** The example's prebuilt payload directories its declared artifacts package. */
export const runtimeExamplePayloads = ['app', 'runtime'] as const;

/**
 * The rsc-agent-runtime example declares its Rsbuild output trees as prebuilt
 * payloads, so the workbench dev artifact epoch needs them to exist. Build
 * them when absent or stale (Rsbuild only — the framework packaging step is
 * what the fixtures exercise live). Presence alone is not enough: the
 * payload bundles `packages/rsc-runtime/dist`, so a `pnpm build` that
 * rewrote the runtime, or an edit under the example's `src`, leaves a tree
 * that exists and tests old code (#576). The short-circuit therefore
 * requires every payload tree to be newer than every build input
 * (scripts/dist-freshness.mjs lists them).
 *
 * This must not run concurrently with itself: two racing builds write the
 * same `examples/rsc-agent-runtime/dist` tree, and a fixture copying that
 * tree mid-build ships a torn payload. The integration pool therefore runs it
 * once in the orchestrator via `globalSetup` (rstest.integration.setup.ts)
 * before any worker starts; the per-fixture call in
 * runtime-playground-fixture.ts is then a warm no-op and only builds when a
 * file is run through a single-worker config with a cold or stale tree.
 */
export const ensureRuntimeExamplePayload = async (): Promise<void> => {
  const payloads = checkDistFreshness(runtimeExampleBuildOutputs(workspaceRoot, runtimeExamplePayloads));
  if (payloads.every((payload) => payload.status === 'fresh')) return;
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('pnpm', ['--filter', '@agent-bundle/rsc-agent-runtime-demo', 'exec', 'rsbuild', 'build', '--mode', 'production'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
    maxBuffer: 64 * 1024 * 1024,
  });
};
