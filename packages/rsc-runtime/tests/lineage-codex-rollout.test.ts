import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { unavailable } from '../src/agent-request.js';
import {
  codexThreadFromRolloutPath,
  createAgentLineageRegistry,
  parseCodexRolloutMeta,
  readCodexRolloutHead,
  readCodexSpawnLineage,
  resolveNativeLineage,
  resolveStandaloneLineage,
  type AgentLineageRegistry,
  type CodexRolloutReader,
} from '../src/lineage/index.js';

interface FixtureRecord {
  readonly event?: {
    readonly canonical: { readonly event: string; readonly idempotencyKey: string; readonly observedAt: string };
    readonly native: Readonly<Record<string, unknown>>;
  };
  readonly kind: 'event' | 'mcp' | 'cli';
  readonly observed?: { readonly client?: { readonly name: string }; readonly mcpReq?: { readonly _meta?: Record<string, unknown> }; readonly tool?: string };
}

const fixturesRoot = resolve(import.meta.dirname, '../../../fixtures/host-lineage');
const capture = (): FixtureRecord[] => readFileSync(resolve(fixturesRoot, 'codex-0.147.0.ndjson'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as FixtureRecord);
const rolloutFixture = (path: string): string => resolve(fixturesRoot, 'codex-0.147.0-rollouts', basename(path));

/** Serves the captured rollout heads for the paths the hook payloads name; the capture's CODEX_HOME itself is gone. */
const capturedRollouts: CodexRolloutReader = (path) => readCodexRolloutHead(rolloutFixture(path));
const noRollouts: CodexRolloutReader = async () => undefined;

const ROOT = '01a06660-110e-7290-8d1c-8ef1b2b68fc2';
const SUBAGENT = '01a06660-8faf-7122-80af-24ba2da81ad7';
const NESTED = '01a06661-100a-7ad3-a0f5-b0e6ffdb4b11';
const ROOT_ROLLOUT = `/tmp/host-test/codex-home/.codex/sessions/2026/09/03/rollout-2026-09-03T08-26-06-${ROOT}.jsonl`;
const SUBAGENT_ROLLOUT = `/tmp/host-test/codex-home/.codex/sessions/2026/09/03/rollout-2026-09-03T08-26-39-${SUBAGENT}.jsonl`;
const NESTED_ROLLOUT = `/tmp/host-test/codex-home/.codex/sessions/2026/09/03/rollout-2026-09-03T08-27-12-${NESTED}.jsonl`;
const SPAWN_CALLS = { nested: 'call_i63o2ohoAVpJXjlsGEjoK4we', subagent: 'call_3koNvBFvpKYdTIqLb1xDOjSX' };

const replay = async (records: readonly FixtureRecord[], registry: AgentLineageRegistry) => {
  const lineages: { readonly index: number; readonly kind: string; readonly lineage: Awaited<ReturnType<AgentLineageRegistry['observe']>>; readonly native?: Readonly<Record<string, unknown>> }[] = [];
  for (const [position, record] of records.entries()) {
    if (record.event !== undefined) {
      const lineage = await registry.observe({
        event: record.event.canonical.event,
        host: 'codex',
        idempotencyKey: record.event.canonical.idempotencyKey,
        native: record.event.native,
        observedAt: record.event.canonical.observedAt,
      });
      lineages.push({ index: position + 1, kind: record.event.canonical.event, lineage, native: record.event.native });
    } else if (record.kind === 'mcp' && record.observed?.tool !== undefined) {
      const lineage = await registry.resolveToolCall({ host: 'codex', meta: record.observed.mcpReq?._meta, toolName: record.observed.tool });
      lineages.push({ index: position + 1, kind: `mcp:${record.observed.tool}`, lineage });
    }
  }
  return lineages;
};

const value = (observed: Awaited<ReturnType<AgentLineageRegistry['observe']>>) => {
  expect(observed.state).toBe('available');
  return observed.state === 'available' ? observed.value : undefined!;
};

/** A hook payload shaped like the capture's, for scenarios the capture did not exercise. */
const codexHook = (event: string, agent: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  cwd: '/tmp/host-test/codex-workspace',
  hook_event_name: event,
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  session_id: ROOT,
  ...(agent === undefined ? { transcript_path: ROOT_ROLLOUT } : { agent_id: agent, agent_type: 'default' }),
  ...extra,
});

