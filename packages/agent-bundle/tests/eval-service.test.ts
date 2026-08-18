import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { EvalService, EvalServiceError } from '../src/dev/eval-service.ts';
import { evalCaseFromDraft } from '../src/eval/index.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { seedEvalProject, writeEvalSuite } from './support/eval-project.ts';

const service = (root: string): EvalService => new EvalService({ projectRoot: root, targets: ['portable'] });

it('lists authored suites and their cases without exposing absolute filesystem paths', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const listing = await service(project.root).suites();

    expect(listing.diagnostics).toEqual([]);
    expect(listing.suites).toHaveLength(1);
    const suite = listing.suites[0]!;
    expect(suite.name).toBe('review-change');
    expect(suite.sourcePath).toBe('evals/review.eval.ts');
    expect(suite.sourcePath).not.toContain(project.root);
    expect(suite.cases.map((entry) => entry.id)).toEqual(['inconclusive-activation', 'reads-result', 'wrong-result']);
    expect(suite.cases[1]).toMatchObject({ hosts: ['portable'], trials: 1 });
    expect(suite.cases[1]?.assertions.map((entry) => entry.kind)).toEqual(['outcome']);
    expect(Object.isFrozen(listing.suites)).toBe(true);
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('persists complete evidence for every trial of a multi-trial run', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await service(project.root).run({ caseIds: ['reads-result'], trials: 3 });

    expect(result.trials).toHaveLength(3);
    expect(result.trials.map((trial) => trial.id)).toEqual([
      'reads-result--portable-1',
      'reads-result--portable-2',
      'reads-result--portable-3',
    ]);
    expect(result.trials.every((trial) => trial.outcome === 'pass')).toBe(true);
    expect(result.run.summary).toEqual({ cases: 1, fail: 0, inconclusive: 0, pass: 3, trials: 3 });
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]).toMatchObject({ caseId: 'reads-result', pass: 3, trials: 3 });
    const digests = new Set(result.trials.map((trial) => trial.targetDigest));
    expect(digests.size).toBe(1);
    expect(result.run.artifact.targetDigests.portable).toBe(result.trials[0]?.targetDigest);
    expect(result.run.artifact.manifestPath).toBe('artifacts/target/agent-bundle.manifest.json');

    const runDirectory = join(project.root, '.agent-bundle', 'runs', result.run.id);
    for (const trial of result.trials) {
      for (const artifactPath of trial.rawArtifacts) {
        await expect(access(join(runDirectory, ...artifactPath.split('/')))).resolves.toBeUndefined();
      }
      expect(trial.evidence.scripts.level).toBe('observed');
    }
    const persisted = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as {
      readonly summary: { readonly pass: number };
    };
    expect(persisted.summary.pass).toBe(3);
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('persists an explicit artifact outside the project as an opaque portable identity', async () => {
  const project = await createProjectFixture();
  const artifactProject = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const artifact = join(artifactProject.root, 'prebuilt');
    await build({ output: artifact, root: artifactProject.root, targets: ['portable'] });

    await expect(service(project.root).run({ artifact, caseIds: ['reads-result'] })).resolves.toMatchObject({
      run: {
        artifact: {
          manifestPath: expect.stringMatching(/^external\/[a-f0-9]{64}\.json$/u),
          source: 'explicit',
        },
      },
    });
  } finally {
    await Promise.all([
      removeProjectFixture(project.root),
      removeProjectFixture(artifactProject.root),
    ]);
  }
}, 120_000);

