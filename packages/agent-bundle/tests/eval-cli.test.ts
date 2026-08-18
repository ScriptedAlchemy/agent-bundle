import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, compareEvals, runEvals } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { createEvalRun, type EvalTrialRecordInput } from '../src/eval/index.ts';
import type { EvalRunResult } from '../src/dev/eval-service.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject } from './support/eval-project.ts';

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

interface PersistComparisonRunOptions {
  readonly caseDigest?: string;
  readonly outcomes?: readonly EvalTrialRecordInput['outcome'][];
}

const persistComparisonRun = async (
  projectRoot: string,
  runId: string,
  options: PersistComparisonRunOptions = {},
): Promise<string> => {
  const writer = await createEvalRun({
    artifact: {
      manifestPath: 'artifacts/target/agent-bundle.manifest.json',
      source: 'run-owned',
      targetDigests: { portable: 'a'.repeat(64) },
    },
    projectRoot,
    provenance: {
      agentBundleVersion: '0.1.0',
      harness: 'deterministic',
      projectRevision: 'b'.repeat(64),
    },
    runId,
  });
  const evidence = {
    mcp: { calls: [], level: 'unavailable' as const },
    process: { exitCode: 0, level: 'observed' as const, timedOut: false },
    scripts: { level: 'unavailable' as const, results: {} },
    skillActivation: { activated: [], level: 'unavailable' as const },
  };
  const outcomes = options.outcomes ?? ['pass', 'pass', 'pass'];
  try {
    for (const [index, outcome] of outcomes.entries()) {
      await writer.writeTrial({
        assertions: [],
        caseDigest: options.caseDigest ?? 'c'.repeat(64),
        caseId: 'reads-result',
        completedAt: '2026-08-17T12:00:01.000Z',
        durationMs: 1000,
        evidence,
        fixtureDigest: 'd'.repeat(64),
        host: 'portable',
        id: `portable-${index + 1}`,
        model: 'deterministic',
        outcome,
        prompt: 'Read the result.',
        rawArtifacts: [],
        startedAt: '2026-08-17T12:00:00.000Z',
        targetDigest: 'a'.repeat(64),
        trialIndex: index,
      } satisfies EvalTrialRecordInput);
    }
    await writer.finish({
      cases: 1,
      fail: outcomes.filter((outcome) => outcome === 'fail').length,
      inconclusive: outcomes.filter((outcome) => outcome === 'inconclusive').length,
      pass: outcomes.filter((outcome) => outcome === 'pass').length,
      trials: outcomes.length,
    });
    return writer.record.id;
  } finally {
    await writer.close();
  }
};

