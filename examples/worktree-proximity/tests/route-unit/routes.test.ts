import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import {
  agent,
  available,
  runAgentRequest,
  type AgentLineage,
  type AgentLineagePeer,
  type Observed,
} from '@agent-bundle/runtime';
import {
  createEventRouteInput,
  expectDocument,
  mountTestState,
  renderRoute,
  testManifest,
  type MountedTestState,
} from 'agent-bundle/test';

import BeforeTool from '../../src/events/tool/before.js';
import agentTopologyProvider, { type AgentTopologyProviderValue } from '../../src/providers/agent-topology.js';
import type { IntentEvents, IntentState } from '../../src/state.js';

const manifest = testManifest();

const worktrees = {
  root: '/repo',
  a: '/repo/.worktrees/a',
  b: '/repo/.worktrees/b',
} as const;

// One mounted topology state (and notice ledger) per test: every event in a
// journey records into it and the assertions read it back, exactly as one
// generated runtime would serve the whole session.
let mounted: MountedTestState<IntentState, IntentEvents>;
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
// carries `agentTopology` too. Event routes never read it, so they get an
// honest unavailable snapshot; the coordinator tests run the real factory over
// the request view the harness would hand it (#459).
const noTopology: AgentTopologyProviderValue = {
  agents: { reason: 'fixture: not resolved', state: 'unavailable' },
  intent: { reason: 'fixture: not read', state: 'unavailable' },
};
const providers = (root: string, agentTopology: AgentTopologyProviderValue = noTopology) => ({
  agentTopology,
  gitWorktree: provider(root),
});

/** Runs the real `agent-topology` factory over the read-only request view a generated scope hands it. */
const topologyFor = (
  lineage: Observed<AgentLineage> = { reason: 'not-provided', state: 'unavailable' },
) => agentTopologyProvider({
  host: { reason: 'not-provided', state: 'unavailable' },
  invocation: { kind: 'tool', props: { input: {}, operationId: 'tool:coordinator/status' } },
  lineage,
  plugin: { reason: 'not-provided', state: 'unavailable' },
  session: { reason: 'not-provided', state: 'unavailable' },
  signal: new AbortController().signal,
  state: mounted.state,
  workspace: { reason: 'not-provided', state: 'unavailable' },
});

// The harness projects the envelope into `canonical.payload` exactly as the
// artifact does; the journeys keep their own readable idempotency keys and
// clock. `validate: false` admits the deliberately partial envelopes below.
const eventInput = (
  event: 'agent/start' | 'agent/stop' | 'session/start' | 'stop' | 'tool/after' | 'tool/before',
  native: Record<string, unknown>,
  id: string,
) => {
  const built = createEventRouteInput(event, native, { host: 'claude', validate: false });
  return {
    canonical: {
      ...built.canonical,
      idempotencyKey: id,
      observedAt: `2026-09-01T20:00:${String(sequence++).padStart(2, '0')}.000Z`,
      sequence,
    },
    native: built.native,
  };
};

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

const rootPeer: AgentLineagePeer = { conversation: 'root-session', depth: 0, resolution: 'native', startedAt: '2026-09-01T19:59:00.000Z' };
const childPeer = (id: string): AgentLineagePeer => ({
  conversation: id,
  depth: 1,
  parent: 'root-session',
  resolution: 'registry',
  startedAt: '2026-09-01T19:59:30.000Z',
  subagent: { id, type: 'implementation' },
});

/** The same child lineage carrying the registry's live tree: the root plus the named live siblings. */
const childLineageWithTree = (id: string, liveSiblings: readonly string[]): Observed<AgentLineage> => {
  const own = childLineage(id);
  if (own.state !== 'available') throw new Error('unreachable');
  return available({
    ...own.value,
    tree: { children: [], roots: [], siblings: [rootPeer, ...liveSiblings.map(childPeer)] },
  }, 'derived');
};

const bindActors = async (): Promise<void> => {
  await renderEvent(
    'event:session/start',
    'session/start',
    { cwd: worktrees.root, hook_event_name: 'SessionStart', session_id: 'root-session' },
    'root:start',
    worktrees.root,
    'root-session',
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

// Claude and Codex carry the subagent's `agent_id` on every one of its hook
// payloads and the shared runtime resolves it as that agent's lineage
// conversation, so a child's tool events arrive with `request.lineage` set.
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
    agent_id: actorId,
    cwd: root,
    hook_event_name: 'PreToolUse',
    session_id: 'root-session',
    tool_input: { deps, file_path: path },
    tool_name: 'Edit',
  },
  id,
  root,
  actorId,
  childLineage(actorId),
);

