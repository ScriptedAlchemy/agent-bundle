import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from '@rstest/core';

import {
  discoverEvalSuites,
  EvalConfigError,
  EvalDiscoveryError,
  findEvalSuiteFiles,
  normalizeEvalConfig,
} from '../src/eval/index.ts';

const assertionsModule = fileURLToPath(new URL('../src/eval/assertions.ts', import.meta.url));
const suiteModule = fileURLToPath(new URL('../src/eval/suite.ts', import.meta.url));

const suiteSource = (name: string, caseId: string): string => `
import { expectExitCode } from ${JSON.stringify(assertionsModule)};
import { defineEvalSuite } from ${JSON.stringify(suiteModule)};

export default defineEvalSuite({
  cases: [
    {
      assertions: [expectExitCode(0)],
      fixture: './fixtures/repo',
      hosts: { claude: { model: 'claude-sonnet-4-5' } },
      id: ${JSON.stringify(caseId)},
      invocation: { mode: 'automatic' },
      prompt: 'Do the task.',
    },
  ],
  name: ${JSON.stringify(name)},
});
`;

const withProject = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle eval config '));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('normalizes the eval configuration section to conventional defaults', () => {
  const normalized = normalizeEvalConfig(undefined);

  expect(normalized).toEqual({
    diagnostics: [],
    include: ['evals/**/*.eval.ts'],
    runsDir: '.agent-bundle/runs',
  });
  expect(Object.isFrozen(normalized)).toBe(true);
});

it('sorts, deduplicates, and keeps authored include patterns and runs directory', () => {
  const normalized = normalizeEvalConfig({
    include: ['suites/**/*.eval.ts', 'evals/**/*.eval.ts', 'suites/**/*.eval.ts'],
    runsDir: '.agent-bundle/eval-runs',
  });

  expect(normalized.include).toEqual(['evals/**/*.eval.ts', 'suites/**/*.eval.ts']);
  expect(normalized.runsDir).toBe('.agent-bundle/eval-runs');
});

it('normalizes the exact configured Claude semantic grader without a diagnostic', () => {
  const normalized = normalizeEvalConfig({
    semanticGrader: { harness: 'claude', model: 'claude-sonnet-4-5' },
  });

  expect(normalized.diagnostics).toEqual([]);
  expect(normalized.semanticGrader).toEqual({ harness: 'claude', model: 'claude-sonnet-4-5' });
  expect(Object.isFrozen(normalized.semanticGrader)).toBe(true);
});

it('rejects every semantic grader shape other than a pinned Claude model', () => {
  for (const semanticGrader of [
    undefined,
    null,
    {},
    { harness: 'claude' },
    { harness: 'claude', model: '' },
    { harness: 'claude', model: '   ' },
    { harness: 'codex', model: 'gpt-5-codex' },
    { harness: 'claude', model: 'claude-sonnet-4-5', unexpected: true },
  ]) {
    expect(() => normalizeEvalConfig({ semanticGrader })).toThrow(EvalConfigError);
  }
});

it('rejects credential fields, unknown keys, and non-directory eval run roots', () => {
  expect(() => normalizeEvalConfig({ apiKey: 'sk-ant-0123456789abcdefghij' })).toThrow(EvalConfigError);
  expect(() => normalizeEvalConfig({ unknown: true })).toThrow(EvalConfigError);
  expect(() => normalizeEvalConfig({ runsDir: '../elsewhere' })).toThrow(EvalConfigError);
  expect(() => normalizeEvalConfig({ runsDir: '.' })).toThrow(expect.objectContaining({ code: 'EVAL_RUNS_DIR_INVALID' }));
  expect(() => normalizeEvalConfig({ include: [] })).toThrow(EvalConfigError);
});

it('discovers suite files by convention in a stable order', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'evals', 'nested'), { recursive: true });
    await writeFile(join(root, 'evals', 'b.eval.ts'), suiteSource('beta', 'case-b'));
    await writeFile(join(root, 'evals', 'nested', 'a.eval.ts'), suiteSource('alpha', 'case-a'));
    await writeFile(join(root, 'evals', 'ignored.ts'), 'export default 1;\n');

    const files = await findEvalSuiteFiles({ projectRoot: root });

    expect(files).toEqual([
      join(root, 'evals', 'b.eval.ts'),
      join(root, 'evals', 'nested', 'a.eval.ts'),
    ]);
  });
});

it('loads discovered suites and records their source path', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'evals'), { recursive: true });
    await writeFile(join(root, 'evals', 'review.eval.ts'), suiteSource('review-change', 'direct-review'));

    const discovered = await discoverEvalSuites({ projectRoot: root });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourcePath).toBe(join(root, 'evals', 'review.eval.ts'));
    expect(discovered[0]?.suite.name).toBe('review-change');
    expect(discovered[0]?.suite.cases[0]?.id).toBe('direct-review');
    expect(Object.isFrozen(discovered[0])).toBe(true);
  });
});

it('rejects a module whose default export is not an authored suite', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'evals'), { recursive: true });
    await writeFile(join(root, 'evals', 'broken.eval.ts'), 'export default { cases: [], name: "broken" };\n');

    await expect(discoverEvalSuites({ projectRoot: root })).rejects.toThrow(EvalDiscoveryError);
  });
});

it('rejects two discovered suites that claim the same name', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'evals'), { recursive: true });
    await writeFile(join(root, 'evals', 'one.eval.ts'), suiteSource('review-change', 'case-one'));
    await writeFile(join(root, 'evals', 'two.eval.ts'), suiteSource('review-change', 'case-two'));

    await expect(discoverEvalSuites({ projectRoot: root })).rejects.toThrow(/same name/iu);
  });
});
