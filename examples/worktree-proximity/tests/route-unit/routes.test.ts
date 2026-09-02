import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import { available } from '@agent-bundle/runtime';
import { agentNoticeStateDefinition } from '@agent-bundle/runtime/notices';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

import { topologyStateDefinition } from '../../src/state.js';

const manifest = testManifest();

const worktrees = {
  root: '/repo',
  a: '/repo/.worktrees/a',
  b: '/repo/.worktrees/b',
} as const;

let stateRoot: string;
let previousStateRoot: string | undefined;
let sequence = 0;

const provider = (root: string) => ({
  branch: `branch-${root.split('/').at(-1) ?? 'root'}`,
  commonDir: '/repo/.git',
  head: '490cb102ebb247d4d0b1a4ce5178ddfb66c9e5dd',
  isLinkedWorktree: root !== worktrees.root,
  root,
  source: 'native-cwd' as const,
  state: 'available' as const,
});

const eventInput = (
  event: 'agent/start' | 'session/start' | 'stop' | 'tool/after' | 'tool/before',
  native: Record<string, unknown>,
  id: string,
) => ({
  canonical: {
    event,
    idempotencyKey: id,
    observedAt: `2026-09-01T20:00:${String(sequence++).padStart(2, '0')}.000Z`,
    provenance: {
      host: 'claude',
      hostContractRevision: 'route-unit',
      nativeEvent: native.hook_event_name as string,
      source: 'native',
    },
    sequence,
  },
  native,
});

const renderEvent = async (
  route: string,
  event: Parameters<typeof eventInput>[0],
  native: Record<string, unknown>,
  id: string,
  worktreeRoot: string,
  actorId?: string,
) => renderRoute(route, {
  context: {
    actor: actorId === undefined ? undefined : available({ id: actorId }, 'native'),
    host: available({ name: 'claude' }, 'native'),
    invocation: {
      id: `invocation:${id}`,
      startedAt: `2026-09-01T20:01:${String(sequence).padStart(2, '0')}.000Z`,
    },
    providers: { gitWorktree: provider(worktreeRoot) },
    session: available({ sessionId: 'root-session' }, 'native'),
    workspace: available({ root: '/repo' }, 'native'),
  },
  input: eventInput(event, native, id),
});

const bindActors = async (): Promise<void> => {
  await renderEvent(
    'event:session/start',
    'session/start',
    { cwd: worktrees.root, hook_event_name: 'SessionStart', session_id: 'root-session' },
    'root:start',
    worktrees.root,
    'session:root-session',
  );
  await renderEvent(
    'event:agent/start',
    'agent/start',
    {
      agent_id: 'agent-a',
      agent_type: 'implementation',
      cwd: worktrees.a,
      hook_event_name: 'SubagentStart',
      session_id: 'root-session',
    },
    'agent-a:start',
    worktrees.a,
    'agent-a',
  );
  await renderEvent(
    'event:agent/start',
    'agent/start',
    {
      agent_id: 'agent-b',
      agent_type: 'implementation',
      cwd: worktrees.b,
      hook_event_name: 'SubagentStart',
      session_id: 'root-session',
    },
    'agent-b:start',
    worktrees.b,
    'agent-b',
  );
};

const recordIntent = (
  actorId: 'agent-a' | 'agent-b',
  root: string,
  path: string,
  id: string,
  deps = '',
) => renderEvent(
  'event:tool/before',
  'tool/before',
  {
    cwd: root,
    hook_event_name: 'PreToolUse',
    session_id: 'root-session',
    tool_input: { deps, file_path: path },
    tool_name: 'Edit',
  },
  id,
  root,
  actorId,
);

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'worktree-proximity-route-unit-'));
  previousStateRoot = process.env.WORKTREE_PROXIMITY_STATE_DIR;
  process.env.WORKTREE_PROXIMITY_STATE_DIR = stateRoot;
  sequence = 0;
});

afterEach(async () => {
  if (previousStateRoot === undefined) delete process.env.WORKTREE_PROXIMITY_STATE_DIR;
  else process.env.WORKTREE_PROXIMITY_STATE_DIR = previousStateRoot;
  await rm(stateRoot, { force: true, recursive: true });
});

it('compiles the complete shared-runtime route surface', () => {
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(Object.keys(manifest.routes)).toEqual(expect.arrayContaining([
    'event:agent/start',
    'event:session/start',
    'event:stop',
    'event:tool/after',
    'event:tool/before',
    'tool:coordinator/status',
  ]));
});

