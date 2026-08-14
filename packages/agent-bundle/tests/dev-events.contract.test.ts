import { expect, it } from '@rstest/core';

import {
  ProjectEventHub,
  ProjectEventHubError,
  type ArtifactEpoch,
  type ArtifactStatus,
  type BuildAttempt,
  type BuildStatus,
  type ProjectEventOf,
  type ProjectEventInput,
  type ProjectEventType,
} from '../src/dev/index.ts';

const diagnostic = {
  code: 'BUILD_FAILED',
  message: 'The compiler rejected the source.',
  severity: 'error' as const,
};

const epoch = {
  configDigest: 'config-1',
  createdAt: '2026-08-14T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id: 'epoch-1',
  manifestPath: '/project/.agent-bundle/epochs/epoch-1/manifest.json',
  modelDigest: 'model-1',
  projectRevision: 'source-1',
  targetDigests: { claude: 'target-1' },
} as const satisfies ArtifactEpoch;

const sourceChanged: ProjectEventInput = {
  payload: {
    occurredAt: '2026-08-14T12:00:00.000Z',
    paths: ['skills/review/SKILL.md'],
    reason: 'source-change',
  },
  type: 'source.changed',
};

const runtimeEvent: ProjectEventInput = {
  epochId: epoch.id,
  payload: {
    details: { connected: true },
    sessionId: 'run-1',
    type: 'mcp.connected',
  },
  type: 'runtime.event',
};

const genericRuntimeEvent: ProjectEventOf<ProjectEventType> = {
  epochId: epoch.id,
  occurredAt: '2026-08-14T12:00:00.000Z',
  payload: runtimeEvent.payload,
  sequence: 1,
  type: 'runtime.event',
};

const runtimeEpochAndSession = (event: ProjectEventOf<ProjectEventType>): string => {
  if (event.type === 'runtime.event') {
    const epochId: string = event.epochId;
    const sessionId: string = event.payload.sessionId;
    return `${epochId}:${sessionId}`;
  }

  return event.type;
};

// @ts-expect-error a generic event union must retain the runtime payload pairing.
const genericMismatchedPayload: ProjectEventOf<ProjectEventType> = {
  epochId: epoch.id,
  occurredAt: '2026-08-14T12:00:00.000Z',
  payload: sourceChanged.payload,
  sequence: 1,
  type: 'runtime.event',
};

const failedAttempt = {
  completedAt: '2026-08-14T12:01:00.000Z',
  diagnostics: [diagnostic] as const,
  id: 'attempt-2',
  outcome: 'failed' as const,
  sourceRevision: 'source-2',
  startedAt: '2026-08-14T12:00:30.000Z',
};

const activeArtifact = {
  activeEpoch: epoch,
  currentSourceRevision: 'source-1',
  state: 'active' as const,
};

const completeBuildStatus: BuildStatus = {
  lastAttempt: failedAttempt,
  state: 'failed',
};

const completeArtifactStatus: ArtifactStatus = activeArtifact;

void completeBuildStatus;
void completeArtifactStatus;

// @ts-expect-error source status events cannot carry an invalidation payload.
const mismatchedPayload: ProjectEventInput = {
  payload: sourceChanged.payload,
  type: 'source.status',
};

// @ts-expect-error runtime events must name the epoch that executed them.
const runtimeWithoutEpoch: ProjectEventInput = {
  payload: runtimeEvent.payload,
  type: 'runtime.event',
};

// @ts-expect-error an available artifact event must name the active epoch.
const artifactWithoutEpoch: ProjectEventInput = {
  payload: activeArtifact,
  type: 'artifact.available',
};

// @ts-expect-error active artifacts cannot omit their active epoch.
const activeWithoutEpoch: ArtifactStatus = {
  currentSourceRevision: 'source-1',
  state: 'active',
};

