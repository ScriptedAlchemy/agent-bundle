import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isHealthyCompilerFixture } from '../../src/compiler-status-contract.ts';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as unknown;
  return isHealthyCompilerFixture(result)
    ? { detail: 'The compiler service is healthy.', outcome: 'pass' as const }
    : { detail: 'The compiler service did not report a healthy status.', outcome: 'fail' as const };
};
