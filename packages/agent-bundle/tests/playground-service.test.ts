import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, link, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  PlaygroundService,
  PlaygroundServiceCloseError,
  PlaygroundSessionCloseError,
  type PlaygroundEventInput,
  type PlaygroundJsonObject,
  type PlaygroundServiceOptions,
} from '../src/services/playground-service.ts';

interface SessionIndex {
  readonly kind: 'agent-bundle-playground-session-index';
  readonly objectId: string;
  readonly projectId: string;
  readonly schemaVersion: 2;
  readonly sessionId: string;
}

type PlaygroundDirectorySyncReason =
  | 'final-index-publication'
  | 'layout-index-entry'
  | 'layout-object-entry'
  | 'layout-pending-index-entry'
  | 'layout-project-entry'
  | 'layout-sessions-entry'
  | 'layout-storage-entry'
  | 'new-file'
  | 'object-created'
  | 'owner-lock-create'
  | 'owner-lock-create-recovery'
  | 'owner-lock-recovery'
  | 'owner-lock-release'
  | 'pending-index-publication'
  | 'session-metadata-rename';

type PlaygroundDurableFilePhase = 'event' | 'owner' | 'pending-index' | 'session-metadata';

type PlaygroundDurabilityTestPhase =
  | 'after-final-index-link'
  | 'before-directory-sync:owner-lock-create'
  | 'before-directory-sync:session-metadata-rename'
  | 'before-final-index-link'
  | `before-directory-fsync:${PlaygroundDirectorySyncReason}`
  | `before-directory-open:${PlaygroundDirectorySyncReason}`
  | `before-directory-sync:${PlaygroundDirectorySyncReason}`
  | `before-file-fsync:${PlaygroundDurableFilePhase}`
  | `before-file-write:${PlaygroundDurableFilePhase}`;

type PlaygroundDurabilityTestHook = (phase: PlaygroundDurabilityTestPhase, path: string) => void;

const playgroundDurabilityTestHookKey = Symbol.for('agent-bundle.playground-service.durability-test-hook');
const playgroundDurabilityTestPlatformKey = Symbol.for('agent-bundle.playground-service.durability-test-platform');
const durabilityTestHooks = globalThis as typeof globalThis & Record<symbol, PlaygroundDurabilityTestHook | undefined>;
const durabilityTestPlatforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;

const withDurabilityTestHook = async <T>(hook: PlaygroundDurabilityTestHook, operation: () => Promise<T>): Promise<T> => {
  const previous = durabilityTestHooks[playgroundDurabilityTestHookKey];
  const previousNodeEnvironment = process.env.NODE_ENV;
  durabilityTestHooks[playgroundDurabilityTestHookKey] = hook;
  process.env.NODE_ENV = 'test';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete durabilityTestHooks[playgroundDurabilityTestHookKey];
    else durabilityTestHooks[playgroundDurabilityTestHookKey] = previous;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
};

const injectedIoFailure = (message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code: 'EIO' });
const injectedErrnoFailure = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

const withDurabilityTestPlatform = async <T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> => {
  const previous = durabilityTestPlatforms[playgroundDurabilityTestPlatformKey];
  const previousNodeEnvironment = process.env.NODE_ENV;
  durabilityTestPlatforms[playgroundDurabilityTestPlatformKey] = platform;
  process.env.NODE_ENV = 'test';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete durabilityTestPlatforms[playgroundDurabilityTestPlatformKey];
    else durabilityTestPlatforms[playgroundDurabilityTestPlatformKey] = previous;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
};

const eventually = async (assertion: () => void, attempts = 100): Promise<void> => {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  throw failure;
};

const deferred = <T = void>(): Readonly<{
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return Object.freeze({ promise, resolve });
};

const sessionInput = (task = 'Explain the current workspace state.') => Object.freeze({
  epoch: Object.freeze({ digest: 'epoch-sha256', id: 'epoch-7' }),
  fixture: Object.freeze({ digest: 'fixture-sha256', id: 'fixture-clean' }),
  invocation: Object.freeze({ intent: Object.freeze({ command: 'inspect', path: 'README.md' }), kind: 'script' }),
  target: Object.freeze({ digest: 'target-sha256', name: 'codex' }),
  task: Object.freeze({ id: 'task-1', text: task }),
});

const event = (
  source: PlaygroundEventInput['source'],
  kind: string,
  summary: string,
  raw: PlaygroundJsonObject,
): PlaygroundEventInput => Object.freeze({ kind, raw, source, summary });

const snapshotDirectory = async (root: string): Promise<Readonly<Record<string, string>>> => Object.freeze(
  Object.fromEntries(await Promise.all((await readdir(root)).sort().map(async (name) => [name, await readFile(join(root, name), 'utf8')]))),
);

const indexPath = (storageRoot: string, sessionId: string): string =>
  join(storageRoot, 'session-index', `${sessionId}.json`);

const readIndex = async (storageRoot: string, sessionId: string): Promise<SessionIndex> =>
  JSON.parse(await readFile(indexPath(storageRoot, sessionId), 'utf8')) as SessionIndex;

const objectRoot = async (storageRoot: string, sessionId: string): Promise<string> =>
  join(storageRoot, 'session-objects', (await readIndex(storageRoot, sessionId)).objectId);

const writeLegacySession = async (
  storageRoot: string,
  sessionId: string,
  input = sessionInput(),
): Promise<string> => {
  const root = join(storageRoot, 'sessions', sessionId);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'events.jsonl'), '', 'utf8');
  await writeFile(join(root, 'session.json'), `${JSON.stringify({
    cleanupFailures: [],
    createdAt: '2026-08-16T00:00:00.000Z',
    identity: input,
    kind: 'agent-bundle-playground-session',
    outcome: { status: 'passed' },
    projectId: 'project-1',
    schemaVersion: 1,
    sessionId,
    state: 'finalized',
  })}\n`, 'utf8');
  return root;
};

const createFixture = async (input: Readonly<{
  readonly maxSubscriberQueue?: number;
  readonly now?: () => Date;
  readonly projectId?: string;
}> = {}): Promise<Readonly<{
  readonly close: () => Promise<void>;
  readonly projectRoot: string;
  readonly service: PlaygroundService;
  readonly storageRoot: string;
}>> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-playground-service-'));
  const projectRoot = join(root, 'project');
  const storageRoot = join(projectRoot, '.agent-bundle', 'playground');
  await mkdir(projectRoot, { recursive: true });
  const service = new PlaygroundService({
    ...(input.maxSubscriberQueue === undefined ? {} : { maxSubscriberQueue: input.maxSubscriberQueue }),
    ...(input.now === undefined ? {} : { now: input.now }),
    projectId: input.projectId ?? 'project-1',
    projectRoot,
    storageRoot,
  });
  return Object.freeze({
    close: async () => {
      await service.close().catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    },
    projectRoot,
    service,
    storageRoot,
  });
};

it('tolerates only unsupported Windows directory fsync errors', async () => {
  for (const code of ['EACCES', 'EINVAL'] as const) {
    const fixture = await createFixture();
    let observed = false;
    try {
      await withDurabilityTestPlatform('win32', async () => {
        await withDurabilityTestHook((phase) => {
          if (phase === 'before-directory-fsync:object-created') {
            observed = true;
            throw injectedErrnoFailure(code, `Windows directory fsync ${code}`);
          }
        }, async () => {
          await expect(fixture.service.openSession({ ...sessionInput(), sessionId: `windows-directory-${code}` })).resolves.toMatchObject({ state: 'open' });
        });
      });
      expect(observed).toBe(true);
    } finally {
      await fixture.close();
    }
  }

  for (const [phase, code] of [
    ['before-directory-open:object-created', 'EACCES'],
    ['before-directory-fsync:object-created', 'EIO'],
    ['before-file-fsync:event', 'EACCES'],
  ] as const) {
    const fixture = await createFixture();
    let observed = false;
    try {
      await withDurabilityTestPlatform('win32', async () => {
        await withDurabilityTestHook((candidate) => {
          if (candidate === phase) {
            observed = true;
            throw injectedErrnoFailure(code, `unexpected durability error ${code}`);
          }
        }, async () => {
          await expect(fixture.service.openSession({ ...sessionInput(), sessionId: `windows-propagated-${phase.replaceAll(':', '-')}` }))
            .rejects.toMatchObject({ code });
        });
      });
      expect(observed).toBe(true);
    } finally {
      await fixture.close();
    }
  }
});