const completeIntent = (
  root: string,
  path: string,
  id: string,
  actorId?: string,
  lineage?: Observed<AgentLineage>,
) => renderEvent(
  'event:tool/after',
  'tool/after',
  {
    ...(actorId === undefined ? {} : { agent_id: actorId }),
    cwd: root,
    hook_event_name: 'PostToolUse',
    session_id: 'root-session',
    tool_input: { file_path: path },
    tool_name: 'Edit',
  },
  id,
  root,
  actorId,
  lineage,
);

beforeEach(async () => {
  mounted = await mountTestState<IntentState, IntentEvents>();
  sequence = 0;
});

afterEach(async () => {
  await mounted.close();
});

it('compiles the complete shared-runtime route surface', () => {
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(Object.keys(manifest.routes)).toEqual(expect.arrayContaining([
    'event:agent/start',
    'event:agent/stop',
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
    // The notice names the other agent's lineage conversation, not its
    // worktree: only that agent thread admits it (#458).
    expect(notices.notices).toEqual([
      expect.objectContaining({
        recipient: { conversation: 'agent-a' },
        state: 'pending',
      }),
    ]);
  });

  it('attempts and surfaces a notice on the recipient next event (journey 6)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    const delivered = await completeIntent(worktrees.a, 'src/shared.ts', 'intent:a:after', 'agent-a', childLineage('agent-a'));

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

  it('delivers a conversation-addressed notice to one agent even when a sibling shares its worktree (#458)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    // agent-c works in agent-a's worktree: same host, session, and workspace
    // as agent-a, so a workspace-addressed notice could not tell them apart.
    const sibling = await completeIntent(worktrees.a, 'src/other.ts', 'intent:c:after', 'agent-c', childLineage('agent-c'));
    expectDocument(sibling).toHaveStatus('success').toHaveNodeKinds(['result']);
    // An event in that worktree whose lineage the runtime could not resolve
    // is not the addressed agent either, even though the worktree binding
    // attributes its intent to agent-a.
    const unresolved = await completeIntent(worktrees.a, 'src/other.ts', 'intent:unresolved:after');
    expectDocument(unresolved).toHaveStatus('success').toHaveNodeKinds(['result']);

    expect((await mounted.notices()).notices).toEqual([expect.objectContaining({ attempts: [], state: 'pending' })]);
    expect((await mounted.read()).state.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: 'agent-a', worktreeRoot: worktrees.a }),
      expect.objectContaining({ actorId: 'agent-c', worktreeRoot: worktrees.a }),
    ]));

    const delivered = await completeIntent(worktrees.a, 'src/shared.ts', 'intent:a:after', 'agent-a', childLineage('agent-a'));
    expectDocument(delivered)
      .toHaveStatus('success')
      .toContainContext('Directed proximity notice')
      .toContainContext('src/shared.ts');
    expect((await mounted.notices()).notices[0]).toMatchObject({
      attempts: [expect.objectContaining({ invocationId: 'invocation:intent:a:after' })],
      state: 'attempted',
    });
  });

  it('addresses a derived actor through its worktree because it has no conversation', async () => {
    await bindActors();
    // No agent_id and no lineage in a worktree no actor is bound to: the
    // application falls back to the derived `worktree:<root>` actor.
    await renderEvent(
      'event:tool/before',
      'tool/before',
      {
        cwd: '/repo/.worktrees/c',
        hook_event_name: 'PreToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/shared.ts' },
        tool_name: 'Edit',
      },
      'intent:derived',
      '/repo/.worktrees/c',
    );
    const rendered = await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    expectDocument(rendered).toHaveStatus('success').toContainContext('Proximity warning');

    expect((await mounted.notices()).notices).toEqual([
      expect.objectContaining({
        recipient: { workspace: { root: '/repo/.worktrees/c' } },
        state: 'pending',
      }),
    ]);

    const delivered = await completeIntent('/repo/.worktrees/c', 'src/shared.ts', 'intent:derived:after');
    expectDocument(delivered).toContainContext('Directed proximity notice');
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
    expect(snapshot.state.bindings).toEqual([]);
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
    // The edge (parent, depth) is the registry's; the application records only the worktree.
    expect(snapshot.state.bindings).toEqual(expect.arrayContaining([
      { actorId: 'agent-c', provenance: { actorId: 'registry', worktreeRoot: 'native' }, worktreeRoot: worktrees.b },
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
    expect(snapshot.state.bindings).toEqual(expect.arrayContaining([
      { actorId: 'agent-c', provenance: { actorId: 'registry', worktreeRoot: 'native' }, worktreeRoot: worktrees.a },
    ]));
    expect(snapshot.state.activities.map((activity) => activity.actorId)).toEqual(['agent-c']);
  });

  it('renders the coordinator status from mounted intent state, with the agent tree honestly absent without a lineage', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    const rendered = await renderRoute('tool:coordinator/status', {
      context: {
        ...mounted.context(),
        providers: providers(worktrees.root, await topologyFor()),
      },
      input: {},
    });

    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('Worktree proximity status')
      .toContainMarkdown('Agent tree unavailable: lineage unavailable (not-provided)');
    expect(rendered.result).toMatchObject({
      activeActivities: 2,
      agents: { reason: 'lineage unavailable (not-provided)', state: 'unavailable' },
      bindings: expect.arrayContaining([
        expect.objectContaining({ actorId: 'agent-a', worktreeRoot: worktrees.a }),
        expect.objectContaining({ actorId: 'agent-b', worktreeRoot: worktrees.b }),
      ]),
      // A caller with no identity published nothing: the count is honestly
      // zero, not the ledger's total.
      notices: expect.objectContaining({ pending: 0, state: 'available', total: 0 }),
      refusals: 0,
      revision: expect.any(Number),
    });
    expect((rendered.result as { bindings: readonly { actorId: string }[] }).bindings.map((binding) => binding.actorId))
      .toEqual(['root-session', 'agent-a', 'agent-b']);
  });

  it('renders the live agent tree the runtime resolved for the call, never a tree of its own (#457)', async () => {
    const lineage = childLineageWithTree('agent-a', ['agent-b']);
    const rendered = await renderRoute('tool:coordinator/status', {
      context: {
        ...mounted.context(),
        lineage,
        providers: providers(worktrees.a, await topologyFor(lineage)),
      },
      input: {},
    });
    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('This call: agent-a at depth 1 under root-session (registry)')
      .toContainMarkdown('root-session (depth 0, native), agent-b (depth 1, registry)');
    expect(rendered.result).toMatchObject({
      agents: {
        children: [],
        conversation: 'agent-a',
        depth: 1,
        parent: 'root-session',
        resolution: 'registry',
        root: 'root-session',
        roots: [],
        siblings: [rootPeer, childPeer('agent-b')],
        state: 'available',
      },
      bindings: [],
      state: 'available',
    });
  });

  it('warns about a sibling the lineage tree lists as alive and stops once the tree drops it (#457)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    const intentB = (id: string, lineage: Observed<AgentLineage>) => renderEvent(
      'event:tool/before',
      'tool/before',
      {
        cwd: worktrees.b,
        hook_event_name: 'PreToolUse',
        session_id: 'root-session',
        tool_input: { file_path: 'src/shared.ts' },
        tool_name: 'Edit',
      },
      id,
      worktrees.b,
      undefined,
      lineage,
    );
    // agent-a is alive under the shared root: its claim on src/shared.ts is a real conflict.
    const alive = await intentB('intent:b:alive', childLineageWithTree('agent-b', ['agent-a']));
    expectDocument(alive).toHaveStatus('success').toContainContext('Proximity warning for agent-b');
    // The registry no longer lists agent-a (it stopped): the same recorded intent is stale and warns nobody.
    const gone = await intentB('intent:b:gone', childLineageWithTree('agent-b', []));
    expectDocument(gone).toHaveStatus('success').toHaveNodeKinds(['result']);
    expect(gone.document.value).toEqual({ outcome: 'continue' });
    // A lineage without a tree presumes nothing about who stopped.
    const unknown = await intentB('intent:b:unknown', childLineage('agent-b'));
    expectDocument(unknown).toHaveStatus('success').toContainContext('Proximity warning for agent-b');
  });

  it('releases a child on agent/stop: its binding and intent go, and the notice ledger is read as usual', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    const rendered = await renderEvent(
      'event:agent/stop',
      'agent/stop',
      {
        agent_id: 'agent-a',
        agent_type: 'implementation',
        cwd: worktrees.a,
        hook_event_name: 'SubagentStop',
        session_id: 'root-session',
      },
      'agent-a:stop',
      worktrees.a,
      'agent-a',
    );
    expectDocument(rendered).toHaveStatus('success').toHaveNodeKinds(['result']);

    const snapshot = await mounted.read();
    expect(snapshot.state.bindings.map((binding) => binding.actorId)).toEqual(['root-session', 'agent-b']);
    expect(snapshot.state.activities).toEqual([]);
    // An identity-less stop releases nobody.
    const anonymous = await renderEvent(
      'event:agent/stop',
      'agent/stop',
      { agent_type: 'implementation', cwd: worktrees.b, hook_event_name: 'SubagentStop', session_id: 'root-session' },
      'agent-?:stop',
      worktrees.b,
    );
    expectDocument(anonymous).toHaveStatus('success').toContainContext('refused to release an actor by guess');
  });

  it('reports the publishing agent its own notice states through coordinator status (#460)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    // agent-b's intent publishes the proximity notice addressed to agent-a.
    await recordIntent('agent-b', worktrees.b, 'src/shared.ts', 'intent:b');

    // An MCP tool call from the same agent: the client name, MCP session id,
    // and server cwd all differ from the hook that published — the lineage
    // conversation is what identifies the publisher.
    const statusFor = async (conversation: string) => renderRoute('tool:coordinator/status', {
      context: {
        ...mounted.context(),
        host: available({ name: 'claude-code' }, 'native'),
        lineage: childLineage(conversation),
        providers: providers(worktrees.root, await topologyFor(childLineage(conversation))),
        session: available({ sessionId: 'mcp-session' }, 'native'),
        workspace: available({ root: worktrees.root }, 'derived'),
      },
      input: {},
    });
    const noticesOf = (conversation: string, worktreeRoot: string) => runAgentRequest({
      ...mounted.context(),
      host: available({ name: 'claude' }, 'native'),
      invocation: { id: `invocation:notices:${conversation}:${String(sequence++)}`, kind: 'tool', startedAt: '2026-09-01T20:05:00.000Z' },
      lineage: childLineage(conversation),
      providers: providers(worktreeRoot),
      session: available({ sessionId: 'root-session' }, 'native'),
      workspace: available({ root: worktreeRoot }, 'native'),
    }, async () => {
      const handle = (await agent()).notices!;
      return { inbox: await handle.inbox(), published: await handle.published() };
    });

    // Pending: the publisher sees it; its own inbox does not (it is not the recipient).
    const pending = await statusFor('agent-b');
    expectDocument(pending).toContainMarkdown('Published notices: 1 (pending 1, attempted 0, acknowledged 0)');
    expect(pending.result).toMatchObject({ notices: { pending: 1, state: 'available', total: 1 } });
    const publisherBefore = await noticesOf('agent-b', worktrees.b);
    expect(publisherBefore.inbox).toEqual([]);
    expect(publisherBefore.published).toEqual([expect.objectContaining({ recipient: { conversation: 'agent-a' }, state: 'pending' })]);
    // The recipient sees it in its inbox and published nothing.
    const recipientBefore = await noticesOf('agent-a', worktrees.a);
    expect(recipientBefore.inbox).toHaveLength(1);
    expect(recipientBefore.published).toEqual([]);
    expect((await statusFor('agent-a')).result).toMatchObject({ notices: { state: 'available', total: 0 } });

    // Admitted on agent-a's next event: the publisher now reads `attempted`,
    // and the recipient's inbox is empty again.
    await completeIntent(worktrees.a, 'src/shared.ts', 'intent:a:after', 'agent-a', childLineage('agent-a'));
    const attempted = await statusFor('agent-b');
    expectDocument(attempted).toContainMarkdown('Published notices: 1 (pending 0, attempted 1, acknowledged 0)');
    expect(attempted.result).toMatchObject({ notices: { attempted: 1, pending: 0, total: 1 } });
    const recipientAfter = await noticesOf('agent-a', worktrees.a);
    expect(recipientAfter.inbox).toEqual([]);
    expect(recipientAfter.published).toEqual([]);
    expect((await noticesOf('agent-b', worktrees.b)).inbox).toEqual([]);
  });

  it('assembles the agent-topology provider value from the request view: lineage tree plus a read of the intent state (#459)', async () => {
    await bindActors();
    await recordIntent('agent-a', worktrees.a, 'src/shared.ts', 'intent:a');
    const topology = await topologyFor(childLineageWithTree('agent-b', ['agent-a']));
    expect(topology.agents).toMatchObject({ conversation: 'agent-b', siblings: [rootPeer, childPeer('agent-a')], state: 'available' });
    expect(topology.intent.state).toBe('available');
    if (topology.intent.state !== 'available') throw new Error('unreachable');
    expect(topology.intent.value.value.bindings.map((binding) => binding.actorId)).toEqual(['root-session', 'agent-a', 'agent-b']);
    expect(topology.intent.value.value.activities.map((activity) => activity.actorId)).toEqual(['agent-a']);
    expect(topology.intent.value.revision).toBeGreaterThan(0);
    // Without a mounted state handle the provider says so instead of opening a store of its own.
    const stateless = await agentTopologyProvider({
      host: { reason: 'not-provided', state: 'unavailable' },
      invocation: { kind: 'cli', props: { args: [], command: 'status' } },
      lineage: { reason: 'unsupported-surface', state: 'unavailable' },
      plugin: { reason: 'not-provided', state: 'unavailable' },
      session: { reason: 'not-provided', state: 'unavailable' },
      signal: new AbortController().signal,
      workspace: { reason: 'not-provided', state: 'unavailable' },
    });
    expect(stateless).toEqual({
      agents: { reason: 'lineage unavailable (unsupported-surface)', state: 'unavailable' },
      intent: { reason: 'Intent state unavailable: this surface mounts no state handle.', state: 'unavailable' },
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