// @ts-expect-error failed build attempts require their completion timestamp.
const incompleteFailure: BuildAttempt = {
  diagnostics: [diagnostic],
  id: 'attempt-2',
  outcome: 'failed',
  sourceRevision: 'source-2',
  startedAt: '2026-08-14T12:00:30.000Z',
};

// @ts-expect-error successful build attempts require their publication result.
const incompleteSuccess: BuildAttempt = {
  completedAt: '2026-08-14T12:01:00.000Z',
  diagnostics: [],
  id: 'attempt-1',
  outcome: 'succeeded',
  sourceRevision: 'source-1',
  startedAt: '2026-08-14T12:00:30.000Z',
};

// @ts-expect-error a building status must expose its running attempt.
const impossibleBuildingStatus: BuildStatus = { state: 'building' };

void mismatchedPayload;
void runtimeWithoutEpoch;
void artifactWithoutEpoch;
void activeWithoutEpoch;
void incompleteFailure;
void incompleteSuccess;
void impossibleBuildingStatus;
void genericMismatchedPayload;
void genericRuntimeEvent;
void runtimeEpochAndSession;

it('rejects non-JSON event payloads before allocating a sequence ID', () => {
  const hub = new ProjectEventHub();

  for (const payload of [
    new Date(),
    new Map([['key', 'value']]),
    new Uint8Array([1]),
    Infinity,
    { missing: undefined },
  ]) {
    expect(() => hub.publish({ payload, type: 'source.changed' } as never)).toThrow(
      ProjectEventHubError,
    );
  }

  expect(hub.latestSequence).toBe(0);
  expect(hub.publish(sourceChanged).sequence).toBe(1);
});

it('rejects numeric own array keys outside the array length without consuming a sequence', () => {
  const hub = new ProjectEventHub();
  const paths = ['skills/review/SKILL.md'];
  Object.defineProperty(paths, '4294967295', {
    enumerable: true,
    value: 'not-an-array-index',
  });

  expect(() => hub.publish({
    payload: {
      occurredAt: '2026-08-14T12:00:00.000Z',
      paths,
      reason: 'source-change',
    },
    type: 'source.changed',
  })).toThrow(ProjectEventHubError);
  expect(hub.latestSequence).toBe(0);
  expect(hub.publish(sourceChanged).sequence).toBe(1);
});

it('rejects a reconnect cursor that is ahead of the current stream', () => {
  const hub = new ProjectEventHub();
  hub.publish(sourceChanged);

  try {
    hub.subscribe({ afterSequence: 2 }, () => undefined);
    throw new Error('expected an ahead-of-stream cursor to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectEventHubError);
    expect((error as ProjectEventHubError).code).toBe('PROJECT_EVENT_CURSOR_AHEAD');
  }
});

it('reports a throwing live listener without starving later listeners', () => {
  const failures: unknown[] = [];
  const hub = new ProjectEventHub({
    onListenerError: (failure) => failures.push(failure),
  });
  let failingCalls = 0;
  const received: number[] = [];

  hub.subscribe(() => {
    failingCalls += 1;
    throw new Error('listener failed');
  });
  hub.subscribe((event) => {
    if (event.type !== 'replay.gap') {
      received.push(event.sequence);
    }
  });

  hub.publish(sourceChanged);
  hub.publish(runtimeEvent);

  expect(received).toEqual([1, 2]);
  expect(failingCalls).toBe(1);
  expect(failures).toHaveLength(1);
  expect(hub.listenerErrors).toHaveLength(1);
});

it('removes a listener that fails during replay before later live events arrive', () => {
  const hub = new ProjectEventHub();
  hub.publish(sourceChanged);
  let failingCalls = 0;

  hub.subscribe({ afterSequence: 0 }, () => {
    failingCalls += 1;
    throw new Error('replay listener failed');
  });
  expect(hub.subscriptionCount).toBe(0);
  hub.publish(runtimeEvent);

  expect(failingCalls).toBe(1);
  expect(hub.listenerErrors).toHaveLength(1);
});
