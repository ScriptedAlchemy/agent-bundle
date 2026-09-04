import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvalGraderFunction } from 'agent-bundle/eval';

interface ReleaseResult {
  readonly blockers?: unknown;
  readonly verdict?: string;
}

const grade: EvalGraderFunction = async ({ fixturePath }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as ReleaseResult;
  return result.verdict === 'ready' && Array.isArray(result.blockers) && result.blockers.length === 0
    ? { detail: 'The release artifact is ready with no blockers.', outcome: 'pass' }
    : { detail: 'The release artifact is not ready or has unresolved blockers.', outcome: 'fail' };
};

export default grade;
