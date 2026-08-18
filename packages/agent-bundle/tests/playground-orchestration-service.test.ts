import { expect, it } from '@rstest/core';

import {
  PlaygroundOrchestrationService,
  type PlaygroundDurableTraceStore,
  type PlaygroundEpochAuthority,
} from '../src/dev/playground-orchestration-service.ts';
import type {
  DraftEvalCase,
  PlaygroundDurableOutcome,
  PlaygroundEventInput,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundReplayCursor,
  PlaygroundSelectedAssertion,
  PlaygroundSession,
  PlaygroundSessionInput,
  PlaygroundSubscribeOptions,
  PlaygroundSubscription,
  PlaygroundTraceEvent,
} from '../src/services/playground-service.ts';
import type { ProjectStatus } from '../src/dev/types.ts';

const activeEpoch = Object.freeze({
  configDigest: 'config-sha256',
  createdAt: '2026-08-18T00:00:00.000Z',
  diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
  id: 'epoch-active',
  manifestPath: 'agent-bundle.manifest.json',
  modelDigest: 'model-sha256',
  projectRevision: 'revision-sha256',
  targetDigests: Object.freeze({ codex: 'target-sha256' }),
});

const currentStatus = (): ProjectStatus => Object.freeze({
  artifact: Object.freeze({ activeEpoch, currentSourceRevision: 'revision-sha256', state: 'active' as const }),
  build: Object.freeze({ state: 'idle' as const }),
  source: Object.freeze({ diagnostics: Object.freeze([]), state: 'ready' as const }),
});

class RecordingTraceStore implements PlaygroundDurableTraceStore {
  readonly appended: PlaygroundEventInput[] = [];
  closed = 0;
  finalized: PlaygroundDurableOutcome | undefined;
  input: PlaygroundSessionInput | undefined;
  readonly promoted: PlaygroundSelectedAssertion[][] = [];
  #session: PlaygroundSession | undefined;

