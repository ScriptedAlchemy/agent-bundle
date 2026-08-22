import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from '@rstest/core';

import { runCli } from '../src/cli.ts';
import type { EvalRunResult } from '../src/dev/eval/eval-service.ts';

const fixtureRoot = join(process.cwd(), 'fixtures', 'integration', 'micro-eval');
const evalEntryPoint = resolve(process.cwd(), 'packages/agent-bundle/src/eval/index.ts');

const runCliWithOutput = async (args: readonly string[]): Promise<{
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}> => {
  const stderr: string[] = [];
  const stdout: string[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runCli([...args], {
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    stdout: { write: (chunk: string) => stdout.push(chunk) },
  });
  return { code, stderr: stderr.join(''), stdout: stdout.join('') };
};

// A suite module must default-export defineEvalSuite output, so it imports agent-bundle/eval.
// That import only typechecks against a built package, so the suite file and the package shim
// are written into the temporary fixture copy instead of being checked in with the fixture.
const suiteModule = `import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [
    {
      assertions: [expectOutcome({ script: './graders/reads-result.ts' })],
      fixture: './fixtures/repo',
      hosts: { portable: { model: 'deterministic' } },
      id: 'reads-result',
      invocation: { mode: 'automatic' },
      prompt: 'Report the highest-risk regression recorded in this repository.',
    },
  ],
  name: 'micro',
});
`;

/**
 * The CI end-to-end spot-check: the checked-in micro fixture must build, its artifact must
 * validate, and one deterministic eval trial must pass through the real CLI — with no native
 * Claude/Codex host and no opt-in environment gate.
 */
it('spot-checks build, validate, and one deterministic eval on the micro fixture', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-micro-eval-'));
  const root = join(parent, 'micro-eval');
  const artifact = join(root, 'artifact');
  await cp(fixtureRoot, root, { recursive: true });
  await mkdir(join(root, 'node_modules', 'agent-bundle'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'node_modules', 'agent-bundle', 'package.json'),
      JSON.stringify({ exports: { './eval': './eval.ts' }, name: 'agent-bundle', type: 'module' }),
    ),
    writeFile(join(root, 'node_modules', 'agent-bundle', 'eval.ts'), `export * from ${JSON.stringify(evalEntryPoint)};\n`),
    writeFile(join(root, 'evals', 'micro.eval.ts'), suiteModule),
  ]);

  try {
    const build = await runCliWithOutput(['build', '--root', root, '--output', 'artifact']);
    expect(build.stderr).toBe('');
    expect(build.code).toBe(0);
    await expect(readFile(join(artifact, 'portable', 'skills', 'triage', 'SKILL.md'), 'utf8')).resolves.toContain(
      'name: triage',
    );

    const validated = await runCliWithOutput(['validate', '--root', root, '--artifact', artifact, '--json']);
    expect(validated.stderr).toBe('');
    expect(validated.code).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ diagnostics: [] });

    const evaluated = await runCliWithOutput([
      'eval', '--root', root, '--artifact', artifact, '--case', 'reads-result', '--trials', '1', '--json',
    ]);
    expect(evaluated.stderr).toBe('');
    expect(evaluated.code).toBe(0);
    const parsed = JSON.parse(evaluated.stdout) as EvalRunResult;
    expect(parsed.run.harness).toBe('deterministic');
    expect(parsed.run.artifact.source).toBe('explicit');
    expect(parsed.run.summary).toMatchObject({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });
    expect(parsed.trials).toHaveLength(1);
    expect(parsed.trials[0]).toMatchObject({ caseId: 'reads-result', host: 'portable', outcome: 'pass' });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 120_000);
