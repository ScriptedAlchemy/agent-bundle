import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  PlaygroundOrchestrationService,
  type PlaygroundDurableTraceStore,
  type PlaygroundEpochAuthority,
} from '../src/dev/playground-orchestration-service.ts';
import {
  ScriptPlaygroundAbortError,
  ScriptPlaygroundFailure,
} from '../src/dev/script-playground-service.ts';
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
import { PlaygroundService } from '../src/services/playground-service.ts';
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

const eventually = async (assertion: () => void): Promise<void> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { assertion(); return; } catch (error) { failure = error; }
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 2); });
  }
  throw failure;
};

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
    return Object.freeze({
      cursor: Object.freeze({ afterSequence: this.appended.length }),
      events: Object.freeze(this.appended.map((input, index) => Object.freeze({ ...input, rawEventRef: `events.jsonl#${index + 1}`, sequence: index + 1, timestamp: '2026-08-18T00:00:01.000Z' }))),
      session,
    });
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

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#session;
    if (session?.id !== sessionId) throw new Error('Expected the session to exist before closing it.');
    this.#session = Object.freeze({ ...session, outcome: Object.freeze({ status: 'aborted' }), state: 'closed' });
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

  expect(run).toMatchObject({ id: 'run-server-owned', session: { id: 'session-server-owned', state: 'open' } });
  await eventually(() => expect(trace.finalized).toEqual({ status: 'passed' }));
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

it('admits a gated operation promptly, replays its epoch binding, and cancels the actual script work', async () => {
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
  const admitted = await service.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof service.run>[0]);
  expect(admitted.session.state).toBe('open');
  await expect(service.replay(admitted.session.id)).resolves.toMatchObject({ events: [expect.objectContaining({ kind: 'epoch.bound' })] });
  await enteredScript;

  await expect(service.cancel('run-server-owned')).resolves.toBe(true);
  expect(observed?.aborted).toBe(true);
  expect(trace.finalized).toEqual({ status: 'cancelled' });
  expect(references).toEqual(['epoch-active', 'close:epoch-active']);
});

it('atomically pins an omitted native prompt to the active epoch and persists awaited progress before normalized host evidence', async () => {
  const trace = new RecordingTraceStore();
  const calls: string[] = [];
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-a',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ claude: 'native-target-digest' }),
  });
  const reference = Object.freeze({ close: async () => { calls.push('release'); }, epoch: nativeEpoch, root: '/epochs/native-a' });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native',
    createSessionId: () => 'session-native',
    epochStore: {
      acquireActiveEpochReference: async () => { calls.push('acquire-active'); return reference; },
      acquireEpochReference: async () => { throw new Error('Native omission must not read coordinator then acquire by id.'); },
    },
    native: {
      close: async () => { calls.push('native-close'); },
      prepare: async (receivedReference: unknown, request: unknown) => {
        calls.push('prepare');
        expect(receivedReference).toBe(reference);
        expect(request).toMatchObject({ operation: 'native.prompt', prompt: 'Review the fixture.', target: 'claude' });
        return Object.freeze({ epochId: nativeEpoch.id, fixtureDigest: 'fixture-content-digest', host: 'claude', prompt: 'Review the fixture.', target: 'claude' });
      },
      run: async (_prepared: unknown, options: { readonly emit: (event: PlaygroundEventInput) => Promise<void>; readonly signal: AbortSignal }) => {
        await options.emit(Object.freeze({ kind: 'native.preflight', raw: Object.freeze({ phase: 'preflight' }), source: 'host-preflight', summary: 'Native host preflight completed.' }));
        await options.emit(Object.freeze({ kind: 'native.fixture.materialized', raw: Object.freeze({ phase: 'fixture.materialized' }), source: 'host-preflight', summary: 'Native fixture materialized.' }));
        return Object.freeze({
          events: Object.freeze([Object.freeze({ kind: 'native.activation', raw: Object.freeze({ activated: Object.freeze([]), level: 'unavailable' }), source: 'skill-evidence', summary: 'Recorded normalized native Skill activation evidence.' })]),
          response: 'Safe normalized response.',
          status: 'passed' as const,
          workspace: Object.freeze({ changes: Object.freeze([]) }),
        });
      },
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);

  const admitted = await service.run({
    caseId: 'opaque-case-a',
    fixtureId: 'opaque-fixture-a',
    host: 'claude',
    modelPinId: 'opaque-model-a',
    operation: 'native.prompt',
    prompt: 'Review the fixture.',
    target: 'claude',
  });
  expect(admitted.session.identity).toMatchObject({ epoch: { id: 'epoch-native-a' }, fixture: { digest: 'fixture-content-digest', id: 'opaque-fixture-a' } });
  await eventually(() => expect(trace.finalized).toEqual({ response: 'Safe normalized response.', status: 'passed', workspace: { changes: [] } }));
  expect(calls).toEqual(['acquire-active', 'prepare', 'release']);
  expect(trace.appended.map((event) => event.kind)).toEqual([
    'epoch.bound',
    'native.preflight',
    'native.fixture.materialized',
    'native.activation',
  ]);
});

