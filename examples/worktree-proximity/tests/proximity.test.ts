import { describe, expect, it } from '@rstest/core';

import { findProximity } from '../src/domain/proximity.js';
import type { IntentState } from '../src/state.js';

const snapshot = (path: string, dependency: string): IntentState => ({
  activities: [{
    actorId: 'agent-b',
    dependencies: [dependency],
    idempotencyKey: 'intent-b',
    observedAt: '2026-09-01T20:00:00.000Z',
    paths: [path],
    provenance: {
      actorId: 'native',
      dependencies: 'native',
      paths: 'native',
    },
  }],
  bindings: [
    {
      actorId: 'agent-a',
      provenance: { actorId: 'native', worktreeRoot: 'native' },
      worktreeRoot: '/repo/worktrees/a',
    },
    {
      actorId: 'agent-b',
      provenance: { actorId: 'native', worktreeRoot: 'native' },
      worktreeRoot: '/repo/worktrees/b',
    },
  ],
  refusals: [],
});

describe('findProximity', () => {
  it('returns no conflict for distinct paths and dependencies', () => {
    expect(findProximity(
      snapshot('src/catalog.ts', 'zod'),
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: ['react'], paths: ['src/player.ts'] },
    )).toEqual([]);
  });

  it('reports a normalized repo-relative path overlap in another worktree', () => {
    expect(findProximity(
      snapshot('./src/shared.ts', 'zod'),
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: [], paths: ['/repo/worktrees/a/src/shared.ts'] },
    )).toEqual([{
      actorId: 'agent-b',
      summary:
        'Worktrees /repo/worktrees/a and /repo/worktrees/b both intend to change path src/shared.ts.',
      worktreeRoot: '/repo/worktrees/b',
    }]);
  });

  it('reports a case-insensitive dependency overlap in another worktree', () => {
    expect(findProximity(
      snapshot('src/catalog.ts', 'Zod'),
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: ['zod'], paths: [] },
    )).toEqual([{
      actorId: 'agent-b',
      summary:
        'Worktrees /repo/worktrees/a and /repo/worktrees/b both depend on zod.',
      worktreeRoot: '/repo/worktrees/b',
    }]);
  });

  it('ignores an actor in the same worktree', () => {
    const sameWorktree: IntentState = {
      ...snapshot('src/shared.ts', 'zod'),
      bindings: snapshot('src/shared.ts', 'zod').bindings.map((binding) => ({
        ...binding,
        worktreeRoot: '/repo/worktrees/a',
      })),
    };
    expect(findProximity(
      sameWorktree,
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: ['zod'], paths: ['src/shared.ts'] },
    )).toEqual([]);
  });

  it('ignores an intent whose host-identified actor the runtime lineage tree no longer lists as alive', () => {
    const state = snapshot('src/shared.ts', 'zod');
    const intent = { actorId: 'agent-a', dependencies: [], paths: ['src/shared.ts'] };
    expect(findProximity(state, '/repo/worktrees/a', intent, { liveConversations: new Set(['agent-a', 'root-session']) })).toEqual([]);
    expect(findProximity(state, '/repo/worktrees/a', intent, { liveConversations: new Set(['agent-a', 'agent-b']) })).toHaveLength(1);
    // Without a tree nothing is presumed stopped.
    expect(findProximity(state, '/repo/worktrees/a', intent)).toHaveLength(1);
  });

  it('never filters a derived worktree actor by the lineage tree: it is not a conversation', () => {
    const base = snapshot('src/shared.ts', 'zod');
    const state: IntentState = {
      ...base,
      activities: base.activities.map((activity) => ({ ...activity, actorId: 'worktree:/repo/worktrees/b', provenance: { ...activity.provenance, actorId: 'derived' } })),
      bindings: base.bindings.map((binding) => binding.actorId === 'agent-b'
        ? { actorId: 'worktree:/repo/worktrees/b', provenance: { actorId: 'derived', worktreeRoot: 'derived' }, worktreeRoot: binding.worktreeRoot }
        : binding),
    };
    expect(findProximity(
      state,
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: [], paths: ['src/shared.ts'] },
      { liveConversations: new Set(['agent-a']) },
    )).toHaveLength(1);
  });
});
