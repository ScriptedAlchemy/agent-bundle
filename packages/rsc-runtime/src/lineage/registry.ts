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
  /** Resolves the lineage of an MCP tool call from `_meta` or from the open pre-tool hook window. */
  resolveToolCall(query: LineageToolCallQuery): Observed<AgentLineage>;
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

const SPAWN_TOOLS: Readonly<Record<LineageHost, (toolName: string) => boolean>> = Object.freeze({
  claude: (toolName) => toolName === 'Agent' || toolName === 'Task',
  codex: (toolName) => toolName.endsWith('spawn_agent'),
  cursor: (toolName) => toolName === 'Task',
});

/** Cursor events only the user-facing conversation emits; a subagent's conversation never carries them. */
const CURSOR_ROOT_EVENTS: ReadonlySet<string> = new Set([
  'session/start',
  'session/end',
  'prompt/submit',
  'stop',
  'compact/before',
  'compact/after',
  'workspace/open',
]);

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

const RECEIPT_TIMESTAMPS = new Set(['openedAt', 'startedAt', 'stoppedAt']);

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

const rootNode = (conversation: string, generation: string | undefined, startedAt: string): LineageNode => ({
  depth: 0,
  ...(generation === undefined ? {} : { generation }),
  id: conversation,
  root: conversation,
  startedAt,
});