it('cancels an admitted native host after its safe start progress and releases the exact epoch once', async () => {
  const trace = new RecordingTraceStore();
  const calls: string[] = [];
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-cancel',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ claude: 'native-target-digest' }),
  });
  const reference = Object.freeze({ close: async () => { calls.push('release'); }, epoch: nativeEpoch, root: '/epochs/native-cancel' });
  let spawned!: () => void;
  const started = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native-cancel',
    createSessionId: () => 'session-native-cancel',
    epochStore: {
      acquireActiveEpochReference: async () => { calls.push('acquire-active'); return reference; },
      acquireEpochReference: async () => { throw new Error('Native cancellation must retain its active epoch reference.'); },
    },
    native: {
      close: async () => undefined,
      prepare: async () => {
        calls.push('prepare');
        return Object.freeze({ epochId: nativeEpoch.id, fixtureDigest: 'fixture-content-digest', host: 'claude', prompt: 'Review the fixture.', target: 'claude' });
      },
      run: async (_prepared: unknown, options: { readonly emit: (event: PlaygroundEventInput) => Promise<void>; readonly signal: AbortSignal }) => {
        calls.push('run');
        await options.emit(Object.freeze({ kind: 'native.host.started', raw: Object.freeze({ phase: 'host.started' }), source: 'host-preflight', summary: 'Native host process started.' }));
        spawned();
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      },
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);

  const admitted = await service.run({
    caseId: 'opaque-case-a',
    fixtureId: 'opaque-fixture-a',
    host: 'claude',
    modelPinId: 'opaque-model-a',
    operation: 'native.prompt',
    prompt: 'Review the fixture.',
    target: 'claude',
  });
  await started;
  await expect(service.cancel(admitted.id)).resolves.toBe(true);

  expect(trace.appended.map((event) => event.kind)).toEqual(['epoch.bound', 'native.host.started', 'operation.cancelled']);
  expect(trace.finalized).toEqual({ status: 'cancelled' });
  expect(calls).toEqual(['acquire-active', 'prepare', 'run', 'release']);
});

it('persists normalized native completion evidence before a cancelled terminal outcome', async () => {
  const trace = new RecordingTraceStore();
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-cancel-evidence',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ claude: 'native-target-digest' }),
  });
  const reference = Object.freeze({ close: async () => undefined, epoch: nativeEpoch, root: '/epochs/native-cancel-evidence' });
  let spawned!: () => void;
  const started = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native-cancel-evidence',
    createSessionId: () => 'session-native-cancel-evidence',
    epochStore: {
      acquireActiveEpochReference: async () => reference,
      acquireEpochReference: async () => { throw new Error('Expected active native epoch reference.'); },
    },
    native: {
      close: async () => undefined,
      prepare: async () => Object.freeze({ epochId: nativeEpoch.id, fixtureDigest: 'fixture-content-digest', host: 'claude', prompt: 'Review the fixture.', target: 'claude' }),
      run: async (_prepared: unknown, options: { readonly emit: (event: PlaygroundEventInput) => Promise<void>; readonly signal: AbortSignal }) => {
        await options.emit(Object.freeze({ kind: 'native.host.started', raw: Object.freeze({ phase: 'host.started' }), source: 'host-preflight', summary: 'Native host process started.' }));
        spawned();
        return new Promise((resolvePromise) => options.signal.addEventListener('abort', () => resolvePromise(Object.freeze({
          events: Object.freeze([
            Object.freeze({ kind: 'native.harness.failed', raw: Object.freeze({ code: 'EVAL_TRACE_UNAVAILABLE', stage: 'trace' }), source: 'host-preflight', summary: 'Native host could not complete the requested run.' }),
            Object.freeze({ kind: 'native.workspace', raw: Object.freeze({ changes: Object.freeze([]) }), source: 'workspace-change', summary: 'Recorded bounded native workspace changes.' }),
          ]),
          status: 'failed' as const,
          workspace: Object.freeze({ changes: Object.freeze([]) }),
        })), { once: true }));
      },
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);

  const admitted = await service.run({
    caseId: 'opaque-case-a',
    fixtureId: 'opaque-fixture-a',
    host: 'claude',
    modelPinId: 'opaque-model-a',
    operation: 'native.prompt',
    prompt: 'Review the fixture.',
    target: 'claude',
  });
  await started;
  await service.cancel(admitted.id);

  expect(trace.appended.map((event) => event.kind)).toEqual([
    'epoch.bound',
    'native.host.started',
    'native.harness.failed',
    'native.workspace',
    'operation.cancelled',
  ]);
  expect(trace.finalized).toEqual({ status: 'cancelled', workspace: { changes: [] } });
});