it('runs a selected case through the same service the workbench uses', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runEvals({ caseIds: ['reads-result'], root: project.root, trials: 2 });

    expect(result.trials).toHaveLength(2);
    expect(result.run.harness).toBe('deterministic');
    expect(result.run.summary).toMatchObject({ pass: 2, trials: 2 });
    expect(result.diagnostics).toEqual([]);
    await expect(access(join(project.root, '.agent-bundle', 'runs', result.run.id, 'run.json'))).resolves.toBeUndefined();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('evaluates exactly the artifact the caller named instead of building a new one', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const artifact = join(project.root, 'prebuilt');
    await build({ output: artifact, root: project.root });

    const result = await runEvals({ artifact, caseIds: ['reads-result'], root: project.root });

    expect(result.run.artifact.source).toBe('explicit');
    expect(result.run.artifact.manifestPath).toBe('prebuilt/agent-bundle.manifest.json');
    await expect(access(join(project.root, '.agent-bundle', 'runs', result.run.id, 'artifacts', 'target')))
      .rejects.toThrow();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reports the deterministic run as one machine-readable document', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runCliWithOutput([
      'eval',
      '--root',
      project.root,
      '--case',
      'reads-result',
      '--trials',
      '2',
      '--json',
    ]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as EvalRunResult;
    expect(parsed.trials).toHaveLength(2);
    expect(parsed.run.summary).toMatchObject({ fail: 0, inconclusive: 0, pass: 2 });
    expect(parsed.aggregates[0]).toMatchObject({ caseId: 'reads-result', targetDigest: expect.any(String) });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('summarizes pass, fail, and inconclusive counts separately and fails the command', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runCliWithOutput(['eval', '--root', project.root, '--suite', 'review-change']);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('1 passed');
    expect(result.stdout).toContain('1 failed');
    expect(result.stdout).toContain('1 inconclusive');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reports a native harness with no matching authored host as an empty selection', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runCliWithOutput(['eval', '--root', project.root, '--harness', 'claude']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly message: string }[];
    expect(diagnostics).toMatchObject([{ code: 'AB9002', severity: 'error' }]);
    expect(diagnostics[0]?.message).toContain('No selected eval case has a host');
    await expect(access(join(project.root, '.agent-bundle', 'runs'))).rejects.toThrow();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reports an empty selection as a recoverable diagnostic rather than an empty run', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runCliWithOutput(['eval', '--root', project.root, '--suite', 'absent-suite']);

    expect(result.code).toBe(1);
    const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly recovery?: string }[];
    expect(diagnostics).toMatchObject([{ code: 'AB9002', severity: 'error' }]);
    expect(diagnostics[0]?.recovery).toContain('agent-bundle eval');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('refuses a configured semantic grader without the native Claude harness', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root, { semanticGrader: true });

    const result = await runCliWithOutput(['eval', '--root', project.root, '--case', 'reads-result']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly message: string }[];
    expect(diagnostics).toMatchObject([{ code: 'AB9008', severity: 'error' }]);
    expect(diagnostics[0]?.message).toContain('semantic grading requires the native Claude');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('compares persisted runs with exactly two positional IDs through the public API and both CLI output modes', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const baselineRunId = await persistComparisonRun(project.root, 'baseline');
    const candidateRunId = await persistComparisonRun(project.root, 'candidate');

    const comparison = await compareEvals({
      baseRunId: baselineRunId,
      candidateRunId: candidateRunId,
      root: project.root,
    });
    expect(comparison).toMatchObject({
      baselineRunId,
      candidateRunId,
      summary: { comparable: 1, nonComparable: 0, reliability: 1, smoke: 0 },
    });

    const machine = await runCliWithOutput([
      'eval',
      'compare',
      baselineRunId,
      candidateRunId,
      '--root',
      project.root,
      '--json',
    ]);
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      baselineRunId,
      candidateRunId,
      summary: { comparable: 1, nonComparable: 0 },
    });

    const human = await runCliWithOutput([
      'eval',
      'compare',
      baselineRunId,
      candidateRunId,
      '--root',
      project.root,
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`Compared ${baselineRunId} to ${candidateRunId}`);
    expect(human.stdout).toContain('1 comparable, 0 non-comparable');

    for (const args of [
      ['eval', 'compare', baselineRunId, '--root', project.root],
      ['eval', 'compare', baselineRunId, candidateRunId, 'extra', '--root', project.root],
      ['eval', 'compare', '--base', baselineRunId, '--candidate', candidateRunId, '--root', project.root],
    ]) {
      const invalid = await runCliWithOutput(args);
      expect(invalid.code).toBe(2);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('error:');
    }
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('renders server-produced comparison rows and mismatch causes in human output', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const pass = ['pass', 'pass', 'pass'] as const;
    const fail = ['fail', 'fail', 'fail'] as const;
    const passingBaseline = await persistComparisonRun(project.root, 'passing-baseline', { outcomes: pass });
    const failingCandidate = await persistComparisonRun(project.root, 'failing-candidate', { outcomes: fail });
    const failingBaseline = await persistComparisonRun(project.root, 'failing-baseline', { outcomes: fail });
    const passingCandidate = await persistComparisonRun(project.root, 'passing-candidate', { outcomes: pass });
    const mismatchedCandidate = await persistComparisonRun(project.root, 'mismatched-candidate', {
      caseDigest: 'e'.repeat(64),
      outcomes: pass,
    });

    const regression = await runCliWithOutput([
      'eval', 'compare', passingBaseline, failingCandidate, '--root', project.root,
    ]);
    const improvement = await runCliWithOutput([
      'eval', 'compare', failingBaseline, passingCandidate, '--root', project.root,
    ]);
    const mismatch = await runCliWithOutput([
      'eval', 'compare', passingBaseline, mismatchedCandidate, '--root', project.root,
    ]);

    expect(regression.code).toBe(0);
    expect(improvement.code).toBe(0);
    expect(mismatch.code).toBe(0);
    expect(regression.stdout).toContain('case reads-result / host portable / model deterministic');
    expect(regression.stdout).toContain('baseline: pass; 3/3 passed, 0 failed, 0 inconclusive');
    expect(regression.stdout).toContain('candidate: fail; 0/3 passed, 3 failed, 0 inconclusive');
    expect(regression.stdout).toContain('delta: pass rate -1');
    expect(improvement.stdout).toContain('delta: pass rate +1');
    expect(regression.stdout).not.toBe(improvement.stdout);
    expect(regression.stdout).toContain('1 comparable, 0 non-comparable');
    expect(improvement.stdout).toContain('1 comparable, 0 non-comparable');
    expect(mismatch.stdout).toContain('case reads-result / host portable / model deterministic');
    expect(mismatch.stdout).toContain('not comparable: case-mismatch');
    expect(mismatch.stdout).toContain('case definition');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('maps corrupt persisted comparison runs to one actionable API and CLI diagnostic', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const candidateRunId = await persistComparisonRun(project.root, 'candidate');

    for (const corruption of [
      { contents: 'not JSON\n', file: 'run.json', runId: 'corrupt-run-document' },
      { contents: 'not JSON\n', file: 'events.jsonl', runId: 'corrupt-event-log' },
    ]) {
      const baseRunId = await persistComparisonRun(project.root, corruption.runId);
      await writeFile(join(project.root, '.agent-bundle', 'runs', baseRunId, corruption.file), corruption.contents);

      await expect(compareEvals({ baseRunId, candidateRunId, root: project.root })).rejects.toMatchObject({
        diagnostics: [{ code: 'AB9007', recovery: expect.any(String), severity: 'error' }],
      });

      const result = await runCliWithOutput([
        'eval', 'compare', baseRunId, candidateRunId, '--root', project.root,
      ]);
      expect(result.code).toBe(1);
      const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly recovery?: string }[];
      expect(diagnostics).toMatchObject([{ code: 'AB9007', severity: 'error' }]);
      expect(diagnostics[0]?.recovery).toContain('Repair');
      expect(diagnostics[0]?.code).not.toBe('AB5000');
    }
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reports invalid or missing comparison run ids with the existing eval diagnostic', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const candidateRunId = await persistComparisonRun(project.root, 'candidate');

    for (const baseRunId of ['../escape', 'absent-run']) {
      const result = await runCliWithOutput([
        'eval',
        'compare',
        baseRunId,
        candidateRunId,
        '--root',
        project.root,
      ]);

      expect(result.code).toBe(1);
      const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly recovery?: string }[];
      expect(diagnostics).toMatchObject([{ code: 'AB9003', severity: 'error' }]);
      expect(diagnostics[0]?.recovery).toContain('start a new one');
    }
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);