describe('Codex rollout heads (#423): what the host writes about a spawned thread', () => {
  it('parses the captured session_meta of a spawned thread into parent, depth, and agent path', async () => {
    const head = await readCodexRolloutHead(rolloutFixture(NESTED_ROLLOUT));
    expect(head).toBeDefined();
    // The reader stops at the first newline: the second fixture line never reaches the parser.
    expect(head).not.toContain('response_item');
    expect(parseCodexRolloutMeta(head!)).toEqual({
      agentPath: '/root/host_probe/nested_probe',
      depth: 2,
      parent: SUBAGENT,
      root: ROOT,
      subagentKind: 'thread_spawn',
      thread: NESTED,
    });
    expect(parseCodexRolloutMeta((await readCodexRolloutHead(rolloutFixture(SUBAGENT_ROLLOUT)))!)).toMatchObject({ depth: 1, parent: ROOT, thread: SUBAGENT });
  });

  it('describes a root rollout without inventing a parent, and a host-internal subagent without a spawn lineage', async () => {
    expect(parseCodexRolloutMeta((await readCodexRolloutHead(rolloutFixture(ROOT_ROLLOUT)))!)).toEqual({ root: ROOT, thread: ROOT });
    // Observed 0.147.0 shape for a review/guardian helper thread: `source.subagent` names no thread_spawn.
    const helper = JSON.stringify({ payload: { id: 'helper', session_id: ROOT, source: { subagent: { other: 'guardian' } }, thread_source: 'subagent' }, type: 'session_meta' });
    expect(parseCodexRolloutMeta(helper)).toEqual({ root: ROOT, subagentKind: 'other', thread: 'helper' });
    const review = JSON.stringify({ payload: { id: 'review', session_id: ROOT, source: { subagent: 'review' } }, type: 'session_meta' });
    expect(parseCodexRolloutMeta(review)).toEqual({ root: ROOT, subagentKind: 'review', thread: 'review' });
    expect(await readCodexSpawnLineage('helper.jsonl', 'helper', async () => helper)).toBeUndefined();
    // Older builds (≤0.136.0) carry `agent_path: null` inside thread_spawn and no top-level copy: parent and depth still parse.
    const older = JSON.stringify({ payload: { id: 'old', source: { subagent: { thread_spawn: { agent_path: null, depth: 1, parent_thread_id: 'p' } } } }, type: 'session_meta' });
    expect(parseCodexRolloutMeta(older)).toEqual({ depth: 1, parent: 'p', subagentKind: 'thread_spawn', thread: 'old' });
  });

  it('rejects anything that is not a session_meta naming its thread', () => {
    expect(parseCodexRolloutMeta('')).toBeUndefined();
    expect(parseCodexRolloutMeta('not json')).toBeUndefined();
    expect(parseCodexRolloutMeta(JSON.stringify({ payload: { type: 'message' }, type: 'response_item' }))).toBeUndefined();
    expect(parseCodexRolloutMeta(JSON.stringify({ payload: {}, type: 'session_meta' }))).toBeUndefined();
    expect(parseCodexRolloutMeta(JSON.stringify({ payload: { id: 'x', source: { subagent: { thread_spawn: { depth: 0, parent_thread_id: 'p' } } } }, type: 'session_meta' }))).toEqual({ parent: 'p', subagentKind: 'thread_spawn', thread: 'x' });
  });

  it('refuses a rollout that belongs to a different thread than the payload speaks for', async () => {
    expect(await readCodexSpawnLineage(NESTED_ROLLOUT, SUBAGENT, capturedRollouts)).toBeUndefined();
    expect(await readCodexSpawnLineage(NESTED_ROLLOUT, NESTED, capturedRollouts)).toMatchObject({ depth: 2, parent: SUBAGENT });
    expect(await readCodexSpawnLineage(undefined, NESTED, capturedRollouts)).toBeUndefined();
    expect(await readCodexRolloutHead('/nonexistent/rollout.jsonl')).toBeUndefined();
  });

  it('reads the thread id out of a rollout basename', () => {
    expect(codexThreadFromRolloutPath(SUBAGENT_ROLLOUT)).toBe(SUBAGENT);
    expect(codexThreadFromRolloutPath('/tmp/agent-transcripts/abc/abc.jsonl')).toBeUndefined();
    expect(codexThreadFromRolloutPath(undefined)).toBeUndefined();
  });
});

