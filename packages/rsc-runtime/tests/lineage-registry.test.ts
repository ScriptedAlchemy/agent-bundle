import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { unavailable } from '../src/agent-request.js';
import {
  agentLineageStateDefinition,
  createAgentLineageRegistry,
  LINEAGE_STOPPED_RETENTION,
  lineageHostFromClient,
  resolveNativeLineage,
  type AgentLineageRegistry,
  type LineageHost,
} from '../src/lineage/index.js';
import { createMemoryStateDriver } from '../src/state/index.js';

interface FixtureRecord {
  readonly event?: {
    readonly canonical: { readonly event: string; readonly idempotencyKey: string; readonly observedAt: string };
    readonly native: Readonly<Record<string, unknown>>;
  };
  readonly kind: 'event' | 'mcp' | 'cli';
  readonly observed?: { readonly client?: { readonly name: string }; readonly mcpReq?: { readonly _meta?: Record<string, unknown> }; readonly tool?: string };
}

const fixture = (name: string): FixtureRecord[] => readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/host-lineage', name),
  'utf8',
).trim().split('\n').map((line) => JSON.parse(line) as FixtureRecord);

/** Replays a redacted capture the way the warm runtime would: hooks feed, MCP calls resolve. */
const replay = async (
  host: LineageHost,
  records: readonly FixtureRecord[],
  registry: AgentLineageRegistry,
) => {
  const lineages: { readonly index: number; readonly kind: string; readonly lineage: Awaited<ReturnType<AgentLineageRegistry['observe']>>; readonly native?: Readonly<Record<string, unknown>> }[] = [];
  for (const [position, record] of records.entries()) {
    if (record.event !== undefined) {
      const lineage = await registry.observe({
        event: record.event.canonical.event,
        host,
        idempotencyKey: record.event.canonical.idempotencyKey,
        native: record.event.native,
        observedAt: record.event.canonical.observedAt,
      });
      lineages.push({ index: position + 1, kind: record.event.canonical.event, lineage, native: record.event.native });
    } else if (record.kind === 'mcp' && record.observed?.tool !== undefined) {
      const lineage = await registry.resolveToolCall({
        host: lineageHostFromClient(record.observed.client?.name) ?? host,
        meta: record.observed.mcpReq?._meta,
        toolName: record.observed.tool,
      });
      lineages.push({ index: position + 1, kind: `mcp:${record.observed.tool}`, lineage });
    }
  }
  return lineages;
};

const value = (observed: Awaited<ReturnType<AgentLineageRegistry['observe']>>) => {
  expect(observed.state).toBe('available');
  return observed.state === 'available' ? observed.value : undefined!;
};

