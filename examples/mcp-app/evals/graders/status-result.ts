import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as {
    readonly checks?: readonly { readonly label?: string; readonly status?: string }[];
    readonly service?: string;
    readonly status?: string;
    readonly summary?: string;
  };
  const hasPassingChecks = result.checks?.every((check) => check.status === 'passing') === true;
  return result.service === 'compiler'
    && result.status === 'healthy'
    && result.summary === 'Compiler service is ready for release.'
    && hasPassingChecks
    ? { detail: 'The compiler service is healthy.', outcome: 'pass' as const }
    : { detail: 'The compiler service did not report a healthy status.', outcome: 'fail' as const };
};
