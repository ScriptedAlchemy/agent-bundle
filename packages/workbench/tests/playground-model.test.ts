import { expect, it } from '@rstest/core';

import type {
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../agent-bundle/src/services/playground-service.ts';
import {
  mergePlaygroundEvents,
  playgroundAssertionsFor,
  playgroundLogsViewFor,
  playgroundTraceRowsFor,
  playgroundViewFor,
} from '../src/playground/playground-model.ts';

const epoch = { digest: 'sha256-epoch', id: 'epoch-1' };

const identity = {
  epoch,
  fixture: { digest: 'sha256-fixture', id: 'fixture-1' },
  invocation: { intent: { operation: 'build' }, kind: 'whole-plugin' },
  target: { digest: 'sha256-claude', name: 'claude' },
  task: { id: 'task-1', text: 'Review the emitted bundle.' },
};

const session: PlaygroundSession = {
  cleanupFailures: [],
  createdAt: '2026-08-14T10:00:00.000Z',
  id: 'session-1',
  identity,
  state: 'open',
};

const finalized: PlaygroundSession = {
  ...session,
  outcome: { response: 'The bundle built cleanly.', status: 'succeeded', workspace: { changed: ['claude/skills'] } },
  state: 'finalized',
};

const event = (sequence: number, source: PlaygroundTraceEvent['source'], kind: string): PlaygroundTraceEvent => ({
  kind,
  raw: { position: sequence },
  rawEventRef: `session-1/${sequence}`,
  sequence,
  source,
  summary: `Event ${sequence}`,
  timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});

const events: readonly PlaygroundTraceEvent[] = [
  event(1, 'build', 'build.started'),
  event(2, 'mcp', 'mcp.request'),
  event(3, 'build', 'build.completed'),
];

it('merges replayed and streamed events into one ordered, deduplicated trace', () => {
  const merged = mergePlaygroundEvents([events[2]!, events[0]!], [events[1]!, events[0]!]);

  expect(merged.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  expect(Object.isFrozen(merged)).toBe(true);
});

it('renders each trace row with its epoch binding and raw event reference', () => {
  const rows = playgroundTraceRowsFor(epoch, events);

  expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
  expect(rows[0]).toMatchObject({
    epochDigest: 'sha256-epoch',
    epochId: 'epoch-1',
    key: 'session-1/1',
    kind: 'build.started',
    rawEventRef: 'session-1/1',
    source: 'build',
    summary: 'Event 1',
    timestamp: '2026-08-14T10:00:01.000Z',
  });
  expect(rows[0]?.raw).toEqual({ position: 1 });
  expect(Object.isFrozen(rows)).toBe(true);
});

it('binds replayed rows to the session epoch instead of the active epoch', () => {
  const view = playgroundViewFor({
    epoch: { digest: 'sha256-epoch-2', id: 'epoch-2' },
    events,
    exported: undefined,
    selectedRefs: [],
    session,
  });

  expect(view.rows.every((row) => row.epochId === 'epoch-1')).toBe(true);
  expect(view.rows.every((row) => row.epochDigest === 'sha256-epoch')).toBe(true);
});

it('derives selected assertions that cite the exact epoch and raw event reference', () => {
  const assertions = playgroundAssertionsFor(playgroundTraceRowsFor(epoch, events), ['session-1/3', 'session-1/1']);

  expect(assertions.map((assertion) => assertion.id)).toEqual(['session-1/1', 'session-1/3']);
  expect(assertions[0]).toEqual({
    evidence: {
      epochDigest: 'sha256-epoch',
      epochId: 'epoch-1',
      rawEventRef: 'session-1/1',
      sequence: 1,
      timestamp: '2026-08-14T10:00:01.000Z',
    },
    expectation: { kind: 'build.started', source: 'build', summary: 'Event 1' },
    id: 'session-1/1',
    kind: 'trace-event',
  });
  expect(Object.isFrozen(assertions)).toBe(true);
});

it('refuses promotion until a durable outcome is finalized', () => {
  const open = playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['session-1/1'], session });

  expect(open.state).toBe('open');
  expect(open.canPromote).toBe(false);
  expect(open.promotionBlocker).toContain('Finalize a durable outcome');
});

