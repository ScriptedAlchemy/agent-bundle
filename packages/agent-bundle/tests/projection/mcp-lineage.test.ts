import { describe, expect, it } from '@rstest/core';
import { createAgentLineageRegistry } from '@agent-bundle/runtime/lineage';
import { openInMemoryMcpServer } from '../../src/test/mcp.ts';

const root = 'session-root';
const child = 'agent-child';

const observe = (
  registry: ReturnType<typeof createAgentLineageRegistry>,
  event: string,
  native: Record<string, unknown>,
) => registry.observe({ event, host: 'claude', idempotencyKey: `${event}:${JSON.stringify(native)}`, native });

const callContext = async (
  registry: ReturnType<typeof createAgentLineageRegistry>,
  meta: Record<string, unknown> | undefined,
) => {
  await using session = await openInMemoryMcpServer({ lineage: registry, lineageHost: 'claude' });
  const result = await session.client.callTool({
    ...(meta === undefined ? {} : { _meta: meta }),
    arguments: {},
    name: 'context',
  });
  return (result.structuredContent as { lineage: unknown }).lineage;
};

/**
 * The generated MCP server and the hook wrappers share one runtime-held
 * registry; this level proves the hook→MCP ordering contract observed live
 * on 2026-09-03 (pre-tool hook, then tools/call, then post-tool hook) without
 * a spawned process.
 */
describe('generated MCP tool calls resolve request.lineage through the runtime registry (mcp-in-memory)', () => {
  it('is unresolvable before any pre-tool hook opened the window', async () => {
    const registry = createAgentLineageRegistry();
    expect(await callContext(registry, { 'claudecode/toolUseId': 'toolu_1' })).toEqual({
      reason: 'id-not-resolvable',
      state: 'unavailable',
    });
  });

  it('resolves a root call from claudecode/toolUseId while the PreToolUse window is open, then closes with PostToolUse', async () => {
    const registry = createAgentLineageRegistry();
    await observe(registry, 'session/start', { hook_event_name: 'SessionStart', session_id: root });
    await observe(registry, 'tool/before', {
      hook_event_name: 'PreToolUse',
      session_id: root,
      tool_input: {},
      tool_name: 'mcp__plugin_harness_harness__context',
      tool_use_id: 'toolu_1',
    });

    expect(await callContext(registry, { 'claudecode/toolUseId': 'toolu_1' })).toEqual({
      source: 'derived',
      state: 'available',
      // The live tree rides along (#457): the root is alone so far.
      value: { conversation: root, depth: 0, resolution: 'registry', root, tree: { children: [], roots: [], siblings: [] } },
    });

    await observe(registry, 'tool/after', {
      hook_event_name: 'PostToolUse',
      session_id: root,
      tool_input: {},
      tool_name: 'mcp__plugin_harness_harness__context',
      tool_response: [{ text: 'ok', type: 'text' }],
      tool_use_id: 'toolu_1',
    });
    expect(await callContext(registry, { 'claudecode/toolUseId': 'toolu_1' })).toEqual({
      reason: 'id-not-resolvable',
      state: 'unavailable',
    });
  });

  it('places a subagent call under its parent using the registry fed by SubagentStart', async () => {
    const registry = createAgentLineageRegistry();
    await observe(registry, 'session/start', { hook_event_name: 'SessionStart', session_id: root });
    await observe(registry, 'tool/before', {
      hook_event_name: 'PreToolUse', session_id: root, tool_input: {}, tool_name: 'Agent', tool_use_id: 'toolu_spawn',
    });
    await observe(registry, 'agent/start', {
      agent_id: child, agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: root,
    });
    await observe(registry, 'tool/before', {
      agent_id: child,
      agent_type: 'general-purpose',
      hook_event_name: 'PreToolUse',
      session_id: root,
      tool_input: {},
      tool_name: 'mcp__plugin_harness_harness__context',
      tool_use_id: 'toolu_child_call',
    });

    // Without _meta (Cursor-shaped), the most recent open pre-tool hook naming the tool wins.
    expect(await callContext(registry, undefined)).toEqual({
      source: 'derived',
      state: 'available',
      value: {
        conversation: child,
        depth: 1,
        parent: root,
        resolution: 'inferred',
        root,
        subagent: { id: child, toolCallId: 'toolu_spawn', type: 'general-purpose' },
        // The child sees its root as the one other live node under the same root (#457).
        tree: { children: [], roots: [], siblings: [{ conversation: root, depth: 0, resolution: 'native', startedAt: expect.any(String) }] },
      },
    });
    expect(await callContext(registry, { 'claudecode/toolUseId': 'toolu_child_call' })).toMatchObject({
      value: { conversation: child, depth: 1, resolution: 'registry' },
    });

    // The root's `Agent` PostToolUse names the child it produced
    // (`tool_response.agentId`, Claude Code 2.1.257): the edge the registry
    // matched is now the host's own, and the same call resolves as confirmed.
    await observe(registry, 'tool/after', {
      hook_event_name: 'PostToolUse',
      session_id: root,
      tool_input: {},
      tool_name: 'Agent',
      tool_response: { agentId: child, isAsync: true, status: 'async_launched' },
      tool_use_id: 'toolu_spawn',
    });
    expect(await callContext(registry, { 'claudecode/toolUseId': 'toolu_child_call' })).toMatchObject({
      source: 'derived',
      value: { conversation: child, depth: 1, parent: root, resolution: 'confirmed', subagent: { toolCallId: 'toolu_spawn' } },
    });
  });

  it('leaves the axis honestly absent when the session has no registry', async () => {
    await using session = await openInMemoryMcpServer();
    const result = await session.client.callTool({ arguments: {}, name: 'context' });
    expect((result.structuredContent as { lineage: unknown }).lineage).toEqual({ reason: 'not-provided', state: 'unavailable' });
  });
});