it('anchors every first-use layout directory with a parent sync', async () => {
  const fixture = await createFixture();
  const observed: Array<readonly [PlaygroundDurabilityTestPhase, string]> = [];
  try {
    await withDurabilityTestHook((phase, path) => {
      if (phase.startsWith('before-directory-sync:layout-')) observed.push([phase, path]);
    }, async () => {
      await fixture.service.openSession({ ...sessionInput(), sessionId: 'layout-syncs' });
    });
    expect(observed).toEqual([
      ['before-directory-sync:layout-project-entry', fixture.projectRoot],
      ['before-directory-sync:layout-storage-entry', dirname(fixture.storageRoot)],
      ['before-directory-sync:layout-sessions-entry', fixture.storageRoot],
      ['before-directory-sync:layout-object-entry', fixture.storageRoot],
      ['before-directory-sync:layout-index-entry', fixture.storageRoot],
      ['before-directory-sync:layout-pending-index-entry', join(fixture.storageRoot, 'session-index')],
    ]);
  } finally {
    await fixture.close();
  }
});

const prepublicationFailurePhases = [
  'before-file-write:owner',
  'before-file-fsync:owner',
  'before-file-write:event',
  'before-file-fsync:event',
  'before-file-write:session-metadata',
  'before-file-fsync:session-metadata',
  'before-file-write:pending-index',
  'before-file-fsync:pending-index',
] as const;

for (const phase of prepublicationFailurePhases) {
  it(`leaves an unreachable object and unchanged legacy session when ${phase} fails before publication`, async () => {
    const fixture = await createFixture();
    const sessionId = `prepublication-${phase.replaceAll(':', '-')}`;
    let reader: PlaygroundService | undefined;
    try {
      const legacyRoot = await writeLegacySession(fixture.storageRoot, sessionId);
      const legacyBefore = await snapshotDirectory(legacyRoot);
      let observed = false;
      await withDurabilityTestHook((candidate) => {
        if (candidate === phase) {
          observed = true;
          throw injectedIoFailure(`${phase} failed`);
        }
      }, async () => {
        await expect(fixture.service.openSession({ ...sessionInput(), sessionId })).rejects.toMatchObject({ code: 'EIO' });
      });
      expect(observed).toBe(true);
      await expect(readFile(indexPath(fixture.storageRoot, sessionId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(join(fixture.storageRoot, 'session-objects'))).resolves.toHaveLength(1);
      await expect(snapshotDirectory(legacyRoot)).resolves.toEqual(legacyBefore);
      await expect(fixture.service.close()).resolves.toBeUndefined();
      reader = new PlaygroundService({
        projectId: 'project-1',
        projectRoot: fixture.projectRoot,
        storageRoot: fixture.storageRoot,
      });
      await expect(reader.reopen(sessionId)).resolves.toMatchObject({ id: sessionId, state: 'finalized' });
    } finally {
      await reader?.close().catch(() => undefined);
      await fixture.close();
    }
  });
}

it('persists a frozen, globally ordered whole-plugin timeline with raw replay references and promotes only durable assertions', async () => {
  const fixture = await createFixture();
  try {
    const session = await fixture.service.openSession({ ...sessionInput(), sessionId: 'session-1' });
    expect(session.identity.epoch).toEqual({ digest: 'epoch-sha256', id: 'epoch-7' });
    expect(Object.isFrozen(session.identity.invocation.intent)).toBe(true);

    const inputs: readonly PlaygroundEventInput[] = [
      event('project', 'loaded', 'Project model loaded.', { revision: 'abc123' }),
      event('build', 'completed', 'Artifact epoch built.', { epoch: 'epoch-7' }),
      event('host-preflight', 'checked', 'Host is ready.', { cliVersion: '0.147.0' }),
      event('skill-evidence', 'activated', 'Skill activation observed.', { skill: 'review' }),
      event('hook', 'completed', 'Generated hook completed.', { outcome: 'continue' }),
      event('mcp', 'response', 'MCP tool returned.', { tool: 'status' }),
      event('script', 'completed', 'Generated script completed.', { exitCode: 0 }),
      event('response', 'completed', 'Assistant response completed.', { text: 'Workspace is clean.' }),
      event('workspace-change', 'observed', 'Workspace change observed.', { path: 'README.md' }),
      event('diagnostics', 'reported', 'No diagnostics.', { errors: 0 }),
    ];
    const events = await Promise.all(inputs.map((input) => fixture.service.append('session-1', input)));
    expect(events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((item) => item.source)).toEqual(inputs.map((item) => item.source));
    expect(events[5]).toMatchObject({
      raw: { tool: 'status' },
      rawEventRef: 'events.jsonl#6',
      sequence: 6,
      summary: 'MCP tool returned.',
    });
    expect(Object.isFrozen(events[5]!.raw)).toBe(true);
    (inputs[0]!.raw as { revision: string }).revision = 'mutated';
    expect(events[0]!.raw).toEqual({ revision: 'abc123' });

    await fixture.service.finalize('session-1', {
      response: 'Workspace is clean.',
      status: 'passed',
      workspace: { changedPaths: ['README.md'], digest: 'workspace-sha256' },
    });
    const exported = await fixture.service.export('session-1');
    expect(exported.events).toHaveLength(10);
    expect(exported.session.outcome).toEqual({
      response: 'Workspace is clean.',
      status: 'passed',
      workspace: { changedPaths: ['README.md'], digest: 'workspace-sha256' },
    });
    expect(Object.isFrozen(exported.events[0]!.raw)).toBe(true);
    expect(exported.events[0]).not.toBe(events[0]);

    const draft = await fixture.service.promoteToDraftEval('session-1', [
      {
        evidence: { path: 'README.md', value: 'clean' },
        expectation: { equals: 'clean' },
        id: 'workspace-is-clean',
        kind: 'workspace-content',
      },
      {
        evidence: { nested: { retained: true } },
        expectation: { status: 'passed' },
        id: 'response-completed',
        kind: 'durable-outcome',
      },
    ]);
    expect(draft).toEqual({
      assertions: [
        {
          evidence: { path: 'README.md', value: 'clean' },
          expectation: { equals: 'clean' },
          id: 'workspace-is-clean',
          kind: 'workspace-content',
        },
        {
          evidence: { nested: { retained: true } },
          expectation: { status: 'passed' },
          id: 'response-completed',
          kind: 'durable-outcome',
        },
      ],
      epoch: { digest: 'epoch-sha256', id: 'epoch-7' },
      fixture: { digest: 'fixture-sha256', id: 'fixture-clean' },
      invocation: { intent: { command: 'inspect', path: 'README.md' }, kind: 'script' },
      outcome: { response: 'Workspace is clean.', status: 'passed', workspace: { changedPaths: ['README.md'], digest: 'workspace-sha256' } },
      schemaVersion: 1,
      target: { digest: 'target-sha256', name: 'codex' },
      task: { id: 'task-1', text: 'Explain the current workspace state.' },
    });
    expect(JSON.stringify(draft)).not.toContain('events.jsonl');
    expect(JSON.stringify(draft)).not.toContain('sequence');

    const persisted = await readFile(join(await objectRoot(fixture.storageRoot, 'session-1'), 'events.jsonl'), 'utf8');
    expect(persisted.trim().split('\n').map((line) => JSON.parse(line).sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(JSON.parse(persisted.trim().split('\n')[5]!).raw).toEqual({ tool: 'status' });
  } finally {
    await fixture.close();
  }
});

it('serializes concurrent writers into complete JSONL records and rejects invalid event JSON before taking a sequence', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'concurrent' });
    const events = await Promise.all(Array.from({ length: 48 }, (_, index) => fixture.service.append(
      'concurrent',
      event('script', 'output', `script output ${index}`, { index }),
    )));
    expect(events.map((item) => item.sequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 48 }, (_, index) => index + 1),
    );
    await expect(fixture.service.append('concurrent', event('mcp', 'bad', 'bad JSON.', { value: Number.NaN }))).rejects.toThrow(
      'JSON-compatible',
    );
    const replay = await fixture.service.replay('concurrent');
    expect(replay.events).toHaveLength(48);
    expect(replay.cursor).toEqual({ afterSequence: 48 });
    const persisted = await readFile(join(await objectRoot(fixture.storageRoot, 'concurrent'), 'events.jsonl'), 'utf8');
    expect(persisted.trim().split('\n')).toHaveLength(48);
    expect(persisted.trim().split('\n').every((line) => Number.isSafeInteger(JSON.parse(line).sequence))).toBe(true);
  } finally {
    await fixture.close();
  }
});

