import { expect, it } from '@rstest/core';

import type { PlaygroundSession, PlaygroundTraceEvent } from '../../agent-bundle/src/services/playground-service.ts';
import { mergePlaygroundEvents, playgroundLogsViewFor, playgroundTraceRowsFor, playgroundViewFor } from '../src/playground/playground-model.ts';

const epoch = { digest: 'sha256-epoch', id: 'epoch-1' };
const identity = {
  epoch,
  fixture: { digest: 'sha256-fixture', id: 'server-owned-workspace' },
  invocation: { intent: { skillId: 'review' }, kind: 'skill.inspect' },
  target: { digest: 'sha256-portable', name: 'portable' },
  task: { id: 'run-1', text: 'Inspect an emitted Skill.' },
};
const session: PlaygroundSession = { cleanupFailures: [], createdAt: '2026-08-14T10:00:00.000Z', id: 'session-1', identity, state: 'open' };
const finalized: PlaygroundSession = { ...session, outcome: { status: 'passed' }, state: 'finalized' };
const event = (sequence: number, source: PlaygroundTraceEvent['source'], kind: string): PlaygroundTraceEvent => ({
  kind, raw: { position: sequence }, rawEventRef: `events.jsonl#${sequence}`, sequence, source, summary: `Event ${sequence}`,
  timestamp: `2026-08-14T10:00:0${sequence}.000Z`,
});
const events = [event(1, 'build', 'epoch.bound'), event(2, 'skill-evidence', 'skill.inspected')] as const;

it('merges replayed and streamed events into one ordered, deduplicated trace', () => {
  const merged = mergePlaygroundEvents([events[1]], [events[0], events[1]]);
  expect(merged.map((entry) => entry.sequence)).toEqual([1, 2]);
  expect(Object.isFrozen(merged)).toBe(true);
});

it('rejects a conflicting duplicate without replacing the trusted persisted event', () => {
  const trusted = event(1, 'build', 'epoch.bound');
  const conflicts = [
    { ...trusted, raw: { position: 99 }, summary: 'Forged replacement.' },
    { ...trusted, sequence: 2 },
  ];

  for (const conflicting of conflicts) {
    expect(() => mergePlaygroundEvents([trusted], [conflicting])).toThrow(/conflicting playground trace event/iu);
  }
  expect(trusted).toMatchObject({ raw: { position: 1 }, rawEventRef: 'events.jsonl#1', summary: 'Event 1' });
});

it('shows the server-pinned epoch for each persisted trace event', () => {
  const rows = playgroundTraceRowsFor(epoch, events);
  expect(rows.map((row) => row.rawEventRef)).toEqual(['events.jsonl#1', 'events.jsonl#2']);
  expect(rows.every((row) => row.epochId === 'epoch-1')).toBe(true);
});

it('promotes only selected persisted raw event references once the server finalizes the run', () => {
  const view = playgroundViewFor({
    epoch: { digest: 'sha256-current', id: 'epoch-current' }, events, exported: undefined,
    selectedRefs: ['forged.jsonl#1', 'events.jsonl#2'], session: finalized,
  });

  expect(view.state).toBe('finalized');
  expect(view.rawEventRefs).toEqual(['events.jsonl#2']);
  expect(view.canPromote).toBe(true);
  expect(view.identity).toContainEqual({ label: 'Epoch', value: 'epoch-1' });
});

it('blocks promotion while a server-owned run remains open', () => {
  const view = playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['events.jsonl#1'], session });
  expect(view.canPromote).toBe(false);
  expect(view.promotionBlocker).toContain('server-owned run');
});

it('keeps logs bound to the persisted session rather than the current epoch', () => {
  const view = playgroundLogsViewFor({ epoch: { digest: 'new', id: 'epoch-2' }, events, kind: undefined, session, source: undefined });
  expect(view.rows.map((row) => row.epochId)).toEqual(['epoch-1', 'epoch-1']);
});
