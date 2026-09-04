import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvalGraderFunction } from 'agent-bundle/eval';

import { isHealthyCompilerFixture } from '../../src/compiler-status-contract.ts';

const grade: EvalGraderFunction = async ({ fixturePath }) => {
  const result = JSON.parse(await readFile(join(fixturePath, 'result.json'), 'utf8')) as unknown;
  return isHealthyCompilerFixture(result)
    ? { detail: 'The compiler service is healthy.', outcome: 'pass' }
    : { detail: 'The compiler service did not report a healthy status.', outcome: 'fail' };
};

export default grade;
