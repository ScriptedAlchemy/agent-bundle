/**
 * Node prints a one-time `ExperimentalWarning: SQLite is an experimental
 * feature` to stderr when the framework state kernel's `node:sqlite` driver
 * loads (#98, documented in this example's README limits section). Tests
 * tolerate exactly that documented warning; every other stderr byte stays
 * load-bearing.
 */
export const withoutNodeSqliteWarning = (stderr: string): string =>
  stderr
    .split('\n')
    .filter(
      (line) =>
        !line.includes('ExperimentalWarning: SQLite is an experimental feature') &&
        !line.includes('Use `node --trace-warnings ...` to show where the warning was created'),
    )
    .join('\n');
