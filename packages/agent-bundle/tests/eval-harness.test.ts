import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import {
  aggregateEvalTrials,
  createEvalHarness,
  createEvalRun,
  defineEvalSuite,
  EvalHarnessError,
  expectExitCode,
  expectMcpCall,
  expectNoSkillActivation,
  expectOutcome,
  expectSkillActivation,
  planEvalFixture,
  prepareEvalArtifact,
  reproduceEvalTrialAssertions,
  resolveEvalAssertions,
  runDeterministicTrial,
  summarizeEvalRun,
  type EvalCase,
  type EvalTrialRecord,
  type PreparedEvalArtifact,
} from '../src/eval/index.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';

const hosts = Object.freeze({ portable: Object.freeze({ model: 'deterministic' }) });

const suiteFor = (assertions: EvalCase['assertions']) => defineEvalSuite({
  cases: [{
    assertions,
    fixture: './fixtures/repo',
    hosts,
    id: 'direct-review',
    invocation: { mode: 'automatic' },
    prompt: 'Review this change and report the highest-risk regression.',
    trials: 2,
  }],
  name: 'review-change',
});

const seedSuiteDirectory = async (root: string): Promise<string> => {
  const suiteDir = join(root, 'evals');
  await mkdir(join(suiteDir, 'fixtures', 'repo'), { recursive: true });
  await mkdir(join(suiteDir, 'graders'), { recursive: true });
  await writeFile(join(suiteDir, 'fixtures', 'repo', 'input.txt'), 'review me\n');
  await writeFile(
    join(suiteDir, 'fixtures', 'repo', 'work.sh'),
    [
      '#!/bin/sh',
      'printf \'{"server":"project","tool":"status"}\\n\' > calls.jsonl',
      'printf \'{"risk":"high"}\\n\' > result.json',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(join(suiteDir, 'fixtures', 'repo', 'work.sh'), 0o755);
  await writeFile(
    join(suiteDir, 'graders', 'review-result.ts'),
    [
      "import { readFile } from 'node:fs/promises';",
      "import { join } from 'node:path';",
      '',
      'export default async ({ fixturePath }: { fixturePath: string }) => {',
      "  const raw = await readFile(join(fixturePath, 'result.json'), 'utf8');",
      '  const parsed = JSON.parse(raw) as { risk?: string };',
      "  return parsed.risk === 'high'",
      "    ? { detail: 'The grader found the high-risk regression.', outcome: 'pass' }",
      "    : { detail: 'The grader found no high-risk regression.', outcome: 'fail' };",
      '};',
      '',
    ].join('\n'),
  );
  return suiteDir;
};

const withWorkspace = async (task: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle eval harness '));
  try {
    await task(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const runTrial = async (options: {
  readonly artifact: PreparedEvalArtifact;
  readonly evalCase: EvalCase;
  readonly root: string;
  readonly suiteDir: string;
  readonly trialIndex: number;
  readonly writer: Awaited<ReturnType<typeof createEvalRun>>;
}): Promise<EvalTrialRecord> => runDeterministicTrial({
  artifact: options.artifact,
  evalCase: options.evalCase,
  fixturePlan: await planEvalFixture({ baseDir: options.suiteDir, fixture: options.evalCase.fixture }),
  host: 'portable',
  probe: { args: ['./work.sh'], command: '/bin/sh', mcpCallLog: 'calls.jsonl' },
  suiteDir: options.suiteDir,
  trialIndex: options.trialIndex,
  workspaceRoot: join(options.root, 'workspaces'),
  writer: options.writer,
});

it('routes each host to its native harness and rejects an unknown one', () => {
  expect(createEvalHarness('deterministic').name).toBe('deterministic');
  expect(createEvalHarness('claude').kind).toBe('native-claude');
  expect(createEvalHarness('codex').kind).toBe('native-codex');
  expect(() => createEvalHarness('gemini')).toThrow(EvalHarnessError);
  expect(() => createEvalHarness('gemini')).toThrow(/unknown or unsupported/iu);
});

it('validates and reads an explicit artifact exactly and builds one run-owned copy otherwise', async () => {
  const project = await createProjectFixture();
  await withWorkspace(async () => {
    try {
      const output = join(project.root, 'explicit-artifact');
      await build({ output, root: project.root });

      const explicitWriter = await createEvalRun({
        artifact: { manifestPath: 'pending', source: 'explicit', targetDigests: { portable: 'pending' } },
        projectRoot: project.root,
        provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
      });
      const explicit = await prepareEvalArtifact({
        artifact: output,
        projectRoot: project.root,
        runDirectory: explicitWriter.directory,
      });
      await explicitWriter.close();

      expect(explicit.binding.source).toBe('explicit');
      expect(explicit.root).toBe(output);
      expect(explicit.binding.manifestPath).toBe(join(output, 'agent-bundle.manifest.json'));
      expect(Object.keys(explicit.binding.targetDigests).length).toBeGreaterThan(0);

      const sourceWriter = await createEvalRun({
        artifact: { manifestPath: 'pending', source: 'run-owned', targetDigests: { portable: 'pending' } },
        projectRoot: project.root,
        provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
      });
      const current = await prepareEvalArtifact({
        projectRoot: project.root,
        runDirectory: sourceWriter.directory,
      });
      await sourceWriter.close();

      expect(current.binding.source).toBe('run-owned');
      expect(current.root).toBe(join(sourceWriter.directory, 'artifacts', 'target'));
      expect(current.binding.targetDigests).toEqual(explicit.binding.targetDigests);
      await expect(prepareEvalArtifact({
        artifact: join(project.root, 'absent'),
        projectRoot: project.root,
        runDirectory: sourceWriter.directory,
      })).rejects.toMatchObject({ code: 'EVAL_ARTIFACT_MISSING' });
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
}, 240_000);

it('records deterministic evidence whose raw artifacts reproduce every conclusion', async () => {
  const project = await createProjectFixture();
  await withWorkspace(async (root) => {
    try {
      const suiteDir = await seedSuiteDirectory(root);
      const suite = suiteFor([
        expectExitCode(0),
        expectMcpCall({ atLeast: 1, server: 'project', tool: 'status' }),
        expectOutcome({ script: './graders/review-result.ts' }),
        expectSkillActivation({ minimumEvidence: 'inferred', skill: 'review' }),
      ]);
      const evalCase = suite.cases[0];
      if (evalCase === undefined) throw new Error('The suite must define a case.');

      const writer = await createEvalRun({
        artifact: { manifestPath: 'pending', source: 'run-owned', targetDigests: { portable: 'pending' } },
        projectRoot: project.root,
        provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
      });
      const artifact = await prepareEvalArtifact({ projectRoot: project.root, runDirectory: writer.directory });
      const trials: EvalTrialRecord[] = [];
      for (let index = 0; index < evalCase.trials; index += 1) {
        trials.push(await runTrial({ artifact, evalCase, root, suiteDir, trialIndex: index, writer }));
      }
      const secondCase = Object.freeze({
        ...evalCase,
        digest: 'b'.repeat(64),
        id: 'indirect-review',
      });
      const secondCaseTrial = await runDeterministicTrial({
        artifact,
        evalCase: secondCase,
        fixturePlan: await planEvalFixture({ baseDir: suiteDir, fixture: secondCase.fixture }),
        host: 'portable',
        probe: { args: ['-c', 'exit 3'], command: '/bin/sh' },
        suiteDir,
        trialIndex: 0,
        workspaceRoot: join(root, 'workspaces'),
        writer,
      });
      await writer.close();

      const [first, second] = trials;
      if (first === undefined || second === undefined) throw new Error('Two trials must be recorded.');

      expect(first.evidence.process).toEqual({ exitCode: 0, level: 'observed', timedOut: false });
      expect(first.evidence.mcp).toEqual({ calls: [{ server: 'project', tool: 'status' }], level: 'observed' });
      expect(first.evidence.skillActivation).toEqual({ activated: [], level: 'unavailable' });
      expect(first.assertions.map((assertion) => assertion.outcome)).toEqual([
        'pass',
        'pass',
        'pass',
        'inconclusive',
      ]);
      expect(first.outcome).toBe('inconclusive');
      expect(first.harnessFailure).toBeUndefined();
      expect(first.pluginFailure).toBeUndefined();
      expect(first.fixtureDigest).toBe(second.fixtureDigest);
      expect(first.targetDigest).toBe(artifact.binding.targetDigests.portable);
      expect(first.prompt).toBe(evalCase.prompt);
      for (const assertion of evalCase.assertions) {
        expect(first.prompt).not.toContain(assertion.id);
      }
      expect(first.id).not.toBe(secondCaseTrial.id);
      expect(first.rawArtifacts[0]).not.toBe(secondCaseTrial.rawArtifacts[0]);

      const reproduced = await reproduceEvalTrialAssertions({
        directory: writer.directory,
        evalCase,
        trial: first,
      });
      expect(reproduced).toEqual(first.assertions);
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
}, 240_000);

it('does not persist inherited credentials and marks a malformed MCP log unavailable', async () => {
  const project = await createProjectFixture();
  const credential = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
  const previousCredential = process.env.REVIEW_PARENT_SECRET;
  process.env.REVIEW_PARENT_SECRET = credential;
  try {
    await withWorkspace(async (root) => {
      try {
        const suiteDir = await seedSuiteDirectory(root);
        const suite = suiteFor([expectMcpCall({ server: 'project', tool: 'status' })]);
        const evalCase = suite.cases[0];
        if (evalCase === undefined) throw new Error('The suite must define a case.');
        const writer = await createEvalRun({
          artifact: { manifestPath: 'pending', source: 'run-owned', targetDigests: { portable: 'pending' } },
          projectRoot: project.root,
          provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
        });
        const artifact = await prepareEvalArtifact({ projectRoot: project.root, runDirectory: writer.directory });
        const trial = await runDeterministicTrial({
          artifact,
          evalCase,
          fixturePlan: await planEvalFixture({ baseDir: suiteDir, fixture: evalCase.fixture }),
          host: 'portable',
          probe: {
            args: ['-c', 'printf %s "$REVIEW_PARENT_SECRET"; printf \'{"server":\n\' > calls.jsonl'],
            command: '/bin/sh',
            mcpCallLog: 'calls.jsonl',
          },
          suiteDir,
          trialIndex: 0,
          workspaceRoot: join(root, 'workspaces'),
          writer,
        });
        await writer.close();

        expect(trial.evidence.mcp).toEqual({ calls: [], level: 'unavailable' });
        const stdout = trial.rawArtifacts.find((path) => path.endsWith('/stdout.log'));
        if (stdout === undefined) throw new Error('The deterministic trial must record stdout.');
        expect(await readFile(join(writer.directory, stdout), 'utf8')).not.toContain(credential);
      } finally {
        await rm(project.root, { force: true, recursive: true });
      }
    });
  } finally {
    if (previousCredential === undefined) delete process.env.REVIEW_PARENT_SECRET;
    else process.env.REVIEW_PARENT_SECRET = previousCredential;
  }
}, 240_000);

it('separates a harness failure from a plugin failure', async () => {
  const project = await createProjectFixture();
  await withWorkspace(async (root) => {
    try {
      const suiteDir = await seedSuiteDirectory(root);
      const suite = suiteFor([expectExitCode(0)]);
      const evalCase = suite.cases[0];
      if (evalCase === undefined) throw new Error('The suite must define a case.');

      const writer = await createEvalRun({
        artifact: { manifestPath: 'pending', source: 'run-owned', targetDigests: { portable: 'pending' } },
        projectRoot: project.root,
        provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
      });
      const artifact = await prepareEvalArtifact({ projectRoot: project.root, runDirectory: writer.directory });
      const shared = {
        artifact,
        evalCase,
        fixturePlan: await planEvalFixture({ baseDir: suiteDir, fixture: evalCase.fixture }),
        host: 'portable',
        suiteDir,
        workspaceRoot: join(root, 'workspaces'),
        writer,
      };

      const pluginFailure = await runDeterministicTrial({
        ...shared,
        probe: { args: ['-c', 'exit 3'], command: '/bin/sh' },
        trialIndex: 0,
      });
      const harnessFailure = await runDeterministicTrial({
        ...shared,
        probe: { args: [], command: join(root, 'no-such-command') },
        trialIndex: 1,
      });
      await writer.close();

      expect(pluginFailure.outcome).toBe('fail');
      expect(pluginFailure.pluginFailure).toEqual({
        code: 'EVAL_PLUGIN_PROCESS_FAILED',
        message: 'The trial process exited with code 3.',
      });
      expect(pluginFailure.harnessFailure).toBeUndefined();

      expect(harnessFailure.outcome).toBe('inconclusive');
      expect(harnessFailure.harnessFailure?.code).toBe('EVAL_PROCESS_UNAVAILABLE');
      expect(harnessFailure.harnessFailure?.stage).toBe('preflight');
      expect(harnessFailure.pluginFailure).toBeUndefined();
      expect(harnessFailure.assertions.every((assertion) => assertion.outcome === 'inconclusive')).toBe(true);
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
}, 240_000);

it('aggregates multiple trials reproducibly and never folds misaligned trials together', () => {
  const base: EvalTrialRecord = {
    assertions: resolveEvalAssertions([expectExitCode(0)], {
      mcp: { calls: [], level: 'unavailable' },
      process: { exitCode: 0, level: 'observed', timedOut: false },
      scripts: { level: 'unavailable', results: {} },
      skillActivation: { activated: [], level: 'unavailable' },
    }),
    caseDigest: 'c'.repeat(64),
    caseId: 'direct-review',
    completedAt: '2026-08-17T12:00:01.000Z',
    durationMs: 10,
    evidence: {
      mcp: { calls: [], level: 'unavailable' },
      process: { exitCode: 0, level: 'observed', timedOut: false },
      scripts: { level: 'unavailable', results: {} },
      skillActivation: { activated: [], level: 'unavailable' },
    },
    fixtureDigest: 'd'.repeat(64),
    host: 'portable',
    id: 'portable-1',
    model: 'deterministic',
    outcome: 'pass',
    prompt: 'Do the task.',
    rawArtifacts: [],
    schemaVersion: 1,
    startedAt: '2026-08-17T12:00:00.000Z',
    targetDigest: 'a'.repeat(64),
    trialIndex: 0,
  };
  const failing: EvalTrialRecord = {
    ...base,
    assertions: resolveEvalAssertions([expectExitCode(0)], {
      mcp: { calls: [], level: 'unavailable' },
      process: { exitCode: 1, level: 'observed', timedOut: false },
      scripts: { level: 'unavailable', results: {} },
      skillActivation: { activated: [], level: 'unavailable' },
    }),
    id: 'portable-2',
    outcome: 'fail',
    trialIndex: 1,
  };
  const misaligned: EvalTrialRecord = { ...base, fixtureDigest: 'e'.repeat(64), id: 'portable-3', trialIndex: 2 };

  const aggregates = aggregateEvalTrials([misaligned, failing, base]);

  expect(aggregates).toHaveLength(2);
  expect(aggregates).toEqual(aggregateEvalTrials([base, misaligned, failing]));
  expect(aggregates[0]).toMatchObject({
    caseId: 'direct-review',
    fail: 1,
    fixtureDigest: 'd'.repeat(64),
    inconclusive: 0,
    outcome: 'fail',
    pass: 1,
    trials: 2,
  });
  expect(aggregates[0]?.assertions[0]).toMatchObject({ fail: 1, inconclusive: 0, pass: 1 });
  expect(aggregates[1]).toMatchObject({ fixtureDigest: 'e'.repeat(64), outcome: 'pass', pass: 1, trials: 1 });
  expect(summarizeEvalRun(aggregates)).toEqual({ cases: 1, fail: 1, inconclusive: 0, pass: 2, trials: 3 });
});

it('keeps a negative case inconclusive when activation evidence is unavailable', async () => {
  const project = await createProjectFixture();
  await withWorkspace(async (root) => {
    try {
      const suiteDir = await seedSuiteDirectory(root);
      const suite = suiteFor([expectNoSkillActivation()]);
      const evalCase = suite.cases[0];
      if (evalCase === undefined) throw new Error('The suite must define a case.');

      const writer = await createEvalRun({
        artifact: { manifestPath: 'pending', source: 'run-owned', targetDigests: { portable: 'pending' } },
        projectRoot: project.root,
        provenance: { agentBundleVersion: '0.1.0', harness: 'deterministic', projectRevision: 'unknown' },
      });
      const artifact = await prepareEvalArtifact({ projectRoot: project.root, runDirectory: writer.directory });
      const unavailable = await runTrial({ artifact, evalCase, root, suiteDir, trialIndex: 0, writer });
      const observed = await runDeterministicTrial({
        activation: { activated: [], level: 'observed' },
        artifact,
        evalCase,
        fixturePlan: await planEvalFixture({ baseDir: suiteDir, fixture: evalCase.fixture }),
        host: 'portable',
        probe: { args: ['./work.sh'], command: '/bin/sh' },
        suiteDir,
        trialIndex: 1,
        workspaceRoot: join(root, 'workspaces'),
        writer,
      });
      await writer.close();

      expect(unavailable.assertions[0]?.outcome).toBe('inconclusive');
      expect(observed.assertions[0]?.outcome).toBe('pass');
      expect(JSON.parse(await readFile(join(writer.directory, unavailable.rawArtifacts[0] ?? ''), 'utf8')))
        .toMatchObject({ skillActivation: { level: 'unavailable' } });
    } finally {
      await rm(project.root, { force: true, recursive: true });
    }
  });
}, 240_000);