it('reopens completed sessions by cursor, recovers a trailing partial JSONL write, and rejects malformed completed records', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'reopen' });
    await fixture.service.append('reopen', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await fixture.service.append('reopen', event('build', 'completed', 'Build completed.', { epoch: 'epoch-7' }));
    await fixture.service.finalize('reopen', { status: 'passed' });
    await fixture.service.close();

    const eventPath = join(await objectRoot(fixture.storageRoot, 'reopen'), 'events.jsonl');
    await appendFile(eventPath, '{"sequence":3', 'utf8');
    const reopened = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      const session = await reopened.reopen('reopen');
      expect(session.state).toBe('closed');
      expect((await reopened.replay('reopen', { afterSequence: 1 })).events.map((item) => item.sequence)).toEqual([2]);
      await expect(reopened.replay('reopen', { afterSequence: 3 })).rejects.toThrow('ahead');
      await expect(reopened.replay('reopen', { afterSequence: -1 })).rejects.toThrow('non-negative');
    } finally {
      await reopened.close().catch(() => undefined);
    }

    await appendFile(eventPath, 'not-json\n', 'utf8');
    const corrupt = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(corrupt.reopen('reopen')).rejects.toThrow('malformed');
    } finally {
      await corrupt.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('sets an atomic subscription replay boundary, preserves reentrant order, and fails closed only for a slow subscriber', async () => {
  const fixture = await createFixture({ maxSubscriberQueue: 1 });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'live' });
    await fixture.service.append('live', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    const received: number[] = [];
    const subscription = await fixture.service.subscribe('live', {
      afterSequence: 0,
      onEvent: (item) => {
        received.push(item.sequence);
        if (item.sequence === 1) void fixture.service.append('live', event('build', 'completed', 'Build completed.', { epoch: 'epoch-7' }));
      },
    });
    await eventually(() => expect(received).toEqual([1, 2]));
    expect(subscription.closed).toBe(false);

    await fixture.service.openSession({ ...sessionInput(), sessionId: 'slow' });
    const release = deferred();
    const slowReceived: number[] = [];
    const slow = await fixture.service.subscribe('slow', {
      afterSequence: 0,
      onEvent: async (item) => {
        slowReceived.push(item.sequence);
        await release.promise;
      },
    });
    await fixture.service.append('slow', event('mcp', 'first', 'First.', { item: 1 }));
    await eventually(() => expect(slowReceived).toEqual([1]));
    await fixture.service.append('slow', event('mcp', 'second', 'Second.', { item: 2 }));
    await fixture.service.append('slow', event('mcp', 'third', 'Third.', { item: 3 }));
    await eventually(() => expect(slow.closed).toBe(true));
    release.resolve();
    await expect(fixture.service.replay('slow')).resolves.toMatchObject({ events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] });
  } finally {
    await fixture.close();
  }
});

it('does not resolve finalization before queued live subscription delivery has drained', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'drain' });
    let delivered = false;
    await fixture.service.subscribe('drain', {
      onEvent: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        delivered = true;
      },
    });
    await fixture.service.append('drain', event('response', 'completed', 'Response completed.', { text: 'ok' }));
    await fixture.service.finalize('drain', { status: 'passed' });
    expect(delivered).toBe(true);
  } finally {
    await fixture.close();
  }
});

it('rejects arbitrary, symlinked, wrong-project, and unknown-session storage paths without leaking mutable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-playground-containment-'));
  try {
    const projectRoot = join(root, 'project');
    const outsideRoot = join(root, 'outside');
    await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(outsideRoot, { recursive: true })]);
    const outside = new PlaygroundService({
      projectId: 'project-1',
      projectRoot,
      storageRoot: outsideRoot,
    });
    await expect(outside.openSession({ ...sessionInput(), sessionId: 'outside' })).rejects.toThrow('contained');

    const linkRoot = join(projectRoot, '.agent-bundle-link');
    await symlink(outsideRoot, linkRoot, 'dir');
    const symlinked = new PlaygroundService({ projectId: 'project-1', projectRoot, storageRoot: linkRoot });
    await expect(symlinked.openSession({ ...sessionInput(), sessionId: 'symlink' })).rejects.toThrow('symbolic link');

    const storageRoot = join(projectRoot, '.agent-bundle', 'playground');
    const owner = new PlaygroundService({ projectId: 'project-1', projectRoot, storageRoot });
    await owner.openSession({ ...sessionInput(), sessionId: 'owned' });
    const otherProject = new PlaygroundService({ projectId: 'project-2', projectRoot, storageRoot });
    await expect(otherProject.reopen('owned')).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    await expect(owner.reopen('missing')).rejects.toThrow('not found');
    await expect(owner.openSession({ ...sessionInput(), sessionId: '../escape' })).rejects.toThrow('path-safe');
    await Promise.allSettled([outside.close(), symlinked.close(), owner.close(), otherProject.close()]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('drains session cleanup and service close with structural failures while other sessions still close', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'broken' });
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'healthy' });
    await fixture.service.subscribe('broken', {
      onEvent: () => { throw new Error('subscriber cleanup failure'); },
    });
    await fixture.service.append('broken', event('hook', 'completed', 'Hook completed.', { outcome: 'continue' }));
    await eventually(() => expect(fixture.service.session('broken')?.cleanupFailures).toHaveLength(1));
    await fixture.service.finalize('broken', { status: 'failed' });
    await fixture.service.append('healthy', event('response', 'completed', 'Response completed.', { text: 'ok' }));
    await fixture.service.finalize('healthy', { status: 'passed' });
    await expect(fixture.service.close()).rejects.toBeInstanceOf(PlaygroundServiceCloseError);
    expect(fixture.service.session('healthy')?.state).toBe('closed');
    await expect(fixture.service.closeSession('broken')).rejects.toBeInstanceOf(PlaygroundSessionCloseError);
  } finally {
    await fixture.close();
  }
});

it('gives exactly one service instance the durable writer claim for an open session', async () => {
  const fixture = await createFixture();
  const contender = new PlaygroundService({
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'owned' });
    await expect(contender.reopen('owned')).rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_OWNED' });
    await expect(fixture.service.append('owned', event('project', 'loaded', 'Project loaded.', { revision: 'a' }))).resolves.toMatchObject({ sequence: 1 });
    await fixture.service.finalize('owned', { status: 'passed' });
    await fixture.service.closeSession('owned');
    await expect(contender.reopen('owned')).resolves.toMatchObject({ state: 'closed' });
    await expect(contender.replay('owned')).resolves.toMatchObject({ events: [{ sequence: 1 }] });
  } finally {
    await Promise.allSettled([fixture.close(), contender.close()]);
  }
});

