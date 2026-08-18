import { Buffer } from 'node:buffer';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { stableJson } from '../src/core/digest.ts';
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

type EvalRunStoreDurabilityTestHook = (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-rollback' | 'before-event-write',
  event: Readonly<{ readonly kind: string }>,
  path: string,
  journal: Readonly<{ close(): Promise<void>; writeFile(contents: string, options?: string): Promise<void> }> | undefined,
) => void | Promise<void>;

const evalRunStoreDurabilityTestHookKey = Symbol.for('agent-bundle.eval-run-store.durability-test-hook');

const withEvalRunStoreDurabilityTestHook = async <T>(
  hook: EvalRunStoreDurabilityTestHook,
  operation: () => Promise<T>,
): Promise<T> => {
  const hooks = globalThis as typeof globalThis & Record<symbol, EvalRunStoreDurabilityTestHook | undefined>;
  const previous = hooks[evalRunStoreDurabilityTestHookKey];
  const previousNodeEnvironment = process.env.NODE_ENV;
  hooks[evalRunStoreDurabilityTestHookKey] = hook;
  process.env.NODE_ENV = 'test';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete hooks[evalRunStoreDurabilityTestHookKey];
    else hooks[evalRunStoreDurabilityTestHookKey] = previous;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
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

it('keeps a dot-prefixed generated manifest path while rejecting traversal segments', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root, {
      artifact: {
        ...artifact,
        manifestPath: '.agent-bundle/epochs/active/agent-bundle.manifest.json',
      },
    }));
    try {
      expect(writer.record.artifact.manifestPath).toBe('.agent-bundle/epochs/active/agent-bundle.manifest.json');
    } finally {
      await writer.close();
    }
    await expect(createEvalRun(runOptions(root, {
      artifact: { ...artifact, manifestPath: '.agent-bundle/../escape.json' },
    }))).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
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

it('retains safe generated artifact segments that begin with punctuation', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      await expect(writer.writeArtifactFile('_meta/evidence.json', '{}\n'))
        .resolves.toBe('artifacts/_meta/evidence.json');
      await expect(writer.writeArtifactFile('.trace/evidence.json', '{}\n'))
        .resolves.toBe('artifacts/.trace/evidence.json');
    } finally {
      await writer.close();
    }
  });
});

it('round-trips bounded provenance and normalized token usage with a trial', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    try {
      const written = await writer.writeTrial(trialInput({
        provenance: {
          hostCliVersion: '2.1.232',
          invocation: { mode: 'explicit', skill: 'review' },
          semanticGrader: { id: 'claude-semantic', model: 'claude-opus-4-6', schemaVersion: 1 },
        },
        usage: { inputTokens: 9, outputTokens: 3 },
      }));

      expect(written.provenance).toEqual({
        hostCliVersion: '2.1.232',
        invocation: { mode: 'explicit', skill: 'review' },
        semanticGrader: { id: 'claude-semantic', model: 'claude-opus-4-6', schemaVersion: 1 },
      });
      expect(written.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
      expect(await readEvalTrials(writer.directory)).toEqual([written]);
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

it('retains a full event line when post-write durability fails', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const durabilityFailure = new Error('event sync failed after write');
    let injected = false;
    try {
      await withEvalRunStoreDurabilityTestHook((phase, event) => {
        if (phase === 'after-event-write' && event.kind === 'run.completed' && !injected) {
          injected = true;
          throw durabilityFailure;
        }
      }, async () => {
        await expect(writer.appendEvent({ kind: 'run.completed', payload: {} })).rejects.toMatchObject({
          event: { kind: 'run.completed' },
          failures: [durabilityFailure],
          name: 'EvalRunEventDurabilityError',
        });
      });

      expect(injected).toBe(true);
      expect((await readEvalRunEvents(writer.directory)).events.map((event) => event.kind)).toEqual(['run.completed']);
      await expect(writer.close()).rejects.toThrow('closed with admitted write failures');
    } finally {
      await writer.close().catch(() => undefined);
    }
  });
});

