import { z } from 'zod';

import type { AgentStateLifetime } from '../state/contract.js';
import { defineState } from '../state/index.js';

const id = z.string().min(1).max(512);
const timestamp = z.string().min(1).max(64);

/** One conversation the runtime has seen start: the root, or a subagent below it. */
export const LineageNodeSchema = z.object({
  /**
   * The host later named this exact parent→child edge itself: on Claude the
   * parent's `Agent` PostToolUse carries the spawn `tool_use_id`, the caller's
   * `agent_id` (or none, for the root) and `tool_response.agentId`, the child.
   * Absent while the edge rests on the registry's spawn-window inference.
   */
  confirmed: z.boolean().optional(),
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
  /**
   * Digest of the pre-tool hook's `tool_input`. Every host delivers the MCP
   * call's arguments there (observed 2026-09-03: Cursor `MCP:probe`
   * `{"note":"subagent"}` arrived at the server as `note: "subagent"`), so a
   * call whose `_meta` names no conversation can still be told apart from a
   * concurrent call to the same tool with different arguments.
   */
  inputDigest: id.optional(),
  openedAt: timestamp,
  /** The root the conversation belonged to when the window opened, so retirement finds it even after its node is pruned. */
  root: id.optional(),
  toolCallId: id,
  toolName: id,
  /** A sibling of this spawn was already claimed blind, so no later start can be matched to it with certainty. */
  uncertain: z.boolean().optional(),
}).strict();

/**
 * A Claude/Codex `SubagentStart` the registry could not place: no spawn call
 * was claimable, or several parents had one. Its start facts are kept so a
 * later host confirmation of the edge (Claude's `Agent` PostToolUse naming the
 * child) materializes the node as it started, not as it was confirmed.
 */
/** The host named a spawn edge: `parent` produced `child` through `toolCallId` (see `spawnConfirmed`). */
export const SpawnConfirmationSchema = z.object({
  at: timestamp,
  child: id,
  completed: z.boolean().optional(),
  parent: id,
  toolCallId: id.optional(),
}).strict();

export const UnplacedStartSchema = z.object({
  /**
   * Edges this start confirmed for its own children while it was still
   * unplaced; applied the moment the start itself is placed, so a missed
   * spawn hook at one level does not lose the subtree beneath it.
   */
  confirmations: z.array(SpawnConfirmationSchema).optional(),
  generation: id.optional(),
  id,
  root: id,
  startedAt: timestamp,
  /** The child's stop arrived before its edge was known. */
  stoppedAt: timestamp.optional(),
  type: id.optional(),
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
  /**
   * Subagent starts awaiting a host confirmation of their edge, oldest first
   * and bounded. Optional so a journal head written before the field existed
   * still satisfies the schema.
   */
  unplacedStarts: z.array(UnplacedStartSchema).optional(),
}).strict();

export type LineageNode = z.output<typeof LineageNodeSchema>;
export type OpenToolCall = z.output<typeof OpenToolCallSchema>;
export type UnplacedStart = z.output<typeof UnplacedStartSchema>;
export type SpawnConfirmation = z.output<typeof SpawnConfirmationSchema>;
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
  /**
   * The host named a spawn edge itself (Claude: the parent's `Agent`
   * PostToolUse carries `tool_use_id`, the caller's identity and
   * `tool_response.agentId`). The child is placed under `parent`, moved there
   * if the spawn-window inference had bound it elsewhere, and marked
   * `confirmed`; a pending spawn call with that `toolCallId` is consumed.
   * `completed` says the child has already finished from the host's view.
   */
  spawnConfirmed: SpawnConfirmationSchema,
  /** A spawn call failed before any child started, so no later start may claim it. */
  spawnFailed: z.object({ toolCallId: id }).strict(),
  /** A subagent started but no single spawn call could be claimed for it; the edge waits for a host confirmation. */
  startUnplaced: UnplacedStartSchema,
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
/** Subagent starts awaiting a host confirmation of their edge are dropped past this count, oldest first. */
export const LINEAGE_UNPLACED_START_RETENTION = 64;

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

/** Ids of every node below `ancestor` (by parent edges) that shares its root; cycle-safe. */
const descendantsOf = (nodes: Record<string, LineageNode>, ancestor: string, root: string): Set<string> => {
  const descendants = new Set<string>();
  const descendsFrom = (node: LineageNode, hops = 0): boolean => {
    if (node.parent === ancestor) return true;
    if (node.parent === undefined || hops > Object.keys(nodes).length) return false;
    const parent = nodes[node.parent];
    return parent !== undefined && descendsFrom(parent, hops + 1);
  };
  for (const node of Object.values(nodes)) {
    if (node.id !== ancestor && node.root === root && descendsFrom(node)) descendants.add(node.id);
  }
  return descendants;
};