it('keeps a failing case distinct from an evidence-free inconclusive case', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    const result = await service(project.root).run({});

    expect(result.trials).toHaveLength(3);
    const outcomes = Object.fromEntries(result.trials.map((trial) => [trial.caseId, trial.outcome]));
    expect(outcomes).toEqual({
      'inconclusive-activation': 'inconclusive',
      'reads-result': 'pass',
      'wrong-result': 'fail',
    });
    expect(result.run.summary).toMatchObject({ fail: 1, inconclusive: 1, pass: 1 });
    const inconclusive = result.trials.find((trial) => trial.caseId === 'inconclusive-activation');
    expect(inconclusive?.pluginFailure).toBeUndefined();
    expect(inconclusive?.assertions[0]).toMatchObject({ evidence: 'unavailable', outcome: 'inconclusive' });
    const failed = result.trials.find((trial) => trial.caseId === 'wrong-result');
    expect(failed?.pluginFailure).toMatchObject({ code: 'EVAL_PLUGIN_ASSERTION_FAILED' });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reads one persisted run and lists every run of the project', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const created = await service(project.root).run({ caseIds: ['reads-result'] });

    const read = await service(project.root).read(created.run.id);
    const listed = await service(project.root).list();

    expect(read.run).toEqual(created.run);
    expect(read.trials).toEqual(created.trials);
    expect(read.aggregates).toEqual(created.aggregates);
    expect(listed.map((entry) => entry.id)).toEqual([created.run.id]);
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('reports a missing or unreadable run instead of inventing an empty one', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    await expect(service(project.root).read('20260101t000000000z-abcdef01')).rejects.toMatchObject({
      code: 'EVAL_RUN_NOT_FOUND',
    });
    await expect(service(project.root).read('../escape')).rejects.toMatchObject({ code: 'EVAL_RUN_NOT_FOUND' });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('rejects native harness selections with no matching authored host', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);

    await expect(service(project.root).run({ harness: 'claude' })).rejects.toMatchObject({
      code: 'EVAL_SELECTION_EMPTY',
    });
    await expect(service(project.root).run({ harness: 'codex' })).rejects.toMatchObject({
      code: 'EVAL_SELECTION_EMPTY',
    });
    await expect(access(join(project.root, '.agent-bundle', 'runs'))).rejects.toThrow();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('rejects deterministic and Codex selections when semantic grading is configured', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root, { semanticGrader: true });

    const evals = service(project.root);
    const listing = await evals.suites();

    expect(listing.diagnostics).toEqual([]);
    await expect(evals.run({ caseIds: ['reads-result'] })).rejects.toMatchObject({
      code: 'EVAL_SEMANTIC_GRADER_UNSUPPORTED',
    });
    await expect(evals.run({ caseIds: ['reads-result'], harness: 'codex' })).rejects.toMatchObject({
      code: 'EVAL_SEMANTIC_GRADER_UNSUPPORTED',
    });
    await expect(access(join(project.root, '.agent-bundle', 'runs'))).rejects.toThrow();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('rejects a service-discovered authored outcome that claims the server-owned semantic grader id', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    await writeFile(join(project.root, 'evals', 'reserved.eval.ts'), [
      "import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';",
      '',
      'export default defineEvalSuite({',
      '  cases: [{',
      "    assertions: [expectOutcome({ script: 'claude-semantic' })],",
      "    fixture: './fixtures/repo',",
      "    hosts: { portable: { model: 'deterministic' } },",
      "    id: 'reserved-outcome',",
      "    invocation: { mode: 'automatic' },",
      "    prompt: 'Report the reserved grader collision.',",
      '  }],',
      "  name: 'reserved-semantic-id',",
      '});',
      '',
    ].join('\n'));

    await expect(service(project.root).suites()).rejects.toMatchObject({ code: 'EVAL_SUITE_LOAD_FAILED' });
    await expect(access(join(project.root, '.agent-bundle', 'runs'))).rejects.toThrow();
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('rejects a selection that matches no suite or case', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const evals = service(project.root);

    await expect(evals.run({ caseIds: ['missing-case'] })).rejects.toBeInstanceOf(EvalServiceError);
    await expect(evals.run({ suites: ['missing-suite'] })).rejects.toMatchObject({ code: 'EVAL_SELECTION_EMPTY' });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('refuses to run a case whose pinned host has no artifact target', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    await writeEvalSuite(project.root, 'unbound.eval.ts', {
      cases: [{ hosts: { claude: { model: 'unpinned' } }, id: 'unbound', kind: 'pass' }],
      name: 'unbound-suite',
    });

    await expect(service(project.root).run({ suites: ['unbound-suite'] })).rejects.toMatchObject({
      code: 'EVAL_TARGET_MISSING',
    });
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('runs a playground draft promoted into typed suite material', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const promoted = evalCaseFromDraft({
      assertions: [{
        evidence: { observed: 'result.json recorded risk high' },
        expectation: { script: './graders/reads-result.ts' },
        id: 'assertion-1',
        kind: 'outcome',
      }],
      epoch: { digest: 'a'.repeat(64), id: 'epoch-1' },
      fixture: { digest: 'b'.repeat(64), id: 'repo' },
      invocation: { intent: { mode: 'automatic' }, kind: 'automatic' },
      outcome: { response: 'The recorded answer is deliberately dropped.', status: 'completed' },
      schemaVersion: 1,
      target: { name: 'portable' },
      task: { id: 'promoted-case', text: 'Report the highest-risk regression.' },
    }, { fixture: './fixtures/repo', hosts: { portable: { model: 'deterministic' } } });

    await mkdir(join(project.root, 'evals'), { recursive: true });
    await writeFile(
      join(project.root, 'evals', 'promoted.eval.ts'),
      [
        "import { defineEvalSuite } from 'agent-bundle/eval';",
        '',
        `export default defineEvalSuite(${JSON.stringify({ cases: [promoted.case], name: 'promoted-suite' }, undefined, 2)});`,
        '',
      ].join('\n'),
    );

    const result = await service(project.root).run({ suites: ['promoted-suite'] });

    expect(promoted.provenance.epoch.id).toBe('epoch-1');
    expect(result.trials).toHaveLength(1);
    expect(result.trials[0]).toMatchObject({ caseId: 'promoted-case', outcome: 'pass' });
    const source = await readFile(join(project.root, 'evals', 'promoted.eval.ts'), 'utf8');
    expect(source).toContain('"prompt": "Report the highest-risk regression."');
    expect(source).toContain('"script": "./graders/reads-result.ts"');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);

it('finishes a cancelled run with the trials it completed instead of tearing the record', async () => {
  const project = await createProjectFixture();
  try {
    await seedEvalProject(project.root);
    const controller = new AbortController();
    controller.abort();

    const result = await service(project.root).run({
      caseIds: ['reads-result'],
      signal: controller.signal,
      trials: 4,
    });

    expect(result.trials).toEqual([]);
    expect(result.run.summary).toEqual({ cases: 0, fail: 0, inconclusive: 0, pass: 0, trials: 0 });
    expect(result.run.completedAt).toBeDefined();
    const events = await readFile(join(project.root, '.agent-bundle', 'runs', result.run.id, 'events.jsonl'), 'utf8');
    expect(events).toContain('"run.cancelled"');
  } finally {
    await removeProjectFixture(project.root);
  }
}, 120_000);