it('reuses an uncommitted event sequence after an open failure', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const openFailure = new Error('event journal open failed');
    let injected = false;
    try {
      await withEvalRunStoreDurabilityTestHook((phase, event) => {
        if (phase === 'before-event-open' && event.kind === 'run.completed' && !injected) {
          injected = true;
          throw openFailure;
        }
      }, async () => {
        await expect(writer.appendEvent({ kind: 'run.completed', payload: {} })).rejects.toBe(openFailure);
      });

      const fallback = await writer.appendEvent({ kind: 'run.failed', payload: {} });
      expect(injected).toBe(true);
      expect(fallback.sequence).toBe(1);
      expect(await readEvalRunEvents(writer.directory)).toMatchObject({ events: [{ kind: 'run.failed', sequence: 1 }] });
      await expect(writer.close()).rejects.toThrow('closed with admitted write failures');
    } finally {
      await writer.close().catch(() => undefined);
    }
  });
});

it('restores partial event bytes before retrying the uncommitted sequence', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const partialWriteFailure = new Error('event journal partial write failed');
    let injected = false;
    try {
      await withEvalRunStoreDurabilityTestHook(async (phase, event, _path, journal) => {
        if (phase === 'before-event-write' && event.kind === 'run.completed' && !injected) {
          if (journal === undefined) throw new Error('The partial-write hook did not receive the event journal.');
          injected = true;
          await journal.writeFile('{"kind":"run.completed"', 'utf8');
          throw partialWriteFailure;
        }
      }, async () => {
        await expect(writer.appendEvent({ kind: 'run.completed', payload: {} })).rejects.toBe(partialWriteFailure);
      });

      const fallback = await writer.appendEvent({ kind: 'run.failed', payload: {} });
      expect(injected).toBe(true);
      expect(fallback.sequence).toBe(1);
      expect(await readEvalRunEvents(writer.directory)).toMatchObject({ events: [{ kind: 'run.failed', sequence: 1 }] });
      await expect(writer.close()).rejects.toThrow('closed with admitted write failures');
    } finally {
      await writer.close().catch(() => undefined);
    }
  });
});

it('poisons every writer mutation when a partial event cannot be rolled back', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const writeFailure = new Error('event journal partial write failed');
    const rollbackFailure = new Error('event journal rollback failed');
    const partial = '{"kind":"run.completed"';
    let uncertainty: unknown;
    let writeInjected = false;
    let rollbackInjected = false;
    try {
      await withEvalRunStoreDurabilityTestHook(async (phase, event, _path, journal) => {
        if (phase === 'before-event-write' && event.kind === 'run.completed' && !writeInjected) {
          if (journal === undefined) throw new Error('The partial-write hook did not receive the event journal.');
          writeInjected = true;
          await journal.writeFile(partial, 'utf8');
          throw writeFailure;
        }
        if (phase === 'before-event-rollback' && event.kind === 'run.completed' && !rollbackInjected) {
          rollbackInjected = true;
          throw rollbackFailure;
        }
      }, async () => {
        try {
          await writer.appendEvent({ kind: 'run.completed', payload: {} });
          throw new Error('The partial event append unexpectedly succeeded.');
        } catch (error) {
          uncertainty = error;
          expect(error).toMatchObject({
            event: { kind: 'run.completed' },
            failures: [writeFailure, rollbackFailure],
            name: 'EvalRunEventWriteUncertainError',
          });
        }
      });

      expect(writeInjected).toBe(true);
      expect(rollbackInjected).toBe(true);
      await expect(writer.appendEvent({ kind: 'run.failed', payload: {} })).rejects.toBe(uncertainty);
      await expect(writer.writeArtifactFile('later.json', '{}')).rejects.toBe(uncertainty);
      await expect(writer.writeTrial(trialInput())).rejects.toBe(uncertainty);
      await expect(writer.finish({ cases: 1, fail: 1, inconclusive: 0, pass: 0, trials: 1 })).rejects.toBe(uncertainty);
      expect(await readEvalRunEvents(writer.directory)).toEqual({
        events: [],
        incompleteTrailingRecord: partial,
      });
      await expect(writer.close()).rejects.toThrow('closed with admitted write failures');
    } finally {
      await writer.close().catch(() => undefined);
    }
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

it('rejects any complete event log whose sequence is not exactly 1 through N', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    await writer.close();
    const eventsPath = join(writer.directory, 'events.jsonl');
    const event = (sequence: number): string => JSON.stringify({
      kind: 'trial.started',
      payload: {},
      schemaVersion: 1,
      sequence,
      timestamp: '2026-08-17T12:00:00.000Z',
    });

    for (const records of [
      [event(2)],
      [event(1), event(3)],
      [event(1), event(1)],
      [event(2), event(1)],
      [event(1), '', event(2)],
    ]) {
      await writeFile(eventsPath, `${records.join('\n')}\n`);
      await expect(readEvalRunEvents(writer.directory)).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });
    }
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