it('exports and promotes the real durable response event reference from a native run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-playground-durable-'));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const trace = new PlaygroundService({
    projectId: 'native-durable-project',
    projectRoot,
    storageRoot: join(projectRoot, '.agent-bundle', 'playground'),
  });
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-durable',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ codex: 'native-target-digest' }),
  });
  const reference = Object.freeze({ close: async () => undefined, epoch: nativeEpoch, root: '/epochs/native-durable' });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native-durable',
    createSessionId: () => 'session-native-durable',
    epochStore: {
      acquireActiveEpochReference: async () => reference,
      acquireEpochReference: async () => { throw new Error('Expected active native epoch reference.'); },
    },
    native: {
      close: async () => undefined,
      prepare: async () => Object.freeze({ epochId: nativeEpoch.id, fixtureDigest: 'fixture-content-digest', host: 'codex', prompt: 'Review the fixture.', target: 'codex' }),
      run: async () => Object.freeze({
        events: Object.freeze([
          Object.freeze({ kind: 'native.response', raw: Object.freeze({ text: 'Safe native response.' }), source: 'response' as const, summary: 'Recorded normalized native host response.' }),
        ]),
        response: 'Safe native response.',
        status: 'passed' as const,
      }),
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);
  try {
    const admitted = await service.run({
      caseId: 'opaque-case-a', fixtureId: 'opaque-fixture-a', host: 'codex', modelPinId: 'opaque-model-a',
      operation: 'native.prompt', prompt: 'Review the fixture.', target: 'codex',
    });
    await eventually(() => expect(trace.session(admitted.session.id)?.state).toBe('finalized'));
    const exported = await service.export(admitted.session.id);
    const response = exported.events.find((event) => event.kind === 'native.response');
    expect(response).toMatchObject({ raw: { text: 'Safe native response.' }, rawEventRef: 'events.jsonl#2' });
    expect(response?.rawEventRef).not.toContain('native-raw-');
    await expect(service.promoteToDraftEval(admitted.session.id, [response!.rawEventRef])).resolves.toMatchObject({
      assertions: [expect.objectContaining({ evidence: { rawEventRef: 'events.jsonl#2' } })],
    });
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

it('publishes the Playground close promise before a native abort handler re-enters close', async () => {
  const trace = new RecordingTraceStore();
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-reentrant-close',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ claude: 'native-target-digest' }),
  });
  const reference = Object.freeze({ close: async () => undefined, epoch: nativeEpoch, root: '/epochs/native-reentrant-close' });
  let reentrant: Promise<void> | undefined;
  const serviceOptions = {
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native-reentrant-close',
    createSessionId: () => 'session-native-reentrant-close',
    epochStore: {
      acquireActiveEpochReference: async () => reference,
      acquireEpochReference: async () => { throw new Error('Expected active native epoch reference.'); },
    },
    native: {
      close: async () => undefined,
      prepare: async () => Object.freeze({ epochId: nativeEpoch.id, fixtureDigest: 'fixture-content-digest', host: 'claude', prompt: 'Review the fixture.', target: 'claude' }),
      run: async (_prepared: unknown, options: { readonly signal: AbortSignal }) => new Promise((resolvePromise) => {
        options.signal.addEventListener('abort', () => {
          reentrant = service.close();
          resolvePromise(Object.freeze({ events: Object.freeze([]), status: 'failed' as const }));
        }, { once: true });
      }),
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0];
  const service = new PlaygroundOrchestrationService(serviceOptions);
  await service.run({
    caseId: 'opaque-case-a', fixtureId: 'opaque-fixture-a', host: 'claude', modelPinId: 'opaque-model-a',
    operation: 'native.prompt', prompt: 'Review the fixture.', target: 'claude',
  });
  const closing = service.close();
  const settled = await Promise.race([
    closing.then(() => true, () => true),
    new Promise<boolean>((resolvePromise) => { setTimeout(() => resolvePromise(false), 50); }),
  ]);
  expect(settled).toBe(true);
  expect(reentrant).toBe(closing);
});

