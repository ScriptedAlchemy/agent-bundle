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
  /**
   * Digest of the Cursor `workspace_roots` the node was seen in. A pending
   * child only binds to a conversation from the same workspace, so two
   * windows sharing one durable registry never bind each other's children.
   */
  workspace: id.optional(),
}).strict();

/** A pre-tool hook whose post-tool hook has not fired: the correlation window for MCP calls and spawns. */
export const OpenToolCallSchema = z.object({
  conversation: id,
  /** The carrier's turn-shaped id when the window opened (Cursor `generation_id`, Codex `turn_id`, Claude `prompt_id`). */
  generation: id.optional(),
  openedAt: timestamp,
  /** The root the conversation belonged to when the window opened, so retirement finds it even after its node is pruned. */
  root: id.optional(),
  toolCallId: id,
  toolName: id,
  /** A sibling of this spawn was already claimed blind, so no later start can be matched to it with certainty. */
  uncertain: z.boolean().optional(),
}).strict();

export const LineageStateSchema = z.object({
  /** Keyed by node id. */
  nodes: z.record(id, LineageNodeSchema),
  openCalls: z.array(OpenToolCallSchema),
  /** Cursor subagent ids whose child conversation has not been observed yet, oldest first. */
  pendingChildren: z.array(id),
  /**
   * Every start identity ever registered (agent ids, Cursor subagent ids and
   * bound conversations), newest last and bounded, so a redelivered start is
   * recognized even after its node was pruned.
   */
  seenStarts: z.array(id),
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
  /**
   * A conversation bound blind to a pending Cursor child later carried a
   * user-only event (`beforeSubmitPrompt`): it was a root whose prompt the
   * registry never saw. The node returns to its subagent id and waits again.
   */
  childUnbound: z.object({ conversation: id, subagentId: id }).strict(),
  nodeStarted: LineageNodeSchema,
  nodeStopped: z.object({ id, stoppedAt: timestamp }).strict(),
  /** A finished session releases its correlation windows and pending spawns. */
  sessionRetired: z.object({ root: id }).strict(),
  /** A subagent start consumed the spawn call that produced it; `siblingsUncertain` marks the cohort it was picked from. */
  spawnClaimed: z.object({ siblingsUncertain: z.boolean().optional(), toolCallId: id }).strict(),
  /** A spawn call failed before any child started, so no later start may claim it. */
  spawnFailed: z.object({ toolCallId: id }).strict(),
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
/** Start identities remembered for replay detection after their nodes are pruned. */
export const LINEAGE_SEEN_START_RETENTION = 4096;

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
  seenStarts: [],
});

const remember = (seen: readonly string[], ids: readonly string[]): string[] => {
  const next = [...seen.filter((known) => !ids.includes(known)), ...ids];
  return next.length > LINEAGE_SEEN_START_RETENTION ? next.slice(next.length - LINEAGE_SEEN_START_RETENTION) : next;
};

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
        seenStarts: node.depth === 0 ? state.seenStarts : remember(state.seenStarts, [node.id]),
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
        seenStarts: remember(state.seenStarts, [conversation]),
      };
    }
    case 'childUnbound': {
      const { conversation, subagentId } = event.payload as { conversation: string; subagentId: string };
      const bound = state.nodes[conversation];
      if (bound === undefined || bound.subagentId !== subagentId || state.nodes[subagentId] !== undefined) return state;
      const { [conversation]: _moved, ...rest } = state.nodes;
      return {
        ...state,
        nodes: { ...rest, [subagentId]: { ...bound, id: subagentId } },
        // A child whose stop already arrived stays a finished, never-bound
        // node; a live one waits for its real conversation again.
        pendingChildren: bound.stoppedAt === undefined
          ? [subagentId, ...state.pendingChildren.filter((candidate) => candidate !== subagentId)]
          : state.pendingChildren,
        seenStarts: state.seenStarts.filter((known) => known !== conversation),
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
      const { siblingsUncertain, toolCallId } = event.payload as { siblingsUncertain?: boolean; toolCallId: string };
      const claimed = state.pendingSpawns.find((open) => open.toolCallId === toolCallId);
      return {
        ...state,
        pendingSpawns: state.pendingSpawns
          .filter((open) => open.toolCallId !== toolCallId)
          .map((open) => siblingsUncertain === true && claimed !== undefined && open.conversation === claimed.conversation
            ? { ...open, uncertain: true }
            : open),
      };
    }
    case 'spawnFailed': {
      const { toolCallId } = event.payload as { toolCallId: string };
      return { ...state, pendingSpawns: state.pendingSpawns.filter((open) => open.toolCallId !== toolCallId) };
    }
    case 'sessionRetired': {
      const { root } = event.payload as { root: string };
      const retired = new Set(
        Object.values(state.nodes).filter((node) => node.root === root).map((node) => node.id).concat(root),
      );
      const belongs = (open: OpenToolCall): boolean => open.root === root || retired.has(open.conversation);
      return {
        ...state,
        openCalls: state.openCalls.filter((open) => !belongs(open)),
        pendingChildren: state.pendingChildren.filter((pending) => !retired.has(pending)),
        pendingSpawns: state.pendingSpawns.filter((open) => !belongs(open)),
      };
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
  // The journal is append-only for the life of an install; the revision cap is
  // raised well past the kernel default and the registry degrades to memory
  // (never to a stale head) once any durable commit fails.
  budgets: { maxRevisions: 5_000_000, maxStateBytes: 4 * 1_048_576 },
  events: lineageEventSchemas,
  id: AGENT_LINEAGE_STATE_ID,
  initial: initialLineageState,
  lifetime,
  reduce: (state, event) => reduceLineage(state, event),
  schema: LineageStateSchema,
  version: 1,
});
