import { z } from 'zod';

import type { AgentStateLifetime } from '../state/contract.js';
import { defineState } from '../state/index.js';

const id = z.string().min(1).max(512);
const timestamp = z.string().min(1).max(64);

/** One conversation the runtime has seen start: the root, or a subagent below it. */
export const LineageNodeSchema = z.object({
  /** Root is depth 0. */
  depth: z.number().int().nonnegative(),
  /** Codex `turn_id` / Claude `prompt_id` / Cursor `generation_id` at start, when present. */
  generation: id.optional(),
  /** The id the node is addressed by on this host (Claude/Codex `agent_id`, Cursor conversation id once bound). */
  id,
  isParallelWorker: z.boolean().optional(),
  parent: id.optional(),
  root: id,
  startedAt: timestamp,
  stoppedAt: timestamp.optional(),
  /** Cursor names the child by its spawning tool call before the child's conversation id is known. */
  subagentId: id.optional(),
  toolCallId: id.optional(),
  type: id.optional(),
}).strict();

/** A pre-tool hook whose post-tool hook has not fired: the correlation window for MCP calls and spawns. */
export const OpenToolCallSchema = z.object({
  conversation: id,
  openedAt: timestamp,
  toolCallId: id,
  toolName: id,
}).strict();

export const LineageStateSchema = z.object({
  /** Keyed by node id. */
  nodes: z.record(id, LineageNodeSchema),
  openCalls: z.array(OpenToolCallSchema),
  /** Cursor subagent ids whose child conversation has not been observed yet, oldest first. */
  pendingChildren: z.array(id),
  /**
   * Spawn tool calls (Claude `Agent`/`Task`, Codex `spawn_agent`) not yet
   * claimed by a subagent start. Kept apart from `openCalls` because Codex
   * closes the spawn call before `SubagentStart` fires.
   */
  pendingSpawns: z.array(OpenToolCallSchema),
}).strict();

export type LineageNode = z.output<typeof LineageNodeSchema>;
export type OpenToolCall = z.output<typeof OpenToolCallSchema>;
export type LineageState = z.output<typeof LineageStateSchema>;

export const lineageEventSchemas = {
  /** A Cursor child conversation is now known for a pending subagent id: the node moves to its conversation id. */
  childBound: z.object({ conversation: id, subagentId: id }).strict(),
  nodeStarted: LineageNodeSchema,
  nodeStopped: z.object({ id, stoppedAt: timestamp }).strict(),
  /** A subagent start consumed the spawn call that produced it. */
  spawnClaimed: z.object({ toolCallId: id }).strict(),
  toolCallClosed: z.object({ conversation: id, toolCallId: id }).strict(),
  toolCallOpened: OpenToolCallSchema.extend({ spawn: z.boolean().optional() }).strict(),
} as const;

export type LineageEvents = typeof lineageEventSchemas;

/** Stopped nodes retained after the tree is pruned; enough for a dump to explain a finished session. */
export const LINEAGE_STOPPED_RETENTION = 256;
/** Pre-tool hooks whose post-tool hook never arrived are dropped past this count, oldest first. */
export const LINEAGE_OPEN_CALL_RETENTION = 512;
/** Spawn calls no subagent start ever claimed are dropped past this count, oldest first. */
export const LINEAGE_PENDING_SPAWN_RETENTION = 64;

export const AGENT_LINEAGE_STATE_ID = '@agent-bundle/runtime/agent-lineage/v1';

const pruneStopped = (nodes: Record<string, LineageNode>): Record<string, LineageNode> => {
  const stopped = Object.values(nodes)
    .filter((node) => node.stoppedAt !== undefined)
    .sort((left, right) => (left.stoppedAt ?? '').localeCompare(right.stoppedAt ?? ''));
  if (stopped.length <= LINEAGE_STOPPED_RETENTION) return nodes;
  const evicted = new Set(stopped.slice(0, stopped.length - LINEAGE_STOPPED_RETENTION).map((node) => node.id));
  return Object.fromEntries(Object.entries(nodes).filter(([key]) => !evicted.has(key)));
};

