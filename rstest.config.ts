import { defineConfig } from '@rstest/core';
import { withRslibConfig } from '@rstest/adapter-rslib';

export default defineConfig({
  extends: withRslibConfig(),
  globalSetup: ['./tests/global-setup.ts'],
  include: ['packages/**/tests/**/*.test.ts'],
  testEnvironment: 'node',
});
