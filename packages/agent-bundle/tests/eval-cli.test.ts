import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build, runEvals } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
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

it('refuses a model-backed harness with one explicit unsupported diagnostic', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await runCliWithOutput(['eval', '--root', project.root, '--harness', 'claude']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const diagnostics = JSON.parse(result.stderr) as readonly { readonly code: string; readonly message: string }[];
    expect(diagnostics).toMatchObject([{ code: 'AB9001', severity: 'error' }]);
    expect(diagnostics[0]?.message).toContain('not supported yet');
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

it('prints a configured semantic grader as a warning beside the completed run', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root, { semanticGrader: true });

    const result = await runCliWithOutput(['eval', '--root', project.root, '--case', 'reads-result']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('AB9000');
    expect(result.stdout).toContain('1 passed');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);