describe('lineage registry replaying the 2026-09-03 host captures', () => {
  // Two live-model Claude Code 2.1.257 sessions (claude-sonnet-5, 2026-09-03):
  // the primary fixture's root spawn ran in the background (`Agent`
  // PostToolUse `status: async_launched` right after SubagentStart, `Stop`
  // while the child still ran, a `<task-notification>` re-prompt afterwards);
  // the foreground fixture's spawns block until the child finishes. Lineage
  // must come out the same either way.
  it.each([
    ['background root spawn', 'claude-2.1.257.ndjson', 'confirmed'],
    ['foreground spawns', 'claude-2.1.257-foreground.ndjson', 'registry'],
  ])('Claude 2.1.257 (%s): subagent events resolve to their own agent under the root session, nested depth 2, parent inferred from the open Agent call', async (_label, name, liveResolution) => {
    const registry = createAgentLineageRegistry();
    const records = fixture(name);
    const lineages = await replay('claude', records, registry);
    const root = records[0]!.event!.native['session_id'] as string;
    const [subagent, nested] = records
      .filter((record) => record.event?.canonical.event === 'agent/start')
      .map((record) => record.event!.native['agent_id'] as string);
    const spawnCalls = records
      .filter((record) => record.event?.canonical.event === 'tool/before' && record.event.native['tool_name'] === 'Agent')
      .map((record) => record.event!.native['tool_use_id'] as string);

    const sessionStart = value(lineages[0]!.lineage);
    expect(sessionStart).toMatchObject({ conversation: root, depth: 0, resolution: 'native', root });
    expect(sessionStart.parent).toBeUndefined();

    const subagentStart = lineages.find((entry) => entry.kind === 'agent/start')!;
    expect(value(subagentStart.lineage)).toMatchObject({
      conversation: subagent,
      depth: 1,
      parent: root,
      resolution: 'registry',
      root,
      subagent: { id: subagent, toolCallId: spawnCalls[0], type: 'general-purpose' },
    });

    const nestedStart = lineages.filter((entry) => entry.kind === 'agent/start')[1]!;
    expect(value(nestedStart.lineage)).toMatchObject({
      conversation: nested,
      depth: 2,
      parent: subagent,
      root,
      subagent: { toolCallId: spawnCalls[1] },
    });

    const nestedTool = lineages.find((entry) => entry.kind === 'tool/before' && entry.native?.['agent_id'] === nested)!;
    expect(value(nestedTool.lineage)).toMatchObject({ conversation: nested, depth: 2, parent: subagent, root });

    // The host confirms each claim after the fact: the parent's `Agent`
    // PostToolUse names the child it produced in `tool_response.agentId`,
    // whether the child ran in the background (`async_launched`) or blocked
    // the parent until it finished (`completed`).
    const spawnResults = records
      .filter((record) => record.event?.canonical.event === 'tool/after' && record.event.native['tool_name'] === 'Agent')
      .map((record) => record.event!.native['tool_response'] as { readonly agentId: string; readonly status: string });
    expect(new Set(spawnResults.map((result) => result.agentId))).toEqual(new Set([subagent, nested]));
    for (const result of spawnResults) expect(['async_launched', 'completed']).toContain(result.status);

    // The MCP probe call carries claudecode/toolUseId, which names the open
    // PreToolUse. A background child's probe runs after the root's `Agent`
    // PostToolUse already named it, so its edge is host-confirmed; a
    // foreground child's runs while the parent's call is still open, so the
    // edge still rests on the registry's match.
    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe');
    expect(probes.map((entry) => value(entry.lineage).depth)).toEqual([0, 1, 2]);
    expect(value(probes[1]!.lineage)).toMatchObject({ conversation: subagent, parent: root, resolution: liveResolution });
    // The nested child is confirmed only by its parent's PostToolUse, which in
    // both captures arrives after the nested child's own hooks have all fired.
    expect(value(probes[2]!.lineage)).toMatchObject({ conversation: nested, parent: subagent, resolution: 'registry' });
    const subagentStop = lineages.find((entry) => entry.kind === 'agent/stop' && entry.native?.['agent_id'] === subagent)!;
    expect(value(subagentStop.lineage)).toMatchObject({ conversation: subagent, resolution: liveResolution });

    // PostToolUse for MCP tools now arrives (string tool_response), so every window closes.
    expect(registry.snapshot().openCalls).toEqual([]);
    // Both subagents stopped on SubagentStop; SessionEnd retired the root.
    const snapshot = registry.snapshot();
    expect(Object.values(snapshot.nodes).filter((node) => node.stoppedAt !== undefined).map((node) => node.id).sort())
      .toEqual([nested, root, subagent].sort());
    // Every edge the registry matched was later named by the host: the
    // inference never disagreed with the parent's PostToolUse in either run.
    expect(snapshot.nodes[subagent]).toMatchObject({ confirmed: true, parent: root, toolCallId: spawnCalls[0] });
    expect(snapshot.nodes[nested]).toMatchObject({ confirmed: true, parent: subagent, toolCallId: spawnCalls[1] });
    expect(snapshot.unplacedStarts ?? []).toEqual([]);
  });

  // Live Claude Code 2.1.259 (claude-sonnet-5, 2026-09-03), driven by
  // examples/host-test/scenarios/claude-orchestration.json: four `claude -p`
  // turns resumed into one session. Turn 1 spawned an `Explore` and a
  // `general-purpose` subagent in parallel (both run in the background by the
  // host), then a sequential subagent that nested another; turn 2 ran the
  // `host-test:host-test` skill at the root; turn 3 was a manual `/compact`;
  // turn 4 stopped. The `.stream.ndjson` twin is the model's own
  // `--output-format stream-json` transcript of the same session.
  it('Claude 2.1.259 orchestration: parallel, sequential and nested spawns, resumed turns and a manual compact all resolve under one root, agreeing with the model stream', async () => {
    const registry = createAgentLineageRegistry();
    const records = fixture('claude-2.1.259-orchestration.ndjson');
    const lineages = await replay('claude', records, registry);
    const natives = records.flatMap((record) => (record.event === undefined ? [] : [record.event.native]));
    const root = natives[0]!['session_id'] as string;

    // One session id across every hook of every turn, including the compact and the resumes.
    expect(new Set(natives.map((native) => native['session_id']))).toEqual(new Set([root]));
    expect(natives.filter((native) => native['hook_event_name'] === 'SessionStart').map((native) => native['source']))
      .toEqual(['startup', 'resume', 'resume', 'compact', 'resume']);
    expect(natives.filter((native) => native['hook_event_name'] === 'SessionEnd')).toHaveLength(4);
    expect(natives.filter((native) => native['hook_event_name'] === 'PreCompact')).toMatchObject([{ trigger: 'manual' }]);
    expect(natives.filter((native) => native['hook_event_name'] === 'PostCompact')).toMatchObject([{ trigger: 'manual' }]);

    // Four spawns: two parallel from the root, one sequential from the root, one nested from the sequential one.
    const starts = natives.filter((native) => native['hook_event_name'] === 'SubagentStart');
    const [explore, parallel, sequential, nested] = starts.map((native) => native['agent_id'] as string);
    expect(starts.map((native) => native['agent_type'])).toEqual(['Explore', 'general-purpose', 'general-purpose', 'general-purpose']);
    const spawnResults = natives
      .filter((native) => native['hook_event_name'] === 'PostToolUse' && native['tool_name'] === 'Agent')
      .map((native) => ({ agentId: (native['tool_response'] as { agentId: string }).agentId, caller: native['agent_id'], status: (native['tool_response'] as { status: string }).status, toolUseId: native['tool_use_id'] }));
    expect(spawnResults).toMatchObject([
      { agentId: explore, caller: undefined, status: 'async_launched' },
      { agentId: parallel, caller: undefined, status: 'async_launched' },
      { agentId: nested, caller: sequential, status: 'completed' },
      { agentId: sequential, caller: undefined, status: 'completed' },
    ]);
    const spawnCall = new Map(spawnResults.map((result) => [result.agentId, result.toolUseId]));
    // The fixture row (1-based) of the PostToolUse that named each child: rows 13 and 17
    // for the background pair — row 13 fires before the Explore agent's own SubagentStart
    // (row 14) — row 99 (the sequential agent's, after the nested child's SubagentStop at
    // row 98) and row 101 (the root's, after the sequential agent's SubagentStop at row 100).
    const confirmedAt = new Map<string, number>();
    for (const [position, record] of records.entries()) {
      const native = record.event?.native;
      if (native?.['hook_event_name'] === 'PostToolUse' && native['tool_name'] === 'Agent') {
        confirmedAt.set((native['tool_response'] as { agentId: string }).agentId, position + 1);
      }
    }
    expect([explore, parallel, nested, sequential].map((id) => confirmedAt.get(id))).toEqual([13, 17, 99, 101]);

    // Every child hook resolves to its own agent under the root; parents and depths follow
    // the spawn tree. The resolution says how much of that the host had vouched for by then:
    // `confirmed` once the child's spawn PostToolUse and every ancestor's have fired,
    // `registry` while any edge on the chain still rests on the spawn-window match — so the
    // background pair's hooks are host-confirmed for their whole run, while the foreground
    // sequential and nested agents (confirmed only after their SubagentStop) never are.
    const expectedParent: Record<string, { depth: number; parent: string }> = {
      [explore]: { depth: 1, parent: root },
      [nested]: { depth: 2, parent: sequential },
      [parallel]: { depth: 1, parent: root },
      [sequential]: { depth: 1, parent: root },
    };
    const chain = (agentId: string): string[] => {
      const parent = expectedParent[agentId]!.parent;
      return parent === root ? [agentId] : [agentId, ...chain(parent)];
    };
    const expectedResolution = (agentId: string, row: number): string =>
      chain(agentId).every((id) => confirmedAt.get(id)! < row) ? 'confirmed' : 'registry';
    let childEvents = 0;
    const seenResolutions = new Map<string, Set<string>>();
    for (const entry of lineages) {
      const agentId = entry.native?.['agent_id'] as string | undefined;
      if (agentId === undefined) continue;
      childEvents += 1;
      const resolution = expectedResolution(agentId, entry.index);
      seenResolutions.set(agentId, new Set([...(seenResolutions.get(agentId) ?? []), resolution]));
      expect(value(entry.lineage), `row ${String(entry.index)}`).toMatchObject({ conversation: agentId, resolution, root, ...expectedParent[agentId]! });
    }
    expect(childEvents).toBe(natives.filter((native) => native['agent_id'] !== undefined).length);
    expect([...seenResolutions.get(explore)!]).toEqual(['confirmed']);
    expect([...seenResolutions.get(parallel)!].sort()).toEqual(['confirmed', 'registry']);
    expect([...seenResolutions.get(sequential)!]).toEqual(['registry']);
    expect([...seenResolutions.get(nested)!]).toEqual(['registry']);
    // Root-side hooks, including the resumed turns, the compact pair and the failed `dump` calls, stay at depth 0.
    for (const entry of lineages) {
      if (entry.native !== undefined && entry.native['agent_id'] === undefined) {
        expect(value(entry.lineage)).toMatchObject({ conversation: root, depth: 0, resolution: 'native', root });
      }
    }
    // The spawn each child came from is certain even for the parallel pair: the host emitted
    // PreToolUse → SubagentStart for one `Agent` call before opening the next.
    const startLineages = lineages.filter((entry) => entry.kind === 'agent/start').map((entry) => value(entry.lineage));
    expect(startLineages.map((lineage) => lineage.subagent?.toolCallId)).toEqual([explore, parallel, sequential, nested].map((id) => spawnCall.get(id)));
    // Generations follow the prompt that owned the work: the sequential and nested spawns
    // ran under the `<task-notification>` re-prompt the host issued after the parallel pair finished.
    const prompts = natives.filter((native) => native['hook_event_name'] === 'UserPromptSubmit').map((native) => native['prompt_id'] as string);
    expect(new Set(prompts).size).toBe(4);
    expect(startLineages.map((lineage) => lineage.generation)).toEqual([prompts[0], prompts[0], prompts[1], prompts[1]]);

    // MCP `probe` calls: `claudecode/toolUseId` names the open PreToolUse, so each resolves to the agent that made it.
    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe').map((entry) => value(entry.lineage));
    expect(probes.map((lineage) => [lineage.conversation, lineage.depth, lineage.resolution])).toEqual([
      [explore, 1, 'confirmed'], [parallel, 1, 'confirmed'], [sequential, 1, 'registry'], [nested, 2, 'registry'], [root, 0, 'registry'],
    ]);

    // PostToolUseFailure closes a window like PostToolUse; nothing stays open, all five nodes stopped.
    expect(natives.filter((native) => native['hook_event_name'] === 'PostToolUseFailure')).toHaveLength(3);
    const snapshot = registry.snapshot();
    expect(snapshot.openCalls).toEqual([]);
    expect(Object.keys(snapshot.nodes).sort()).toEqual([explore, nested, parallel, root, sequential].sort());
    expect(Object.values(snapshot.nodes).every((node) => node.stoppedAt !== undefined)).toBe(true);
    // Every edge the spawn window matched was later named by the host, with the same spawn call.
    for (const id of [explore, parallel, sequential, nested]) {
      expect(snapshot.nodes[id], id).toMatchObject({ confirmed: true, toolCallId: spawnCall.get(id), ...expectedParent[id]! });
    }
    expect(snapshot.unplacedStarts ?? []).toEqual([]);
    // The Explore agent was held from its PostToolUse (row 13) and completed by its SubagentStart (row 14):
    // the start's time and agent_type, not the confirmation's.
    expect(snapshot.nodes[explore]).toMatchObject({ startedAt: records[13]!.event!.canonical.observedAt, type: 'Explore' });

    // The model's own stream agrees: `task_started` names the same agent id (`task_id`) and
    // spawn call (`tool_use_id`) per child, with the depth the registry derived.
    interface StreamEnvelope {
      readonly is_backgrounded?: boolean;
      readonly parent_tool_use_id?: string | null;
      readonly session_id: string;
      readonly spawn_depth?: number;
      readonly subtype?: string;
      readonly task_id?: string;
      readonly tool_use_id?: string;
      readonly turn: number;
      readonly type: string;
    }
    const stream = readFileSync(resolve(import.meta.dirname, '../../../fixtures/host-lineage/claude-2.1.259-orchestration.stream.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as StreamEnvelope);
    expect(new Set(stream.map((envelope) => envelope.session_id))).toEqual(new Set([root]));
    expect(new Set(stream.map((envelope) => envelope.turn))).toEqual(new Set([1, 2, 3, 4]));
    const taskStarts = stream.filter((envelope) => envelope.subtype === 'task_started');
    expect(taskStarts.map((envelope) => [envelope.task_id, envelope.tool_use_id, envelope.spawn_depth, envelope.is_backgrounded])).toEqual([
      [explore, spawnCall.get(explore), 1, true],
      [parallel, spawnCall.get(parallel), 1, true],
      [sequential, spawnCall.get(sequential), 1, false],
      [nested, spawnCall.get(nested), 2, false],
    ]);
    // Envelopes produced inside a subagent carry the parent's `Agent` call; the stream shows
    // depth-1 children only, so the nested agent is visible through hooks alone.
    const parentCalls = new Set(stream.map((envelope) => envelope.parent_tool_use_id).filter((id): id is string => typeof id === 'string'));
    expect(parentCalls).toEqual(new Set([spawnCall.get(explore), spawnCall.get(parallel), spawnCall.get(sequential)]));
    expect(stream.filter((envelope) => envelope.subtype === 'compact_boundary')).toHaveLength(1);
  });

  it('Codex 0.147.0: MCP _meta resolves lineage natively including parent_thread_id; hooks agree', async () => {
    const registry = createAgentLineageRegistry();
    const lineages = await replay('codex', fixture('codex-0.147.0.ndjson'), registry);
    const root = '01a06660-110e-7290-8d1c-8ef1b2b68fc2';
    const subagent = '01a06660-8faf-7122-80af-24ba2da81ad7';
    const nested = '01a06661-100a-7ad3-a0f5-b0e6ffdb4b11';

    const starts = lineages.filter((entry) => entry.kind === 'agent/start');
    expect(value(starts[0]!.lineage)).toMatchObject({ conversation: subagent, depth: 1, parent: root, root, generation: '01a06660-901a-77f1-a660-ac3c549409c0' });
    expect(value(starts[1]!.lineage)).toMatchObject({ conversation: nested, depth: 2, parent: subagent, root });

    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe');
    expect(probes.map((entry) => value(entry.lineage))).toMatchObject([
      { conversation: root, depth: 0, resolution: 'native', root },
      { conversation: subagent, depth: 1, parent: root, resolution: 'native', root, subagent: { id: subagent, type: 'thread_spawn' } },
      { conversation: nested, depth: 2, parent: subagent, resolution: 'native', root },
    ]);
    // The generated dump tool carried no _meta in the capture; the open pre-tool hook still places it.
    const dump = lineages.find((entry) => entry.kind === 'mcp:dump')!;
    expect(value(dump.lineage)).toMatchObject({ conversation: root, depth: 0, resolution: 'inferred' });
  });

  it('Cursor 3.18.25: subagentStart binds the next unseen conversation as the child; MCP calls resolve only through the MCP:<tool> pre-tool hook', async () => {
    const registry = createAgentLineageRegistry();
    const lineages = await replay('cursor', fixture('cursor-3.18.25.ndjson'), registry);
    const root = 'b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c';
    const child = 'bf617dfd-e03d-4d6b-adef-8f97e7df6b71';
    const nested = '46efda32-26ac-4ea1-9c05-b1bff02e5ea0'.slice(0, 8);

    expect(value(lineages[0]!.lineage)).toMatchObject({ conversation: root, depth: 0, root, generation: 'd4b2603b-ebfe-45ee-832d-b30d048defbb' });

    const childTool = lineages.find((entry) => entry.native?.['conversation_id'] === child)!;
    expect(value(childTool.lineage)).toMatchObject({
      conversation: child,
      depth: 1,
      parent: root,
      resolution: 'inferred',
      root,
      subagent: { isParallelWorker: false, type: 'general-purpose' },
    });
    expect(value(childTool.lineage).subagent?.toolCallId).toMatch(/^call-2ec9530d/u);

    const nestedTool = lineages.find((entry) => String(entry.native?.['conversation_id'] ?? '').startsWith(nested))!;
    expect(value(nestedTool.lineage)).toMatchObject({ depth: 2, parent: child, root });

    // Three probes: from the first subagent, from its nested child, and from
    // a third subagent the root spawned afterwards.
    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe');
    expect(probes.map((entry) => value(entry.lineage))).toMatchObject([
      { conversation: child, depth: 1, resolution: 'inferred' },
      { depth: 2, parent: child, resolution: 'inferred' },
      { depth: 1, parent: root, resolution: 'inferred' },
    ]);
    expect(value(probes[2]!.lineage).conversation).not.toBe(child);

    const stops = lineages.filter((entry) => entry.kind === 'agent/stop');
    expect(stops.length).toBeGreaterThanOrEqual(2);
    const stopped = Object.values(registry.snapshot().nodes).filter((node) => node.stoppedAt !== undefined);
    expect(stopped.map((node) => node.depth).sort()).toEqual([1, 1, 2]);
  });

  it('persists through the durable state kernel and rehydrates a fresh registry', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const definition = agentLineageStateDefinition('process');
    const store = await driver.open(definition);
    const records = fixture('claude-2.1.257.ndjson');
    const root = records[0]!.event!.native['session_id'] as string;
    const firstStart = records.findIndex((record) => record.event?.canonical.event === 'agent/start');
    const subagent = records[firstStart]!.event!.native['agent_id'] as string;
    const first = createAgentLineageRegistry({ store });
    await replay('claude', records.slice(0, firstStart + 1), first);
    const second = createAgentLineageRegistry({ store });
    const lineage = await second.observe({
      event: 'tool/before',
      host: 'claude',
      idempotencyKey: 'rehydrated',
      native: { agent_id: subagent, hook_event_name: 'PreToolUse', session_id: root, tool_name: 'Bash', tool_use_id: 'later' },
    });
    expect(value(lineage)).toMatchObject({ conversation: subagent, depth: 1, parent: root });
    await store.close();
    await driver.close();
  });

  it('replays a duplicate delivery through the same journal keys without rewinding the tree', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const registry = createAgentLineageRegistry({ store });
    const before = {
      hook_event_name: 'preToolUse', conversation_id: 'root-c', tool_input: {}, tool_name: 'Read', tool_use_id: 'call-1',
    };
    await registry.observe({ event: 'prompt/submit', host: 'cursor', idempotencyKey: 'prompt', native: { conversation_id: 'root-c', hook_event_name: 'beforeSubmitPrompt' } });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'dup', native: before, observedAt: '2026-09-03T00:00:00.000Z' });
    const revisionAfterFirst = (await store.read()).revision;
    // A later, unrelated event advances the journal.
    await registry.observe({ event: 'tool/after', host: 'cursor', idempotencyKey: 'after', native: { ...before, hook_event_name: 'postToolUse', tool_output: '{}' }, observedAt: '2026-09-03T00:00:01.000Z' });
    const head = (await store.read()).revision;
    // Cursor 3.18.25 delivers some preToolUse payloads twice with the same canonical key.
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'dup', native: before, observedAt: '2026-09-03T00:00:00.000Z' });
    expect((await store.read()).revision).toBe(head);
    expect(revisionAfterFirst).toBeLessThan(head);
    // The in-memory tree stayed at the head: the window that closed stays closed.
    expect(registry.snapshot().openCalls).toEqual([]);
    await store.close();
    await driver.close();
  });

  it('scopes spawn claims to the starting subagent\'s root when two sessions share one registry', async () => {
    const registry = createAgentLineageRegistry();
    const spawn = (session: string, id: string) => registry.observe({
      event: 'tool/before',
      host: 'claude',
      idempotencyKey: `${session}:${id}`,
      native: { hook_event_name: 'PreToolUse', session_id: session, tool_input: {}, tool_name: 'Agent', tool_use_id: id },
    });
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 'a', native: { hook_event_name: 'SessionStart', session_id: 'session-a' } });
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 'b', native: { hook_event_name: 'SessionStart', session_id: 'session-b' } });
    await spawn('session-a', 'spawn-a');
    await spawn('session-b', 'spawn-b');
    // Session A's child starts after B opened its own spawn: it must claim A's call, not the newest one.
    const child = await registry.observe({
      event: 'agent/start',
      host: 'claude',
      idempotencyKey: 'a:start',
      native: { agent_id: 'child-a', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'session-a' },
    });
    expect(value(child)).toMatchObject({ parent: 'session-a', root: 'session-a', subagent: { toolCallId: 'spawn-a' } });
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['spawn-b']);
  });

  it('answers honestly when the registry never saw the subagent start', async () => {
    const registry = createAgentLineageRegistry();
    const lineage = await registry.observe({
      event: 'tool/before',
      host: 'codex',
      idempotencyKey: 'cold',
      native: { agent_id: 'unknown-thread', session_id: 'root-thread', tool_name: 'Bash', tool_use_id: 'x' },
    });
    expect(lineage).toEqual(unavailable('id-not-resolvable'));
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    expect(await registry.resolveToolCall({ host: undefined, toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
  });

  it('standalone hooks state only what the payload proves', () => {
    expect(resolveNativeLineage('claude', { session_id: 'root' })).toMatchObject({ state: 'available', value: { conversation: 'root', depth: 0, root: 'root' } });
    expect(resolveNativeLineage('claude', { agent_id: 'child', session_id: 'root' })).toEqual(unavailable('no-shared-runtime'));
    expect(resolveNativeLineage('cursor', { conversation_id: 'c' })).toEqual(unavailable('no-shared-runtime'));
  });
});

describe('lineage registry edge cases raised in review', () => {
  it('ignores a replayed SubagentStart instead of claiming a second spawn or rewriting the node', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native });
    await observe('session/start', 'start', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'spawn-1', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'spawn-1' });
    await observe('tool/before', 'spawn-2', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'spawn-2' });
    const start = { agent_id: 'child', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' };
    const first = await observe('agent/start', 'child-start', start);
    // Two sibling spawns from the same parent: the parent is certain, the exact tool call is not.
    expect(value(first)).toMatchObject({ depth: 1, parent: 'root' });
    expect(value(first).subagent?.toolCallId).toBeUndefined();
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['spawn-1']);
    const replayed = await observe('agent/start', 'child-start', start);
    expect(value(replayed)).toMatchObject({ depth: 1, parent: 'root' });
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['spawn-1']);
  });

  it('leaves a Cursor child unresolved while two subagent starts are pending, then binds once one has stopped', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'cursor', idempotencyKey: key, native });
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt' });
    const start = (id: string) => ({
      conversation_id: 'root', hook_event_name: 'subagentStart', is_parallel_worker: true, parent_conversation_id: 'root',
      subagent_id: id, subagent_type: 'general-purpose', tool_call_id: id,
    });
    await observe('agent/start', 'a', start('call-a'));
    await observe('agent/start', 'b', start('call-b'));
    const ambiguous = await observe('tool/before', 'x', { conversation_id: 'child-x', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'Shell', tool_use_id: 'x' });
    expect(ambiguous).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().nodes['child-x']).toBeUndefined();
    await observe('agent/stop', 'a-stop', { ...start('call-a'), hook_event_name: 'subagentStop', status: 'completed' });
    const bound = await observe('tool/before', 'y', { conversation_id: 'child-y', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'Shell', tool_use_id: 'y' });
    expect(value(bound)).toMatchObject({ conversation: 'child-y', depth: 1, parent: 'root', subagent: { id: 'call-b' } });
  });

  it('does not fabricate a Codex depth when neither the thread nor its parent is registered', async () => {
    const registry = createAgentLineageRegistry();
    const meta = (thread: string, parent: string | undefined) => ({
      'x-codex-turn-metadata': { session_id: 'root', thread_id: thread, turn_id: 't', ...(parent === undefined ? {} : { parent_thread_id: parent }) },
    });
    expect(await registry.resolveToolCall({ host: 'codex', meta: meta('root', undefined), toolName: 'dump' })).toMatchObject({ value: { depth: 0 } });
    expect(await registry.resolveToolCall({ host: 'codex', meta: meta('child', 'root'), toolName: 'dump' })).toMatchObject({ value: { depth: 1, parent: 'root' } });
    expect(await registry.resolveToolCall({ host: 'codex', meta: meta('grandchild', 'child'), toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
  });
});

describe('lineage registry durability and retention (review round 3)', () => {
  it('shares one hydration so concurrent first observations see the persisted tree', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const seed = createAgentLineageRegistry({ store });
    await seed.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    await seed.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'spawn', native: { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'spawn-1' } });
    await seed.observe({ event: 'agent/start', host: 'claude', idempotencyKey: 'start', native: { agent_id: 'child', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' } });

    const fresh = createAgentLineageRegistry({ store });
    const [first, second] = await Promise.all([
      fresh.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'c1', native: { agent_id: 'child', hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Bash', tool_use_id: 'c1' } }),
      fresh.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'c2', native: { agent_id: 'child', hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Bash', tool_use_id: 'c2' } }),
    ]);
    expect(value(first)).toMatchObject({ conversation: 'child', depth: 1, parent: 'root' });
    expect(value(second)).toMatchObject({ conversation: 'child', depth: 1, parent: 'root' });
    expect(Object.keys(fresh.snapshot().nodes).sort()).toEqual(['child', 'root']);
    await store.close();
    await driver.close();
  });

  it('keeps the receipt timestamp out of the replay identity so a redelivered pre-tool hook cannot reopen a closed window', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const registry = createAgentLineageRegistry({ store });
    const before = { conversation_id: 'root', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'm1' };
    await registry.observe({ event: 'prompt/submit', host: 'cursor', idempotencyKey: 'p', native: { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt' } });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'open', native: before, observedAt: '2026-09-03T00:00:00.000Z' });
    await registry.observe({ event: 'tool/after', host: 'cursor', idempotencyKey: 'close', native: { ...before, hook_event_name: 'postToolUse', tool_output: '{}' }, observedAt: '2026-09-03T00:00:01.000Z' });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'open', native: before, observedAt: '2026-09-03T00:00:02.000Z' });
    expect(registry.snapshot().openCalls).toEqual([]);
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    await store.close();
    await driver.close();
  });

  it('does not promote an unknown Cursor conversation to a root on a tool event', async () => {
    const registry = createAgentLineageRegistry();
    const lineage = await registry.observe({
      event: 'tool/before',
      host: 'cursor',
      idempotencyKey: 'orphan',
      native: { conversation_id: 'maybe-a-child', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'Shell', tool_use_id: 'x' },
    });
    expect(lineage).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().nodes).toEqual({});
    const root = await registry.observe({
      event: 'prompt/submit',
      host: 'cursor',
      idempotencyKey: 'prompt',
      native: { conversation_id: 'a-root', hook_event_name: 'beforeSubmitPrompt' },
    });
    expect(value(root)).toMatchObject({ conversation: 'a-root', depth: 0 });
  });

  it('retires the root and its live descendants on session/end', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'codex', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp' });
    await observe('agent/start', 'a', { agent_id: 'child', agent_type: 'default', hook_event_name: 'SubagentStart', session_id: 'root' });
    await observe('session/end', 'e', { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'root' });
    const nodes = registry.snapshot().nodes;
    expect(nodes['root']?.stoppedAt).toBe('2026-09-03T00:00:00.000Z');
    expect(nodes['child']?.stoppedAt).toBe('2026-09-03T00:00:00.000Z');
  });

  it('prunes stopped nodes at the moment they stop, never exceeding the retention bound', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>, observedAt: string) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native, observedAt });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' }, '2026-09-03T00:00:00.000Z');
    const total = LINEAGE_STOPPED_RETENTION + 10;
    for (let index = 0; index < total; index += 1) {
      await observe('tool/before', `spawn-${String(index)}`, { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: `spawn-${String(index)}` }, '2026-09-03T00:00:00.000Z');
      await observe('agent/start', `start-${String(index)}`, { agent_id: `agent-${String(index)}`, agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }, `2026-09-03T00:00:${String(index % 60).padStart(2, '0')}.000Z`);
      await observe('tool/after', `spawned-${String(index)}`, { hook_event_name: 'PostToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_response: {}, tool_use_id: `spawn-${String(index)}` }, '2026-09-03T00:00:00.000Z');
    }
    for (let index = 0; index < total; index += 1) {
      await observe('agent/stop', `stop-${String(index)}`, { agent_id: `agent-${String(index)}`, agent_type: 'general-purpose', hook_event_name: 'SubagentStop', session_id: 'root', stop_hook_active: false }, `2026-09-03T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`);
    }
    const stopped = Object.values(registry.snapshot().nodes).filter((node) => node.stoppedAt !== undefined);
    expect(stopped.length).toBe(LINEAGE_STOPPED_RETENTION);
  });
});

