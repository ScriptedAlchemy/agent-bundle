import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default async ({ fixturePath }: { readonly fixturePath: string }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as {
    readonly evidence?: unknown;
    readonly outcome?: string;
    readonly rollbackOrStopCondition?: string;
  };
  const complete = result.outcome === 'ready'
    && Array.isArray(result.evidence)
    && result.evidence.length >= 2
    && typeof result.rollbackOrStopCondition === 'string'
    && result.rollbackOrStopCondition.length > 0;
  return complete
    ? { detail: 'The operational handoff includes evidence and a rollback or stop condition.', outcome: 'pass' as const }
    : { detail: 'The operational handoff is missing evidence or a rollback or stop condition.', outcome: 'fail' as const };
};