describe('lineage registry places Codex threads from their own rollout (#423)', () => {
  it('replays the 2026-09-03 capture: SubagentStart resolves parent, depth, and the exact spawn call without ordering inference', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: capturedRollouts });
    const lineages = await replay(capture(), registry);

    const [subagentStart, nestedStart] = lineages.filter((entry) => entry.kind === 'agent/start');
    expect(subagentStart!.lineage).toMatchObject({ source: 'derived', state: 'available' });
    expect(value(subagentStart!.lineage)).toEqual({
      conversation: SUBAGENT,
      depth: 1,
      generation: '01a06660-901a-77f1-a660-ac3c549409c0',
      parent: ROOT,
      resolution: 'transcript',
      root: ROOT,
      subagent: { id: SUBAGENT, toolCallId: SPAWN_CALLS.subagent, type: 'default' },
    });
    expect(value(nestedStart!.lineage)).toMatchObject({
      conversation: NESTED,
      depth: 2,
      parent: SUBAGENT,
      resolution: 'transcript',
      root: ROOT,
      subagent: { id: NESTED, toolCallId: SPAWN_CALLS.nested, type: 'default' },
    });

    // Every hook inside a subagent resolves the same way; root hooks stay native.
    const nestedTool = lineages.find((entry) => entry.kind === 'tool/before' && entry.native?.['agent_id'] === NESTED)!;
    expect(value(nestedTool.lineage)).toMatchObject({ conversation: NESTED, depth: 2, parent: SUBAGENT, resolution: 'transcript' });
    expect(value(lineages[0]!.lineage)).toMatchObject({ conversation: ROOT, depth: 0, resolution: 'native' });

    // MCP calls still resolve natively from _meta and agree with the hooks.
    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe').map((entry) => value(entry.lineage));
    expect(probes).toMatchObject([
      { conversation: ROOT, depth: 0, resolution: 'native' },
      { conversation: SUBAGENT, depth: 1, parent: ROOT, resolution: 'native' },
      { conversation: NESTED, depth: 2, parent: SUBAGENT, resolution: 'native' },
    ]);

    // Both spawn calls were claimed by agent path; both threads stopped on SubagentStop.
    const snapshot = registry.snapshot();
    expect(snapshot.pendingSpawns).toEqual([]);
    expect(snapshot.nodes[SUBAGENT]).toMatchObject({ placement: 'transcript', stoppedAt: expect.any(String), toolCallId: SPAWN_CALLS.subagent });
    expect(snapshot.nodes[NESTED]).toMatchObject({ placement: 'transcript', stoppedAt: expect.any(String), toolCallId: SPAWN_CALLS.nested });
  });

  it('falls back to spawn-ordering inference when the rollout is unreadable, as the pre-#423 registry did', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: noRollouts });
    const lineages = await replay(capture(), registry);
    const [subagentStart, nestedStart] = lineages.filter((entry) => entry.kind === 'agent/start');
    expect(value(subagentStart!.lineage)).toMatchObject({ depth: 1, parent: ROOT, resolution: 'registry', subagent: { toolCallId: SPAWN_CALLS.subagent } });
    expect(value(nestedStart!.lineage)).toMatchObject({ depth: 2, parent: SUBAGENT, resolution: 'registry', subagent: { toolCallId: SPAWN_CALLS.nested } });
    expect(registry.snapshot().nodes[SUBAGENT]?.placement).toBeUndefined();
  });

  it('keeps the spawn agent path from the parent\'s PostToolUse on the pending spawn', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: noRollouts });
    const records = capture();
    const upToSpawnClose = records.findIndex((record) => record.event?.canonical.event === 'tool/after' && record.event.native['tool_name'] === 'collaborationspawn_agent') + 1;
    await replay(records.slice(0, upToSpawnClose), registry);
    expect(registry.snapshot().pendingSpawns).toMatchObject([{ agentPath: '/root/host_probe', toolCallId: SPAWN_CALLS.subagent }]);
  });

  it('resolves a start that spawn ordering alone had to refuse: two parents with unclaimed spawns', async () => {
    const rollouts = new Map<string, string>();
    const read: CodexRolloutReader = async (path) => rollouts.get(path);
    const registry = createAgentLineageRegistry({ readTranscript: read });
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'codex', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
    const spawnMeta = (thread: string, parent: string, depth: number, agentPath: string) =>
      JSON.stringify({ payload: { id: thread, session_id: ROOT, source: { subagent: { thread_spawn: { agent_path: agentPath, depth, parent_thread_id: parent } } }, thread_source: 'subagent' }, type: 'session_meta' });
    const rollout = (thread: string) => `/home/u/.codex/sessions/2026/09/03/rollout-2026-09-03T00-00-00-${thread}.jsonl`;
    const worker = '01a00000-0000-7000-8000-000000000001';
    const workerChild = '01a00000-0000-7000-8000-000000000002';
    const rootChild = '01a00000-0000-7000-8000-000000000003';
    rollouts.set(rollout(worker), spawnMeta(worker, ROOT, 1, '/root/worker'));
    rollouts.set(rollout(workerChild), spawnMeta(workerChild, worker, 2, '/root/worker/nested'));
    rollouts.set(rollout(rootChild), spawnMeta(rootChild, ROOT, 1, '/root/second'));

    await observe('session/start', 's', codexHook('SessionStart', undefined));
    await observe('tool/before', 'sp1', codexHook('PreToolUse', undefined, { tool_input: { task_name: 'worker' }, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp1' }));
    await observe('tool/after', 'sp1-after', codexHook('PostToolUse', undefined, { tool_input: { task_name: 'worker' }, tool_name: 'collaborationspawn_agent', tool_response: '{"task_name":"/root/worker"}', tool_use_id: 'sp1' }));
    await observe('agent/start', 'w', codexHook('SubagentStart', worker, { transcript_path: rollout(worker), turn_id: 'w-turn' }));
    // The root and the worker each spawn again before either child starts: nothing in the start payloads tells them apart.
    await observe('tool/before', 'sp2', codexHook('PreToolUse', undefined, { tool_input: { task_name: 'second' }, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp2' }));
    await observe('tool/after', 'sp2-after', codexHook('PostToolUse', undefined, { tool_input: { task_name: 'second' }, tool_name: 'collaborationspawn_agent', tool_response: '{"task_name":"/root/second"}', tool_use_id: 'sp2' }));
    await observe('tool/before', 'sp3', codexHook('PreToolUse', worker, { tool_input: { task_name: 'nested' }, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp3', transcript_path: rollout(worker) }));
    await observe('tool/after', 'sp3-after', codexHook('PostToolUse', worker, { tool_input: { task_name: 'nested' }, tool_name: 'collaborationspawn_agent', tool_response: { task_name: '/root/worker/nested' }, tool_use_id: 'sp3', transcript_path: rollout(worker) }));

    const nested = await observe('agent/start', 'wc', codexHook('SubagentStart', workerChild, { transcript_path: rollout(workerChild), turn_id: 'wc-turn' }));
    expect(value(nested)).toMatchObject({ conversation: workerChild, depth: 2, parent: worker, resolution: 'transcript', subagent: { toolCallId: 'sp3' } });
    const second = await observe('agent/start', 'rc', codexHook('SubagentStart', rootChild, { transcript_path: rollout(rootChild), turn_id: 'rc-turn' }));
    expect(value(second)).toMatchObject({ conversation: rootChild, depth: 1, parent: ROOT, resolution: 'transcript', subagent: { toolCallId: 'sp2' } });
    expect(registry.snapshot().pendingSpawns).toEqual([]);
  });

  it('places a thread first seen mid-flight from the rollout its hook names, and MCP _meta for that grandchild then resolves', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: capturedRollouts });
    // The registry never saw the root start, the spawn calls, or either SubagentStart.
    const tool = await registry.observe({
      event: 'tool/before',
      host: 'codex',
      idempotencyKey: 'cold',
      native: codexHook('PreToolUse', NESTED, { tool_input: { command: 'pwd' }, tool_name: 'Bash', tool_use_id: 'exec-1', transcript_path: NESTED_ROLLOUT, turn_id: 'n-turn' }),
    });
    expect(tool).toMatchObject({ source: 'derived', state: 'available' });
    expect(value(tool)).toEqual({
      conversation: NESTED,
      depth: 2,
      generation: 'n-turn',
      parent: SUBAGENT,
      resolution: 'transcript',
      root: ROOT,
      subagent: { id: NESTED, type: 'default' },
    });
    // The root node was materialized from the payload's session_id; the parent thread itself is named, not fabricated.
    expect(registry.snapshot().nodes[ROOT]).toMatchObject({ depth: 0 });
    expect(registry.snapshot().nodes[SUBAGENT]).toBeUndefined();
    // The pre-#423 refusal for a grandchild whose parent the registry never saw no longer applies once its hook placed it.
    expect(await registry.resolveToolCall({
      host: 'codex',
      meta: { 'x-codex-turn-metadata': { parent_thread_id: SUBAGENT, session_id: ROOT, thread_id: NESTED, turn_id: 'n-turn' } },
      toolName: 'probe',
    })).toMatchObject({ value: { conversation: NESTED, depth: 2, parent: SUBAGENT, resolution: 'native' } });
  });

  it('still answers honestly when a mid-flight thread names an unreadable rollout', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: noRollouts });
    const tool = await registry.observe({
      event: 'tool/before',
      host: 'codex',
      idempotencyKey: 'cold',
      native: codexHook('PreToolUse', NESTED, { tool_input: {}, tool_name: 'Bash', tool_use_id: 'exec-1', transcript_path: NESTED_ROLLOUT }),
    });
    expect(tool).toEqual(unavailable('id-not-resolvable'));
    expect(registry.snapshot().nodes).toEqual({});
  });

  it('places and retires a thread whose only observed event is SubagentStop, from agent_transcript_path', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: capturedRollouts });
    const stop = await registry.observe({
      event: 'agent/stop',
      host: 'codex',
      idempotencyKey: 'stop',
      native: codexHook('SubagentStop', NESTED, { agent_transcript_path: NESTED_ROLLOUT, stop_hook_active: false, transcript_path: SUBAGENT_ROLLOUT, turn_id: 'n-turn' }),
      observedAt: '2026-09-03T08:27:40.000Z',
    });
    expect(value(stop)).toMatchObject({ conversation: NESTED, depth: 2, parent: SUBAGENT, resolution: 'transcript' });
    expect(registry.snapshot().nodes[NESTED]).toMatchObject({ placement: 'transcript', stoppedAt: '2026-09-03T08:27:40.000Z' });
  });

  it('corrects an inferred parent at SubagentStop from the parent rollout the payload names, shifting descendants', async () => {
    // Rollouts are unreadable at start (the pre-#423 inference path), so the
    // nested thread is filed under the only parent with an unclaimed spawn.
    const registry = createAgentLineageRegistry({ readTranscript: noRollouts });
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'codex', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
    const other = '01a00000-0000-7000-8000-00000000000a';
    const grandchild = '01a00000-0000-7000-8000-00000000000b';
    await observe('session/start', 's', codexHook('SessionStart', undefined));
    await observe('tool/before', 'sp1', codexHook('PreToolUse', undefined, { tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp1' }));
    await observe('agent/start', 'sub', codexHook('SubagentStart', SUBAGENT, { transcript_path: SUBAGENT_ROLLOUT }));
    await observe('tool/before', 'sp2', codexHook('PreToolUse', undefined, { tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp2' }));
    await observe('agent/start', 'other', codexHook('SubagentStart', other, { transcript_path: `/x/rollout-2026-09-03T00-00-00-${other}.jsonl` }));
    // The registry missed SUBAGENT's spawn hook; `other` has one unclaimed, so the nested thread is misfiled under `other`.
    await observe('tool/before', 'sp3', codexHook('PreToolUse', other, { tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp3' }));
    const misfiled = await observe('agent/start', 'nested', codexHook('SubagentStart', NESTED, { transcript_path: NESTED_ROLLOUT }));
    expect(value(misfiled)).toMatchObject({ depth: 2, parent: other, resolution: 'registry' });
    await observe('tool/before', 'sp4', codexHook('PreToolUse', NESTED, { tool_input: {}, tool_name: 'collaborationspawn_agent', tool_use_id: 'sp4' }));
    await observe('agent/start', 'gc', codexHook('SubagentStart', grandchild, { transcript_path: `/x/rollout-2026-09-03T00-00-00-${grandchild}.jsonl` }));
    expect(value(await observe('tool/before', 'gc-tool', codexHook('PreToolUse', grandchild, { tool_input: {}, tool_name: 'Bash', tool_use_id: 'b' })))).toMatchObject({ depth: 3, parent: NESTED });

    // SubagentStop names the real parent's rollout in transcript_path (fixture rows 37 and 39): here the
    // root's, so the thread moves up a level and its own child follows.
    const stopped = await observe('agent/stop', 'nested-stop', codexHook('SubagentStop', NESTED, { agent_transcript_path: NESTED_ROLLOUT, stop_hook_active: false, transcript_path: ROOT_ROLLOUT }));
    expect(value(stopped)).toMatchObject({ conversation: NESTED, depth: 1, parent: ROOT, resolution: 'registry' });
    expect(registry.snapshot().nodes[NESTED]).toMatchObject({ depth: 1, parent: ROOT, stoppedAt: '2026-09-03T00:00:00.000Z' });
    expect(registry.snapshot().nodes[grandchild]).toMatchObject({ depth: 2, parent: NESTED });
    // The parent it was misfiled under is untouched.
    expect(registry.snapshot().nodes[other]).toMatchObject({ depth: 1, parent: ROOT });
    expect(registry.snapshot().nodes[other]?.stoppedAt).toBeUndefined();
  });

  it('leaves a transcript-placed node alone at SubagentStop and ignores a self-referential path', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: capturedRollouts });
    const observe = (event: string, key: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'codex', idempotencyKey: key, native, observedAt: '2026-09-03T00:00:00.000Z' });
    await observe('agent/start', 'nested', codexHook('SubagentStart', NESTED, { transcript_path: NESTED_ROLLOUT }));
    const stopped = await observe('agent/stop', 'stop', codexHook('SubagentStop', NESTED, { agent_transcript_path: NESTED_ROLLOUT, stop_hook_active: false, transcript_path: NESTED_ROLLOUT }));
    expect(value(stopped)).toMatchObject({ depth: 2, parent: SUBAGENT, resolution: 'transcript' });
  });

  it('ignores a replayed SubagentStart once the transcript-placed node has stopped', async () => {
    const registry = createAgentLineageRegistry({ readTranscript: capturedRollouts });
    const start = codexHook('SubagentStart', NESTED, { transcript_path: NESTED_ROLLOUT });
    await registry.observe({ event: 'agent/start', host: 'codex', idempotencyKey: 'n', native: start });
    await registry.observe({ event: 'agent/stop', host: 'codex', idempotencyKey: 'n-stop', native: codexHook('SubagentStop', NESTED, { agent_transcript_path: NESTED_ROLLOUT, stop_hook_active: false, transcript_path: SUBAGENT_ROLLOUT }) });
    const stoppedAt = registry.snapshot().nodes[NESTED]?.stoppedAt;
    await registry.observe({ event: 'agent/start', host: 'codex', idempotencyKey: 'n', native: start });
    expect(registry.snapshot().nodes[NESTED]?.stoppedAt).toBe(stoppedAt);
  });
});

describe('standalone Codex hooks read their own rollout (#423)', () => {
  it('resolves a subagent hook exactly from the rollout the payload names, with derived provenance', async () => {
    const native = codexHook('PreToolUse', SUBAGENT, { tool_input: {}, tool_name: 'Bash', tool_use_id: 'exec-1', transcript_path: SUBAGENT_ROLLOUT, turn_id: '01a06660-901a-77f1-a660-ac3c549409c0' });
    expect(resolveNativeLineage('codex', native)).toEqual(unavailable('no-shared-runtime'));
    expect(await resolveStandaloneLineage('codex', native, capturedRollouts)).toEqual({
      source: 'derived',
      state: 'available',
      value: {
        conversation: SUBAGENT,
        depth: 1,
        generation: '01a06660-901a-77f1-a660-ac3c549409c0',
        parent: ROOT,
        resolution: 'transcript',
        root: ROOT,
        subagent: { id: SUBAGENT, type: 'default' },
      },
    });
  });

  it('uses agent_transcript_path on SubagentStop, where transcript_path is the parent\'s rollout', async () => {
    const stop = codexHook('SubagentStop', NESTED, { agent_transcript_path: NESTED_ROLLOUT, stop_hook_active: false, transcript_path: SUBAGENT_ROLLOUT });
    expect(await resolveStandaloneLineage('codex', stop, capturedRollouts)).toMatchObject({ value: { conversation: NESTED, depth: 2, parent: SUBAGENT } });
  });

  it('keeps the payload-only answer for roots, other hosts, and unreadable rollouts', async () => {
    expect(await resolveStandaloneLineage('codex', codexHook('SessionStart', undefined), capturedRollouts)).toMatchObject({ source: 'native', value: { conversation: ROOT, depth: 0, resolution: 'native' } });
    expect(await resolveStandaloneLineage('claude', { agent_id: 'child', session_id: 'root' }, capturedRollouts)).toEqual(unavailable('no-shared-runtime'));
    expect(await resolveStandaloneLineage('cursor', { conversation_id: 'c' }, capturedRollouts)).toEqual(unavailable('no-shared-runtime'));
    expect(await resolveStandaloneLineage('codex', codexHook('PreToolUse', SUBAGENT, { transcript_path: SUBAGENT_ROLLOUT }), noRollouts)).toEqual(unavailable('no-shared-runtime'));
    // The default reader hits the filesystem; the capture's CODEX_HOME no longer exists.
    expect(await resolveStandaloneLineage('codex', codexHook('PreToolUse', SUBAGENT, { transcript_path: SUBAGENT_ROLLOUT }))).toEqual(unavailable('no-shared-runtime'));
  });
});