describe('lineage registry ambiguity refusals (review round 4)', () => {
  it('keeps a root-shaped Cursor conversation a root even while another root has a pending child', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'cursor', idempotencyKey: key, native });
    await observe('prompt/submit', 'a', { conversation_id: 'root-a', hook_event_name: 'beforeSubmitPrompt' });
    await observe('agent/start', 'a-spawn', {
      conversation_id: 'root-a', hook_event_name: 'subagentStart', parent_conversation_id: 'root-a', subagent_id: 'call-a', tool_call_id: 'call-a',
    });
    const other = await observe('prompt/submit', 'b', { conversation_id: 'root-b', hook_event_name: 'beforeSubmitPrompt' });
    expect(value(other)).toMatchObject({ conversation: 'root-b', depth: 0, root: 'root-b' });
    // The pending child is still waiting for A's real child conversation.
    const child = await observe('tool/before', 'c', { conversation_id: 'child-a', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'Shell', tool_use_id: 'c' });
    expect(value(child)).toMatchObject({ conversation: 'child-a', depth: 1, parent: 'root-a', root: 'root-a' });
  });

  it('refuses a spawn claim when two different parents under one root have unclaimed spawns', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp1' });
    await observe('agent/start', 'p', { agent_id: 'parent-agent', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    await observe('tool/before', 'sp2', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp2' });
    await observe('tool/before', 'sp3', { agent_id: 'parent-agent', hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp3' });
    const ambiguous = await observe('agent/start', 'n', { agent_id: 'new-agent', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    expect(ambiguous).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId).sort()).toEqual(['sp2', 'sp3']);
  });

  it('claims siblings from one parent but marks the tool call uncertain', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp1' });
    await observe('tool/before', 'sp2', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp2' });
    const sibling = await observe('agent/start', 'n', { agent_id: 'sibling', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    expect(value(sibling)).toMatchObject({ depth: 1, parent: 'root' });
    expect(value(sibling).subagent?.toolCallId).toBeUndefined();
  });

  it('refuses to correlate an MCP call when open windows for the tool span several conversations', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'cursor', idempotencyKey: key, native });
    await observe('prompt/submit', 'a', { conversation_id: 'root-a', hook_event_name: 'beforeSubmitPrompt' });
    await observe('prompt/submit', 'b', { conversation_id: 'root-b', hook_event_name: 'beforeSubmitPrompt' });
    await observe('tool/before', 'ma', { conversation_id: 'root-a', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'ma' });
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toMatchObject({ value: { conversation: 'root-a' } });
    await observe('tool/before', 'mb', { conversation_id: 'root-b', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'mb' });
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    await observe('tool/after', 'mb-close', { conversation_id: 'root-b', hook_event_name: 'postToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_output: '{}', tool_use_id: 'mb' });
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toMatchObject({ value: { conversation: 'root-a' } });
  });
});

describe('lineage registry retirement and cohorts (review round 5)', () => {
  const claude = (registry: ReturnType<typeof createAgentLineageRegistry>) =>
    (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });

  it('keeps the whole sibling cohort uncertain, including the last spawn left', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp1' });
    await observe('tool/before', 'sp2', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp2' });
    const first = await observe('agent/start', 'a', { agent_id: 'a', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    const second = await observe('agent/start', 'b', { agent_id: 'b', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    expect(value(first).subagent?.toolCallId).toBeUndefined();
    expect(value(second).subagent?.toolCallId).toBeUndefined();
    expect(value(second)).toMatchObject({ depth: 1, parent: 'root' });
    expect(registry.snapshot().pendingSpawns).toEqual([]);
  });

  it('does not create a root for a session/end the registry never saw start', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    const ended = await observe('session/end', 'e', { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'ghost' });
    expect(ended).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().nodes).toEqual({});
  });

  it('releases the retired root\'s correlation windows and pending spawns', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp' });
    await observe('tool/before', 'mcp', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_x_y__dump', tool_use_id: 'm' });
    await observe('session/end', 'e', { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'root' });
    expect(registry.snapshot().openCalls).toEqual([]);
    expect(registry.snapshot().pendingSpawns).toEqual([]);
    expect(await registry.resolveToolCall({ host: 'claude', toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
  });
});

describe('lineage registry cross-server and storeless behaviour (review round 6)', () => {
  it('re-reads the shared journal so a second registry over the same store resolves what the event host recorded', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const eventHost = createAgentLineageRegistry({ store });
    const otherServer = createAgentLineageRegistry({ store });
    expect(await otherServer.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'm1' }, toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    await eventHost.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    await eventHost.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'm', native: { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_p_other__dump', tool_use_id: 'm1' } });
    expect(await otherServer.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'm1' }, toolName: 'dump' })).toMatchObject({ value: { conversation: 'root', depth: 0 } });
    await store.close();
    await driver.close();
  });

  it('treats a supplied but unmatched Claude tool-use id as a miss instead of guessing by name', async () => {
    const registry = createAgentLineageRegistry();
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    await registry.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'm', native: { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_p_s__dump', tool_use_id: 'open-1' } });
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'missing' }, toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'open-1' }, toolName: 'dump' })).toMatchObject({ value: { conversation: 'root' } });
  });

  it('suppresses redeliveries in a storeless registry through its in-memory key ledger', async () => {
    const registry = createAgentLineageRegistry();
    const before = { conversation_id: 'root', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'm1' };
    await registry.observe({ event: 'prompt/submit', host: 'cursor', idempotencyKey: 'p', native: { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt' } });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'open', native: before, observedAt: '2026-09-03T00:00:00.000Z' });
    await registry.observe({ event: 'tool/after', host: 'cursor', idempotencyKey: 'close', native: { ...before, hook_event_name: 'postToolUse', tool_output: '{}' } });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'open', native: before, observedAt: '2026-09-03T00:00:05.000Z' });
    expect(registry.snapshot().openCalls).toEqual([]);
  });
});

describe('lineage registry serialization (review round 7)', () => {
  it('serializes concurrent starts so two sibling spawns are claimed once each', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const registry = createAgentLineageRegistry({ store });
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await Promise.all([
      observe('tool/before', 'sp1', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp1' }),
      observe('tool/before', 'sp2', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'sp2' }),
    ]);
    const [a, b] = await Promise.all([
      observe('agent/start', 'a', { agent_id: 'a', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }),
      observe('agent/start', 'b', { agent_id: 'b', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }),
    ]);
    expect(value(a)).toMatchObject({ depth: 1, parent: 'root' });
    expect(value(b)).toMatchObject({ depth: 1, parent: 'root' });
    expect(registry.snapshot().pendingSpawns).toEqual([]);
    await store.close();
    await driver.close();
  });

  it('records no correlation window for a carrier the tree cannot place', async () => {
    const registry = createAgentLineageRegistry();
    await registry.observe({
      event: 'tool/before',
      host: 'cursor',
      idempotencyKey: 'orphan',
      native: { conversation_id: 'unknown', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'u' },
    });
    expect(registry.snapshot().openCalls).toEqual([]);
    await registry.observe({ event: 'prompt/submit', host: 'cursor', idempotencyKey: 'p', native: { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt' } });
    await registry.observe({
      event: 'tool/before',
      host: 'cursor',
      idempotencyKey: 'known',
      native: { conversation_id: 'root', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'k' },
    });
    expect(registry.snapshot().openCalls).toMatchObject([{ conversation: 'root', root: 'root', toolCallId: 'k' }]);
  });
});

describe('lineage registry failure handling (review round 8)', () => {
  it('discards a spawn whose call failed so a later start is not attributed to it', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'f', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'failed' });
    await observe('tool/failure', 'ff', { error: 'boom', hook_event_name: 'PostToolUseFailure', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'failed' });
    expect(registry.snapshot().pendingSpawns).toEqual([]);
    await observe('tool/before', 'ps', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'ps' });
    await observe('agent/start', 'p', { agent_id: 'parent-agent', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    await observe('tool/before', 'ok', { agent_id: 'parent-agent', hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'ok' });
    const child = await observe('agent/start', 'c', { agent_id: 'child', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    expect(value(child)).toMatchObject({ depth: 2, parent: 'parent-agent', subagent: { toolCallId: 'ok' } });
  });

  it('keeps a parentless non-root Codex thread unresolved', async () => {
    const registry = createAgentLineageRegistry();
    expect(await registry.resolveToolCall({
      host: 'codex',
      meta: { 'x-codex-turn-metadata': { session_id: 'root', thread_id: 'orphan-thread', turn_id: 't' } },
      toolName: 'dump',
    })).toEqual(unavailable('id-not-resolvable'));
  });

  it('stays in memory after a durable commit fails instead of re-reading a head that lacks the mutation', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const failing = {
      ...store,
      dispatch: async (name: string, payload: unknown, options: { idempotencyKey: string }) => {
        if (name === 'toolCallOpened') throw new Error('journal full');
        return store.dispatch(name as never, payload as never, options);
      },
    } as typeof store;
    const registry = createAgentLineageRegistry({ store: failing });
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    await registry.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'm', native: { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_p_s__dump', tool_use_id: 'm1' } });
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'm1' }, toolName: 'dump' })).toMatchObject({ value: { conversation: 'root' } });
    await store.close();
    await driver.close();
  });
});

