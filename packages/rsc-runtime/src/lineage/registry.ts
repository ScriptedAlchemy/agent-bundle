import { createHash } from 'node:crypto';

import {
  available,
  unavailable,
  type AgentLineage,
  type AgentLineageResolution,
  type Observed,
} from '../agent-request.js';
import { lineageCarrier, type LineageHost } from '../lineage-native.js';
import { AgentStateError, type AgentStateStore } from '../state/contract.js';
import { canonicalJson } from '../state/index.js';
import {
  initialLineageState,
  reduceLineage,
  type LineageEvents,
  type LineageNode,
  type LineageState,
  type OpenToolCall,
} from './state.js';

/** The canonical event families the registry reacts to; every other family only resolves. */
export type LineageEventFamily =
  | 'agent/start'
  | 'agent/stop'
  | 'tool/before'
  | 'tool/after'
  | 'tool/failure'
  | (string & {});

export interface LineageObservation {
  readonly event: LineageEventFamily;
  readonly host: LineageHost;
  /** Caller-owned dedupe identity for the durable journal (the canonical event idempotency key). */
  readonly idempotencyKey: string;
  readonly native: Readonly<Record<string, unknown>>;
  readonly observedAt?: string;
}

export interface LineageToolCallQuery {
  readonly host: LineageHost | undefined;
  /** The MCP request `_meta`, when the transport supplied one. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /** The protocol tool name the server registered (`dump`), never the host-prefixed spelling. */
  readonly toolName: string;
}

export interface AgentLineageRegistry {
  /** Feeds the registry with one hook event and resolves the lineage of the conversation that carried it. */
  observe(observation: LineageObservation): Promise<Observed<AgentLineage>>;
  /**
   * Resolves the lineage of an MCP tool call from `_meta` or from the open
   * pre-tool hook window. A durable registry re-reads its journal first, so a
   * generated server that hosts no event routes still sees what the event-host
   * server recorded.
   */
  resolveToolCall(query: LineageToolCallQuery): Promise<Observed<AgentLineage>>;
  /** The current tree, for dumps and the Workbench. */
  snapshot(): LineageState;
}

export interface CreateAgentLineageRegistryOptions {
  /** Durable journal; omitted registries live only in memory. */
  readonly store?: AgentStateStore<LineageState, LineageEvents>;
}