  async openSession(input: PlaygroundSessionInput): Promise<PlaygroundSession> {
    this.input = input;
    this.#session = Object.freeze({
      cleanupFailures: Object.freeze([]),
      createdAt: '2026-08-18T00:00:00.000Z',
      id: input.sessionId!,
      identity: Object.freeze({
        epoch: input.epoch,
        fixture: input.fixture,
        invocation: input.invocation,
        target: input.target,
        task: input.task,
      }),
      state: 'open',
    });
    return this.#session;
  }

  async append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent> {
    this.appended.push(input);
    return Object.freeze({ ...input, rawEventRef: `events.jsonl#${this.appended.length}`, sequence: this.appended.length, timestamp: '2026-08-18T00:00:01.000Z' });
  }

  async finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession> {
    this.finalized = outcome;
    const session = this.#session;
    if (session === undefined) throw new Error('Expected the run to open a session first.');
    this.#session = Object.freeze({ ...session, outcome, state: 'finalized' });
    return this.#session;
  }

  session(sessionId: string): PlaygroundSession | undefined {
    return sessionId === this.#session?.id ? this.#session : undefined;
  }

  async replay(_sessionId: string, _cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    const session = this.#session;
    if (session === undefined) throw new Error('Expected a session.');
    return Object.freeze({ cursor: Object.freeze({ afterSequence: this.appended.length }), events: Object.freeze([]), session });
  }

  async subscribe(_sessionId: string, _options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription> {
    return Object.freeze({ close: async () => undefined, closed: false });
  }

  async export(_sessionId: string): Promise<PlaygroundExport> {
    const session = this.#session;
    if (session === undefined) throw new Error('Expected a session.');
    return Object.freeze({
      events: Object.freeze(this.appended.map((input, index) => Object.freeze({
        ...input,
        rawEventRef: `events.jsonl#${index + 1}`,
        sequence: index + 1,
        timestamp: '2026-08-18T00:00:01.000Z',
      }))),
      schemaVersion: 1,
      session,
    });
  }

  async promoteToDraftEval(sessionId: string, assertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase> {
    this.promoted.push([...assertions]);
    const session = this.#session;
    if (session?.outcome === undefined) throw new Error('Expected a finalized session.');
    return Object.freeze({ ...session.identity, assertions, outcome: session.outcome, schemaVersion: 1 });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

const epochAuthority = (calls: string[]): PlaygroundEpochAuthority => Object.freeze({
  acquireEpochReference: async (epochId: string) => {
    calls.push(epochId);
    return Object.freeze({ close: async () => { calls.push(`close:${epochId}`); }, root: `/epochs/${epochId}` });
  },
});

it('mints a run and session from the active epoch while deriving every durable identity and evidence field', async () => {
  const trace = new RecordingTraceStore();
  const references: string[] = [];
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-server-owned',
    createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority(references),
    skillDocuments: { generated: async (epochId, target, skillId) => Object.freeze({ id: skillId, markdown: '# Review', target }) },
    trace,
  });

  const run = await service.run({
    epochId: 'forged-cross-epoch',
    operation: 'skill.inspect',
    skillId: 'skill:review',
    target: 'codex',
  } as unknown as Parameters<typeof service.run>[0]);

  expect(run).toMatchObject({ id: 'run-server-owned', session: { id: 'session-server-owned', state: 'finalized' } });
  expect(references).toEqual(['epoch-active', 'close:epoch-active']);
  expect(trace.input).toMatchObject({
    epoch: { id: 'epoch-active' },
    fixture: { id: 'server-owned-workspace' },
    invocation: { intent: { skillId: 'skill:review' }, kind: 'skill.inspect' },
    sessionId: 'session-server-owned',
    target: { digest: 'target-sha256', name: 'codex' },
    task: { id: 'run-server-owned' },
  });
  expect(trace.appended).toEqual([
    expect.objectContaining({ kind: 'epoch.bound', source: 'build' }),
    expect.objectContaining({ kind: 'skill.inspected', raw: { skillId: 'skill:review' }, source: 'skill-evidence' }),
  ]);
  expect(trace.finalized).toEqual({ status: 'passed' });
});

it('cancels the actual script operation, finalizes its server-owned trace, and releases its epoch reference', async () => {
  const trace = new RecordingTraceStore();
  const references: string[] = [];
  let entered!: () => void;
  const enteredScript = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
  let observed: AbortSignal | undefined;
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-server-owned',
    createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority(references),
    scripts: { run: async ({ signal }) => {
      observed = signal;
      entered();
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
    trace,
  });
  const running = service.run({ operation: 'script.run', script: 'review.mjs', target: 'codex' });
  await enteredScript;

  await expect(service.cancel('run-server-owned')).resolves.toBe(true);
  await expect(running).resolves.toMatchObject({ session: { state: 'finalized' } });
  expect(observed?.aborted).toBe(true);
  expect(trace.finalized).toEqual({ status: 'cancelled' });
  expect(references).toEqual(['epoch-active', 'close:epoch-active']);
});

it('promotes only persisted raw event references and closes admission before draining active work', async () => {
  const trace = new RecordingTraceStore();
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-server-owned',
    createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]),
    skillDocuments: { generated: async () => Object.freeze({ id: 'skill:review', markdown: '# Review' }) },
    trace,
  });
  await service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' });

  await expect(service.promoteToDraftEval('session-server-owned', ['events.jsonl#2'])).resolves.toMatchObject({ schemaVersion: 1 });
  expect(trace.promoted).toEqual([[{
    evidence: { rawEventRef: 'events.jsonl#2' },
    expectation: { kind: 'skill.inspected', source: 'skill-evidence' },
    id: 'events.jsonl#2',
    kind: 'playground-event',
  }]]);
  await expect(service.promoteToDraftEval('session-server-owned', ['events.jsonl#forged'])).rejects.toThrow('not a persisted playground event');

  await service.close();
  await expect(service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' })).rejects.toThrow('closed');
  expect(trace.closed).toBe(1);
});