describe('lineage registry spawn evidence (review round 9)', () => {
  it('leaves a subagent start unresolved when no spawn call can be claimed', async () => {
    const registry = createAgentLineageRegistry();
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    const start = await registry.observe({
      event: 'agent/start',
      host: 'claude',
      idempotencyKey: 'orphan',
      native: { agent_id: 'orphan', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' },
    });
    expect(start).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().nodes['orphan']).toBeUndefined();
    // The start's own facts wait for the host to name the edge.
    expect(registry.snapshot().unplacedStarts).toMatchObject([{ id: 'orphan', root: 'root', type: 'general-purpose' }]);
  });

  it('does not mistake a generated MCP tool named spawn_agent for the Codex collaboration spawn', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'codex', idempotencyKey: key, native });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'mcp', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__server__spawn_agent', tool_use_id: 'm' });
    expect(registry.snapshot().pendingSpawns).toEqual([]);
    await observe('tool/before', 'sp', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp' });
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['sp']);
  });
});

describe('lineage registry generation and replay memory (review round 10)', () => {
  it('carries the pre-tool hook generation onto the correlated MCP call', async () => {
    const registry = createAgentLineageRegistry();
    await registry.observe({ event: 'prompt/submit', host: 'cursor', idempotencyKey: 'p', native: { conversation_id: 'root', generation_id: 'gen-1', hook_event_name: 'beforeSubmitPrompt' } });
    await registry.observe({ event: 'tool/before', host: 'cursor', idempotencyKey: 'm', native: { conversation_id: 'root', generation_id: 'gen-2', hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'MCP:dump', tool_use_id: 'm' } });
    expect(await registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toMatchObject({ value: { conversation: 'root', generation: 'gen-2' } });
  });

  it('recognizes a redelivered start after its node was pruned', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, key: string, native: Record<string, unknown>, observedAt: string) =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native, observedAt });
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' }, '2026-09-03T00:00:00.000Z');
    const spawnAndStart = async (index: number) => {
      await observe('tool/before', `spawn-${String(index)}`, { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: `spawn-${String(index)}` }, '2026-09-03T00:00:00.000Z');
      await observe('agent/start', `start-${String(index)}`, { agent_id: `agent-${String(index)}`, agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }, '2026-09-03T00:00:01.000Z');
      await observe('tool/after', `spawned-${String(index)}`, { hook_event_name: 'PostToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_response: {}, tool_use_id: `spawn-${String(index)}` }, '2026-09-03T00:00:01.000Z');
      await observe('agent/stop', `stop-${String(index)}`, { agent_id: `agent-${String(index)}`, agent_type: 'general-purpose', hook_event_name: 'SubagentStop', session_id: 'root', stop_hook_active: false }, `2026-09-03T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`);
    };
    for (let index = 0; index < LINEAGE_STOPPED_RETENTION + 5; index += 1) await spawnAndStart(index);
    expect(registry.snapshot().nodes['agent-0']).toBeUndefined();
    // A fresh spawn is pending for a new child when agent-0's start is redelivered late.
    await observe('tool/before', 'spawn-new', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'spawn-new' }, '2026-09-03T02:00:00.000Z');
    const replayed = await observe('agent/start', 'start-0', { agent_id: 'agent-0', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }, '2026-09-03T00:00:01.000Z');
    expect(replayed).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['spawn-new']);
    const fresh = await observe('agent/start', 'start-new', { agent_id: 'agent-new', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' }, '2026-09-03T02:00:01.000Z');
    expect(value(fresh)).toMatchObject({ depth: 1, subagent: { toolCallId: 'spawn-new' } });
  });
});