it('refuses promotion of a finalized session with no selected assertion', () => {
  const view = playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: [], session: finalized });

  expect(view.state).toBe('finalized');
  expect(view.canPromote).toBe(false);
  expect(view.promotionBlocker).toContain('Select at least one');
});

it('allows promotion once an outcome is finalized and assertions are selected', () => {
  const view = playgroundViewFor({
    epoch,
    events,
    exported: { events, schemaVersion: 1, session: finalized },
    selectedRefs: ['session-1/2'],
    session: finalized,
  });

  expect(view.canPromote).toBe(true);
  expect(view.promotionBlocker).toBeUndefined();
  expect(view.assertions.map((assertion) => assertion.id)).toEqual(['session-1/2']);
  expect(view.cursor).toBe(3);
  expect(view.exported?.schemaVersion).toBe(1);
  expect(view.outcome).toEqual([
    { label: 'Status', value: 'succeeded' },
    { label: 'Response', value: 'The bundle built cleanly.' },
  ]);
  expect(Object.isFrozen(view)).toBe(true);
});

it('lists the session identity that a draft eval case will carry', () => {
  const view = playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: [], session });

  expect(view.identity).toEqual([
    { label: 'Session', value: 'session-1' },
    { label: 'Session state', value: 'open' },
    { label: 'Epoch', value: 'epoch-1' },
    { label: 'Epoch digest', value: 'sha256-epoch' },
    { label: 'Fixture', value: 'fixture-1' },
    { label: 'Fixture digest', value: 'sha256-fixture' },
    { label: 'Target', value: 'claude' },
    { label: 'Target digest', value: 'sha256-claude' },
    { label: 'Task', value: 'task-1' },
    { label: 'Invocation kind', value: 'whole-plugin' },
  ]);
});

it('reports the no-epoch and no-session states', () => {
  const noEpoch = playgroundViewFor({ epoch: undefined, events: [], exported: undefined, selectedRefs: [], session: undefined });
  const noSession = playgroundViewFor({ epoch, events: [], exported: undefined, selectedRefs: [], session: undefined });

  expect(noEpoch.state).toBe('no-epoch');
  expect(noEpoch.summary).toContain('No artifact epoch is active');
  expect(noEpoch.rows).toEqual([]);
  expect(noSession.state).toBe('no-session');
  expect(noSession.summary).toContain('epoch-1');
  expect(noSession.identity).toEqual([]);
});

it('orders the log rows most recent first and offers the observed filters', () => {
  const view = playgroundLogsViewFor({ epoch, events, kind: undefined, session, source: undefined });

  expect(view.rows.map((row) => row.sequence)).toEqual([3, 2, 1]);
  expect(view.sources).toEqual(['build', 'mcp']);
  expect(view.kinds).toEqual(['build.completed', 'build.started', 'mcp.request']);
  expect(view.total).toBe(3);
  expect(view.summary).toContain('3 of 3');
  expect(Object.isFrozen(view)).toBe(true);
});

it('filters the log rows by source and kind without losing the epoch citation', () => {
  const bySource = playgroundLogsViewFor({ epoch, events, kind: undefined, session, source: 'build' });
  const byKind = playgroundLogsViewFor({ epoch, events, kind: 'build.completed', session, source: 'build' });

  expect(bySource.rows.map((row) => row.sequence)).toEqual([3, 1]);
  expect(byKind.rows.map((row) => row.rawEventRef)).toEqual(['session-1/3']);
  expect(byKind.rows.every((row) => row.epochId === 'epoch-1')).toBe(true);
  expect(byKind.summary).toContain('1 of 3');
});

it('reports the no-session log state before a playground session exists', () => {
  const view = playgroundLogsViewFor({ epoch, events: [], kind: undefined, session: undefined, source: undefined });

  expect(view.state).toBe('no-session');
  expect(view.rows).toEqual([]);
  expect(view.sources).toEqual([]);
});
