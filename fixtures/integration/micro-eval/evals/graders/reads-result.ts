import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { fixturePath: string }) => {
  const parsed = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as { risk?: string };
  return parsed.risk === 'high'
    ? { detail: 'The fixture recorded risk high.', outcome: 'pass' }
    : { detail: 'The fixture did not record risk high.', outcome: 'fail' };
};