it('fails closed on bounded provider credential values before identity, raw events, outcomes, or drafts persist them', async () => {
  const fixture = await createFixture();
  const credential = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    await expect(fixture.service.openSession({
      ...sessionInput(),
      invocation: { intent: { note: credential }, kind: 'script' },
      sessionId: 'credential-identity',
    })).rejects.toThrow('credential');
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'credential-event' });
    await expect(fixture.service.append('credential-event', event('mcp', 'response', 'MCP responded.', { note: credential }))).rejects.toThrow('credential');
    await expect(fixture.service.finalize('credential-event', { response: credential, status: 'passed' })).rejects.toThrow('credential');
    await expect(fixture.service.promoteToDraftEval('credential-event', [])).rejects.toThrow('durable');
    const credentialObject = await objectRoot(fixture.storageRoot, 'credential-event');
    const sessionDocument = await readFile(join(credentialObject, 'session.json'), 'utf8');
    const eventDocument = await readFile(join(credentialObject, 'events.jsonl'), 'utf8');
    expect(sessionDocument).not.toContain(credential);
    expect(eventDocument).not.toContain(credential);
  } finally {
    await fixture.close();
  }
});

it('shuts down open sessions into a durable aborted terminal state, drains subscribers, and releases their owner claim', async () => {
  const fixture = await createFixture();
  const contender = new PlaygroundService({
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'aborted' });
    const delivered = deferred<void>();
    const subscription = await fixture.service.subscribe('aborted', { onEvent: () => delivered.promise });
    await fixture.service.append('aborted', event('response', 'completed', 'Response completed.', { text: 'interrupted' }));
    const closing = fixture.service.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(subscription.closed).toBe(false);
    delivered.resolve(undefined);
    await expect(closing).resolves.toBeUndefined();
    expect(subscription.closed).toBe(true);
    expect(fixture.service.session('aborted')).toMatchObject({ outcome: { status: 'aborted' }, state: 'closed' });
    await expect(contender.reopen('aborted')).resolves.toMatchObject({ outcome: { status: 'aborted' }, state: 'closed' });
  } finally {
    await Promise.allSettled([fixture.close(), contender.close()]);
  }
});

it('rolls back a failed finalization metadata commit so promotion cannot observe a non-durable outcome and retry succeeds', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'transactional' });
    const metadataPath = join(await objectRoot(fixture.storageRoot, 'transactional'), 'session.json');
    const original = await readFile(metadataPath, 'utf8');
    await rm(metadataPath);
    await mkdir(metadataPath);
    await expect(fixture.service.finalize('transactional', { status: 'passed' })).rejects.toBeDefined();
    expect(fixture.service.session('transactional')).toMatchObject({ state: 'open' });
    expect(fixture.service.session('transactional')).not.toHaveProperty('outcome');
    await expect(fixture.service.promoteToDraftEval('transactional', [])).rejects.toThrow('durable');
    await rm(metadataPath, { recursive: true });
    await writeFile(metadataPath, original, 'utf8');
    await expect(fixture.service.finalize('transactional', { status: 'passed' })).resolves.toMatchObject({ state: 'finalized' });
    await expect(fixture.service.promoteToDraftEval('transactional', [])).resolves.toMatchObject({ outcome: { status: 'passed' } });
  } finally {
    await fixture.close();
  }
});

it('rejects a session metadata symlink during reopen without following its contents', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'metadata-link' });
    await fixture.service.finalize('metadata-link', { status: 'passed' });
    await fixture.service.close();
    const metadataPath = join(await objectRoot(fixture.storageRoot, 'metadata-link'), 'session.json');
    const outsidePath = join(fixture.projectRoot, 'outside-session.json');
    await writeFile(outsidePath, await readFile(metadataPath, 'utf8'), 'utf8');
    await rm(metadataPath);
    await symlink(outsidePath, metadataPath, 'file');
    const reopened = new PlaygroundService({ projectId: 'project-1', projectRoot: fixture.projectRoot, storageRoot: fixture.storageRoot });
    try {
      await expect(reopened.reopen('metadata-link')).rejects.toThrow('metadata');
    } finally {
      await reopened.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('fails closed deterministically when a replay backlog exceeds the subscriber queue limit while persisted replay remains complete', async () => {
  const fixture = await createFixture({ maxSubscriberQueue: 1 });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'backlog' });
    await fixture.service.append('backlog', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await fixture.service.append('backlog', event('build', 'completed', 'Build completed.', { epoch: 'epoch-7' }));
    await fixture.service.append('backlog', event('mcp', 'response', 'MCP responded.', { tool: 'status' }));
    const received: number[] = [];
    const subscription = await fixture.service.subscribe('backlog', {
      afterSequence: 0,
      onEvent: (item) => { received.push(item.sequence); },
    });
    expect(subscription.closed).toBe(true);
    expect(received).toEqual([]);
    await expect(fixture.service.replay('backlog')).resolves.toMatchObject({ events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] });
  } finally {
    await fixture.close();
  }
});

it('rejects sensitive credential key names before metadata, event logs, outcomes, or draft evals can retain their values', async () => {
  const fixture = await createFixture();
  const credential = '0123456789abcdef0123456789abcdef';
  try {
    await expect(fixture.service.openSession({
      ...sessionInput(),
      invocation: { intent: { provider: { apiKey: credential } }, kind: 'script' },
      sessionId: 'credential-key-identity',
    })).rejects.toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });

    await fixture.service.openSession({ ...sessionInput(), sessionId: 'credential-key' });
    await fixture.service.append('credential-key', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await expect(fixture.service.append('credential-key', event('mcp', 'response', 'MCP responded.', {
      headers: { 'auth-token': credential },
    }))).rejects.toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });
    await expect(fixture.service.finalize('credential-key', {
      status: 'passed',
      workspace: { provider_secret: credential },
    })).rejects.toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });

    await fixture.service.finalize('credential-key', { status: 'passed' });
    await expect(fixture.service.promoteToDraftEval('credential-key', [{
      evidence: { nested: { access_token: credential } },
      expectation: { equals: 'passed' },
      id: 'credential-key',
      kind: 'durable-outcome',
    }])).rejects.toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });
    const draft = await fixture.service.promoteToDraftEval('credential-key', [{
      evidence: { status: 'passed' },
      expectation: { equals: 'passed' },
      id: 'durable-outcome',
      kind: 'durable-outcome',
    }]);
    const credentialObject = await objectRoot(fixture.storageRoot, 'credential-key');
    const sessionDocument = await readFile(join(credentialObject, 'session.json'), 'utf8');
    const eventDocument = await readFile(join(credentialObject, 'events.jsonl'), 'utf8');
    expect(sessionDocument).not.toContain(credential);
    expect(eventDocument).not.toContain(credential);
    expect(JSON.stringify(draft)).not.toContain(credential);
  } finally {
    await fixture.close();
  }
});

