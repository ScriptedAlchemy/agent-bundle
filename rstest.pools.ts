import { availableParallelism } from 'node:os';

/**
 * Pool-level policy shared by every workspace Rstest configuration: the
 * orchestrator hooks each pool runs, the per-worker setup file, and the
 * timeout floors. Per-test restoration lives in `rstestHygiene`
 * (rstest.rslib.ts) because the adapter-based pools inherit it through
 * `extends`; the values here are the ones every pool spells out itself.
 */

/**
 * Orchestrator hooks every pool runs, in order: refuse a stale `dist` before
 * anything else happens (rstest.dist-freshness.setup.ts), then tag this
 * invocation so its teardown can remove exactly the worker roots it created
 * (rstest.global-setup.ts). Both run once, in Rstest's global-setup process,
 * before any worker starts; the run id reaches the workers through Rstest's
 * env relay (see rstest.global-setup.ts).
 */
export const workspaceGlobalSetup: readonly string[] = [
  './rstest.dist-freshness.setup.ts',
  './rstest.global-setup.ts',
];

/**
 * The hooks above plus the shared rsc-agent-runtime example payload build
 * (rstest.integration.setup.ts), for pools whose fixtures copy
 * `examples/rsc-agent-runtime/dist`.
 */
export const examplePayloadGlobalSetup: readonly string[] = [
  ...workspaceGlobalSetup,
  './rstest.integration.setup.ts',
];

/** Per-worker TMPDIR / XDG isolation; must precede any test module. */
export const workspaceSetupFiles: readonly string[] = ['./rstest.setup.ts'];

/**
 * A pool's timeout floors. `hookTimeout` matches `testTimeout` so a
 * `beforeAll` that prepares what a test is allowed to spend `testTimeout` on
 * does not die at Rstest's 10 s hook default first. Explicit per-test
 * timeouts still win.
 */
export const poolTimeouts = (testTimeout: number): Readonly<{ hookTimeout: number; testTimeout: number }> =>
  ({ hookTimeout: testTimeout, testTimeout });

/**
 * Worker count for pools whose files each drive a Chrome + dev-server +
 * rsbuild pair, CI and local alike: half the cores (hosted runners report 4,
 * so CI runs 2 workers), clamped to at least 1 and at most 4. Rstest's own
 * auto-sizing would run cores - 1 (3 on hosted runners); halving keeps the
 * pairs from starving each other, the cap bounds memory on large machines,
 * and the 2-worker shape is the one the burn-in evidence covers.
 * AGENT_BUNDLE_INTEGRATION_MAX_WORKERS overrides the computed value (e.g. to
 * bisect locally in serial).
 *
 * History: CI briefly pinned 1 worker because early 2-worker matrix runs
 * flaked on a rotating test per leg. The causes were since fixed at the
 * source rather than by keeping the serial shape: contention-sensitive tests
 * now sequence readiness instead of racing fixed timers (e.g. the
 * script-playground descendant-drain suites), shared cold artifacts are
 * built once in the orchestrator (`examplePayloadGlobalSetup`), watched-file
 * and pid publications use staged renames, dev ports are ephemeral, and
 * polling budgets follow AGENT_BUNDLE_TEST_TIME_SCALE. Burn-ins of the
 * 2-worker, 4-core CI shape back the unpin; if a new contention flake
 * appears, fix its race — do not re-pin.
 */
export const processPoolMaxWorkers = (): number => {
  const override = Number(process.env['AGENT_BUNDLE_INTEGRATION_MAX_WORKERS'] ?? '');
  return Number.isSafeInteger(override) && override >= 1
    ? override
    : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
};

/**
 * Polling budgets scale with contention. A multi-worker pool needs at least
 * 2 (see the env comment in rstest.integration.config.ts); an externally set
 * AGENT_BUNDLE_TEST_TIME_SCALE raises it further when the machine is shared —
 * scripts/local-ci.mjs passes 4 (hosted CI's own scale) because it runs
 * three Node legs plus the release gates concurrently. The external value
 * never lowers the scale below what the pool shape requires.
 */
export const processPoolTimeScale = (maxWorkers: number): number => {
  const external = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
  const fromShape = maxWorkers > 1 ? 2 : 1;
  return Number.isSafeInteger(external) && external >= 1 ? Math.max(external, fromShape) : fromShape;
};