it('keeps a native prepare failure primary when releasing its epoch lease also fails', async () => {
  const trace = new RecordingTraceStore();
  const prepareFailure = new Error('native prepare failed');
  const releaseFailure = new Error('epoch release failed');
  const nativeEpoch = Object.freeze({
    configDigest: 'native-config-digest',
    createdAt: '2026-08-18T00:00:00.000Z',
    diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
    id: 'epoch-native-prepare-failure',
    manifestPath: 'agent-bundle.manifest.json',
    modelDigest: 'native-model-digest',
    projectRevision: 'native-revision-digest',
    targetDigests: Object.freeze({ claude: 'native-target-digest' }),
  });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-native-prepare-failure',
    createSessionId: () => 'session-native-prepare-failure',
    epochStore: {
      acquireActiveEpochReference: async () => Object.freeze({ close: async () => { throw releaseFailure; }, epoch: nativeEpoch, root: '/epochs/native-prepare-failure' }),
      acquireEpochReference: async () => { throw new Error('Expected active native epoch reference.'); },
    },
    native: {
      close: async () => undefined,
      prepare: async () => { throw prepareFailure; },
      run: async () => Object.freeze({ events: Object.freeze([]), status: 'failed' as const }),
    },
    trace,
  } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);

  let received: unknown;
  try {
    await service.run({
      caseId: 'opaque-case-a', fixtureId: 'opaque-fixture-a', host: 'claude', modelPinId: 'opaque-model-a',
      operation: 'native.prompt', prompt: 'Review the fixture.', target: 'claude',
    });
  } catch (error) { received = error; }
  expect(received).toBeInstanceOf(AggregateError);
  expect((received as AggregateError).errors).toEqual([prepareFailure, releaseFailure]);
});

it('gives cancellation precedence when a gated Skill ignores its AbortSignal', async () => {
  const trace = new RecordingTraceStore();
  let release!: () => void;
  const gated = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus },
    createRunId: () => 'run-server-owned',
    createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]),
    skillDocuments: { generated: async () => gated },
    trace,
  });
  const admitted = await service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' });
  let cancelled = false;
  const pending = service.cancel(admitted.id).then(() => { cancelled = true; });
  await Promise.resolve();
  expect(cancelled).toBe(false);
  release();
  await pending;
  expect(trace.finalized).toEqual({ status: 'cancelled' });
  expect(trace.appended.some((event) => event.kind === 'skill.inspected')).toBe(false);
});

it('keeps close pending through epoch-reference release and reports its contained failure', async () => {
  const trace = new RecordingTraceStore();
  let entered!: () => void;
  const enteredRelease = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
  let failRelease!: (error: Error) => void;
  const release = new Promise<void>((_resolvePromise, rejectPromise) => { failRelease = rejectPromise; });
  const references: string[] = [];
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: {
      acquireEpochReference: async (epochId) => {
        references.push(epochId);
        return Object.freeze({ close: async () => { entered(); await release; }, root: `/epochs/${epochId}` });
      },
    },
    skillDocuments: { generated: async () => undefined }, trace,
  });
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' });
    await enteredRelease;
    let settled = false;
    const closing = service.close().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    failRelease(new Error('epoch release failed'));
    await expect(closing).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'epoch release failed' }) });
    expect(rejections).toEqual([]);
    expect(references).toEqual(['epoch-active']);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

it('records the selected script id and its nonzero exit as durable failed script evidence', async () => {
  const trace = new RecordingTraceStore();
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]), scripts: { run: async () => Object.freeze({ exitCode: 17, script: 'review', stderr: 'failed', stdout: 'reviewed' }) }, trace,
  });
  await service.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof service.run>[0]);
  await eventually(() => expect(trace.finalized).toEqual({ status: 'failed' }));
  expect(trace.input?.invocation).toEqual({ intent: { scriptId: 'script:review' }, kind: 'script.run' });
  expect(trace.appended).toContainEqual(expect.objectContaining({
    kind: 'script.completed',
    raw: { result: { exitCode: 17, script: 'review', stderr: 'failed', stdout: 'reviewed' }, targetDigest: 'target-sha256' },
    source: 'script',
  }));
});

