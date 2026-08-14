import { defineConfig, globalIgnores, js, ts } from '@rslint/core';

export default defineConfig([
  globalIgnores(['**/dist/**']),
  js.configs.recommended,
  ts.configs.recommended,
]);
