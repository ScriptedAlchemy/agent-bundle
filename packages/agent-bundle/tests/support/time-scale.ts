/**
 * Fixed test budgets are tuned on many-core development machines, while CI
 * runners have two cores and share them between Chrome, dev servers, child
 * processes, and rsbuild compiles inside a single test. Scaling the budgets
 * costs nothing on green runs - polling assertions return on success - and
 * the workflow-level timeout-minutes still bounds real hangs.
 */
export const timeScale = process.env['CI'] === undefined ? 1 : 4;