describe('lineage registry replay ledger across degradation (review round 11)', () => {
  it('keeps suppressing a redelivered durable commit after the journal degrades to memory', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    let fail = false;
    const flaky = {
      ...store,
      dispatch: async (name: string, payload: unknown, options: { idempotencyKey: string }) => {
        if (fail) throw new Error('journal full');
        return store.dispatch(name as never, payload as never, options);
      },
    } as typeof store;
    const registry = createAgentLineageRegistry({ store: flaky });
    const open = { event: 'tool/before', host: 'claude', idempotencyKey: 'm', native: { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_p_s__dump', tool_use_id: 'm1' } } as const;
    await registry.observe({ event: 'session/start', host: 'claude', idempotencyKey: 's', native: { hook_event_name: 'SessionStart', session_id: 'root' } });
    await registry.observe(open);
    await registry.observe({ event: 'tool/after', host: 'claude', idempotencyKey: 'm-after', native: { hook_event_name: 'PostToolUse', session_id: 'root', tool_input: {}, tool_name: 'mcp__plugin_p_s__dump', tool_response: 'ok', tool_use_id: 'm1' } });
    expect(registry.snapshot().openCalls).toEqual([]);
    // An unrelated commit fails: the registry degrades to memory for good.
    fail = true;
    await registry.observe({ event: 'prompt/submit', host: 'claude', idempotencyKey: 'p', native: { hook_event_name: 'UserPromptSubmit', prompt: 'again', session_id: 'root' } });
    // The earlier `tool/before` is redelivered: the closed window must stay closed.
    await registry.observe(open);
    expect(registry.snapshot().openCalls).toEqual([]);
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'm1' }, toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    await store.close();
    await driver.close();
  });
});

