import { expect, it } from '@rstest/core';

import type { PlaygroundSession, PlaygroundTraceEvent } from '../../agent-bundle/src/dev/playground/playground-store.ts';
import {
  mergePlaygroundEvents,
  nativePlaygroundRequestFor,
  nativeSelectionFor,
  playgroundTraceRowsFor,
  playgroundViewFor,
} from '../src/playground/playground-model.ts';

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

const nativeCatalog = {
  cases: [{ id: 'case:review', label: 'Review fixture' }],
  epochId: 'epoch-native',
  fixtures: [{ id: 'fixture:empty', label: 'Empty workspace' }],
  modelPins: [{ host: 'claude' as const, id: 'pin:sonnet', label: 'Sonnet — authored pin' }],
  selections: [{ caseId: 'case:review', fixtureId: 'fixture:empty', host: 'claude' as const, modelPinId: 'pin:sonnet' }],
} as const;

const nativeSelection = {
  caseId: 'case:review',
  epochId: 'epoch-native',
  fixtureId: 'fixture:empty',
  host: 'claude' as const,
  modelPinId: 'pin:sonnet',
};

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
  expect(view.identity).toContainEqual({ label: 'Build ID', value: 'epoch-1' });
});

it('blocks promotion while a server-owned run remains open', () => {
  const view = playgroundViewFor({ epoch, events, exported: undefined, selectedRefs: ['events.jsonl#1'], session });
  expect(view.canPromote).toBe(false);
  expect(view.promotionBlocker).toContain('server-owned run');
});

it('admits a native prompt only for an exact server-advertised target and opaque catalog tuple', () => {
  const request = nativePlaygroundRequestFor({
    catalog: nativeCatalog,
    prompt: 'Review the fixture and report the result.',
    selection: nativeSelection,
    target: 'claude',
    targets: [{ digest: 'sha256-claude', name: 'claude' }],
  });

  expect(request).toEqual({
    caseId: 'case:review', epochId: 'epoch-native', fixtureId: 'fixture:empty', host: 'claude', modelPinId: 'pin:sonnet',
    operation: 'native.prompt', prompt: 'Review the fixture and report the result.', target: 'claude',
  });
  expect(Object.isFrozen(request)).toBe(true);
  expect(nativePlaygroundRequestFor({
    catalog: nativeCatalog,
    prompt: 'Review the fixture and report the result.',
    selection: { ...nativeSelection, modelPinId: 'pin:forged' },
    target: 'claude',
    targets: [{ digest: 'sha256-claude', name: 'claude' }],
  })).toBeUndefined();
  expect(nativePlaygroundRequestFor({
    catalog: nativeCatalog,
    prompt: 'Review the fixture and report the result.',
    selection: nativeSelection,
    target: 'missing-target',
    targets: [{ digest: 'sha256-claude', name: 'claude' }],
  })).toBeUndefined();
});

it('clears opaque native selection fields when a catalog epoch or tuple is stale', () => {
  expect(nativeSelectionFor(nativeCatalog, nativeSelection)).toEqual(nativeSelection);
  expect(nativeSelectionFor({ ...nativeCatalog, epochId: 'epoch-rebuilt' }, nativeSelection)).toEqual({
    caseId: '', epochId: 'epoch-rebuilt', fixtureId: '', host: '', modelPinId: '',
  });
  expect(nativeSelectionFor(nativeCatalog, { ...nativeSelection, fixtureId: 'fixture:forged' })).toEqual({
    caseId: 'case:review', epochId: 'epoch-native', fixtureId: '', host: 'claude', modelPinId: '',
  });
});

it('keeps native host/pin/case provenance and observed classification literal from durable identity and events', () => {
  const nativeSession: PlaygroundSession = {
    ...finalized,
    identity: {
      ...identity,
      fixture: { digest: 'sha256-native-fixture', id: 'fixture:empty' },
      invocation: {
        intent: { caseId: 'case:review', fixtureId: 'fixture:empty', host: 'claude', modelPinId: 'pin:sonnet' },
        kind: 'native.prompt',
      },
    },
    outcome: { response: 'Native response.', status: 'passed', workspace: { changed: ['result.txt'] } },
  };
  const activation: PlaygroundTraceEvent = {
    kind: 'native.activation', raw: { activation: { level: 'observed', skills: ['review'] } }, rawEventRef: 'events.jsonl#3',
    sequence: 3, source: 'skill-evidence', summary: 'Recorded native activation.', timestamp: '2026-08-14T10:00:03.000Z',
  };
  const view = playgroundViewFor({ epoch, events: [activation], exported: undefined, selectedRefs: ['events.jsonl#3'], session: nativeSession });

  expect(view.identity).toContainEqual({ label: 'Native host', value: 'claude' });
  expect(view.identity).toContainEqual({ label: 'Native case', value: 'case:review' });
  expect(view.identity).toContainEqual({ label: 'Authored model pin', value: 'pin:sonnet' });
  expect(view.rows[0]?.raw).toEqual({ activation: { level: 'observed', skills: ['review'] } });
  expect(view.workspace).toEqual({ changed: ['result.txt'] });
  expect(view.rawEventRefs).toEqual(['events.jsonl#3']);
  expect(view.canPromote).toBe(true);
});