const nativeString = (native: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = native[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/**
 * The hosts' own subagent-spawning tools, by exact native spelling (observed
 * 2026-09-03: Claude `Agent`, Codex `collaborationspawn_agent`, Cursor
 * `Task`). MCP tools are prefixed (`mcp__…`) and never match.
 */
const SPAWN_TOOLS: Readonly<Record<LineageHost, (toolName: string) => boolean>> = Object.freeze({
  claude: (toolName) => toolName === 'Agent' || toolName === 'Task',
  codex: (toolName) => toolName === 'collaborationspawn_agent' || toolName === 'spawn_agent',
  cursor: (toolName) => toolName === 'Task',
});

/** The host named the child a spawn call produced, on the spawn's own post-tool hook. */
interface SpawnConfirmation {
  readonly child: string;
  /** The host reports the child already finished (Claude foreground `Agent`: `status: "completed"`). */
  readonly completed: boolean;
}

/**
 * Which spawn post-tool payloads name their child. Claude's `Agent`
 * PostToolUse (hooks reference, "PostToolUse") returns `tool_response.agentId`
 * — the same id the child's own `SubagentStart`/`SubagentStop` and every hook
 * it fires carry as `agent_id` — beside `status: "async_launched"` for a
 * background agent still running or `status: "completed"` for a foreground
 * one that already stopped (captured 2026-09-03, Claude Code 2.1.257). Codex
 * and Cursor spawn responses name no child.
 */
const SPAWN_CONFIRMATIONS: Readonly<Record<LineageHost, (native: Readonly<Record<string, unknown>>) => SpawnConfirmation | undefined>> = Object.freeze({
  claude: (native) => {
    const response = native['tool_response'];
    if (response === null || typeof response !== 'object' || Array.isArray(response)) return undefined;
    const record = response as Readonly<Record<string, unknown>>;
    const child = nativeString(record, 'agentId');
    return child === undefined ? undefined : { child, completed: record['status'] === 'completed' };
  },
  codex: () => undefined,
  cursor: () => undefined,
});

/**
 * Cursor events only the user-facing conversation emits; a subagent's
 * conversation never carries them. Observed on a conversation the registry
 * bound blind to a pending child, one proves the binding wrong.
 */
const CURSOR_ROOT_EVENTS: ReadonlySet<string> = new Set([
  'session/start',
  'session/end',
  'prompt/submit',
  'stop',
  'compact/before',
  'compact/after',
  'workspace/open',
]);


/**
 * A digest of the Cursor `workspace_roots` on a payload. Every Cursor hook
 * carries it (observed 2026-09-03 on CLI and desktop), and a subagent runs in
 * its parent's workspace, so a pending child never binds across workspaces.
 */
const cursorWorkspace = (native: Readonly<Record<string, unknown>>): string | undefined => {
  const roots = native['workspace_roots'];
  if (!Array.isArray(roots)) return undefined;
  const paths = roots.filter((root): root is string => typeof root === 'string' && root.trim() !== '').sort();
  if (paths.length === 0) return undefined;
  return createHash('sha256').update(canonicalJson(paths), 'utf8').digest('hex').slice(0, 16);
};

/** An unknown workspace on either side matches: older Cursor builds that omit the roots keep the single-pending rule. */
const sameWorkspace = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined || left === right;

const lineageOf = (node: LineageNode, generation: string | undefined, resolution: AgentLineageResolution): AgentLineage => Object.freeze({
  conversation: node.id,
  depth: node.depth,
  ...(generation === undefined ? {} : { generation }),
  ...(node.parent === undefined ? {} : { parent: node.parent }),
  resolution,
  root: node.root,
  ...(node.depth === 0
    ? {}
    : {
        subagent: Object.freeze({
          id: node.subagentId ?? node.id,
          ...(node.isParallelWorker === undefined ? {} : { isParallelWorker: node.isParallelWorker }),
          ...(node.toolCallId === undefined ? {} : { toolCallId: node.toolCallId }),
          ...(node.type === undefined ? {} : { type: node.type }),
        }),
      }),
});

/**
 * Deterministic journal keys for one observation: the caller's key, the event
 * name, and a digest of the canonical payload. A duplicate delivery produces
 * the same payloads and therefore the same keys, whatever the registry already
 * knew when it arrived.
 */
interface JournalKeys {
  next(name: keyof LineageEvents, payload: unknown): string;
}

const RECEIPT_TIMESTAMPS = new Set(['at', 'openedAt', 'startedAt', 'stoppedAt']);
/** Journal keys a storeless registry remembers to suppress redeliveries. */
const APPLIED_KEY_RETENTION = 4096;

/** Receipt timestamps are regenerated per delivery, so they stay out of the replay identity. */
const replayIdentity = (payload: unknown): string => canonicalJson(
  payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => !RECEIPT_TIMESTAMPS.has(key)))
    : payload,
);

const journalKeys = (idempotencyKey: string): JournalKeys => ({
  next(name, payload) {
    const digest = createHash('sha256').update(replayIdentity(payload), 'utf8').digest('hex').slice(0, 16);
    return `lineage:${idempotencyKey}:${name}:${digest}`;
  },
});

const rootNode = (
  conversation: string,
  generation: string | undefined,
  startedAt: string,
  workspace: string | undefined,
): LineageNode => ({
  depth: 0,
  ...(generation === undefined ? {} : { generation }),
  id: conversation,
  root: conversation,
  startedAt,
  ...(workspace === undefined ? {} : { workspace }),
});

