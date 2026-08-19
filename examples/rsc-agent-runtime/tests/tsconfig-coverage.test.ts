import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

test('typechecks all TypeScript source and test files, including development materializers', async () => {
  const config = JSON.parse(await readFile(join(process.cwd(), 'tsconfig.json'), 'utf8')) as { include: string[] };

  expect(config.include).toEqual(expect.arrayContaining([
    'src/**/*.ts',
    'src/**/*.tsx',
    'tests/**/*.ts',
    'tests/**/*.tsx',
  ]));
});
