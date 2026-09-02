import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import { available } from '@agent-bundle/runtime';
import {
  createGeneratedRuntimeState,
  type GeneratedRuntimeState,
} from '@agent-bundle/runtime/mount';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

import BeforeTool from '../../src/events/tool/before.js';
import {
  topologyStateDefinition,
  type TopologyEvents,
  type TopologyState,
} from '../../src/state.js';

const manifest = testManifest();

const worktrees = {
  root: '/repo',
  a: '/repo/.worktrees/a',
  b: '/repo/.worktrees/b',
} as const;

let stateRoot: string;
let runtimeState: GeneratedRuntimeState<TopologyState, TopologyEvents>;
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

const renderEventInput = async (
  route: string,
  input: ReturnType<typeof eventInput>,
  id: string,
  worktreeRoot: string,
  actorId?: string,
) => {
  const bindings = await runtimeState.requestBindings();
  try {
    return await renderRoute(route, {
      context: {
        actor: actorId === undefined ? undefined : available({ id: actorId }, 'native'),
        host: available({ name: 'claude' }, 'native'),
        invocation: {
          id: `invocation:${id}`,
          startedAt: `2026-09-01T20:01:${String(sequence).padStart(2, '0')}.000Z`,
        },
        noticeLedger: bindings.noticeLedger,
        providers: { gitWorktree: provider(worktreeRoot) },
        session: available({ sessionId: 'root-session' }, 'native'),
        state: bindings.state,
        workspace: available({ root: '/repo' }, 'native'),
      },
      input,
    });
  } finally {
    await bindings.close();
  }
};

const renderEvent = (
  route: string,
  event: Parameters<typeof eventInput>[0],
  native: Record<string, unknown>,
  id: string,
  worktreeRoot: string,
  actorId?: string,
) => renderEventInput(
  route,
  eventInput(event, native, id),
  id,
  worktreeRoot,
  actorId,
);

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
  runtimeState = createGeneratedRuntimeState({
    definition: topologyStateDefinition,
    driver: createSqliteStateDriver({ root: stateRoot }),
  });
  sequence = 0;
});

afterEach(async () => {
  await runtimeState.close();
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
    const first = await recordIntent('agent-a', worktrees.a, 'src/player.ts', 'intent:a', 'deps:react');
    const rendered = await recordIntent('agent-b', worktrees.b, 'src/catalog.ts', 'intent:b', 'deps:zod');

    expectDocument(first).toHaveStatus('success').toHaveNodeKinds(['result']);
    expect(first.document.value).toEqual({ outcome: 'continue' });
    expectDocument(rendered).toHaveStatus('success').toHaveNodeKinds(['result']);
    expect(rendered.document.value).toEqual({ outcome: 'continue' });
  });

  it('warns without denying and publishes a pending directed notice (journeys 4 and 5)', async () => {
    await bindActors();
    const first = await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    const rendered = await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    expectDocument(first).toHaveStatus('success').toHaveNodeKinds(['result']);
    expect(first.document.value).toEqual({ outcome: 'continue' });
    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainContext('Proximity warning')
      .toContainContext('src/shared.ts');
    expect(rendered.document.value).toMatchObject({
      outcome: 'continue',
      reason: expect.stringContaining('src/shared.ts'),
    });

    const bindings = await runtimeState.requestBindings();
    try {
      const snapshot = await bindings.noticeLedger.read();
      expect(snapshot.notices).toEqual([
        expect.objectContaining({
          recipient: { actor: { id: 'agent-a' } },
          state: 'pending',
        }),
      ]);
    } finally {
      await bindings.close();
    }
  });

  it('attempts and surfaces a notice on the recipient next event (journey 6)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    const delivered = await renderEvent(
      'event:tool/after',
      'tool/after',
      {
        cwd: worktrees.a,
        hook_event_name: 'PostToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/shared.ts' },
        tool_name: 'Edit',
      },
      'intent:a:after',
      worktrees.a,
      'agent-a',
    );

    expectDocument(delivered)
      .toHaveStatus('success')
      .toContainContext('Directed proximity notice')
      .toContainContext('src/shared.ts');

    const bindings = await runtimeState.requestBindings();
    try {
      const snapshot = await bindings.noticeLedger.read();
      expect(snapshot.notices[0]).toMatchObject({
        attempts: [expect.objectContaining({ invocationId: 'invocation:intent:a:after' })],
        state: 'attempted',
      });
    } finally {
      await bindings.close();
    }
  });

  it('deduplicates a repeated native intent envelope (journey 7)', async () => {
    await bindActors();
    const replayed = eventInput(
      'tool/before',
      {
        cwd: worktrees.a,
        hook_event_name: 'PreToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/player.ts' },
        tool_name: 'Edit',
      },
      'intent:replayed',
    );
    await renderEventInput(
      'event:tool/before',
      replayed,
      'intent:replayed',
      worktrees.a,
      'agent-a',
    );
    await renderEventInput(
      'event:tool/before',
      replayed,
      'intent:replayed',
      worktrees.a,
      'agent-a',
    );

    const bindings = await runtimeState.requestBindings();
    try {
      const snapshot = await bindings.state.read();
      expect(snapshot.state.activities.filter((activity) => activity.actorId === 'agent-a')).toHaveLength(1);
    } finally {
      await bindings.close();
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

    const bindings = await runtimeState.requestBindings();
    try {
      const snapshot = await bindings.state.read();
      expect(snapshot.state.actors).toEqual([]);
      expect(snapshot.state.refusals).toEqual([
        expect.objectContaining({
          reason: 'agent/start omitted native agent_id; refused to fabricate a topology edge',
        }),
      ]);
    } finally {
      await bindings.close();
    }
  });

  it('renders the coordinator status from mounted topology state', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    const bindings = await runtimeState.requestBindings();
    let rendered: Awaited<ReturnType<typeof renderRoute>>;
    try {
      rendered = await renderRoute('tool:coordinator/status', {
        context: {
          noticeLedger: bindings.noticeLedger,
          providers: { gitWorktree: provider(worktrees.root) },
          state: bindings.state,
        },
        input: {},
      });
    } finally {
      await bindings.close();
    }

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('Worktree proximity status');
    expect(rendered.result).toMatchObject({
      activeActivities: 2,
      actors: expect.arrayContaining([
        expect.objectContaining({ id: 'agent-a', worktreeRoot: worktrees.a }),
        expect.objectContaining({ id: 'agent-b', worktreeRoot: worktrees.b }),
      ]),
      refusals: 0,
    });
  });

  it('renders state unavailability when an event module has no mounted handle', async () => {
    const rendered = await renderRoute({ default: BeforeTool }, {
      context: {
        actor: available({ id: 'agent-a' }, 'native'),
        providers: { gitWorktree: provider(worktrees.a) },
      },
      input: eventInput(
        'tool/before',
        {
          cwd: worktrees.a,
          hook_event_name: 'PreToolUse',
          session_id: 'root-session',
          tool_input: { file_path: 'src/shared.ts' },
          tool_name: 'Edit',
        },
        'intent:unmounted',
      ),
      kind: 'event-route',
      routeId: 'event:tool/before',
    });

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainContext('state unavailable');
    expect(rendered.document.value).toMatchObject({
      outcome: 'continue',
      reason: expect.stringContaining('state unavailable'),
    });
  });
});
