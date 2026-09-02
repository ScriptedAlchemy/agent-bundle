import { describe, expect, it } from '@rstest/core';

import { findProximity } from '../src/domain/proximity.js';
import type { TopologyState } from '../src/state.js';

const snapshot = (path: string, dependency: string): TopologyState => ({
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
  actors: [
    {
      id: 'agent-a',
      kind: 'child',
      parentSessionId: 'root-session',
      provenance: {
        id: 'native',
        parentSessionId: 'native',
        worktreeRoot: 'native',
      },
      status: 'active',
      worktreeRoot: '/repo/worktrees/a',
    },
    {
      id: 'agent-b',
      kind: 'child',
      parentSessionId: 'root-session',
      provenance: {
        id: 'native',
        parentSessionId: 'native',
        worktreeRoot: 'native',
      },
      status: 'active',
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
    }]);
  });

  it('ignores an actor in the same worktree', () => {
    const sameWorktree: TopologyState = {
      ...snapshot('src/shared.ts', 'zod'),
      actors: snapshot('src/shared.ts', 'zod').actors.map((actor) => ({
        ...actor,
        worktreeRoot: '/repo/worktrees/a',
      })),
    };
    expect(findProximity(
      sameWorktree,
      '/repo/worktrees/a',
      { actorId: 'agent-a', dependencies: ['zod'], paths: ['src/shared.ts'] },
    )).toEqual([]);
  });
});
