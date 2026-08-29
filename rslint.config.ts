import { defineConfig, globalIgnores, js, ts } from '@rslint/core';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'packages/workbench/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
]);