export const createAgentLineageRegistry = (
  options: CreateAgentLineageRegistryOptions = {},
): AgentLineageRegistry => {
  const { store } = options;
  let state: LineageState = initialLineageState;
  let hydration: Promise<void> | undefined;
  const applied = new Set<string>();
  /**
   * Once a durable commit fails for any reason other than a redelivery, the
   * journal head no longer describes what this registry knows; it stays in
   * memory from then on so a later re-read cannot erase local mutations.
   */
  let degraded = false;
  const journal = (): AgentStateStore<LineageState, LineageEvents> | undefined => (degraded ? undefined : store);

  /** One shared initial read: concurrent observations all wait for it, none mutates the empty state first. */
  const hydrate = (): Promise<void> => {
    if (store === undefined) return Promise.resolve();
    hydration ??= (async () => {
      try {
        state = (await store.read()).state;
      } catch {
        // An unreadable journal degrades to in-memory tracking for good.
        degraded = true;
      }
    })();
    return hydration;
  };

  /**
   * Journal keys derive from the caller's idempotency key plus the mutation's
   * canonical payload, so a host that delivers the same event twice (Cursor
   * repeats some `preToolUse` payloads) replays the same committed journal
   * entries instead of appending fresh ones. A replayed commit reports the
   * historical snapshot, so the head is re-read instead of rewinding the
   * in-memory tree to it.
   */
  const dispatch = async <TName extends keyof LineageEvents>(
    name: TName,
    payload: Parameters<typeof reduceLineage>[1]['payload'],
    keys: JournalKeys,
  ): Promise<void> => {
    const idempotencyKey = keys.next(name, payload);
    // Every key this registry has applied — durably or in memory — lands in
    // one bounded ledger, so a redelivery is still suppressed after the
    // journal degrades mid-session (the durable head is no longer consulted).
    if (applied.has(idempotencyKey)) return;
    const remember = (): void => {
      applied.add(idempotencyKey);
      if (applied.size > APPLIED_KEY_RETENTION) applied.delete(applied.values().next().value!);
    };
    const target = journal();
    if (target === undefined) {
      remember();
      state = reduceLineage(state, { name, payload });
      return;
    }
    try {
      const committed = await target.dispatch(name, payload as never, { idempotencyKey });
      remember();
      state = committed.replayed ? (await target.read()).state : committed.state;
    } catch (error) {
      // The same key with a payload that differs only in what the digest
      // ignores (a receipt timestamp) is a redelivery, not a new fact.
      if (error instanceof AgentStateError && error.code === 'idempotency-conflict') {
        remember();
        try {
          state = (await target.read()).state;
        } catch {
          // Keep the head we already hold.
        }
        return;
      }
      degraded = true;
      remember();
      state = reduceLineage(state, { name, payload });
    }
  };

  const nodeFor = (conversation: string | undefined): LineageNode | undefined =>
    conversation === undefined ? undefined : state.nodes[conversation];

  /**
   * Every edge from the node to its root was named by the host, so nothing in
   * its `parent`/`root`/`depth` rests on the spawn-window inference any more.
   * A root has no edge and is never "confirmed"; it resolves natively.
   */
  const chainConfirmed = (node: LineageNode): boolean => {
    if (node.depth === 0) return false;
    let current: LineageNode | undefined = node;
    for (let hops = 0; current !== undefined && current.depth > 0 && hops <= Object.keys(state.nodes).length; hops += 1) {
      if (current.confirmed !== true) return false;
      current = nodeFor(current.parent);
    }
    return current !== undefined && current.depth === 0;
  };

  /** The non-native resolution for a subagent node: the host-named edge chain, or the registry's own match. */
  const registryResolution = (node: LineageNode, fallback: AgentLineageResolution): AgentLineageResolution =>
    fallback === 'registry' && chainConfirmed(node) ? 'confirmed' : fallback;

  /**
   * The spawn call that produced the subagent starting now: the most recent
   * unclaimed one *under the same root*, so two sessions sharing one durable
   * registry never claim each other's spawns. Claude keeps the call open
   * across `SubagentStart`; Codex closes it first, so the claim window is
   * independent of `openCalls`.
   */
  type SpawnClaim =
    | { readonly kind: 'ambiguous' }
    | { readonly kind: 'claimed'; readonly call: OpenToolCall; readonly toolCallIdCertain: boolean }
    | { readonly kind: 'none' };

  const claimSpawn = async (host: LineageHost, root: string, keys: JournalKeys): Promise<SpawnClaim> => {
    const spawn = SPAWN_TOOLS[host];
    const candidates = state.pendingSpawns.filter((call) =>
      spawn(call.toolName) && (nodeFor(call.conversation)?.root ?? call.conversation) === root);
    if (candidates.length === 0) return { kind: 'none' };
    // Several unclaimed spawns from different parents under one root: the
    // start payload carries nothing to pick between them, so no guess.
    if (new Set(candidates.map((call) => call.conversation)).size > 1) return { kind: 'ambiguous' };
    const call = candidates[candidates.length - 1]!;
    // One of several same-parent spawns is picked blind; the whole cohort,
    // including the last one left, then stays uncertain.
    const cohort = candidates.length > 1;
    await dispatch('spawnClaimed', { ...(cohort ? { siblingsUncertain: true } : {}), toolCallId: call.toolCallId }, keys);
    return { call, kind: 'claimed', toolCallIdCertain: !cohort && call.uncertain !== true };
  };

  /**
   * The node for a conversation that speaks for itself, creating it when it is
   * new. A never-seen Cursor conversation while exactly one `subagentStart` is
   * pending *in its workspace* is that child speaking for the first time; with
   * several pending children the child payload carries nothing to tell them
   * apart, so the conversation stays unresolved rather than being bound
   * arbitrarily.
   */
  const ensureRoot = async (
    host: LineageHost,
    conversation: string,
    generation: string | undefined,
    observedAt: string,
    keys: JournalKeys,
    allowRoot: boolean,
    workspace: string | undefined,
  ): Promise<LineageNode | undefined> => {
    const existing = state.nodes[conversation];
    if (existing !== undefined) return existing;
    // A root-shaped event is a root: it never binds to a pending child, so an
    // unrelated conversation starting beside a pending spawn stays its own root.
    if (allowRoot) {
      const node = rootNode(conversation, generation, observedAt, workspace);
      await dispatch('nodeStarted', node, keys);
      return node;
    }
    if (host === 'cursor') {
      const pending = state.pendingChildren.filter((subagentId) => sameWorkspace(state.nodes[subagentId]?.workspace, workspace));
      if (pending.length === 1) {
        await dispatch('childBound', { conversation, subagentId: pending[0]! }, keys);
        return state.nodes[conversation];
      }
    }
    // No single pending start and not root-shaped: a Cursor child's tool event
    // after a registry restart carries nothing that distinguishes it from a root.
    return undefined;
  };

  /**
   * A conversation bound blind to a pending Cursor child that now carries a
   * root-only event was a root all along (its prompt predates the registry, or
   * Cursor never delivered it). The child returns to pending, anything started
   * beneath the conversation is re-rooted under it, and the conversation
   * becomes the root it is.
   */
  const correctMisboundChild = async (
    conversation: string,
    observedAt: string,
    keys: JournalKeys,
  ): Promise<void> => {
    const node = state.nodes[conversation];
    if (node === undefined || node.depth === 0 || node.subagentId === undefined) return;
    await dispatch('childUnbound', { conversation, subagentId: node.subagentId }, keys);
    // Materialize the root at once — the bound node carried the conversation's
    // generation, workspace and first-seen time — so the correcting event
    // resolves against it like any known root's would, including a
    // `session/end`, which then retires this node instead of finding none.
    await dispatch('nodeStarted', rootNode(conversation, node.generation, node.startedAt, node.workspace), keys);
  };

  const resolve = (
    host: LineageHost,
    native: Readonly<Record<string, unknown>>,
    fallback: AgentLineageResolution,
  ): Observed<AgentLineage> => {
    const carrier = lineageCarrier(host, native);
    if (carrier.conversation === undefined) return unavailable('id-not-resolvable');
    const node = nodeFor(carrier.conversation);
    if (node === undefined) return unavailable('id-not-resolvable');
    const resolution: AgentLineageResolution = node.depth === 0 && (host !== 'cursor' || state.pendingChildren.length === 0)
      ? 'native'
      : registryResolution(node, fallback);
    return available(lineageOf(node, carrier.generation, resolution), resolution === 'native' ? 'native' : 'derived');
  };

  const observeStart = async (observation: LineageObservation, observedAt: string, keys: JournalKeys): Promise<void> => {
    const { host, native } = observation;
    const carrier = lineageCarrier(host, native);
    if (host === 'cursor') {
      const subagentId = nativeString(native, 'subagent_id') ?? nativeString(native, 'tool_call_id');
      const parentId = nativeString(native, 'parent_conversation_id') ?? carrier.conversation;
      if (subagentId === undefined || parentId === undefined) return;
      // A replayed start already registered (or bound) this child, even if its node was pruned since.
      if (state.seenStarts.includes(subagentId) || state.nodes[subagentId] !== undefined || Object.values(state.nodes).some((node) => node.subagentId === subagentId)) return;
      const workspace = cursorWorkspace(native);
      const parent = await ensureRoot(host, parentId, undefined, observedAt, keys, false, workspace);
      if (parent === undefined) return;
      await dispatch('nodeStarted', {
        depth: parent.depth + 1,
        id: subagentId,
        ...(native['is_parallel_worker'] === undefined ? {} : { isParallelWorker: native['is_parallel_worker'] === true }),
        parent: parent.id,
        root: parent.root,
        startedAt: observedAt,
        subagentId,
        ...(nativeString(native, 'tool_call_id') === undefined ? {} : { toolCallId: nativeString(native, 'tool_call_id')! }),
        ...(nativeString(native, 'subagent_type') === undefined ? {} : { type: nativeString(native, 'subagent_type')! }),
        ...(workspace === undefined ? {} : { workspace }),
      }, keys);
      return;
    }
    const agentId = nativeString(native, 'agent_id');
    const root = carrier.root;
    if (agentId === undefined || root === undefined) return;
    // A replayed start must not claim a second spawn or rewrite the node — even
    // after retention pruned the node, the start identity is remembered.
    if (state.seenStarts.includes(agentId)) return;
    const materialized = state.nodes[agentId];
    if (materialized !== undefined) {
      // The host confirmed the spawn before the child's start arrived (Claude
      // fires a background `Agent` PostToolUse ahead of `SubagentStart`): the
      // node exists by the host's word; the start adds what only it carries.
      if (materialized.depth === 0) return;
      await dispatch('nodeStarted', {
        ...materialized,
        ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
        startedAt: observedAt,
        ...(nativeString(native, 'agent_type') === undefined ? {} : { type: nativeString(native, 'agent_type')! }),
      }, keys);
      return;
    }
    const rootNodeValue = await ensureRoot(host, root, undefined, observedAt, keys, true, undefined);
    if (rootNodeValue === undefined) return;
    const claim = await claimSpawn(host, rootNodeValue.root, keys);
    // No spawn to claim (the pre-tool hook was missed, or the registry
    // restarted), or several parents with one, proves nothing about the
    // parent: a nested agent would be misfiled under the root, so the start
    // stays unplaced until the host names its edge (Claude's `Agent`
    // PostToolUse), keeping what the start itself said.
    if (claim.kind !== 'claimed') {
      await dispatch('startUnplaced', {
        ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
        id: agentId,
        root: rootNodeValue.root,
        startedAt: observedAt,
        ...(nativeString(native, 'agent_type') === undefined ? {} : { type: nativeString(native, 'agent_type')! }),
      }, keys);
      return;
    }
    const parent = nodeFor(claim.call.conversation) ?? rootNodeValue;
    await dispatch('nodeStarted', {
      depth: parent.depth + 1,
      ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
      id: agentId,
      parent: parent.id,
      root: rootNodeValue.root,
      startedAt: observedAt,
      ...(claim.kind === 'claimed' && claim.toolCallIdCertain ? { toolCallId: claim.call.toolCallId } : {}),
      ...(nativeString(native, 'agent_type') === undefined ? {} : { type: nativeString(native, 'agent_type')! }),
    }, keys);
  };

  const observeStop = async (observation: LineageObservation, observedAt: string, keys: JournalKeys): Promise<void> => {
    const { host, native } = observation;
    const stopped = host === 'cursor'
      ? (() => {
          const subagentId = nativeString(native, 'subagent_id');
          if (subagentId === undefined) return undefined;
          if (state.nodes[subagentId] !== undefined) return subagentId;
          return Object.values(state.nodes).find((node) => node.subagentId === subagentId)?.id;
        })()
      : nativeString(native, 'agent_id');
    if (stopped === undefined) return;
    // A stop for a start still waiting on its edge is kept with that start, so
    // a late confirmation materializes an already-finished node.
    const unplaced = (state.unplacedStarts ?? []).some((start) => start.id === stopped);
    if (state.nodes[stopped] === undefined && !unplaced) return;
    await dispatch('nodeStopped', { id: stopped, stoppedAt: observedAt }, keys);
  };

  /** A finished session retires its root and every descendant still marked live, so roots never accumulate. */
  const observeSessionEnd = async (observation: LineageObservation, observedAt: string, keys: JournalKeys): Promise<void> => {
    const carrier = lineageCarrier(observation.host, observation.native);
    const rootId = observation.host === 'cursor' ? carrier.conversation : carrier.root;
    if (rootId === undefined) return;
    const rootNodeValue = state.nodes[rootId];
    const root = rootNodeValue?.root ?? rootId;
    const live = Object.values(state.nodes)
      .filter((node) => node.root === root && node.stoppedAt === undefined)
      .sort((left, right) => right.depth - left.depth);
    for (const node of live) {
      await dispatch('nodeStopped', { id: node.id, stoppedAt: observedAt }, keys);
    }
    await dispatch('sessionRetired', { root }, keys);
  };

  // Observations mutate the tree in several awaited steps (candidate selection,
  // claim, node start); running them one at a time keeps two concurrent hooks
  // from selecting the same spawn or binding the same pending child.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const observeSerialized = async (observation: LineageObservation): Promise<Observed<AgentLineage>> => {
    await hydrate();
    const keys = journalKeys(observation.idempotencyKey);
    const observedAt = observation.observedAt ?? new Date().toISOString();
    const { event, host, native } = observation;
    const carrier = lineageCarrier(host, native);
    // A Cursor conversation bound blind to a pending child cannot carry a
    // root-only event; one that does was a root the registry had not seen, so
    // the binding is undone before anything acts on the wrong tree — a
    // `session/end` must retire this conversation, not the parent it was
    // misfiled under.
    if (host === 'cursor' && CURSOR_ROOT_EVENTS.has(event) && carrier.conversation !== undefined) {
      await correctMisboundChild(carrier.conversation, observedAt, keys);
    }
    switch (event) {
      case 'agent/start':
        await observeStart(observation, observedAt, keys);
        break;
      case 'agent/stop':
        await observeStop(observation, observedAt, keys);
        break;
      case 'session/end':
        await observeSessionEnd(observation, observedAt, keys);
        break;
      default:
        break;
    }
    // Claude and Codex name the root on every payload; Cursor never repeats
    // it, so only root-shaped Cursor events may establish a root, and a
    // fresh child conversation binds to the single pending start in its
    // workspace. A session that ends before this registry saw it start leaves
    // no node behind: establishing one after retirement would never be pruned.
    if (event !== 'session/end' && carrier.conversation !== undefined && nodeFor(carrier.conversation) === undefined) {
      const rootLike = host === 'cursor'
        ? CURSOR_ROOT_EVENTS.has(event)
        : carrier.conversation === carrier.root;
      if (rootLike || host === 'cursor') {
        await ensureRoot(host, carrier.conversation, carrier.generation, observedAt, keys, rootLike, host === 'cursor' ? cursorWorkspace(native) : undefined);
      }
    }
    const toolCallId = nativeString(native, 'tool_use_id') ?? nativeString(native, 'tool_call_id');
    const toolName = nativeString(native, 'tool_name');
    // Correlation windows exist only for conversations the tree can place;
    // a window for an unplaceable carrier could never resolve and could not
    // be retired with its session.
    const carrierNode = carrier.conversation === undefined ? undefined : nodeFor(carrier.conversation);
    if (carrier.conversation !== undefined && carrierNode !== undefined && toolCallId !== undefined && toolName !== undefined) {
      if (event === 'tool/before') {
        await dispatch('toolCallOpened', {
          conversation: carrier.conversation,
          ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
          openedAt: observedAt,
          root: carrierNode.root,
          ...(SPAWN_TOOLS[host](toolName) ? { spawn: true } : {}),
          toolCallId,
          toolName,
        }, keys);
      } else if (event === 'tool/after' || event === 'tool/failure') {
        await dispatch('toolCallClosed', { conversation: carrier.conversation, toolCallId }, keys);
        // A spawn that failed produced no child; Codex closes a successful
        // spawn before SubagentStart, so only failure discards the claim.
        if (event === 'tool/failure' && SPAWN_TOOLS[host](toolName)) {
          await dispatch('spawnFailed', { toolCallId }, keys);
        }
      }
    }
    // The spawn's own post-tool hook names the child (Claude
    // `tool_response.agentId`): the carrier is the parent, by the host's word.
    // That places a start the claim window could not, confirms an edge it
    // matched, or moves one it matched wrong — the same event in every case,
    // so a redelivery is idempotent. A carrier that is itself an unplaced
    // start keeps the confirmation until its own edge is known.
    const confirmation = event === 'tool/after' && toolName !== undefined && SPAWN_TOOLS[host](toolName)
      ? SPAWN_CONFIRMATIONS[host](native)
      : undefined;
    if (
      confirmation !== undefined
      && carrier.conversation !== undefined
      && confirmation.child !== carrier.conversation
      && (carrierNode !== undefined || (state.unplacedStarts ?? []).some((start) => start.id === carrier.conversation))
    ) {
      await dispatch('spawnConfirmed', {
        at: observedAt,
        child: confirmation.child,
        ...(confirmation.completed ? { completed: true } : {}),
        parent: carrier.conversation,
        ...(toolCallId === undefined ? {} : { toolCallId }),
      }, keys);
    }
    return resolve(host, native, host === 'cursor' ? 'inferred' : 'registry');
  };

  const registry: AgentLineageRegistry = {
    observe(observation) {
      return serialized(() => observeSerialized(observation));
    },

    async resolveToolCall(query) {
      // Observations already accepted settle first, so a call that arrived
      // after its pre-tool hook sees that hook's window.
      await queue;
      await hydrate();
      const target = journal();
      if (target !== undefined) {
        // Another generated server of the same install may hold the event
        // routes; its journal is the shared truth.
        try {
          state = (await target.read()).state;
        } catch {
          // Keep the head already held.
        }
      }
      const { host, meta, toolName } = query;
      if (host === undefined) return unavailable('id-not-resolvable');
      if (host === 'codex') {
        const turn = meta?.['x-codex-turn-metadata'];
        if (turn !== null && typeof turn === 'object' && !Array.isArray(turn)) {
          const record = turn as Readonly<Record<string, unknown>>;
          const conversation = nativeString(record, 'thread_id');
          const root = nativeString(record, 'session_id');
          if (conversation !== undefined && root !== undefined) {
            const parent = nativeString(record, 'parent_thread_id');
            const known = nodeFor(conversation);
            const turnId = nativeString(record, 'turn_id');
            const subagentKind = nativeString(record, 'subagent_kind');
            // Codex names conversation, parent, and root but no depth: it is
            // known for a registered node, zero for a root, one for a direct
            // child of the root, and otherwise only through a registered parent.
            const parentDepth = parent === undefined ? undefined : parent === root ? 0 : nodeFor(parent)?.depth;
            const depth = known?.depth
              ?? (parent === undefined
                ? (conversation === root ? 0 : undefined)
                : parentDepth === undefined ? undefined : parentDepth + 1);
            if (depth === undefined) return unavailable('id-not-resolvable');
            const value: AgentLineage = {
              conversation,
              depth,
              ...(turnId === undefined ? {} : { generation: turnId }),
              ...(parent === undefined ? {} : { parent }),
              resolution: 'native',
              root,
              ...(parent === undefined
                ? {}
                : { subagent: { id: conversation, ...(subagentKind === undefined ? {} : { type: subagentKind }) } }),
            };
            return available(value, 'native');
          }
        }
      }
      let call: OpenToolCall | undefined;
      const claudeToolUseId = host === 'claude' ? nativeString(meta ?? {}, 'claudecode/toolUseId') : undefined;
      if (claudeToolUseId !== undefined) {
        // A native id that matches no open window is a miss, never a licence to guess by name.
        call = state.openCalls.find((open) => open.toolCallId === claudeToolUseId);
        if (call === undefined) return unavailable('id-not-resolvable');
      }
      if (call === undefined) {
        // The open pre-tool hooks naming this tool: `MCP:<tool>` on Cursor,
        // `mcp__<server>__<tool>` on Codex, `mcp__plugin_<p>_<s>__<tool>` on
        // Claude. Several from one conversation share a lineage; several from
        // different conversations cannot be told apart without `_meta`.
        const matches = state.openCalls.filter((candidate) =>
          candidate.toolName === `MCP:${toolName}`
          || candidate.toolName.endsWith(`__${toolName}`)
          || candidate.toolName === toolName);
        if (new Set(matches.map((candidate) => candidate.conversation)).size > 1) return unavailable('id-not-resolvable');
        call = matches[matches.length - 1];
      }
      if (call === undefined) return unavailable('id-not-resolvable');
      const node = nodeFor(call.conversation);
      if (node === undefined) return unavailable('id-not-resolvable');
      const resolution: AgentLineageResolution = claudeToolUseId !== undefined ? registryResolution(node, 'registry') : 'inferred';
      return available(lineageOf(node, call.generation, resolution), 'derived');
    },

    snapshot() {
      return state;
    },
  };
  return Object.freeze(registry);
};
