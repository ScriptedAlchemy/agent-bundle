import { expect, it } from '@rstest/core';

import {
  ProjectEventHub,
  freezeProjectStatus,
  type ProjectEvent,
  type ProjectEventMessage,
  type ProjectStatus,
} from '../src/dev/index.ts';

const isPublishedEvent = (event: ProjectEventMessage): event is ProjectEvent =>
  event.type !== 'replay.gap';

const invalidation = (
  paths: readonly string[],
  reason: 'initial' | 'manual' | 'source-change' = 'source-change',
) => ({
  occurredAt: '2026-08-14T12:00:00.000Z',
  paths,
  reason,
});

it('retains the active artifact when a later build attempt fails', () => {
  const status = freezeProjectStatus({
    artifact: {
      activeEpoch: {
        configDigest: 'config-1',
        createdAt: '2026-08-14T12:00:00.000Z',
        diagnostics: { errors: 0, infos: 0, warnings: 0 },
        id: 'epoch-1',
        manifestPath: '/project/.agent-bundle/epochs/epoch-1/manifest.json',
        modelDigest: 'model-1',
        projectRevision: 'source-1',
        targetDigests: { claude: 'target-1' },
      },
      currentSourceRevision: 'source-2',
      state: 'stale',
    },
    build: {
      lastAttempt: {
        completedAt: '2026-08-14T12:01:00.000Z',
        diagnostics: [
          {
            code: 'BUILD_FAILED',
            message: 'The compiler rejected the current source.',
            severity: 'error',
          },
        ] as const,
        id: 'attempt-2',
        outcome: 'failed',
        sourceRevision: 'source-2',
        startedAt: '2026-08-14T12:00:30.000Z',
      },
      state: 'failed',
    },
    source: {
      diagnostics: [],
      revision: 'source-2',
      state: 'ready',
    },
  } satisfies ProjectStatus);

  expect(status.artifact).toMatchObject({
    activeEpoch: { id: 'epoch-1', projectRevision: 'source-1' },
    currentSourceRevision: 'source-2',
    state: 'stale',
  });
  const lastAttempt = status.build.lastAttempt;
  if (lastAttempt === undefined) {
    throw new Error('expected the failed build attempt to be retained');
  }
  expect(lastAttempt).toMatchObject({
    outcome: 'failed',
    sourceRevision: 'source-2',
  });
  expect(Object.isFrozen(status)).toBe(true);
  expect(Object.isFrozen(status.artifact.activeEpoch)).toBe(true);
  expect(Object.isFrozen(lastAttempt.diagnostics)).toBe(true);
});

it('assigns monotonic sequence IDs and freezes published event payloads', () => {
  const hub = new ProjectEventHub();

  const first = hub.publish({
    payload: invalidation(['skills/review/SKILL.md']),
    type: 'source.changed',
  });
  const second = hub.publish({
    payload: { providerSessionId: 'provider-a', type: 'runtime.mcp.ready' },
    type: 'runtime.event',
  });

  expect([first.sequence, second.sequence]).toEqual([1, 2]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.payload)).toBe(true);
  expect(Object.isFrozen((first.payload as { paths: readonly string[] }).paths)).toBe(true);
});

it('queues live events published during replay until retained events are delivered', () => {
  const hub = new ProjectEventHub();
  hub.publish({ payload: invalidation(['agent-bundle.config.ts']), type: 'source.changed' });
  hub.publish({ payload: invalidation([], 'manual'), type: 'invalidation' });

  const received: number[] = [];
  hub.subscribe({ afterSequence: 0 }, (event) => {
    if (!isPublishedEvent(event)) {
      return;
    }

    received.push(event.sequence);
    if (event.sequence === 1) {
      hub.publish({
        payload: { providerSessionId: 'provider-a', type: 'runtime.mcp.ready' },
        type: 'runtime.event',
      });
    }
  });

  expect(received).toEqual([1, 2, 3]);
});

it('continues a reconnecting client with later live events in sequence order', () => {
  const hub = new ProjectEventHub();
  hub.publish({ payload: invalidation(['one']), type: 'source.changed' });
  hub.publish({ payload: invalidation(['two']), type: 'source.changed' });

  const received: number[] = [];
  hub.subscribe({ afterSequence: 1 }, (event) => {
    if (isPublishedEvent(event)) {
      received.push(event.sequence);
    }
  });
  hub.publish({ payload: invalidation(['three']), type: 'source.changed' });

  expect(received).toEqual([2, 3]);
});

it('reports a replay gap before the retained suffix when the requested cursor has expired', () => {
  const hub = new ProjectEventHub({ replayLimit: 2 });
  hub.publish({ payload: invalidation(['one']), type: 'source.changed' });
  hub.publish({ payload: invalidation(['two']), type: 'source.changed' });
  hub.publish({ payload: invalidation(['three']), type: 'source.changed' });

  const received: Array<{ readonly sequence?: number; readonly type: string }> = [];
  hub.subscribe({ afterSequence: 0 }, (event) => {
    if (isPublishedEvent(event)) {
      received.push({ sequence: event.sequence, type: event.type });
      return;
    }

    received.push({ type: event.type });
  });

  expect(received).toEqual([
    { type: 'replay.gap' },
    { sequence: 2, type: 'source.changed' },
    { sequence: 3, type: 'source.changed' },
  ]);
});
