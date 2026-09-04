import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvalGraderFunction } from 'agent-bundle/eval';

interface OperationsResult {
  readonly evidence?: unknown;
  readonly outcome?: string;
  readonly rollbackOrStopCondition?: string;
}

const grade: EvalGraderFunction = async ({ fixturePath }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as OperationsResult;
  const complete = result.outcome === 'ready'
    && Array.isArray(result.evidence)
    && result.evidence.length >= 2
    && typeof result.rollbackOrStopCondition === 'string'
    && result.rollbackOrStopCondition.length > 0;
  return complete
    ? { detail: 'The operational handoff includes evidence and a rollback or stop condition.', outcome: 'pass' }
    : { detail: 'The operational handoff is missing evidence or a rollback or stop condition.', outcome: 'fail' };
};

export default grade;