it('enforces the persisted trial byte limit before atomically publishing the record', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const emptyPrompt = { ...trialInput(), prompt: '', schemaVersion: 1 };
    const allowedPromptBytes = 1024 * 1024 - Buffer.byteLength(`${stableJson(emptyPrompt)}\n`, 'utf8');
    const exact = trialInput({ prompt: 'x'.repeat(allowedPromptBytes) });
    const tooLarge = trialInput({ id: 'trial-2', prompt: 'x'.repeat(allowedPromptBytes + 1), trialIndex: 1 });
    try {
      expect(Buffer.byteLength(`${stableJson({ ...exact, schemaVersion: 1 })}\n`, 'utf8')).toBe(1024 * 1024);
      await expect(writer.writeTrial(exact)).resolves.toMatchObject({ id: 'trial-1' });
      await expect(writer.writeTrial(tooLarge)).rejects.toMatchObject({
        code: 'EVAL_RUN_RECORD_INVALID',
        message: 'Eval trial record exceeds the 1 MiB storage limit.',
      });
      await expect(readEvalTrials(writer.directory)).resolves.toHaveLength(1);
    } finally {
      await writer.close().catch(() => undefined);
    }
  });
});

it('rejects trial authority when the cases root changes after its directory snapshot', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const outside = `${root}-outside`;
    try {
      await writer.writeTrial(trialInput());
      await writer.close();
      const cases = join(writer.directory, 'cases');
      const original = join(writer.directory, 'cases-before-swap');
      await mkdir(join(outside, 'direct-review'), { recursive: true });
      await writeFile(join(outside, 'direct-review', 'trial-1.json'), await readFile(join(cases, 'direct-review', 'trial-1.json')));
      const readWithSnapshot = readEvalTrials as unknown as (
        directory: string,
        options: { readonly afterCasesSnapshot: () => Promise<void> },
      ) => Promise<readonly unknown[]>;

      await expect(readWithSnapshot(writer.directory, {
        afterCasesSnapshot: async () => {
          await rename(cases, original);
          await symlink(outside, cases);
        },
      })).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });
    } finally {
      await rm(outside, { force: true, recursive: true });
      await writer.close().catch(() => undefined);
    }
  });
});