export const initialLineageState: LineageState = Object.freeze({
  nodes: {},
  openCalls: [],
  pendingChildren: [],
  pendingSpawns: [],
});

export const reduceLineage = (
  state: LineageState,
  event: { readonly name: keyof LineageEvents; readonly payload: unknown },
): LineageState => {
  switch (event.name) {
    case 'nodeStarted': {
      const node = event.payload as LineageNode;
      const nodes = pruneStopped({ ...state.nodes, [node.id]: node });
      return {
        ...state,
        nodes,
        pendingChildren: node.subagentId !== undefined && node.subagentId === node.id
          ? [...state.pendingChildren.filter((pending) => pending !== node.id), node.id]
          : state.pendingChildren,
      };
    }
    case 'nodeStopped': {
      const { id: nodeId, stoppedAt } = event.payload as { id: string; stoppedAt: string };
      const node = state.nodes[nodeId];
      if (node === undefined) return state;
      return {
        ...state,
        nodes: pruneStopped({ ...state.nodes, [nodeId]: { ...node, stoppedAt } }),
        pendingChildren: state.pendingChildren.filter((pending) => pending !== nodeId),
      };
    }
    case 'childBound': {
      const { conversation, subagentId } = event.payload as { conversation: string; subagentId: string };
      const pending = state.nodes[subagentId];
      if (pending === undefined) return state;
      const { [subagentId]: _moved, ...rest } = state.nodes;
      return {
        ...state,
        nodes: { ...rest, [conversation]: { ...pending, id: conversation } },
        pendingChildren: state.pendingChildren.filter((candidate) => candidate !== subagentId),
      };
    }
    case 'toolCallOpened': {
      const { spawn, ...call } = event.payload as OpenToolCall & { readonly spawn?: boolean };
      const openCalls = [...state.openCalls.filter((open) => open.toolCallId !== call.toolCallId), call];
      const pendingSpawns = spawn === true
        ? [...state.pendingSpawns.filter((open) => open.toolCallId !== call.toolCallId), call]
        : state.pendingSpawns;
      return {
        ...state,
        openCalls: openCalls.length > LINEAGE_OPEN_CALL_RETENTION
          ? openCalls.slice(openCalls.length - LINEAGE_OPEN_CALL_RETENTION)
          : openCalls,
        pendingSpawns: pendingSpawns.length > LINEAGE_PENDING_SPAWN_RETENTION
          ? pendingSpawns.slice(pendingSpawns.length - LINEAGE_PENDING_SPAWN_RETENTION)
          : pendingSpawns,
      };
    }
    case 'toolCallClosed': {
      const { toolCallId } = event.payload as { conversation: string; toolCallId: string };
      return { ...state, openCalls: state.openCalls.filter((open) => open.toolCallId !== toolCallId) };
    }
    case 'spawnClaimed': {
      const { toolCallId } = event.payload as { toolCallId: string };
      return { ...state, pendingSpawns: state.pendingSpawns.filter((open) => open.toolCallId !== toolCallId) };
    }
    default: {
      const unreachable: never = event.name;
      throw new Error(`Unhandled lineage event ${String(unreachable)}`);
    }
  }
};

/**
 * The framework-owned durable registry definition. One per plugin install,
 * opened by the warm runtime beside the project's own state so a restart of
 * the MCP process mid-session does not forget which subagents are alive.
 */
export const agentLineageStateDefinition = (lifetime: AgentStateLifetime = 'workspace-durable') => defineState({
  budgets: { maxStateBytes: 4 * 1_048_576 },
  events: lineageEventSchemas,
  id: AGENT_LINEAGE_STATE_ID,
  initial: initialLineageState,
  lifetime,
  reduce: (state, event) => reduceLineage(state, event),
  schema: LineageStateSchema,
  version: 1,
});
