import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  createEvalRun,
  EvalRunStoreError,
  listEvalRuns,
  readEvalRun,
  readEvalRunEvents,
  readEvalTrials,
  type CreateEvalRunOptions,
  type EvalTrialRecordInput,
} from '../src/eval/index.ts';

const artifact = Object.freeze({
  manifestPath: 'artifacts/target/agent-bundle.manifest.json',
  source: 'run-owned',
  targetDigests: Object.freeze({ claude: 'a'.repeat(64) }),
} as const);

const provenance = Object.freeze({
  agentBundleVersion: '0.1.0',
  harness: 'deterministic',
  projectRevision: 'b'.repeat(64),
});

const runOptions = (projectRoot: string, overrides: Partial<CreateEvalRunOptions> = {}): CreateEvalRunOptions => ({
  artifact,
  projectRoot,
  provenance,
  ...overrides,
});

const trialInput = (overrides: Partial<EvalTrialRecordInput> = {}): EvalTrialRecordInput => ({
  assertions: [{ assertionId: 'exit-code:1234', detail: 'The process exited with code 0.', evidence: 'observed', kind: 'exit-code', outcome: 'pass' }],
  caseDigest: 'c'.repeat(64),
  caseId: 'direct-review',
  completedAt: '2026-08-17T12:00:01.000Z',
  durationMs: 1000,
  evidence: {
    mcp: { calls: [], level: 'unavailable' },
    process: { exitCode: 0, level: 'observed', timedOut: false },
    scripts: { level: 'unavailable', results: {} },
    skillActivation: { activated: [], level: 'unavailable' },
  },
  fixtureDigest: 'd'.repeat(64),
  host: 'claude',
  id: 'trial-1',
  model: 'claude-sonnet-4-5',
  outcome: 'pass',
  prompt: 'Do the task.',
  rawArtifacts: ['artifacts/trial-1/evidence.json'],
  startedAt: '2026-08-17T12:00:00.000Z',
  targetDigest: 'a'.repeat(64),
  trialIndex: 0,
  ...overrides,
});

const withProject = async (task: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle eval runs '));
  try {
    await task(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('publishes a schema-versioned run document with its exact target digest', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      expect(writer.record.schemaVersion).toBe(1);
      expect(writer.record.artifact.targetDigests).toEqual({ claude: 'a'.repeat(64) });
      expect(Object.isFrozen(writer.record)).toBe(true);

      const persisted = await readEvalRun(writer.directory);
      expect(persisted.id).toBe(writer.record.id);
      expect(persisted.completedAt).toBeUndefined();
      expect(await listEvalRuns({ projectRoot: root })).toEqual([writer.record.id]);
    } finally {
      await writer.close();
    }
  });
});

it('refuses a second writer for an owned run and lets a dead owner be reported separately', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root, { runId: 'run-1' }));
    try {
      await expect(createEvalRun(runOptions(root, { runId: 'run-1' }))).rejects.toThrow(EvalRunStoreError);
      await expect(createEvalRun(runOptions(root, { runId: 'run-1' }))).rejects.toMatchObject({ code: 'EVAL_RUN_OWNED' });
      await expect(createEvalRun(runOptions(root, { probeProcess: () => false, runId: 'run-1' })))
        .rejects.toMatchObject({ code: 'EVAL_RUN_EXISTS' });
    } finally {
      await writer.close();
    }
  });
});

it('mints a distinct run for a second concurrent writer instead of appending', async () => {
  await withProject(async (root) => {
    const first = await createEvalRun(runOptions(root));
    const second = await createEvalRun(runOptions(root));
    try {
      expect(first.record.id).not.toBe(second.record.id);
      expect(first.directory).not.toBe(second.directory);
      expect((await listEvalRuns({ projectRoot: root })).length).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

it('stores trials and raw artifacts under the run directory without a database', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      const reference = await writer.writeArtifactFile('trial-1/evidence.json', '{"exitCode":0}\n');
      const trial = await writer.writeTrial(trialInput());
      await writer.finish({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });

      expect(reference).toBe('artifacts/trial-1/evidence.json');
      expect(trial.schemaVersion).toBe(1);
      expect(await readEvalTrials(writer.directory)).toEqual([trial]);
      expect((await readEvalRun(writer.directory)).summary).toEqual({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });
      expect((await readdir(writer.directory)).sort()).toEqual(['artifacts', 'cases', 'events.jsonl', 'owner.json', 'run.json']);
      expect(await readdir(join(writer.directory, 'cases', 'direct-review'))).toEqual(['trial-1.json']);
    } finally {
      await writer.close();
    }
  });
});

it('publishes JSON documents by rename and leaves no staging file behind', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      await writer.writeTrial(trialInput());
      await writer.writeTrial(trialInput({ id: 'trial-2', trialIndex: 1 }));
      await writer.finish({ cases: 1, fail: 0, inconclusive: 0, pass: 2, trials: 2 });

      const caseFiles = await readdir(join(writer.directory, 'cases', 'direct-review'));
      expect(caseFiles.sort()).toEqual(['trial-1.json', 'trial-2.json']);
      expect((await readdir(writer.directory)).some((entry) => entry.includes('.stage-'))).toBe(false);
      expect(JSON.parse(await readFile(join(writer.directory, 'run.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 });
    } finally {
      await writer.close();
    }
  });
});

it('ignores and reports at most one incomplete trailing JSONL record', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    await writer.appendEvent({ kind: 'trial.started', payload: { caseId: 'direct-review' } });
    await writer.appendEvent({ kind: 'trial.completed', payload: { caseId: 'direct-review' } });
    await writer.close();

    const eventsPath = join(writer.directory, 'events.jsonl');
    await appendFile(eventsPath, '{"kind":"trial.started","payl');

    const read = await readEvalRunEvents(writer.directory);
    expect(read.events.map((event) => event.kind)).toEqual(['trial.started', 'trial.completed']);
    expect(read.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(read.incompleteTrailingRecord).toBe('{"kind":"trial.started","payl');
  });
});

it('reports a malformed complete JSONL record as a corrupt run', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    await writer.appendEvent({ kind: 'trial.started', payload: {} });
    await writer.close();

    await writeFile(join(writer.directory, 'events.jsonl'), 'not json\n{"kind":"trial.started"}\n');

    await expect(readEvalRunEvents(writer.directory)).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });
  });
});

it('rejects writes after the run is closed and unknown run directories', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    await writer.close();

    await expect(writer.writeTrial(trialInput())).rejects.toMatchObject({ code: 'EVAL_RUN_CLOSED' });
    await expect(writer.appendEvent({ kind: 'trial.started', payload: {} })).rejects.toMatchObject({ code: 'EVAL_RUN_CLOSED' });
    await expect(readEvalRun(join(root, '.agent-bundle', 'runs', 'absent'))).rejects.toMatchObject({ code: 'EVAL_RUN_NOT_FOUND' });
  });
});

it('rejects a trial record whose identifiers are not path safe', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      await expect(writer.writeTrial(trialInput({ caseId: '../escape' }))).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(writer.writeTrial(trialInput({ id: '../escape' }))).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(writer.writeArtifactFile('../escape.json', '{}')).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    } finally {
      await writer.close();
    }
  });
});
