import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as { readonly risk?: string };
  return result.risk === 'high'
    ? { detail: 'The deterministic packed fixture passed.', outcome: 'pass' as const }
    : { detail: 'The deterministic packed fixture failed.', outcome: 'fail' as const };
};
