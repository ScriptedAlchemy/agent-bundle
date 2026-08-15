import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  PlaygroundService,
  PlaygroundServiceCloseError,
  PlaygroundSessionCloseError,
  type PlaygroundEventInput,
  type PlaygroundJsonObject,
} from '../src/services/playground-service.ts';

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

const createFixture = async (input: Readonly<{
  readonly maxSubscriberQueue?: number;
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
        evidence: { authorization: 'Bearer provider-secret', nested: { apiKey: 'provider-key', retained: true } },
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
    expect(JSON.stringify(draft)).not.toContain('provider-secret');
    expect(JSON.stringify(draft)).not.toContain('provider-key');
    expect(JSON.stringify(draft)).not.toContain('events.jsonl');
    expect(JSON.stringify(draft)).not.toContain('sequence');

    const persisted = await readFile(join(fixture.storageRoot, 'sessions', 'session-1', 'events.jsonl'), 'utf8');
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
    const persisted = await readFile(join(fixture.storageRoot, 'sessions', 'concurrent', 'events.jsonl'), 'utf8');
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

    const eventPath = join(fixture.storageRoot, 'sessions', 'reopen', 'events.jsonl');
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
    await expect(otherProject.reopen('owned')).rejects.toThrow('project');
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

it('rejects persisted trace records with unsupported source values', async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.openSession({ ...sessionInput(), sessionId: 'invalid-event-source' });
    await fixture.service.append('invalid-event-source', event('project', 'loaded', 'Project loaded.', { revision: 'a' }));
    await fixture.service.close();

    const eventPath = join(fixture.storageRoot, 'sessions', 'invalid-event-source', 'events.jsonl');
    const persisted = JSON.parse((await readFile(eventPath, 'utf8')).trim()) as Record<string, unknown>;
    await writeFile(eventPath, `${JSON.stringify({ ...persisted, source: 'unsupported-source' })}\n`, 'utf8');

    const reopened = new PlaygroundService({
      projectId: 'project-1',
      projectRoot: fixture.projectRoot,
      storageRoot: fixture.storageRoot,
    });
    try {
      await expect(reopened.reopen('invalid-event-source')).rejects.toMatchObject({
        code: 'PLAYGROUND_STORE_CORRUPT',
      });
    } finally {
      await reopened.close().catch(() => undefined);
    }
  } finally {
    await fixture.close();
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
    const sessionDocument = await readFile(join(fixture.storageRoot, 'sessions', 'credential-event', 'session.json'), 'utf8');
    const eventDocument = await readFile(join(fixture.storageRoot, 'sessions', 'credential-event', 'events.jsonl'), 'utf8');
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
    const metadataPath = join(fixture.storageRoot, 'sessions', 'transactional', 'session.json');
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
    const metadataPath = join(fixture.storageRoot, 'sessions', 'metadata-link', 'session.json');
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
