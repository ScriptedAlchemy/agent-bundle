/**
 * Fixed test budgets are tuned on many-core development machines, while CI
 * runners have two cores and share them between Chrome, dev servers, child
 * processes, and rsbuild compiles inside a single test. Scaling the budgets
 * costs nothing on green runs - polling assertions return on success - and
 * the workflow-level timeout-minutes still bounds real hangs.
 *
 * AGENT_BUNDLE_TEST_TIME_SCALE covers the same contention on development
 * machines, where concurrent Chrome + dev-server + rsbuild pairs share cores.
 * rstest.integration.config.ts sets it locally from core count without pinning
 * workers. CI always uses 4, independent of pool size.
 */
const localScale = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
export const timeScale = process.env['CI'] !== undefined
  ? 4
  : Number.isSafeInteger(localScale) && localScale >= 1 ? localScale : 1;