describe('worktree proximity journeys', () => {
  it('does not warn when active paths and dependencies do not overlap (journey 3)', async () => {
    await bindActors();
    await recordIntent('agent-b', worktrees.b, 'src/catalog.ts', 'intent:b', 'deps:zod');
    const rendered = await recordIntent('agent-a', worktrees.a, 'src/player.ts', 'intent:a', 'deps:react');

    expectDocument(rendered).toHaveStatus('success').toHaveNodeKinds(['result']);
    expect(rendered.document.value).toEqual({ outcome: 'continue' });
  });

  it('warns without denying and publishes a pending directed notice (journeys 4 and 5)', async () => {
    await bindActors();
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');
    const rendered = await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainContext('Proximity warning')
      .toContainContext('src/shared.ts');
    expect(rendered.document.value).toMatchObject({ outcome: 'continue' });

    const driver = createSqliteStateDriver({ root: stateRoot });
    try {
      const store = await driver.open(agentNoticeStateDefinition());
      const snapshot = await store.read();
      expect(snapshot.state.notices).toEqual([
        expect.objectContaining({
          recipient: { actor: { id: 'agent-b' } },
          state: 'pending',
        }),
      ]);
    } finally {
      await driver.close();
    }
  });

  it('attempts and surfaces a notice on the recipient next event (journey 6)', async () => {
    await bindActors();
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');

    const delivered = await renderEvent(
      'event:tool/after',
      'tool/after',
      {
        cwd: worktrees.b,
        hook_event_name: 'PostToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/shared.ts' },
        tool_name: 'Edit',
      },
      'intent:b:after',
      worktrees.b,
      'agent-b',
    );

    expectDocument(delivered)
      .toHaveStatus('success')
      .toContainContext('Directed proximity notice')
      .toContainContext('src/shared.ts');

    const driver = createSqliteStateDriver({ root: stateRoot });
    try {
      const store = await driver.open(agentNoticeStateDefinition());
      const snapshot = await store.read();
      expect(snapshot.state.notices[0]).toMatchObject({
        attempts: [expect.objectContaining({ invocationId: 'invocation:intent:b:after' })],
        state: 'attempted',
      });
    } finally {
      await driver.close();
    }
  });

  it('deduplicates a repeated native intent envelope (journey 7)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/player.ts', 'intent:replayed');
    await recordIntent('agent-a', worktrees.a, 'src/player.ts', 'intent:replayed');

    const driver = createSqliteStateDriver({ root: stateRoot });
    try {
      const store = await driver.open(topologyStateDefinition);
      const snapshot = await store.read();
      expect(snapshot.state.activities.filter((activity) => activity.actorId === 'agent-a')).toHaveLength(1);
      expect(snapshot.revision).toBe(7);
    } finally {
      await driver.close();
    }
  });

  it('records a refusal and never fabricates an edge without native agent identity (journey 8)', async () => {
    const rendered = await renderEvent(
      'event:agent/start',
      'agent/start',
      {
        agent_type: 'fixture-without-identity',
        cwd: worktrees.a,
        hook_event_name: 'SubagentStart',
        session_id: 'root-session',
      },
      'agent:missing-id',
      worktrees.a,
    );

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainContext('Parent identity unavailable')
      .toContainContext('refused to fabricate');

    const driver = createSqliteStateDriver({ root: stateRoot });
    try {
      const store = await driver.open(topologyStateDefinition);
      const snapshot = await store.read();
      expect(snapshot.state.actors).toEqual([]);
      expect(snapshot.state.refusals).toEqual([
        expect.objectContaining({
          reason: 'agent/start omitted native agent_id; refused to fabricate a topology edge',
        }),
      ]);
    } finally {
      await driver.close();
    }
  });

  it('renders the coordinator status with topology and pending notice counts', async () => {
    await bindActors();
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');

    const rendered = await renderRoute('tool:coordinator/status', {
      context: {
        providers: { gitWorktree: provider(worktrees.root) },
      },
      input: {},
    });

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('Worktree proximity status');
    expect(rendered.result).toMatchObject({
      activeActivities: 2,
      actors: expect.arrayContaining([
        expect.objectContaining({ id: 'agent-a', worktreeRoot: worktrees.a }),
        expect.objectContaining({ id: 'agent-b', worktreeRoot: worktrees.b }),
      ]),
      pendingNotices: 1,
      refusals: 0,
    });
  });
});
