import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { unavailable } from '../src/agent-request.js';
import {
  agentLineageStateDefinition,
  createAgentLineageRegistry,
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
      const lineage = registry.resolveToolCall({
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
  it('Claude 2.1.257: subagent events resolve to their own agent under the root session, nested depth 2, parent inferred from the open Agent call', async () => {
    const registry = createAgentLineageRegistry();
    const lineages = await replay('claude', fixture('claude-2.1.257.ndjson'), registry);
    const root = 'a7f96472-e9d0-447a-826d-36da9b635fd6';

    const sessionStart = value(lineages[0]!.lineage);
    expect(sessionStart).toMatchObject({ conversation: root, depth: 0, resolution: 'native', root });
    expect(sessionStart.parent).toBeUndefined();

    const subagentStart = lineages.find((entry) => entry.kind === 'agent/start')!;
    expect(value(subagentStart.lineage)).toMatchObject({
      conversation: 'aca96ce761c9f0cea',
      depth: 1,
      parent: root,
      resolution: 'registry',
      root,
      subagent: { id: 'aca96ce761c9f0cea', toolCallId: 'toolu_mock_5', type: 'general-purpose' },
    });

    const nestedStart = lineages.filter((entry) => entry.kind === 'agent/start')[1]!;
    expect(value(nestedStart.lineage)).toMatchObject({
      conversation: 'ac093bdad0566ffa7',
      depth: 2,
      parent: 'aca96ce761c9f0cea',
      root,
      subagent: { toolCallId: 'toolu_mock_10' },
    });

    const nestedTool = lineages.find((entry) => entry.kind === 'tool/before' && entry.native?.['agent_id'] === 'ac093bdad0566ffa7')!;
    expect(value(nestedTool.lineage)).toMatchObject({ conversation: 'ac093bdad0566ffa7', depth: 2, parent: 'aca96ce761c9f0cea', root });

    // The MCP probe call carries claudecode/toolUseId, which names the open PreToolUse.
    const probes = lineages.filter((entry) => entry.kind === 'mcp:probe');
    expect(probes.map((entry) => value(entry.lineage).depth)).toEqual([0, 1, 2]);
    expect(value(probes[1]!.lineage)).toMatchObject({ conversation: 'aca96ce761c9f0cea', resolution: 'registry' });

    const snapshot = registry.snapshot();
    expect(Object.values(snapshot.nodes).filter((node) => node.stoppedAt !== undefined).map((node) => node.id).sort())
      .toEqual(['ac093bdad0566ffa7', 'aca96ce761c9f0cea']);
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
    const first = createAgentLineageRegistry({ store });
    await replay('claude', fixture('claude-2.1.257.ndjson').slice(0, 12), first);
    const second = createAgentLineageRegistry({ store });
    const lineage = await second.observe({
      event: 'tool/before',
      host: 'claude',
      idempotencyKey: 'rehydrated',
      native: { agent_id: 'aca96ce761c9f0cea', hook_event_name: 'PreToolUse', session_id: 'a7f96472-e9d0-447a-826d-36da9b635fd6', tool_name: 'Bash', tool_use_id: 'later' },
    });
    expect(value(lineage)).toMatchObject({ conversation: 'aca96ce761c9f0cea', depth: 1, parent: 'a7f96472-e9d0-447a-826d-36da9b635fd6' });
    await store.close();
    await driver.close();
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
    expect(registry.resolveToolCall({ host: 'cursor', toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
    expect(registry.resolveToolCall({ host: undefined, toolName: 'dump' })).toEqual(unavailable('id-not-resolvable'));
  });

  it('standalone hooks state only what the payload proves', () => {
    expect(resolveNativeLineage('claude', { session_id: 'root' })).toMatchObject({ state: 'available', value: { conversation: 'root', depth: 0, root: 'root' } });
    expect(resolveNativeLineage('claude', { agent_id: 'child', session_id: 'root' })).toEqual(unavailable('no-shared-runtime'));
    expect(resolveNativeLineage('cursor', { conversation_id: 'c' })).toEqual(unavailable('no-shared-runtime'));
  });
});
