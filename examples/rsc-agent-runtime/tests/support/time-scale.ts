/**
 * Fixed test budgets are tuned on many-core development machines, while CI
 * runners have two cores and share them between Chrome, dev servers, child
 * processes, and rsbuild compiles inside a single test. Scaling the budgets
 * costs nothing on green runs - polling assertions return on success - and
 * the workflow-level timeout-minutes still bounds real hangs.
 *
 * This example is user-facing and must run independently of the repository
 * layout, so it keeps its own copy of the helper instead of importing
 * another package's private test sources.
 */
const localScale = Number(process.env['AGENT_BUNDLE_TEST_TIME_SCALE'] ?? '');
export const timeScale = process.env['CI'] !== undefined
  ? 4
  : Number.isSafeInteger(localScale) && localScale >= 1 ? localScale : 1;