export const createAgentLineageRegistry = (
  options: CreateAgentLineageRegistryOptions = {},
): AgentLineageRegistry => {
  const { store } = options;
  let state: LineageState = initialLineageState;
  let hydration: Promise<void> | undefined;

  /** One shared initial read: concurrent observations all wait for it, none mutates the empty state first. */
  const hydrate = (): Promise<void> => {
    if (store === undefined) return Promise.resolve();
    hydration ??= (async () => {
      try {
        state = (await store.read()).state;
      } catch {
        // A cold or unreadable journal degrades to in-memory tracking; resolution stays honest through `inferred`.
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
    if (store === undefined) {
      state = reduceLineage(state, { name, payload });
      return;
    }
    try {
      const committed = await store.dispatch(name, payload as never, { idempotencyKey });
      state = committed.replayed ? (await store.read()).state : committed.state;
    } catch (error) {
      // The same key with a payload that differs only in what the digest
      // ignores (a receipt timestamp) is a redelivery, not a new fact.
      if (error instanceof AgentStateError && error.code === 'idempotency-conflict') {
        try {
          state = (await store.read()).state;
        } catch {
          // Keep the head we already hold.
        }
        return;
      }
      state = reduceLineage(state, { name, payload });
    }
  };

  const nodeFor = (conversation: string | undefined): LineageNode | undefined =>
    conversation === undefined ? undefined : state.nodes[conversation];

  /**
   * The spawn call that produced the subagent starting now: the most recent
   * unclaimed one *under the same root*, so two sessions sharing one durable
   * registry never claim each other's spawns. Claude keeps the call open
   * across `SubagentStart`; Codex closes it first, so the claim window is
   * independent of `openCalls`.
   */
  const claimSpawn = async (host: LineageHost, root: string, keys: JournalKeys): Promise<OpenToolCall | undefined> => {
    const spawn = SPAWN_TOOLS[host];
    for (let index = state.pendingSpawns.length - 1; index >= 0; index -= 1) {
      const call = state.pendingSpawns[index]!;
      if (!spawn(call.toolName)) continue;
      if ((nodeFor(call.conversation)?.root ?? call.conversation) !== root) continue;
      await dispatch('spawnClaimed', { toolCallId: call.toolCallId }, keys);
      return call;
    }
    return undefined;
  };

  /**
   * The node for a conversation that speaks for itself, creating it when it is
   * new. A never-seen Cursor conversation while exactly one `subagentStart` is
   * pending is that child speaking for the first time; with several pending
   * children the child payload carries nothing to tell them apart, so the
   * conversation stays unresolved rather than being bound arbitrarily.
   */
  const ensureRoot = async (
    host: LineageHost,
    conversation: string,
    generation: string | undefined,
    observedAt: string,
    keys: JournalKeys,
    allowRoot: boolean,
  ): Promise<LineageNode | undefined> => {
    const existing = state.nodes[conversation];
    if (existing !== undefined) return existing;
    if (host === 'cursor' && state.pendingChildren.length > 0) {
      if (state.pendingChildren.length > 1) return undefined;
      const subagentId = state.pendingChildren[0]!;
      await dispatch('childBound', { conversation, subagentId }, keys);
      return state.nodes[conversation];
    }
    // An unknown conversation with no pending start is a root only when the
    // event itself is root-shaped; a Cursor child's tool event after a registry
    // restart carries nothing that distinguishes it from a root.
    if (!allowRoot) return undefined;
    const node = rootNode(conversation, generation, observedAt);
    await dispatch('nodeStarted', node, keys);
    return node;
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
      : fallback;
    return available(lineageOf(node, carrier.generation, resolution), resolution === 'native' ? 'native' : 'derived');
  };

  const observeStart = async (observation: LineageObservation, observedAt: string, keys: JournalKeys): Promise<void> => {
    const { host, native } = observation;
    const carrier = lineageCarrier(host, native);
    if (host === 'cursor') {
      const subagentId = nativeString(native, 'subagent_id') ?? nativeString(native, 'tool_call_id');
      const parentId = nativeString(native, 'parent_conversation_id') ?? carrier.conversation;
      if (subagentId === undefined || parentId === undefined) return;
      // A replayed start already registered (or bound) this child.
      if (state.nodes[subagentId] !== undefined || Object.values(state.nodes).some((node) => node.subagentId === subagentId)) return;
      const parent = await ensureRoot(host, parentId, undefined, observedAt, keys, false);
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
      }, keys);
      return;
    }
    const agentId = nativeString(native, 'agent_id');
    const root = carrier.root;
    if (agentId === undefined || root === undefined) return;
    // A replayed start must not claim a second spawn or rewrite the node.
    if (state.nodes[agentId] !== undefined) return;
    const rootNodeValue = await ensureRoot(host, root, undefined, observedAt, keys, true);
    if (rootNodeValue === undefined) return;
    const spawn = await claimSpawn(host, rootNodeValue.root, keys);
    const parent = (spawn === undefined ? undefined : nodeFor(spawn.conversation)) ?? rootNodeValue;
    await dispatch('nodeStarted', {
      depth: parent.depth + 1,
      ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
      id: agentId,
      parent: parent.id,
      root: rootNodeValue.root,
      startedAt: observedAt,
      ...(spawn === undefined ? {} : { toolCallId: spawn.toolCallId }),
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
    if (stopped === undefined || state.nodes[stopped] === undefined) return;
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
  };

  const registry: AgentLineageRegistry = {
    async observe(observation) {
      await hydrate();
      const keys = journalKeys(observation.idempotencyKey);
      const observedAt = observation.observedAt ?? new Date().toISOString();
      const { event, host, native } = observation;
      const carrier = lineageCarrier(host, native);
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
      // fresh child conversation binds to the single pending start.
      if (carrier.conversation !== undefined && nodeFor(carrier.conversation) === undefined) {
        const rootLike = host === 'cursor'
          ? CURSOR_ROOT_EVENTS.has(event)
          : carrier.conversation === carrier.root;
        if (rootLike || host === 'cursor') {
          await ensureRoot(host, carrier.conversation, carrier.generation, observedAt, keys, rootLike);
        }
      }
      const toolCallId = nativeString(native, 'tool_use_id') ?? nativeString(native, 'tool_call_id');
      const toolName = nativeString(native, 'tool_name');
      if (carrier.conversation !== undefined && toolCallId !== undefined && toolName !== undefined) {
        if (event === 'tool/before') {
          await dispatch('toolCallOpened', {
            conversation: carrier.conversation,
            openedAt: observedAt,
            ...(SPAWN_TOOLS[host](toolName) ? { spawn: true } : {}),
            toolCallId,
            toolName,
          }, keys);
        } else if (event === 'tool/after' || event === 'tool/failure') {
          await dispatch('toolCallClosed', { conversation: carrier.conversation, toolCallId }, keys);
        }
      }
      return resolve(host, native, host === 'cursor' ? 'inferred' : 'registry');
    },

    resolveToolCall(query) {
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
            const depth = known?.depth ?? (parent === undefined ? 0 : parentDepth === undefined ? undefined : parentDepth + 1);
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
        call = state.openCalls.find((open) => open.toolCallId === claudeToolUseId);
      }
      if (call === undefined) {
        // The most recent open pre-tool hook naming this tool: `MCP:<tool>` on
        // Cursor, `mcp__<server>__<tool>` on Codex, `mcp__plugin_<p>_<s>__<tool>` on Claude.
        for (let index = state.openCalls.length - 1; index >= 0; index -= 1) {
          const candidate = state.openCalls[index]!;
          if (
            candidate.toolName === `MCP:${toolName}`
            || candidate.toolName.endsWith(`__${toolName}`)
            || candidate.toolName === toolName
          ) {
            call = candidate;
            break;
          }
        }
      }
      if (call === undefined) return unavailable('id-not-resolvable');
      const node = nodeFor(call.conversation);
      if (node === undefined) return unavailable('id-not-resolvable');
      const resolution: AgentLineageResolution = claudeToolUseId !== undefined ? 'registry' : 'inferred';
      return available(lineageOf(node, undefined, resolution), 'derived');
    },

    snapshot() {
      return state;
    },
  };
  return Object.freeze(registry);
};