it('refuses lexical, absolute, and Windows-absolute run storage escapes without creating them', async () => {
  await withProject(async (root) => {
    const outside = `${root}-outside`;
    try {
      await expect(createEvalRun(runOptions(root, { runsDir: '../escaped-runs' })))
        .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(createEvalRun(runOptions(root, { runsDir: outside })))
        .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(createEvalRun(runOptions(root, { runsDir: 'C:\\escaped-runs' })))
        .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

it('refuses a configured storage ancestor that is a symlink outside the project', async () => {
  await withProject(async (root) => {
    const outside = `${root}-outside`;
    try {
      await symlink(outside, join(root, '.agent-bundle'));
      await expect(createEvalRun(runOptions(root))).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(readdir(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

it('refuses writes when a run directory is replaced with an outside symlink', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const outside = `${root}-outside`;
    try {
      await rm(writer.directory, { force: true, recursive: true });
      await symlink(outside, writer.directory);

      await expect(writer.appendEvent({ kind: 'escaped', payload: {} }))
        .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
      await expect(readdir(outside)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(writer.close()).rejects.toBeInstanceOf(AggregateError);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});

it('makes close an admission barrier while draining writes admitted before it starts', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const admitted = writer.appendEvent({ kind: 'before-close', payload: {} });
    const close = writer.close();

    await expect(writer.appendEvent({ kind: 'after-close', payload: {} }))
      .rejects.toMatchObject({ code: 'EVAL_RUN_CLOSED' });
    await admitted;
    await close;
    expect((await readEvalRunEvents(writer.directory)).events.map((event) => event.kind)).toEqual(['before-close']);
  });
});

it('shares a failing close outcome after an admitted storage write fails', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const eventsPath = join(writer.directory, 'events.jsonl');
    await rm(eventsPath);
    await symlink(`${root}-outside-events`, eventsPath);

    const write = writer.appendEvent({ kind: 'blocked', payload: {} });
    const firstClose = writer.close();
    const secondClose = writer.close();
    expect(firstClose).toBe(secondClose);
    await expect(write).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    await expect(firstClose).rejects.toBeInstanceOf(AggregateError);
  });
});

it('makes finish terminal before later writes can enter the run', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const finished = writer.finish({ cases: 1, fail: 0, inconclusive: 0, pass: 1, trials: 1 });

    await expect(writer.appendEvent({ kind: 'after-finish', payload: {} }))
      .rejects.toMatchObject({ code: 'EVAL_RUN_CLOSED' });
    await expect(writer.writeArtifactFile('after-finish.json', '{}')).rejects.toMatchObject({ code: 'EVAL_RUN_CLOSED' });
    await finished;
    await writer.close();
    expect((await readEvalRunEvents(writer.directory)).events).toEqual([]);
  });
});

it('rejects hostile and non-JSON trial and event inputs without evaluating accessors', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    let accessorRead = false;
    const accessorTrial = trialInput();
    Object.defineProperty(accessorTrial, 'caseId', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        throw new Error('must not run');
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const proxiedTrial = new Proxy(trialInput(), {
      ownKeys: () => {
        throw new Error('must reject proxy');
      },
    });

    await expect(writer.writeTrial(accessorTrial)).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    expect(accessorRead).toBe(false);
    await expect(writer.writeTrial(proxiedTrial)).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    await expect(writer.appendEvent({ kind: 'non-finite', payload: { value: Number.NaN } }))
      .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    await expect(writer.appendEvent({ kind: 'cycle', payload: cyclic })).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    await expect(writer.appendEvent({ kind: 'symbol', payload: { value: Symbol('unsafe') } }))
      .rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    await writer.close();
  });
});

it('rejects accessor-backed run creation options before evaluating them', async () => {
  await withProject(async (root) => {
    let accessorRead = false;
    const options = runOptions(root);
    Object.defineProperty(options, 'artifact', {
      enumerable: true,
      get: () => {
        accessorRead = true;
        throw new Error('must not run');
      },
    });

    await expect(createEvalRun(options)).rejects.toMatchObject({ code: 'EVAL_RUN_RECORD_INVALID' });
    expect(accessorRead).toBe(false);
  });
});

it('persists detached deep-frozen trial and event snapshots including null-prototype __proto__ data', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', {
      configurable: true,
      enumerable: true,
      value: Object.freeze({ retained: 'yes' }),
      writable: true,
    });
    const input = trialInput();
    const written = await writer.writeTrial(input);
    const event = await writer.appendEvent({ kind: 'snapshot', payload });
    (input.assertions as unknown as { detail: string }[])[0]!.detail = 'mutated';
    (input.evidence.mcp.calls as { server: string; tool: string }[]).push({ server: 'later', tool: 'mutation' });

    expect(written.assertions[0]!.detail).toBe('The process exited with code 0.');
    expect(Object.isFrozen(written.assertions)).toBe(true);
    expect(Object.isFrozen(written.evidence.mcp)).toBe(true);
    expect(Object.hasOwn(event.payload as object, '__proto__')).toBe(true);
    expect((event.payload as Record<string, unknown>).__proto__).toEqual({ retained: 'yes' });
    expect(Object.isFrozen(event.payload)).toBe(true);

    const [persisted] = await readEvalTrials(writer.directory);
    expect(persisted!.assertions[0]!.detail).toBe('The process exited with code 0.');
    expect(Object.isFrozen(persisted!.evidence.mcp.calls)).toBe(true);
    await writer.close();
  });
});

it('rejects malformed persisted summary, trial, and event schemas instead of returning shallow records', async () => {
  await withProject(async (root) => {
    const writer = await createEvalRun(runOptions(root));
    await writer.writeTrial(trialInput());
    await writer.appendEvent({ kind: 'complete', payload: {} });
    await writer.close();

    await writeFile(join(writer.directory, 'run.json'), JSON.stringify({
      ...writer.record,
      summary: { cases: 'one', fail: 0, inconclusive: 0, pass: 0, trials: 0 },
    }));
    await expect(readEvalRun(writer.directory)).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });

    await writeFile(join(writer.directory, 'cases', 'direct-review', 'trial-1.json'), JSON.stringify({ schemaVersion: 1 }));
    await expect(readEvalTrials(writer.directory)).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });

    await writeFile(join(writer.directory, 'events.jsonl'), `${JSON.stringify({ kind: '', payload: {}, schemaVersion: 1, sequence: 1, timestamp: '2026-08-17T12:00:00.000Z' })}\n`);
    await expect(readEvalRunEvents(writer.directory)).rejects.toMatchObject({ code: 'EVAL_RUN_CORRUPT' });
  });
});
