import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

test('typechecks all TSX source and test files', async () => {
  const config = JSON.parse(await readFile(join(process.cwd(), 'tsconfig.json'), 'utf8')) as { include: string[] };

  expect(config.include).toEqual(expect.arrayContaining(['src/**/*.tsx', 'tests/**/*.tsx']));
});
