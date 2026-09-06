import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const main = async (): Promise<number> => {
  const typescript = require('typescript') as { readonly version: string };
  await writeFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'lifecycle-ran.txt'), `${typescript.version}\n`);
  return 0;
};