it('rejects reopened metadata and event records that contain sensitive credential key names without echoing their values', async () => {
  const fixture = await createFixture();
  const credential = '0123456789abcdef0123456789abcdef';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'credential-corrupt' });
    await fixture.service.append('credential-corrupt', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await fixture.service.finalize('credential-corrupt', { status: 'passed' });
    await fixture.service.close();

    const corruptObject = await objectRoot(fixture.storageRoot, 'credential-corrupt');
    const sessionPath = join(corruptObject, 'session.json');
    const eventPath = join(corruptObject, 'events.jsonl');
    const originalSession = await readFile(sessionPath, 'utf8');
    const originalEvents = await readFile(eventPath, 'utf8');
    const metadata = JSON.parse(originalSession) as { identity: { invocation: { intent: Record<string, unknown> } } };
    metadata.identity.invocation.intent = { api_key: credential };
    await writeFile(sessionPath, `${JSON.stringify(metadata)}\n`, 'utf8');
    const corruptMetadata = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      const failure = await corruptMetadata.reopen('credential-corrupt').catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      expect(String(failure)).not.toContain(credential);
    } finally {
      await corruptMetadata.close().catch(() => undefined);
    }

    await writeFile(sessionPath, originalSession, 'utf8');
    const events = originalEvents.trim().split('\n').map((line) => JSON.parse(line) as { raw: Record<string, unknown> });
    events[0]!.raw = { authorization: credential };
    await writeFile(eventPath, `${events.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    const corruptEvent = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      const failure = await corruptEvent.reopen('credential-corrupt').catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      expect(String(failure)).not.toContain(credential);
    } finally {
      await corruptEvent.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('does not admit sessions, subscriptions, replay, export, or promotion after close begins or resolves', async () => {
  const fixture = await createFixture();
  let deliveries = 0;
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'post-close' });
    await fixture.service.append('post-close', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await expect(fixture.service.close()).resolves.toBeUndefined();

    await expect(fixture.service.reopen('post-close')).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.subscribe('post-close', {
      onEvent: () => { deliveries += 1; },
    })).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.replay('post-close')).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.export('post-close')).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.promoteToDraftEval('post-close', [])).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.closeSession('post-close')).resolves.toBeUndefined();
    await expect(fixture.service.close()).resolves.toBeUndefined();
    expect(fixture.service.session('post-close')).toMatchObject({ state: 'closed' });
    expect(deliveries).toBe(0);
  } finally {
    await fixture.close();
  }
});

it('rejects provider credential values in every identity and assertion scalar before promotion or persisted reopen can retain them', async () => {
  const fixture = await createFixture();
  const credential = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  try {
    const base = sessionInput();
    const identityCases = [
      { epoch: { ...base.epoch, digest: credential } },
      { epoch: { ...base.epoch, id: credential } },
      { fixture: { ...base.fixture, digest: credential } },
      { fixture: { ...base.fixture, id: credential } },
      { invocation: { ...base.invocation, intent: { note: credential } } },
      { invocation: { ...base.invocation, kind: credential } },
      { target: { ...base.target, digest: credential } },
      { target: { ...base.target, name: credential } },
      { task: { ...base.task, id: credential } },
      { task: { ...base.task, text: credential } },
      { sessionId: credential },
    ];
    for (const input of identityCases) {
      const failure = await fixture.service.openSession({ ...base, ...input }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });
      expect(String(failure)).not.toContain(credential);
    }

    await fixture.service.openSession({ ...base, sessionId: 'scalar-credentials' });
    await fixture.service.finalize('scalar-credentials', { status: 'passed' });
    const assertionCases = [
      { evidence: credential, expectation: { equals: 'passed' }, id: 'evidence', kind: 'durable-outcome' },
      { evidence: { status: 'passed' }, expectation: credential, id: 'expectation', kind: 'durable-outcome' },
      { evidence: { status: 'passed' }, expectation: { equals: 'passed' }, id: credential, kind: 'durable-outcome' },
      { evidence: { status: 'passed' }, expectation: { equals: 'passed' }, id: 'kind', kind: credential },
    ];
    for (const assertion of assertionCases) {
      const failure = await fixture.service.promoteToDraftEval('scalar-credentials', [assertion]).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PLAYGROUND_CREDENTIAL_REJECTED' });
      expect(String(failure)).not.toContain(credential);
    }
    const draft = await fixture.service.promoteToDraftEval('scalar-credentials', [{
      evidence: { status: 'passed' },
      expectation: { equals: 'passed' },
      id: 'durable-outcome',
      kind: 'durable-outcome',
    }]);
    expect(JSON.stringify(draft)).not.toContain(credential);

    await fixture.service.close();
    const sessionPath = join(await objectRoot(fixture.storageRoot, 'scalar-credentials'), 'session.json');
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as { createdAt: string };
    persisted.createdAt = credential;
    await writeFile(sessionPath, `${JSON.stringify(persisted)}\n`, 'utf8');
    const corrupt = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      const failure = await corrupt.reopen('scalar-credentials').catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      expect(String(failure)).not.toContain(credential);
    } finally {
      await corrupt.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('linearizes cold open and reopen admissions with close so completed cleanup cannot be bypassed', async () => {
  const lifecycle: { closing?: Promise<void>; service?: PlaygroundService } = {};
  const fixture = await createFixture({
    now: () => {
      lifecycle.closing ??= lifecycle.service!.close();
      return new Date('2026-08-15T00:00:00.000Z');
    },
  });
  lifecycle.service = fixture.service;
  try {
    const opening = fixture.service.openSession({ ...sessionInput(), sessionId: 'cold-open' });
    const openRoot = join(fixture.storageRoot, 'sessions', 'cold-open');
    await expect(opening).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(lifecycle.closing).resolves.toBeUndefined();
    expect(fixture.service.session('cold-open')).toBeUndefined();
    await expect(readFile(join(openRoot, '.owner.lock'), 'utf8')).rejects.toBeDefined();
    await expect(readFile(join(openRoot, 'session.json'), 'utf8')).rejects.toBeDefined();
    await expect(fixture.service.subscribe('cold-open', { onEvent: () => undefined })).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(fixture.service.close()).resolves.toBeUndefined();

    const seed = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    await seed.openSession({ ...sessionInput(), sessionId: 'cold-reopen' });
    await seed.finalize('cold-reopen', { status: 'passed' });
    await seed.close();

    const reopened = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await reopened.openSession({ ...sessionInput(), sessionId: 'reopen-warmup' });
      const reopening = reopened.reopen('cold-reopen');
      await Promise.resolve();
      const close = reopened.close();
      await expect(reopening).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
      await expect(close).resolves.toBeUndefined();
      expect(reopened.session('cold-reopen')).toBeUndefined();
      await expect(reopened.subscribe('cold-reopen', { onEvent: () => undefined })).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
      await expect(reopened.close()).resolves.toBeUndefined();
    } finally {
      await reopened.close().catch(() => undefined);
      await seed.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('preserves legacy and v2 victims without any admission-directory move, deletion, or cleanup path', async () => {
  const fixture = await createFixture();
  const contender = new PlaygroundService({
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'v2-victim' });
    await fixture.service.finalize('v2-victim', { status: 'passed' });
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warmup' });
    const legacyRoot = await writeLegacySession(fixture.storageRoot, 'legacy-victim');
    const v2Root = await objectRoot(fixture.storageRoot, 'v2-victim');
    const legacyBefore = await snapshotDirectory(legacyRoot);
    const v2Before = await snapshotDirectory(v2Root);
    const indexBefore = await readFile(indexPath(fixture.storageRoot, 'v2-victim'), 'utf8');

    await expect(contender.openSession({ ...sessionInput(), sessionId: 'legacy-victim' })).rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_CONFLICT' });
    await expect(contender.openSession({ ...sessionInput(), sessionId: 'v2-victim' })).rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_CONFLICT' });

    await expect(snapshotDirectory(legacyRoot)).resolves.toEqual(legacyBefore);
    await expect(snapshotDirectory(v2Root)).resolves.toEqual(v2Before);
    await expect(readFile(indexPath(fixture.storageRoot, 'v2-victim'), 'utf8')).resolves.toBe(indexBefore);
    const sessionEntries = await readdir(join(fixture.storageRoot, 'sessions'));
    expect(sessionEntries.some((name) => name.startsWith('.cleanup-'))).toBe(false);
  } finally {
    await contender.close().catch(() => undefined);
    await fixture.close();
  }
});

it('leaves a path-swapped legacy victim untouched when close wins after v2 object creation and before publication', async () => {
  const fixture = await createFixture();
  const victimId = 'path-swap-victim';
  const targetId = 'path-swap-target';
  let contender: PlaygroundService | undefined;
  let closing: Promise<void> | undefined;
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warmup' });
    const victimRoot = await writeLegacySession(fixture.storageRoot, victimId);
    const targetRoot = join(fixture.storageRoot, 'sessions', targetId);
    const victimBefore = await snapshotDirectory(victimRoot);
    let swapped = false;
    contender = new PlaygroundService({
      now: () => {
        if (!swapped) {
          swapped = true;
          renameSync(victimRoot, targetRoot);
          closing = contender!.close();
        }
        return new Date('2026-08-16T00:00:00.000Z');
      },
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });

    await expect(contender.openSession({ ...sessionInput(), sessionId: targetId })).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(closing).resolves.toBeUndefined();
    await expect(snapshotDirectory(targetRoot)).resolves.toEqual(victimBefore);
    expect((await readdir(join(fixture.storageRoot, 'sessions'))).some((name) => name.startsWith('.cleanup-'))).toBe(false);
  } finally {
    await contender?.close().catch(() => undefined);
    await fixture.close();
  }
});

it('reopens and exports strict v1 sessions only when no v2 index exists, and conflicts with both formats', async () => {
  const fixture = await createFixture();
  const contender = new PlaygroundService({
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warmup' });
    await writeLegacySession(fixture.storageRoot, 'legacy-reopen');
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reader.reopen('legacy-reopen')).resolves.toMatchObject({ id: 'legacy-reopen', state: 'finalized' });
      await expect(reader.replay('legacy-reopen')).resolves.toMatchObject({ events: [] });
      await expect(reader.export('legacy-reopen')).resolves.toMatchObject({ session: { id: 'legacy-reopen' } });
    } finally {
      await reader.close().catch(() => undefined);
    }
    await expect(contender.openSession({ ...sessionInput(), sessionId: 'legacy-reopen' })).rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_CONFLICT' });
  } finally {
    await contender.close().catch(() => undefined);
    await fixture.close();
  }
});

it('publishes one complete v2 session index for concurrent same-ID contenders and leaves the loser object unreachable', async () => {
  const fixture = await createFixture();
  const contender = new PlaygroundService({
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  });
  const sessionId = 'v2-concurrent';
  try {
    const results = await Promise.allSettled([
      fixture.service.openSession({ ...sessionInput(), sessionId }),
      contender.openSession({ ...sessionInput(), sessionId }),
    ]);
    const winner = results.find((result) => result.status === 'fulfilled');
    const loser = results.find((result) => result.status === 'rejected');
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    if (loser?.status === 'rejected') {
      expect(loser.reason).toMatchObject({ code: 'PLAYGROUND_SESSION_CONFLICT' });
    }

    const index = await readIndex(fixture.storageRoot, sessionId);
    expect(index).toEqual({
      kind: 'agent-bundle-playground-session-index',
      objectId: expect.any(String),
      projectId: 'project-1',
      schemaVersion: 2,
      sessionId,
    });
    const objects = await readdir(join(fixture.storageRoot, 'session-objects'));
    expect(objects).toHaveLength(2);
    expect(objects).toContain(index.objectId);
    expect(objects.filter((objectId) => objectId !== index.objectId)).toHaveLength(1);

    await fixture.service.close();
    await contender.close();
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reader.reopen(sessionId)).resolves.toMatchObject({ id: sessionId, state: 'closed' });
    } finally {
      await reader.close().catch(() => undefined);
    }
  } finally {
    await contender.close().catch(() => undefined);
    await fixture.close();
  }
});

it('leaves a v2 object orphaned but unpublished when close wins before final index publication, then permits a retry', async () => {
  const lifecycle: { closing?: Promise<void>; service?: PlaygroundService } = {};
  const fixture = await createFixture({
    now: () => {
      lifecycle.closing ??= lifecycle.service!.close();
      return new Date('2026-08-16T00:00:00.000Z');
    },
  });
  lifecycle.service = fixture.service;
  const sessionId = 'v2-close-before-publication';
  try {
    await expect(fixture.service.openSession({ ...sessionInput(), sessionId })).rejects.toMatchObject({ code: 'PLAYGROUND_SERVICE_CLOSED' });
    await expect(lifecycle.closing).resolves.toBeUndefined();
    expect(fixture.service.session(sessionId)).toBeUndefined();
    await expect(readFile(indexPath(fixture.storageRoot, sessionId), 'utf8')).rejects.toBeDefined();
    expect(await readdir(join(fixture.storageRoot, 'session-objects'))).toHaveLength(1);

    const retry = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(retry.openSession({ ...sessionInput(), sessionId })).resolves.toMatchObject({ id: sessionId, state: 'open' });
    } finally {
      await retry.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('rejects malformed or mismatched v2 indexes without falling back to a valid v1 session', async () => {
  const fixture = await createFixture();
  const sessionId = 'v2-index-fail-closed';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warm-v2-index' });
    await fixture.service.close();
    await writeLegacySession(fixture.storageRoot, sessionId);
    const cases = [
      '{',
      JSON.stringify({
        kind: 'agent-bundle-playground-session-index',
        objectId: 'missing-object',
        projectId: 'other-project',
        schemaVersion: 2,
        sessionId,
      }),
      JSON.stringify({
        kind: 'agent-bundle-playground-session-index',
        objectId: 'missing-object',
        projectId: 'project-1',
        schemaVersion: 2,
        sessionId: 'other-session',
      }),
    ];
    for (const document of cases) {
      await writeFile(indexPath(fixture.storageRoot, sessionId), `${document}\n`, 'utf8');
      const reader = new PlaygroundService({
        projectId: 'project-1',
        projectRoot: fixture.projectRoot,
        storageRoot: fixture.storageRoot,
      });
      try {
        await expect(reader.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      } finally {
        await reader.close().catch(() => undefined);
      }
    }
    const outsideIndex = join(fixture.projectRoot, 'outside-index.json');
    await rm(indexPath(fixture.storageRoot, sessionId));
    await writeFile(outsideIndex, cases[1]!, 'utf8');
    await symlink(outsideIndex, indexPath(fixture.storageRoot, sessionId), 'file');
    const symlinked = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(symlinked.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    } finally {
      await symlinked.close().catch(() => undefined);
      await rm(indexPath(fixture.storageRoot, sessionId));
    }

    const objectSource = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    await objectSource.openSession({ ...sessionInput(), sessionId: 'index-object-source' });
    await objectSource.finalize('index-object-source', { status: 'passed' });
    await objectSource.close();
    const sourceIndex = await readIndex(fixture.storageRoot, 'index-object-source');
    await writeFile(indexPath(fixture.storageRoot, sessionId), `${JSON.stringify({
      ...sourceIndex,
      sessionId,
    })}\n`, 'utf8');
    const objectMismatch = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(objectMismatch.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    } finally {
      await objectMismatch.close().catch(() => undefined);
    }
    await rm(indexPath(fixture.storageRoot, sessionId));
    const fallback = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(fallback.reopen(sessionId)).resolves.toMatchObject({ id: sessionId, state: 'finalized' });
      await expect(fallback.export(sessionId)).resolves.toMatchObject({ session: { id: sessionId } });
    } finally {
      await fallback.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('fails a v2 index that references no object without falling back to a legacy session', async () => {
  const fixture = await createFixture();
  const sessionId = 'v2-missing-object';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warm-v2-object' });
    await writeLegacySession(fixture.storageRoot, sessionId);
    await writeFile(indexPath(fixture.storageRoot, sessionId), `${JSON.stringify({
      kind: 'agent-bundle-playground-session-index',
      objectId: 'missing-object',
      projectId: 'project-1',
      schemaVersion: 2,
      sessionId,
    })}\n`, 'utf8');
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reader.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    } finally {
      await reader.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('retains unindexed objects and pending indexes across startup while readers observe only absent or complete final indexes', async () => {
  const fixture = await createFixture();
  const sessionId = 'v2-reader';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warm-orphans' });
    const orphanRoot = join(fixture.storageRoot, 'session-objects', 'unindexed-orphan');
    const pendingPath = join(fixture.storageRoot, 'session-index', '.pending', 'abandoned.json');
    await mkdir(orphanRoot);
    await writeFile(join(orphanRoot, 'sentinel'), 'orphan\n', 'utf8');
    await writeFile(pendingPath, '{"pending":true}\n', 'utf8');

    const writer = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    const observed: SessionIndex[] = [];
    let writerDone = false;
    const publishing = writer.openSession({ ...sessionInput(), sessionId }).finally(() => { writerDone = true; });
    while (!writerDone) {
      try {
        observed.push(await readIndex(fixture.storageRoot, sessionId));
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
      await Promise.resolve();
    }
    await publishing;
    observed.push(await readIndex(fixture.storageRoot, sessionId));
    expect(observed.length).toBeGreaterThan(0);
    for (const index of observed) {
      expect(index).toEqual({
        kind: 'agent-bundle-playground-session-index',
        objectId: expect.any(String),
        projectId: 'project-1',
        schemaVersion: 2,
        sessionId,
      });
    }
    await expect(readFile(join(orphanRoot, 'sentinel'), 'utf8')).resolves.toBe('orphan\n');
    await expect(readFile(pendingPath, 'utf8')).resolves.toBe('{"pending":true}\n');
    await writer.close();
  } finally {
    await fixture.close();
  }
});

it('leaves a failed pre-publication object orphaned without changing a legacy victim', async () => {
  const fixture = await createFixture();
  const targetId = 'blocked-pending-write';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'warm-pending-write' });
    const legacyRoot = await writeLegacySession(fixture.storageRoot, 'pending-write-victim');
    const victimBefore = await snapshotDirectory(legacyRoot);
    const pendingRoot = join(fixture.storageRoot, 'session-index', '.pending');
    const blocked = new PlaygroundService({
      now: () => {
        rmSync(pendingRoot, { force: true, recursive: true });
        writeFileSync(pendingRoot, 'blocked\n', 'utf8');
        return new Date('2026-08-16T00:00:00.000Z');
      },
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(blocked.openSession({ ...sessionInput(), sessionId: targetId })).rejects.toBeDefined();
      await expect(readFile(indexPath(fixture.storageRoot, targetId), 'utf8')).rejects.toBeDefined();
      expect((await readdir(join(fixture.storageRoot, 'session-objects'))).length).toBeGreaterThan(1);
      await expect(snapshotDirectory(legacyRoot)).resolves.toEqual(victimBefore);
    } finally {
      await blocked.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('rejects a replaced v2 object before it can write or publish an unrelated victim', async () => {
  const fixture = await createFixture();
  const sessionId = 'replaced-v2-object';
  const objectsRoot = join(fixture.storageRoot, 'session-objects');
  const displacedRoot = join(fixture.storageRoot, 'displaced-owned-object');
  let contender: PlaygroundService | undefined;
  try {
    let replaced = false;
    contender = new PlaygroundService({
      now: () => {
        if (!replaced) {
          replaced = true;
          const objectId = readdirSync(objectsRoot)[0]!;
          const root = join(objectsRoot, objectId);
          renameSync(root, displacedRoot);
          mkdirSync(root);
          writeFileSync(join(root, 'unrelated'), 'unchanged\n', 'utf8');
        }
        return new Date('2026-08-16T00:00:00.000Z');
      },
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });

    await expect(contender.openSession({ ...sessionInput(), sessionId })).rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_OWNED' });
    await expect(readFile(join(objectsRoot, readdirSync(objectsRoot)[0]!, 'unrelated'), 'utf8')).resolves.toBe('unchanged\n');
    await expect(readFile(indexPath(fixture.storageRoot, sessionId), 'utf8')).rejects.toBeDefined();
    await expect(readFile(join(displacedRoot, '.owner.lock'), 'utf8')).resolves.toContain('token');
  } finally {
    await contender?.close().catch(() => undefined);
    await fixture.close();
  }
});

it('fails closed when a pending pathname is replaced before the final hard link', async () => {
  const fixture = await createFixture();
  const sessionId = 'pending-substitution';
  try {
    await withDurabilityTestHook((phase, path) => {
      if (phase === 'before-final-index-link') {
        renameSync(path, `${path}.pinned`);
        writeFileSync(path, `${JSON.stringify({
          kind: 'agent-bundle-playground-session-index',
          objectId: 'substituted-object',
          projectId: 'project-1',
          schemaVersion: 2,
          sessionId,
        })}\n`, 'utf8');
      }
    }, async () => {
      await expect(fixture.service.openSession({ ...sessionInput(), sessionId }))
        .rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    });
    const index = await readIndex(fixture.storageRoot, sessionId);
    expect(index.objectId).toBe('substituted-object');
    expect(() => fixture.service.session(sessionId)).toThrow(expect.objectContaining({ code: 'PLAYGROUND_STORE_CORRUPT' }));
    await fixture.service.close();
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reader.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    } finally {
      await reader.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('permanently quarantines a post-link failed admission through a failed close recovery', async () => {
  const fixture = await createFixture();
  const sessionId = 'post-link-verification-failure';
  try {
    await withDurabilityTestHook((phase) => {
      if (phase === 'after-final-index-link') throw injectedIoFailure('post-link verification failed');
    }, async () => {
      await expect(fixture.service.openSession({ ...sessionInput(), sessionId }))
        .rejects.toMatchObject({ code: 'EIO' });
    });
    const index = await readIndex(fixture.storageRoot, sessionId);
    await expect(readFile(join(fixture.storageRoot, 'session-objects', index.objectId, 'session.json'), 'utf8'))
      .resolves.toContain(`"sessionId":"${sessionId}"`);
    const expectQuarantined = async (): Promise<void> => {
      const blockedOperations = [
        () => fixture.service.append(sessionId, event('project', 'loaded', 'Project loaded.', { revision: 'blocked' })),
        () => fixture.service.finalize(sessionId, { status: 'passed' }),
        () => fixture.service.reopen(sessionId),
        () => fixture.service.replay(sessionId),
        () => fixture.service.subscribe(sessionId, { onEvent: () => undefined }),
        () => fixture.service.export(sessionId),
        () => fixture.service.promoteToDraftEval(sessionId, []),
      ];
      for (const operation of blockedOperations) {
        await expect(operation()).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      }
      expect(() => fixture.service.session(sessionId)).toThrow(expect.objectContaining({ code: 'PLAYGROUND_STORE_CORRUPT' }));
    };
    await expectQuarantined();
    await withDurabilityTestHook((phase) => {
      if (phase === 'before-directory-sync:session-metadata-rename') {
        throw injectedIoFailure('close metadata directory sync failed');
      }
    }, async () => {
      await expect(fixture.service.closeSession(sessionId)).rejects.toMatchObject({ code: 'EIO' });
    });
    await fixture.service.closeSession(sessionId);
    await expect(readFile(join(fixture.storageRoot, 'session-objects', index.objectId, '.owner.lock'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expectQuarantined();
    await fixture.service.close();
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reader.reopen(sessionId)).resolves.toMatchObject({ id: sessionId, state: 'closed' });
    } finally {
      await reader.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('keeps terminal memory aligned with metadata after a post-rename directory-sync failure', async () => {
  const fixture = await createFixture();
  const sessionId = 'metadata-rename-sync-failure';
  const outcome = Object.freeze({ status: 'passed', workspace: Object.freeze({ alpha: 'a', beta: 'b' }) });
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId });
    const root = await objectRoot(fixture.storageRoot, sessionId);
    await withDurabilityTestHook((phase) => {
      if (phase === 'before-directory-sync:session-metadata-rename') {
        throw injectedIoFailure('metadata directory sync failed');
      }
    }, async () => {
      await expect(fixture.service.finalize(sessionId, outcome)).rejects.toMatchObject({ code: 'EIO' });
    });
    expect(JSON.parse(await readFile(join(root, 'session.json'), 'utf8'))).toMatchObject({
      outcome,
      state: 'finalized',
    });
    const blockedOperations = [
      () => fixture.service.append(sessionId, event('project', 'loaded', 'Project loaded.', { revision: 'blocked' })),
      () => fixture.service.reopen(sessionId),
      () => fixture.service.replay(sessionId),
      () => fixture.service.subscribe(sessionId, { onEvent: () => undefined }),
      () => fixture.service.export(sessionId),
      () => fixture.service.promoteToDraftEval(sessionId, []),
    ];
    for (const operation of blockedOperations) {
      await expect(operation()).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    }
    let sessionError: unknown;
    try {
      fixture.service.session(sessionId);
    } catch (error) {
      sessionError = error;
    }
    expect(sessionError).toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
    await expect(fixture.service.finalize(sessionId, { status: 'different' }))
      .rejects.toMatchObject({ code: 'PLAYGROUND_SESSION_FINALIZED' });
    const recovered = await fixture.service.finalize(sessionId, {
      status: 'passed',
      workspace: { beta: 'b', alpha: 'a' },
    });
    expect(recovered).toMatchObject({ outcome, state: 'finalized' });
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered.outcome)).toBe(true);
    await expect(fixture.service.export(sessionId)).resolves.toMatchObject({ session: { outcome, state: 'finalized' } });
    await expect(fixture.service.promoteToDraftEval(sessionId, [])).resolves.toMatchObject({ outcome });
    await fixture.service.close();
  } finally {
    await fixture.close();
  }
});

it('removes only a just-created owner lock when its directory sync fails during reopen', async () => {
  const fixture = await createFixture();
  const sessionId = 'owner-lock-sync-failure';
  try {
    const root = await writeLegacySession(fixture.storageRoot, sessionId);
    const document = JSON.parse(await readFile(join(root, 'session.json'), 'utf8')) as Record<string, unknown>;
    delete document.outcome;
    document.state = 'open';
    await writeFile(join(root, 'session.json'), `${JSON.stringify(document)}\n`, 'utf8');
    const reader = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await withDurabilityTestHook((phase) => {
        if (phase === 'before-directory-sync:owner-lock-create') {
          throw injectedIoFailure('owner lock directory sync failed');
        }
      }, async () => {
        await expect(reader.reopen(sessionId)).rejects.toMatchObject({ code: 'EIO' });
      });
      await expect(readFile(join(root, '.owner.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(reader.reopen(sessionId)).resolves.toMatchObject({ id: sessionId, state: 'open' });
    } finally {
      await reader.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
  }
});

it('rejects hard-linked event logs before a mutable event can alter the linked file', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'hard-linked-event' });
    const eventPath = join(await objectRoot(fixture.storageRoot, 'hard-linked-event'), 'events.jsonl');
    const linkedPath = join(fixture.storageRoot, 'linked-events.jsonl');
    await link(eventPath, linkedPath);
    await expect(fixture.service.append('hard-linked-event', event('project', 'loaded', 'Project loaded.', { revision: 'a' })))
      .rejects.toMatchObject({ code: 'PLAYGROUND_ROOT_INVALID' });
    await expect(readFile(linkedPath, 'utf8')).resolves.toBe('');
  } finally {
    await fixture.close();
  }
});

it('rejects hard-linked mutable session metadata and owner locks', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'hard-linked-metadata' });
    const metadataPath = join(await objectRoot(fixture.storageRoot, 'hard-linked-metadata'), 'session.json');
    const linkedMetadata = join(fixture.storageRoot, 'linked-session.json');
    await link(metadataPath, linkedMetadata);
    await expect(fixture.service.finalize('hard-linked-metadata', { status: 'passed' }))
      .rejects.toMatchObject({ code: 'PLAYGROUND_ROOT_INVALID' });
    await expect(readFile(linkedMetadata, 'utf8')).resolves.toContain('"state":"open"');

    const owner = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    await owner.openSession({ ...sessionInput(), sessionId: 'hard-linked-owner' });
    const ownerPath = join(await objectRoot(fixture.storageRoot, 'hard-linked-owner'), '.owner.lock');
    const linkedOwner = join(fixture.storageRoot, 'linked-owner.lock');
    await link(ownerPath, linkedOwner);
    const contender = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(contender.reopen('hard-linked-owner')).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      await expect(readFile(linkedOwner, 'utf8')).resolves.toContain('"token"');
    } finally {
      await Promise.allSettled([owner.close(), contender.close()]);
    }
  } finally {
    await fixture.close();
  }
});

it('rejects duplicate and extra persisted envelope keys before reopening', async () => {
  const fixture = await createFixture();
  const sessionId = 'strict-persisted-envelopes';
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId });
    await fixture.service.append(sessionId, event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await fixture.service.finalize(sessionId, { status: 'passed' });
    await fixture.service.close();
    const root = await objectRoot(fixture.storageRoot, sessionId);
    const metadataPath = join(root, 'session.json');
    const eventPath = join(root, 'events.jsonl');
    const indexDocument = await readFile(indexPath(fixture.storageRoot, sessionId), 'utf8');
    const metadataDocument = await readFile(metadataPath, 'utf8');
    const eventDocument = await readFile(eventPath, 'utf8');
    const corruptions = [
      [indexPath(fixture.storageRoot, sessionId), indexDocument.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')],
      [indexPath(fixture.storageRoot, sessionId), `${JSON.stringify({ ...JSON.parse(indexDocument), extra: true })}\n`],
      [metadataPath, metadataDocument.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')],
      [metadataPath, `${JSON.stringify({ ...JSON.parse(metadataDocument), extra: true })}\n`],
      [eventPath, eventDocument.replace('"sequence":1', '"sequence":1,"sequence":1')],
      [eventPath, `${JSON.stringify({ ...JSON.parse(eventDocument), extra: true })}\n`],
    ] as const;
    for (const [path, document] of corruptions) {
      await writeFile(path, document, 'utf8');
      const reader = new PlaygroundService({
        projectId: 'project-1',
        projectRoot: fixture.projectRoot,
        storageRoot: fixture.storageRoot,
      });
      try {
        await expect(reader.reopen(sessionId)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      } finally {
        await reader.close().catch(() => undefined);
      }
    }

    await writeFile(indexPath(fixture.storageRoot, sessionId), indexDocument, 'utf8');
    await writeFile(metadataPath, metadataDocument, 'utf8');
    await writeFile(eventPath, eventDocument, 'utf8');
    for (const [session, corrupt] of [
      ['strict-owner-extra', (document: string) => `${JSON.stringify({ ...JSON.parse(document), extra: true })}\n`],
      ['strict-owner-duplicate', (document: string) => document.replace('"version":1', '"version":1,"version":1')],
    ] as const) {
      const owner = new PlaygroundService({
        projectId: 'project-1',
        projectRoot: fixture.projectRoot,
        storageRoot: fixture.storageRoot,
      });
      await owner.openSession({ ...sessionInput(), sessionId: session });
      const ownerPath = join(await objectRoot(fixture.storageRoot, session), '.owner.lock');
      await writeFile(ownerPath, corrupt(await readFile(ownerPath, 'utf8')), 'utf8');
      const contender = new PlaygroundService({
        projectId: 'project-1',
        projectRoot: fixture.projectRoot,
        storageRoot: fixture.storageRoot,
      });
      try {
        await expect(contender.reopen(session)).rejects.toMatchObject({ code: 'PLAYGROUND_STORE_CORRUPT' });
      } finally {
        await Promise.allSettled([owner.close(), contender.close()]);
      }
    }
  } finally {
    await fixture.close();
  }
});

it('snapshots own __proto__ JSON keys without prototype mutation', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'own-proto' });
    const raw = JSON.parse('{"__proto__":{"retained":true},"safe":1}') as PlaygroundJsonObject;
    const stored = await fixture.service.append('own-proto', event('project', 'loaded', 'Project loaded.', raw));
    const snapshot = stored.raw as PlaygroundJsonObject;
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
    expect(snapshot).toMatchObject({ __proto__: { retained: true }, safe: 1 });
  } finally {
    await fixture.close();
  }
});

it('does not categorically reject durable persistence on a Windows platform', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  const fixture = await createFixture();
  try {
    await expect(fixture.service.openSession({ ...sessionInput(), sessionId: 'windows-directory-sync' }))
      .resolves.toMatchObject({ id: 'windows-directory-sync', state: 'open' });
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    await fixture.close();
  }
});

it('ignores unknown callback-shaped constructor properties instead of letting them block shutdown', async () => {
  const fixture = await createFixture();
  let injected = false;
  const options = {
    beforeSessionInstall: () => { injected = true; },
    projectId: 'project-1',
    projectRoot: fixture.projectRoot,
    storageRoot: fixture.storageRoot,
  } as unknown as PlaygroundServiceOptions;
  const service = new PlaygroundService(options);
  try {
    await service.openSession({ ...sessionInput(), sessionId: 'no-callback-injection' });
    expect(injected).toBe(false);
    await expect(service.close()).resolves.toBeUndefined();
  } finally {
    await service.close().catch(() => undefined);
    await fixture.close();
  }
});