describe('lineage registry Cursor child binding precision (desktop hooks-service evidence, 2026-09-03)', () => {
  const cursor = (registry: AgentLineageRegistry) =>
    (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'cursor', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
  const start = (parent: string, id: string, workspace: string) => ({
    conversation_id: parent, hook_event_name: 'subagentStart', is_parallel_worker: false, parent_conversation_id: parent,
    subagent_id: id, subagent_type: 'general-purpose', tool_call_id: id, workspace_roots: [workspace],
  });
  const tool = (conversation: string, id: string, workspace: string) => ({
    conversation_id: conversation, hook_event_name: 'preToolUse', tool_input: {}, tool_name: 'Shell', tool_use_id: id, workspace_roots: [workspace],
  });

  it('binds an unseen conversation only to the pending child of its own workspace', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'pa', { conversation_id: 'root-a', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws/a'] });
    await observe('prompt/submit', 'pb', { conversation_id: 'root-b', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws/b'] });
    await observe('agent/start', 'sa', start('root-a', 'call-a', '/ws/a'));
    await observe('agent/start', 'sb', start('root-b', 'call-b', '/ws/b'));
    // Two starts are pending overall, but only one per workspace: each window's child binds to its own parent.
    expect(value(await observe('tool/before', 'ta', tool('child-a', 'ta', '/ws/a')))).toMatchObject({ conversation: 'child-a', depth: 1, parent: 'root-a', root: 'root-a', subagent: { id: 'call-a' } });
    expect(value(await observe('tool/before', 'tb', tool('child-b', 'tb', '/ws/b')))).toMatchObject({ conversation: 'child-b', depth: 1, parent: 'root-b', root: 'root-b', subagent: { id: 'call-b' } });
  });

  it('refuses to bind a conversation from a workspace where nothing is pending', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'pa', { conversation_id: 'root-a', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws/a'] });
    await observe('agent/start', 'sa', start('root-a', 'call-a', '/ws/a'));
    // A conversation in another window is not A's child, however alone the pending start is.
    expect(await observe('tool/before', 'tc', tool('other-window', 'tc', '/ws/c'))).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().pendingChildren).toEqual(['call-a']);
    // A payload without roots (older Cursor builds) keeps the single-pending rule.
    const { workspace_roots: _roots, ...rootless } = tool('child-a', 'ta', '/ws/a');
    expect(value(await observe('tool/before', 'ta', rootless))).toMatchObject({ conversation: 'child-a', parent: 'root-a' });
  });

  it('undoes a blind binding when the bound conversation receives a prompt, and rebinds the real child', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] });
    await observe('agent/start', 's', start('root', 'call-a', '/ws'));
    // A second chat tab whose prompt predates the registry speaks first: it is bound blind.
    expect(value(await observe('tool/before', 'x1', tool('other-root', 'x1', '/ws')))).toMatchObject({ conversation: 'other-root', depth: 1, parent: 'root' });
    // Its next prompt proves it a root: subagents never receive one.
    const corrected = await observe('prompt/submit', 'x-prompt', { conversation_id: 'other-root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] });
    expect(value(corrected)).toMatchObject({ conversation: 'other-root', depth: 0, root: 'other-root' });
    expect(value(corrected).parent).toBeUndefined();
    const snapshot = registry.snapshot();
    expect(snapshot.pendingChildren).toEqual(['call-a']);
    expect(snapshot.nodes['call-a']).toMatchObject({ depth: 1, id: 'call-a', parent: 'root', subagentId: 'call-a' });
    expect(snapshot.seenStarts).not.toContain('other-root');
    // The real child now binds to the restored pending start.
    expect(value(await observe('tool/before', 'c1', tool('child', 'c1', '/ws')))).toMatchObject({ conversation: 'child', depth: 1, parent: 'root', subagent: { id: 'call-a' } });
    expect(value(await observe('tool/before', 'x2', tool('other-root', 'x2', '/ws')))).toMatchObject({ conversation: 'other-root', depth: 0, resolution: 'native' });
  });

  it('keeps a mis-bound child that already stopped as a finished node instead of re-queuing it', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] });
    await observe('agent/start', 's', start('root', 'call-a', '/ws'));
    await observe('tool/before', 'x1', tool('other-root', 'x1', '/ws'));
    await observe('agent/stop', 'stop', { ...start('root', 'call-a', '/ws'), hook_event_name: 'subagentStop', status: 'completed' });
    expect(value(await observe('prompt/submit', 'x-prompt', { conversation_id: 'other-root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] }))).toMatchObject({ depth: 0 });
    const snapshot = registry.snapshot();
    expect(snapshot.pendingChildren).toEqual([]);
    expect(snapshot.nodes['call-a']).toMatchObject({ id: 'call-a', stoppedAt: '2026-09-03T00:00:00.000Z' });
    expect(snapshot.nodes['other-root']).toMatchObject({ depth: 0, root: 'other-root' });
  });

  it('corrects a blind binding before session/end so the misbound chat retires itself, not the parent it was filed under', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] });
    await observe('agent/start', 's', start('root', 'call-a', '/ws'));
    await observe('tool/before', 'x1', tool('other-root', 'x1', '/ws'));
    expect(registry.snapshot().nodes['other-root']).toMatchObject({ depth: 1, root: 'root' });
    // The other chat tab is closed: only a root receives sessionEnd, and the
    // event resolves against the corrected root exactly as a known root's would.
    const ended = await observe('session/end', 'x-end', {
      conversation_id: 'other-root', duration_ms: 1, final_status: 'none', hook_event_name: 'sessionEnd', is_background_agent: false, reason: 'window_close', workspace_roots: ['/ws'],
    });
    expect(value(ended)).toMatchObject({ conversation: 'other-root', depth: 0, root: 'other-root' });
    expect(value(ended).parent).toBeUndefined();
    const snapshot = registry.snapshot();
    expect(snapshot.nodes['root']?.stoppedAt).toBeUndefined();
    expect(snapshot.nodes['call-a']).toMatchObject({ id: 'call-a', parent: 'root' });
    expect(snapshot.nodes['call-a']?.stoppedAt).toBeUndefined();
    expect(snapshot.pendingChildren).toEqual(['call-a']);
    // The proven root is materialized as stopped, like any retired root, and keeps its first-seen time.
    expect(snapshot.nodes['other-root']).toMatchObject({ depth: 0, root: 'other-root', stoppedAt: '2026-09-03T00:00:00.000Z' });
    expect(snapshot.nodes['other-root']?.startedAt).toBe(snapshot.nodes['call-a']?.startedAt);
    // The real child still binds to the restored pending start.
    expect(value(await observe('tool/before', 'c1', tool('child', 'c1', '/ws')))).toMatchObject({ conversation: 'child', depth: 1, parent: 'root', root: 'root' });
  });

  it('re-roots what the misbound conversation started beneath it when the binding is undone', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] });
    await observe('agent/start', 's', start('root', 'call-a', '/ws'));
    // The other chat is bound blind, then spawns its own subagent, whose conversation binds beneath it.
    await observe('tool/before', 'x1', tool('other-root', 'x1', '/ws'));
    await observe('agent/start', 'sx', start('other-root', 'call-x', '/ws'));
    const grandchild = value(await observe('tool/before', 'g1', tool('grandchild', 'g1', '/ws')));
    expect(grandchild).toMatchObject({ conversation: 'grandchild', depth: 2, parent: 'other-root', root: 'root' });
    await observe('tool/before', 'g-mcp', { ...tool('grandchild', 'g-mcp', '/ws'), tool_name: 'MCP:probe' });
    // The prompt proves the other chat a root; its subtree follows it.
    expect(value(await observe('prompt/submit', 'x-prompt', { conversation_id: 'other-root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws'] }))).toMatchObject({ depth: 0, root: 'other-root' });
    const snapshot = registry.snapshot();
    expect(snapshot.nodes['grandchild']).toMatchObject({ depth: 1, parent: 'other-root', root: 'other-root', subagentId: 'call-x' });
    expect(snapshot.nodes['call-a']).toMatchObject({ depth: 1, parent: 'root', root: 'root' });
    expect(snapshot.pendingChildren).toEqual(['call-a']);
    expect(snapshot.openCalls.find((call) => call.toolCallId === 'g-mcp')?.root).toBe('other-root');
    expect(value(await registry.resolveToolCall({ host: 'cursor', toolName: 'probe' }))).toMatchObject({ conversation: 'grandchild', depth: 1, parent: 'other-root', root: 'other-root' });
    // Retiring the corrected root takes its own subtree and nothing of the original root's.
    await observe('session/end', 'x-end', {
      conversation_id: 'other-root', duration_ms: 1, final_status: 'none', hook_event_name: 'sessionEnd', is_background_agent: false, reason: 'window_close', workspace_roots: ['/ws'],
    });
    const retired = registry.snapshot();
    expect(retired.nodes['grandchild']?.stoppedAt).toBe('2026-09-03T00:00:00.000Z');
    expect(retired.nodes['root']?.stoppedAt).toBeUndefined();
    expect(retired.nodes['call-a']?.stoppedAt).toBeUndefined();
    expect(retired.openCalls.find((call) => call.toolCallId === 'g-mcp')).toBeUndefined();
  });

  it('records the workspace digest on Cursor roots and children and never the raw roots', async () => {
    const registry = createAgentLineageRegistry();
    const observe = cursor(registry);
    await observe('prompt/submit', 'p', { conversation_id: 'root', hook_event_name: 'beforeSubmitPrompt', workspace_roots: ['/ws/b', '/ws/a'] });
    await observe('agent/start', 's', start('root', 'call-a', '/ws/a'));
    const { nodes } = registry.snapshot();
    expect(nodes['root']?.workspace).toMatch(/^[0-9a-f]{16}$/u);
    expect(nodes['call-a']?.workspace).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(nodes)).not.toContain('/ws/');
  });
});