const trimUnplaced = (starts: readonly UnplacedStart[]): UnplacedStart[] =>
  starts.length > LINEAGE_UNPLACED_START_RETENTION
    ? starts.slice(starts.length - LINEAGE_UNPLACED_START_RETENTION)
    : [...starts];

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
      if (node === undefined) {
        // A child whose edge is still unknown finished; remember that so a
        // late confirmation materializes it as already stopped.
        const unplaced = state.unplacedStarts ?? [];
        return unplaced.some((start) => start.id === nodeId)
          ? { ...state, unplacedStarts: unplaced.map((start) => start.id === nodeId ? { ...start, stoppedAt } : start) }
          : state;
      }
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
      // Everything started beneath the misbound conversation belongs to the
      // root it is about to become: same shape, re-rooted, depth rebased.
      const descendants = descendantsOf(rest, conversation, bound.root);
      const rerooted = (node: LineageNode): LineageNode =>
        descendants.has(node.id) ? { ...node, depth: node.depth - bound.depth, root: conversation } : node;
      const rerootedCall = (call: OpenToolCall): OpenToolCall =>
        call.conversation === conversation || descendants.has(call.conversation) ? { ...call, root: conversation } : call;
      return {
        ...state,
        nodes: { ...Object.fromEntries(Object.entries(rest).map(([key, node]) => [key, rerooted(node)])), [subagentId]: { ...bound, id: subagentId } },
        openCalls: state.openCalls.map(rerootedCall),
        // A child whose stop already arrived stays a finished, never-bound
        // node; a live one waits for its real conversation again.
        pendingChildren: bound.stoppedAt === undefined
          ? [subagentId, ...state.pendingChildren.filter((candidate) => candidate !== subagentId)]
          : state.pendingChildren,
        pendingSpawns: state.pendingSpawns.map(rerootedCall),
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
    case 'startUnplaced': {
      const start = event.payload as UnplacedStart;
      const unplaced = (state.unplacedStarts ?? []).filter((waiting) => waiting.id !== start.id);
      return {
        ...state,
        seenStarts: remember(state.seenStarts, [start.id]),
        unplacedStarts: trimUnplaced([...unplaced, start]),
      };
    }
    case 'spawnConfirmed': {
      const confirmation = event.payload as SpawnConfirmation;
      const { at, child, completed, parent: parentId, toolCallId } = confirmation;
      const parent = state.nodes[parentId];
      const existing = state.nodes[child];
      if (child === parentId || existing?.depth === 0) return state;
      if (parent === undefined) {
        // The parent is itself waiting for its edge: keep the confirmation
        // with it, to apply the moment the parent is placed.
        const unplaced = state.unplacedStarts ?? [];
        if (!unplaced.some((start) => start.id === parentId)) return state;
        return {
          ...state,
          unplacedStarts: unplaced.map((start) => start.id === parentId
            ? { ...start, confirmations: [...(start.confirmations ?? []).filter((kept) => kept.child !== child), confirmation] }
            : start),
        };
      }
      // A root never becomes a child on a host's say-so, and no parent may be
      // made to descend from its own child; the confirmation is then noise.
      const descendants = existing === undefined ? new Set<string>() : descendantsOf(state.nodes, child, existing.root);
      if (descendants.has(parentId)) return state;
      const waiting = (state.unplacedStarts ?? []).find((start) => start.id === child);
      const stoppedAt = existing?.stoppedAt ?? waiting?.stoppedAt ?? (completed === true ? at : undefined);
      const base: LineageNode = existing ?? {
        depth: parent.depth + 1,
        id: child,
        root: parent.root,
        startedAt: waiting?.startedAt ?? at,
        ...(waiting?.generation === undefined ? {} : { generation: waiting.generation }),
        ...(waiting?.type === undefined ? {} : { type: waiting.type }),
      };
      const placed: LineageNode = {
        ...base,
        confirmed: true,
        depth: parent.depth + 1,
        parent: parentId,
        root: parent.root,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      };
      // Whatever already hangs below a moved child follows it: same shape,
      // depth rebased onto the confirmed parent, root updated.
      const shift = placed.depth - (existing?.depth ?? placed.depth);
      const moved = (node: LineageNode): LineageNode =>
        descendants.has(node.id) ? { ...node, depth: node.depth + shift, root: placed.root } : node;
      const movedCall = (call: OpenToolCall): OpenToolCall =>
        call.root !== placed.root && (call.conversation === child || descendants.has(call.conversation))
          ? { ...call, root: placed.root }
          : call;
      const placedState: LineageState = {
        ...state,
        nodes: pruneStopped({
          ...Object.fromEntries(Object.entries(state.nodes).map(([key, node]) => [key, moved(node)])),
          [child]: placed,
        }),
        openCalls: state.openCalls.map(movedCall),
        pendingSpawns: state.pendingSpawns
          .filter((open) => open.toolCallId !== toolCallId)
          .map(movedCall),
        // A child known only from the confirmation has not started from the
        // registry's view: its `SubagentStart`, when it arrives (Claude can
        // fire the spawn's PostToolUse first), still fills in what it says.
        seenStarts: existing === undefined && waiting === undefined ? state.seenStarts : remember(state.seenStarts, [child]),
        ...(waiting === undefined
          ? {}
          : { unplacedStarts: (state.unplacedStarts ?? []).filter((start) => start.id !== child) }),
      };
      // Edges the child confirmed for its own children while unplaced follow it into the tree.
      return (waiting?.confirmations ?? []).reduce(
        (next, kept) => reduceLineage(next, { name: 'spawnConfirmed', payload: kept }),
        placedState,
      );
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
        ...(state.unplacedStarts === undefined
          ? {}
          : { unplacedStarts: state.unplacedStarts.filter((start) => start.root !== root) }),
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
