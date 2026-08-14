import { defineConfig, globalIgnores, js, ts } from '@rslint/core';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    'packages/workbench/src/inspector/vendor/**',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
]);