// Claude Code 2.1.257 names no parent on `SubagentStart` (#422), but the
// parent's own `Agent` PostToolUse carries `tool_use_id`, the caller's
// `agent_id` (none for the root) and `tool_response.agentId` — the child's id
// (captured 2026-09-03: `status: "async_launched"` for a background spawn,
// `status: "completed"` for a foreground one; hooks reference "PostToolUse",
// sub-agents "Resume subagents": Claude receives the child's agent ID when it
// completes). The registry treats that hook as the host's word on the edge.
describe('lineage registry Claude spawn confirmation from the Agent PostToolUse (#422)', () => {
  const claude = (registry: AgentLineageRegistry) =>
    (event: string, key: string, native: Record<string, unknown>, observedAt = '2026-09-03T00:00:00.000Z') =>
      registry.observe({ event, host: 'claude', idempotencyKey: key, native, observedAt });
  const session = (agentId?: string) => ({ session_id: 'root', ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'general-purpose' }) });
  const spawnBefore = (toolUseId: string, agentId?: string) =>
    ({ ...session(agentId), hook_event_name: 'PreToolUse', tool_input: { prompt: 'x' }, tool_name: 'Agent', tool_use_id: toolUseId });
  const spawnAfter = (toolUseId: string, child: string, status: 'async_launched' | 'completed', agentId?: string) => ({
    ...session(agentId),
    hook_event_name: 'PostToolUse',
    tool_input: { prompt: 'x' },
    tool_name: 'Agent',
    tool_response: status === 'completed'
      ? { agentId: child, agentType: 'general-purpose', content: [], status }
      : { agentId: child, isAsync: true, status },
    tool_use_id: toolUseId,
  });
  const start = (agentId: string) => ({ ...session(agentId), hook_event_name: 'SubagentStart' });
  const stop = (agentId: string) => ({ ...session(agentId), hook_event_name: 'SubagentStop', stop_hook_active: false });
  const bash = (toolUseId: string, agentId?: string) =>
    ({ ...session(agentId), hook_event_name: 'PreToolUse', tool_input: { command: 'pwd' }, tool_name: 'Bash', tool_use_id: toolUseId });

  it('places a start two parents could have produced once the spawning parent names it, and confirms the chain edge by edge', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', spawnBefore('sp1'));
    await observe('agent/start', 'p', start('p'));
    await observe('tool/before', 'sp2', spawnBefore('sp2'));
    await observe('tool/before', 'sp3', spawnBefore('sp3', 'p'));
    // Two parents, two open spawns: the start payload cannot pick, so no guess.
    expect(await observe('agent/start', 'n', start('n'), '2026-09-03T00:00:05.000Z')).toEqual(unavailable('id-not-resolvable'));
    expect(await observe('tool/before', 'n-bash', bash('n-bash', 'n'))).toEqual(unavailable('id-not-resolvable'));
    // The nested parent's PostToolUse says sp3 produced n: placed under p at
    // depth 2, as it started (time and type), with the spawn call named.
    await observe('tool/after', 'sp3-done', spawnAfter('sp3', 'n', 'async_launched', 'p'), '2026-09-03T00:00:06.000Z');
    expect(registry.snapshot().nodes['n']).toMatchObject({ confirmed: true, depth: 2, parent: 'p', root: 'root', startedAt: '2026-09-03T00:00:05.000Z', toolCallId: 'sp3', type: 'general-purpose' });
    expect(registry.snapshot().unplacedStarts).toEqual([]);
    expect(registry.snapshot().pendingSpawns.map((call) => call.toolCallId)).toEqual(['sp2']);
    // n's own edge is host-named but p's still rests on the registry's match, so the chain is not confirmed yet.
    const nestedTool = await observe('tool/before', 'n-bash-2', bash('n-bash-2', 'n'));
    expect(value(nestedTool)).toMatchObject({ conversation: 'n', depth: 2, parent: 'p', resolution: 'registry', root: 'root', subagent: { id: 'n', toolCallId: 'sp3' } });
    // The root's PostToolUse names p: every edge from n to the root is now the host's.
    await observe('tool/after', 'sp1-done', spawnAfter('sp1', 'p', 'async_launched'));
    expect(value(await observe('tool/before', 'n-bash-3', bash('n-bash-3', 'n')))).toMatchObject({ conversation: 'n', depth: 2, parent: 'p', resolution: 'confirmed' });
    expect(value(await observe('tool/before', 'p-bash', bash('p-bash', 'p')))).toMatchObject({ conversation: 'p', depth: 1, parent: 'root', resolution: 'confirmed', subagent: { toolCallId: 'sp1' } });
    // The root itself stays native: it has no edge to confirm.
    expect(value(await observe('tool/before', 'root-bash', bash('root-bash')))).toMatchObject({ conversation: 'root', depth: 0, resolution: 'native' });
    // The MCP path agrees with the hook path.
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'n-bash-3' }, toolName: 'probe' }))
      .toMatchObject({ value: { conversation: 'n', resolution: 'confirmed' } });
    expect(await registry.resolveToolCall({ host: 'claude', meta: { 'claudecode/toolUseId': 'root-bash' }, toolName: 'probe' }))
      .toMatchObject({ value: { conversation: 'root', resolution: 'registry' } });
  });

  it('fills in which sibling came from which spawn call once the parent names each child', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', spawnBefore('sp1'));
    await observe('tool/before', 'sp2', spawnBefore('sp2'));
    expect(value(await observe('agent/start', 'a', start('a'))).subagent?.toolCallId).toBeUndefined();
    expect(value(await observe('agent/start', 'b', start('b'))).subagent?.toolCallId).toBeUndefined();
    // The host's order is the reverse of the registry's blind pick.
    await observe('tool/after', 'sp1-done', spawnAfter('sp1', 'b', 'async_launched'));
    await observe('tool/after', 'sp2-done', spawnAfter('sp2', 'a', 'async_launched'));
    expect(registry.snapshot().nodes['a']).toMatchObject({ confirmed: true, parent: 'root', toolCallId: 'sp2' });
    expect(registry.snapshot().nodes['b']).toMatchObject({ confirmed: true, parent: 'root', toolCallId: 'sp1' });
    expect(value(await observe('tool/before', 'a-bash', bash('a-bash', 'a')))).toMatchObject({ resolution: 'confirmed', subagent: { id: 'a', toolCallId: 'sp2' } });
  });

  it('recovers a start whose spawn PreToolUse was never seen, keeping its start and stop times, through a durable journal', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentLineageStateDefinition('process'));
    const registry = createAgentLineageRegistry({ store });
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    // Missed PreToolUse: nothing to claim, so the start waits, and so does its stop.
    expect(await observe('agent/start', 'x', start('x'), '2026-09-03T00:00:01.000Z')).toEqual(unavailable('id-not-resolvable'));
    await observe('agent/stop', 'x-stop', stop('x'), '2026-09-03T00:00:02.000Z');
    expect(registry.snapshot().unplacedStarts).toMatchObject([{ id: 'x', stoppedAt: '2026-09-03T00:00:02.000Z' }]);
    const before = (await store.read()).revision;
    await observe('tool/after', 'sp-done', spawnAfter('sp-missed', 'x', 'completed'), '2026-09-03T00:00:03.000Z');
    expect(registry.snapshot().nodes['x']).toMatchObject({
      confirmed: true, depth: 1, parent: 'root', root: 'root', startedAt: '2026-09-03T00:00:01.000Z', stoppedAt: '2026-09-03T00:00:02.000Z', toolCallId: 'sp-missed',
    });
    expect(registry.snapshot().unplacedStarts).toEqual([]);
    // A redelivered PostToolUse replays the same journal entries; nothing moves.
    const after = (await store.read()).revision;
    expect(after).toBeGreaterThan(before);
    await observe('tool/after', 'sp-done', spawnAfter('sp-missed', 'x', 'completed'), '2026-09-03T00:00:09.000Z');
    expect((await store.read()).revision).toBe(after);
    expect(registry.snapshot().nodes['x']?.stoppedAt).toBe('2026-09-03T00:00:02.000Z');
    // A fresh registry over the same journal sees the confirmed node.
    const rehydrated = createAgentLineageRegistry({ store });
    expect(value(await rehydrated.observe({ event: 'tool/before', host: 'claude', idempotencyKey: 'late', native: bash('late', 'x') })))
      .toMatchObject({ conversation: 'x', depth: 1, parent: 'root', resolution: 'confirmed' });
    await store.close();
    await driver.close();
  });

  it('moves a child the spawn window filed under the wrong parent, rebases what it spawned, and materializes the real child', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', spawnBefore('sp1'));
    await observe('agent/start', 'p', start('p'));
    await observe('tool/after', 'sp1-done', spawnAfter('sp1', 'p', 'async_launched'));
    // p opens a spawn; the root's own second spawn PreToolUse is lost, so the
    // root's child q is the only start beside p's open call and is filed under p.
    await observe('tool/before', 'sp2', spawnBefore('sp2', 'p'));
    expect(value(await observe('agent/start', 'q', start('q')))).toMatchObject({ depth: 2, parent: 'p', subagent: { toolCallId: 'sp2' } });
    await observe('tool/before', 'sp4', spawnBefore('sp4', 'q'));
    expect(value(await observe('agent/start', 'r', start('r')))).toMatchObject({ depth: 3, parent: 'q' });
    // The root's PostToolUse for the lost call names q: q moves under the
    // root, r follows one level up, and the call is recorded on q.
    await observe('tool/after', 'lost-done', spawnAfter('sp-lost', 'q', 'async_launched'));
    expect(registry.snapshot().nodes['q']).toMatchObject({ confirmed: true, depth: 1, parent: 'root', root: 'root', toolCallId: 'sp-lost' });
    expect(registry.snapshot().nodes['r']).toMatchObject({ depth: 2, parent: 'q', root: 'root' });
    expect(value(await observe('tool/before', 'r-bash', bash('r-bash', 'r')))).toMatchObject({ depth: 2, parent: 'q', resolution: 'registry' });
    // p's PostToolUse names the child sp2 really produced, one whose start the
    // registry never saw: it exists from the confirmation on, under p.
    await observe('tool/after', 'sp2-done', spawnAfter('sp2', 'real', 'completed', 'p'), '2026-09-03T00:00:07.000Z');
    expect(registry.snapshot().nodes['real']).toMatchObject({ confirmed: true, depth: 2, parent: 'p', startedAt: '2026-09-03T00:00:07.000Z', stoppedAt: '2026-09-03T00:00:07.000Z', toolCallId: 'sp2' });
    expect(value(await observe('tool/before', 'q-bash', bash('q-bash', 'q')))).toMatchObject({ depth: 1, parent: 'root', resolution: 'confirmed' });
  });

  it('ignores a confirmation that names the carrier itself, a root, or would make a parent descend from its own child', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', 'sp1', spawnBefore('sp1'));
    await observe('agent/start', 'p', start('p'));
    await observe('tool/before', 'sp2', spawnBefore('sp2', 'p'));
    await observe('agent/start', 'q', start('q'));
    const before = registry.snapshot().nodes;
    await observe('tool/after', 'self', spawnAfter('sp-self', 'p', 'async_launched', 'p'));
    await observe('tool/after', 'root-child', spawnAfter('sp-root', 'root', 'async_launched', 'p'));
    await observe('tool/after', 'cycle', spawnAfter('sp-cycle', 'p', 'async_launched', 'q'));
    expect(registry.snapshot().nodes).toEqual(before);
    // A spawn response without an agentId (2.1.250-era shape) confirms nothing either.
    await observe('tool/after', 'sp1-done', { ...session(), hook_event_name: 'PostToolUse', tool_input: {}, tool_name: 'Agent', tool_response: { status: 'async_launched' }, tool_use_id: 'sp1' });
    expect(registry.snapshot().nodes['p']?.confirmed).toBeUndefined();
  });

  // The live Claude Code 2.1.259 orchestration capture (PR #455) replayed with
  // chosen hook rows withheld, the way a plugin whose PreToolUse hook was not
  // yet installed, or a runtime that came up mid-turn, would have seen it.
  const orchestration = fixture('claude-2.1.259-orchestration.ndjson');
  const row = (index: number) => orchestration[index - 1]!;
  const native = (index: number) => row(index).event!.native;
  const agentOf = (index: number) => native(index)['agent_id'] as string;
  const at = (index: number) => row(index).event!.canonical.observedAt;
  const withoutRows = (...dropped: number[]) => orchestration.filter((_record, index) => !dropped.includes(index + 1));
  /** Replays a filtered copy of the capture and keys each result by its original fixture row. */
  const replayRows = async (records: readonly FixtureRecord[], registry: AgentLineageRegistry) => {
    const lineages = await replay('claude', records, registry);
    return new Map(lineages.map((entry) => [orchestration.indexOf(records[entry.index - 1]!) + 1, entry.lineage]));
  };
  const orchestrationRoot = native(1)['session_id'] as string;
  // Row 14/16: the background Explore and general-purpose starts; 65: the
  // sequential foreground start; 82: its nested child. Rows 64 and 81 are the
  // root's and the sequential agent's `Agent` PreToolUse; 99 and 101 the
  // PostToolUse that name the nested and the sequential child.
  const [explore, parallel, sequential, nested] = [14, 16, 65, 82].map(agentOf) as [string, string, string, string];

  it('holds the Explore child from the PostToolUse that precedes its SubagentStart (2.1.259 rows 12–17), and lets the start add its type without claiming the next spawn', async () => {
    const registry = createAgentLineageRegistry();
    await replay('claude', orchestration.slice(0, 13), registry);
    expect(registry.snapshot().nodes[explore]).toMatchObject({ confirmed: true, depth: 1, parent: orchestrationRoot, startedAt: at(13), toolCallId: native(12)['tool_use_id'] });
    expect(registry.snapshot().nodes[explore]?.type).toBeUndefined();
    expect(registry.snapshot().pendingSpawns).toEqual([]);
    const [started] = await replay('claude', orchestration.slice(13, 14), registry);
    expect(value(started!.lineage)).toMatchObject({ conversation: explore, depth: 1, parent: orchestrationRoot, resolution: 'confirmed', subagent: { id: explore, toolCallId: native(12)['tool_use_id'], type: 'Explore' } });
    expect(registry.snapshot().nodes[explore]).toMatchObject({ startedAt: at(14), type: 'Explore' });
    // The same start redelivered under another key changes nothing.
    await registry.observe({ event: 'agent/start', host: 'claude', idempotencyKey: 'redelivered-14', native: native(14), observedAt: '2026-09-04T00:00:00.000Z' });
    expect(registry.snapshot().nodes[explore]?.startedAt).toBe(at(14));
    // The root's second spawn (rows 15–17) is claimed by its own child, not by the one already placed.
    const rest = await replay('claude', orchestration.slice(14, 17), registry);
    expect(value(rest[1]!.lineage)).toMatchObject({ conversation: parallel, depth: 1, parent: orchestrationRoot, resolution: 'registry', subagent: { toolCallId: native(15)['tool_use_id'] } });
    expect(registry.snapshot().nodes[parallel]).toMatchObject({ confirmed: true, toolCallId: native(15)['tool_use_id'] });
  });

  it('recovers the nested child when the sequential agent\'s spawn PreToolUse (2.1.259 row 81) was never seen', async () => {
    const registry = createAgentLineageRegistry();
    const byRow = await replayRows(withoutRows(81), registry);
    // The nested start has no spawn to claim: unplaced, and unresolvable for its whole run.
    expect(byRow.get(82)).toEqual(unavailable('id-not-resolvable'));
    for (const index of [83, 85, 89, 98]) expect(byRow.get(index), `row ${String(index)}`).toEqual(unavailable('id-not-resolvable'));
    // Row 99, the sequential agent's PostToolUse naming it, places it as it started and stopped.
    expect(registry.snapshot().nodes[nested]).toMatchObject({
      confirmed: true, depth: 2, parent: sequential, root: orchestrationRoot, startedAt: at(82), stoppedAt: at(98), toolCallId: native(99)['tool_use_id'], type: 'general-purpose',
    });
    expect(registry.snapshot().unplacedStarts ?? []).toEqual([]);
  });

  it('recovers the sequential agent and its nested child when the root\'s spawn PreToolUse (2.1.259 row 64) was never seen', async () => {
    const registry = createAgentLineageRegistry();
    const byRow = await replayRows(withoutRows(64), registry);
    // Neither start can be placed: the sequential agent has no spawn to claim, and the
    // nested child's spawn call opens no window because its carrier is unplaced.
    expect(byRow.get(65)).toEqual(unavailable('id-not-resolvable'));
    expect(byRow.get(82)).toEqual(unavailable('id-not-resolvable'));
    // Before the root's PostToolUse (row 101) the nested confirmation (row 99) waits with its unplaced parent.
    const partial = createAgentLineageRegistry();
    await replay('claude', withoutRows(64).slice(0, 99), partial);
    expect(partial.snapshot().unplacedStarts).toMatchObject([
      { confirmations: [{ child: nested, parent: sequential, toolCallId: native(99)['tool_use_id'] }], id: sequential, stoppedAt: at(100) },
      { id: nested, stoppedAt: at(98) },
    ]);
    // Row 101 places the sequential agent under the root and applies the parked confirmation beneath it.
    expect(registry.snapshot().nodes[sequential]).toMatchObject({ confirmed: true, depth: 1, parent: orchestrationRoot, startedAt: at(65), stoppedAt: at(100), toolCallId: native(101)['tool_use_id'] });
    expect(registry.snapshot().nodes[nested]).toMatchObject({ confirmed: true, depth: 2, parent: sequential, root: orchestrationRoot, startedAt: at(82), stoppedAt: at(98), toolCallId: native(99)['tool_use_id'] });
    expect(registry.snapshot().unplacedStarts ?? []).toEqual([]);
    // Nothing else moved: the background pair still hangs under the root.
    expect(registry.snapshot().nodes[explore]).toMatchObject({ confirmed: true, depth: 1, parent: orchestrationRoot });
    expect(registry.snapshot().nodes[parallel]).toMatchObject({ confirmed: true, depth: 1, parent: orchestrationRoot });
  });

  it('drops the unplaced starts of a session that ends', async () => {
    const registry = createAgentLineageRegistry();
    const observe = claude(registry);
    await observe('session/start', 's', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('agent/start', 'x', start('x'));
    expect(registry.snapshot().unplacedStarts).toHaveLength(1);
    await observe('session/end', 'e', { hook_event_name: 'SessionEnd', reason: 'other', session_id: 'root' });
    expect(registry.snapshot().unplacedStarts).toEqual([]);
  });
});