it('records a clean zero-exit script as passed evidence', async () => {
  const trace = new RecordingTraceStore();
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]), scripts: { run: async () => Object.freeze({ exitCode: 0, script: 'review', stderr: '', stdout: 'reviewed' }) }, trace,
  });

  await service.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof service.run>[0]);
  await eventually(() => expect(trace.finalized).toEqual({ status: 'passed' }));
  expect(trace.appended).toContainEqual(expect.objectContaining({
    kind: 'script.completed',
    raw: { result: { exitCode: 0, script: 'review', stderr: '', stdout: 'reviewed' }, targetDigest: 'target-sha256' },
    source: 'script',
  }));
});

it('persists stable admitted script infrastructure failures with safe partial output', async () => {
  for (const code of ['timeout', 'output-limit', 'interpreter-unavailable'] as const) {
    const trace = new RecordingTraceStore();
    const failure = new ScriptPlaygroundFailure(
      code,
      'Script ' + code + ' failure.',
      { stderr: 'partial stderr', stdout: 'partial stdout' },
    );
    const service = new PlaygroundOrchestrationService({
      coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
      epochStore: epochAuthority([]), scripts: { run: async () => { throw failure; } }, trace,
    });

    await service.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof service.run>[0]);
    await eventually(() => expect(trace.finalized).toEqual({ status: 'failed' }));
    expect(trace.appended).toContainEqual(expect.objectContaining({
      kind: 'operation.failed',
      raw: {
        failure: { code, stderr: 'partial stderr', stdout: 'partial stdout' },
        operation: 'script.run',
      },
      source: 'diagnostics',
    }));
  }
});

