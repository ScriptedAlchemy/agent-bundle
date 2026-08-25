import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as {
    readonly service?: string;
    readonly status?: string;
  };
  return result.service === 'compiler' && result.status === 'healthy'
    ? { detail: 'The compiler service is healthy.', outcome: 'pass' as const }
    : { detail: 'The compiler service did not report a healthy status.', outcome: 'fail' as const };
};
