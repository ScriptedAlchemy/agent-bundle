import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import { available, type AgentLineage, type Observed } from '@agent-bundle/runtime';
import { expectDocument, mountTestState, renderRoute, testManifest, type MountedTestState } from 'agent-bundle/test';

import BeforeTool from '../../src/events/tool/before.js';
import agentTopologyProvider from '../../src/providers/agent-topology.js';
import type { TopologyEvents, TopologyState } from '../../src/state.js';

const manifest = testManifest();

const worktrees = {
  root: '/repo',
  a: '/repo/.worktrees/a',
  b: '/repo/.worktrees/b',
} as const;

// One mounted topology state (and notice ledger) per test: every event in a
// journey records into it and the assertions read it back, exactly as one
// generated runtime would serve the whole session.
let mounted: MountedTestState<TopologyState, TopologyEvents>;
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

// The generated `.agent-bundle/routes.d.ts` (in this project's tsconfig program)
// makes every declared provider key required on an explicit map, so the fixture
// carries `agentTopology` too; its factory is pure and reports the same honest
// unavailable value the harness would mount.
const providers = (root: string) => ({
  agentTopology: agentTopologyProvider(),
  gitWorktree: provider(root),
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
  lineage?: Observed<AgentLineage>,
) => renderRoute(route, {
  context: {
    ...mounted.context(),
    actor: actorId === undefined ? undefined : available({ id: actorId }, 'native'),
    host: available({ name: 'claude' }, 'native'),
    invocation: {
      id: `invocation:${id}`,
      startedAt: `2026-09-01T20:01:${String(sequence).padStart(2, '0')}.000Z`,
    },
    ...(lineage === undefined ? {} : { lineage }),
    providers: providers(worktreeRoot),
    session: available({ sessionId: 'root-session' }, 'native'),
    workspace: available({ root: worktreeRoot }, 'native'),
  },
  input,
});

const renderEvent = (
  route: string,
  event: Parameters<typeof eventInput>[0],
  native: Record<string, unknown>,
  id: string,
  worktreeRoot: string,
  actorId?: string,
  lineage?: Observed<AgentLineage>,
) => renderEventInput(
  route,
  eventInput(event, native, id),
  id,
  worktreeRoot,
  actorId,
  lineage,
);

/** A runtime-registry lineage placing `id` one level below `root-session`. */
const childLineage = (id: string): Observed<AgentLineage> => available({
  conversation: id,
  depth: 1,
  parent: 'root-session',
  resolution: 'registry',
  root: 'root-session',
  subagent: { id },
}, 'derived');

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
  mounted = await mountTestState<TopologyState, TopologyEvents>();
  sequence = 0;
});

afterEach(async () => {
  await mounted.close();
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
    // The warning travels as context only; a pass-through result carries no
    // decision and therefore no reason, so the host's permission flow is untouched.
    expect(rendered.document.value).toEqual({ outcome: 'continue' });

    const notices = await mounted.notices();
    expect(notices.notices).toEqual([
      expect.objectContaining({
        recipient: { workspace: { root: worktrees.a } },
        state: 'pending',
      }),
    ]);
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

    const notices = await mounted.notices();
    expect(notices.notices[0]).toMatchObject({
      attempts: [expect.objectContaining({ invocationId: 'invocation:intent:a:after' })],
      state: 'attempted',
    });
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

    const snapshot = await mounted.read();
    expect(snapshot.state.activities.filter((activity) => activity.actorId === 'agent-a')).toHaveLength(1);
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

    const snapshot = await mounted.read();
    expect(snapshot.state.actors).toEqual([]);
    expect(snapshot.state.refusals).toEqual([
      expect.objectContaining({
        reason: 'agent/start omitted native agent_id; refused to fabricate a topology edge',
      }),
    ]);
  });

  it('records the child and its parent from request.lineage when the envelope carries no agent_id', async () => {
    await bindActors();
    const rendered = await renderEvent(
      'event:agent/start',
      'agent/start',
      {
        agent_type: 'implementation',
        cwd: worktrees.b,
        hook_event_name: 'SubagentStart',
        session_id: 'root-session',
      },
      'agent-c:start',
      worktrees.b,
      undefined,
      childLineage('agent-c'),
    );

    expectDocument(rendered).toHaveStatus('success').toHaveNodeKinds(['result']);

    const snapshot = await mounted.read();
    expect(snapshot.state.refusals).toEqual([]);
    expect(snapshot.state.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent-c',
        kind: 'child',
        parentSessionId: 'root-session',
        provenance: expect.objectContaining({ id: 'registry', parentSessionId: 'registry' }),
        worktreeRoot: worktrees.b,
      }),
    ]));
  });

  it('attributes a tool envelope to the lineage child ahead of the worktree binding', async () => {
    await bindActors();
    const rendered = await renderEvent(
      'event:tool/before',
      'tool/before',
      {
        cwd: worktrees.a,
        hook_event_name: 'PreToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/shared.ts' },
        tool_name: 'Edit',
      },
      'intent:c',
      worktrees.a,
      undefined,
      childLineage('agent-c'),
    );

    expectDocument(rendered).toHaveStatus('success');
    expect(rendered.document.value).toEqual({ outcome: 'continue' });

    const snapshot = await mounted.read();
    expect(snapshot.state.actors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent-c',
        provenance: expect.objectContaining({ id: 'registry', parentSessionId: 'registry' }),
        worktreeRoot: worktrees.a,
      }),
    ]));
    expect(snapshot.state.activities.map((activity) => activity.actorId)).toEqual(['agent-c']);
  });

  it('renders the coordinator status from mounted topology state', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    const rendered = await renderRoute('tool:coordinator/status', {
      context: {
        ...mounted.context(),
        providers: providers(worktrees.root),
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
      refusals: 0,
      revision: expect.any(Number),
    });
  });

  it('renders state unavailability when an event module has no mounted handle', async () => {
    const rendered = await renderRoute({ default: BeforeTool }, {
      context: {
        actor: available({ id: 'agent-a' }, 'native'),
        providers: providers(worktrees.a),
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
    expect(rendered.document.value).toEqual({ outcome: 'continue' });
  });
});
