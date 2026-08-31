import { defineConfig } from '@rstest/core';

import { timeScale } from './tests/support/time-scale.ts';

export default defineConfig({
  include: ['tests/**/*.test.{ts,tsx}'],
  pool: { maxWorkers: 1 },
  testEnvironment: 'node',
  // Every suite here runs real rsbuild compiles and spawned children, which a
  // loaded host pushes past the 5s default long before anything is actually
  // wedged. The default scales with the same knob as the polling budgets (see
  // tests/support/time-scale.ts); explicit per-test timeouts still win.
  testTimeout: 30_000 * timeScale,
});
