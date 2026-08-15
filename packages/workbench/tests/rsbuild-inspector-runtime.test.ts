import { expect, it } from '@rstest/core';

import { createWorkbenchConfig } from '../rsbuild.config.ts';

it('compiles the Inspector runtime React boundary with a production NODE_ENV', () => {
  const config = createWorkbenchConfig(undefined, 'production');

  expect(config).toMatchObject({
    source: {
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      include: [/node_modules[\\/](?:react|react-dom|scheduler)[\\/]/],
    },
  });
  const define = (config.source as { readonly define: Record<string, unknown> }).define;
  expect(define).not.toHaveProperty('process');
  expect(define).not.toHaveProperty('process.env');
});
