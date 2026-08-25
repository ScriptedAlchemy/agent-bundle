import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as {
    readonly blockers?: unknown;
    readonly verdict?: string;
  };
  return result.verdict === 'ready' && Array.isArray(result.blockers) && result.blockers.length === 0
    ? { detail: 'The release artifact is ready with no blockers.', outcome: 'pass' as const }
    : { detail: 'The release artifact is not ready or has unresolved blockers.', outcome: 'fail' as const };
};
