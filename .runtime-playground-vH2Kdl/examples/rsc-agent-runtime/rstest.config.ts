import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/**/*.test.{ts,tsx}'],
  pool: { maxWorkers: 1 },
  testEnvironment: 'node',
});
