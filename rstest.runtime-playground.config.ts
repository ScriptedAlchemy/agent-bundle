import { defineConfig } from '@rstest/core';
import { withRslibConfig } from '@rstest/adapter-rslib';

export default defineConfig({
  coverage: {
    enabled: true,
    include: ['packages/workbench/src/runtime-{client,model,playground}.{ts,tsx}'],
    provider: 'v8',
    reporters: ['text', 'json'],
    thresholds: { branches: 85, functions: 90, lines: 90, statements: 90 },
  },
  extends: withRslibConfig(),
  include: [
    'packages/workbench/tests/runtime-client.test.ts',
    'packages/workbench/tests/runtime-contract-compile.test.ts',
    'packages/workbench/tests/runtime-model.test.ts',
  ],
  pool: { maxWorkers: 1 },
  testEnvironment: 'node',
});
