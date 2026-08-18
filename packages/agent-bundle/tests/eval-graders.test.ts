import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { evalScriptGraderSpec, runEvalGraders } from '../src/eval/graders.ts';

it('replaces a thrown grader fixture path with stable inconclusive evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-eval-grader-'));
  const fixturePath = join(root, 'fixture');
  const suiteDir = join(root, 'suite');
  try {
    await Promise.all([mkdir(fixturePath), mkdir(suiteDir)]);
    await writeFile(join(suiteDir, 'throwing.ts'), [
      'export default async ({ fixturePath }) => {',
      '  throw new Error(fixturePath);',
      '};',
      '',
    ].join('\n'));

    const result = await runEvalGraders([
      evalScriptGraderSpec('./throwing.ts', suiteDir),
    ], {
      artifactRoot: join(root, 'artifact'),
      fixturePath,
      prompt: 'Review the fixture.',
    });

    expect(result.failures).toEqual([{
      id: './throwing.ts',
      message: 'The grader could not complete.',
    }]);
    expect(result.results).toEqual({
      './throwing.ts': { detail: 'The grader could not complete.', outcome: 'inconclusive' },
    });
    expect(JSON.stringify(result)).not.toContain(fixturePath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
