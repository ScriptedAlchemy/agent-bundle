import { defineConfig, globalIgnores, js, ts } from '@rslint/core';

import { effectBoundaryPlugin } from './scripts/eslint-plugin-effect-boundary.ts';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    'repos/**',
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
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['**/src/effect/boundary.ts'],
    plugins: { 'effect-boundary': effectBoundaryPlugin },
    rules: {
      'effect-boundary/no-ad-hoc-run': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/repos/**', 'repos/**', '**/repos/effect/**'],
          message: 'Never import from repos/**. Application code imports the npm effect package.',
        }],
      }],
    },
  },
]);