it('persists script lifecycle cleanup evidence without replacing the primary outcome', async () => {
  const successfulTrace = new RecordingTraceStore();
  const successful = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]),
    scripts: { run: async () => Object.freeze({
      cleanupFailures: Object.freeze([{ code: 'workspace-release-failed' as const }]),
      exitCode: 0,
      script: 'review',
      stderr: '',
      stdout: 'completed',
    }) },
    trace: successfulTrace,
  });
  await successful.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof successful.run>[0]);
  await eventually(() => expect(successfulTrace.finalized).toEqual({ status: 'failed' }));
  expect(successfulTrace.appended).toContainEqual(expect.objectContaining({
    kind: 'script.completed',
    raw: expect.objectContaining({ result: expect.objectContaining({
      cleanupFailures: [{ code: 'workspace-release-failed' }],
      exitCode: 0,
    }) }),
  }));

  const failedTrace = new RecordingTraceStore();
  const timedOut = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]),
    scripts: { run: async () => {
      throw new ScriptPlaygroundFailure(
        'timeout',
        'Script execution timed out.',
        { stderr: '', stdout: '' },
        [{ code: 'workspace-release-failed' }],
      );
    } },
    trace: failedTrace,
  });
  await timedOut.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof timedOut.run>[0]);
  await eventually(() => expect(failedTrace.finalized).toEqual({ status: 'failed' }));
  expect(failedTrace.appended).toContainEqual(expect.objectContaining({
    kind: 'operation.failed',
    raw: {
      cleanupFailures: [{ code: 'workspace-release-failed' }],
      failure: { code: 'timeout', stderr: '', stdout: '' },
      operation: 'script.run',
    },
  }));

  const cancelledTrace = new RecordingTraceStore();
  const cancelled = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned',
    epochStore: epochAuthority([]),
    scripts: { run: async ({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new ScriptPlaygroundAbortError([
        { code: 'workspace-release-failed' },
      ])), { once: true });
    }) },
    trace: cancelledTrace,
  });
  const admitted = await cancelled.run({ operation: 'script.run', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<typeof cancelled.run>[0]);
  await cancelled.cancel(admitted.id);
  expect(cancelledTrace.appended).toContainEqual(expect.objectContaining({
    kind: 'operation.cancelled',
    raw: { cleanupFailures: [{ code: 'workspace-release-failed' }], operation: 'script.run' },
  }));
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
  await eventually(() => expect(trace.finalized).toEqual({ status: 'passed' }));

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

it('derives failed outcomes from script exits, hook diagnostics, and MCP error results while preserving the canonical epoch target digest', async () => {
  const cases = [
    {
      operation: { operation: 'script.run' as const, scriptId: 'script:review', target: 'codex' } as unknown as Parameters<PlaygroundOrchestrationService['run']>[0],
      services: { scripts: { run: async () => Object.freeze({ exitCode: 17, script: 'review.mjs', stderr: 'failed', stdout: '' }) } },
    },
    {
      operation: { hook: 'session-start', input: {}, operation: 'hook.simulate' as const, target: 'codex' },
      services: { hookPlayground: { simulate: async () => Object.freeze({ diagnostics: Object.freeze([{ severity: 'error' as const }]) }) } },
    },
    {
      operation: { arguments: {}, operation: 'mcp.call-tool' as const, serverName: 'fixture', target: 'codex', tool: 'fail' },
      services: { mcpSessions: { closeSession: async () => true, open: async () => Object.freeze({ callTool: async () => Object.freeze({ isError: true }), id: 'mcp-server-owned' }) } },
    },
  ] as const;
  for (const { operation, services } of cases) {
    const trace = new RecordingTraceStore();
    const service = new PlaygroundOrchestrationService({ coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned', epochStore: epochAuthority([]), trace, ...services } as unknown as ConstructorParameters<typeof PlaygroundOrchestrationService>[0]);
    await service.run(operation);
    await eventually(() => expect(trace.finalized).toEqual({ status: 'failed' }));
    if (operation.operation === 'script.run') {
      expect(trace.appended[1]).toMatchObject({ raw: { targetDigest: 'target-sha256' } });
    }
  }
});

it('contains failed epoch binding append without retaining an open usable session', async () => {
  const trace = new RecordingTraceStore();
  const append = trace.append.bind(trace);
  trace.append = async (_sessionId, input) => {
    if (input.kind === 'epoch.bound') throw new Error('epoch append failed');
    return append('session-server-owned', input);
  };
  const service = new PlaygroundOrchestrationService({ coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned', epochStore: epochAuthority([]), trace });
  await expect(service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' })).rejects.toThrow('epoch append failed');
  expect(trace.session('session-server-owned')).toMatchObject({ outcome: { status: 'failed' }, state: 'finalized' });
});

it('contains post-admission terminalization faults without an unhandled rejection and reports them from close', async () => {
  const trace = new RecordingTraceStore();
  const append = trace.append.bind(trace);
  trace.append = async (sessionId, input) => {
    if (input.kind === 'skill.inspected' || input.kind === 'operation.failed') throw new Error('post-admission append failed');
    return append(sessionId, input);
  };
  const service = new PlaygroundOrchestrationService({
    coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned', epochStore: epochAuthority([]),
    skillDocuments: { generated: async () => undefined }, trace,
  });
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const admitted = await service.run({ operation: 'skill.inspect', skillId: 'skill:review', target: 'codex' });
    await eventually(() => expect(trace.session(admitted.session.id)?.state).toBe('closed'));
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 0); });
    expect(rejections).toEqual([]);
    await expect(service.close()).rejects.toThrow('background operations');
    expect(trace.session(admitted.session.id)?.state).toBe('closed');
  } finally { process.off('unhandledRejection', onUnhandled); }
});

it('turns hostile getter, proxy, and cyclic operation evidence into an unavailable marker without evaluating it', async () => {
  let getterRead = 0;
  const getter = Object.create(null) as { readonly value: unknown };
  Object.defineProperty(getter, 'value', { enumerable: true, get: () => { getterRead += 1; return 'leak'; } });
  const proxy = new Proxy({}, { ownKeys: () => { throw new Error('proxy trap'); } });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const result of [getter, proxy, cyclic]) {
    const trace = new RecordingTraceStore();
    const service = new PlaygroundOrchestrationService({ coordinator: { status: currentStatus }, createRunId: () => 'run-server-owned', createSessionId: () => 'session-server-owned', epochStore: epochAuthority([]), mcpSessions: { closeSession: async () => true, open: async () => Object.freeze({ callTool: async () => result as never, id: 'mcp-server-owned' }) }, trace });
    await service.run({ arguments: {}, operation: 'mcp.call-tool', serverName: 'fixture', target: 'codex', tool: 'inspect' });
    await eventually(() => expect(trace.finalized).toEqual({ status: 'passed' }));
    expect(trace.appended[1]).toMatchObject({ raw: { result: '[unavailable evidence]' } });
  }
  expect(getterRead).toBe(0);
});
