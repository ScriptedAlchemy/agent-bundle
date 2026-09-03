import {
  available,
  unavailable,
  type AgentLineage,
  type AgentLineageResolution,
  type Observed,
} from '../agent-request.js';
import { lineageCarrier, type LineageHost } from '../lineage-native.js';
import type { AgentStateStore } from '../state/contract.js';
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
  let hydrated = store === undefined;
  let sequence = 0;

  const hydrate = async (): Promise<void> => {
    if (hydrated || store === undefined) return;
    hydrated = true;
    try {
      state = (await store.read()).state;
    } catch {
      // A cold or unreadable journal degrades to in-memory tracking; resolution stays honest through `inferred`.
    }
  };

  const dispatch = async <TName extends keyof LineageEvents>(
    name: TName,
    payload: Parameters<typeof reduceLineage>[1]['payload'],
    idempotencyKey: string,
  ): Promise<void> => {
    sequence += 1;
    if (store === undefined) {
      state = reduceLineage(state, { name, payload });
      return;
    }
    try {
      const committed = await store.dispatch(name, payload as never, {
        idempotencyKey: `lineage:${idempotencyKey}:${String(sequence)}`,
      });
      state = committed.state;
    } catch {
      state = reduceLineage(state, { name, payload });
    }
  };

  const nodeFor = (conversation: string | undefined): LineageNode | undefined =>
    conversation === undefined ? undefined : state.nodes[conversation];

  /**
   * The spawn call that produced the subagent starting now: the most recent
   * unclaimed one. Claude keeps the call open across `SubagentStart`; Codex
   * closes it first, so the claim window is independent of `openCalls`.
   */
  const claimSpawn = async (host: LineageHost, key: string): Promise<OpenToolCall | undefined> => {
    const spawn = SPAWN_TOOLS[host];
    for (let index = state.pendingSpawns.length - 1; index >= 0; index -= 1) {
      const call = state.pendingSpawns[index]!;
      if (!spawn(call.toolName)) continue;
      await dispatch('spawnClaimed', { toolCallId: call.toolCallId }, `${key}:claim`);
      return call;
    }
    return undefined;
  };

  const ensureRoot = async (
    host: LineageHost,
    conversation: string,
    generation: string | undefined,
    observedAt: string,
    key: string,
  ): Promise<LineageNode> => {
    const existing = state.nodes[conversation];
    if (existing !== undefined) return existing;
    if (host === 'cursor' && state.pendingChildren.length > 0) {
      // A never-seen Cursor conversation while a subagentStart is pending is
      // that child speaking for the first time.
      const subagentId = state.pendingChildren[0]!;
      await dispatch('childBound', { conversation, subagentId }, key);
      const bound = state.nodes[conversation];
      if (bound !== undefined) return bound;
    }
    const node = rootNode(conversation, generation, observedAt);
    await dispatch('nodeStarted', node, key);
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

  const observeStart = async (observation: LineageObservation, observedAt: string): Promise<void> => {
    const { host, native } = observation;
    const carrier = lineageCarrier(host, native);
    const key = observation.idempotencyKey;
    if (host === 'cursor') {
      const subagentId = nativeString(native, 'subagent_id') ?? nativeString(native, 'tool_call_id');
      const parentId = nativeString(native, 'parent_conversation_id') ?? carrier.conversation;
      if (subagentId === undefined || parentId === undefined) return;
      const parent = await ensureRoot(host, parentId, undefined, observedAt, `${key}:parent`);
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
      }, key);
      return;
    }
    const agentId = nativeString(native, 'agent_id');
    const root = carrier.root;
    if (agentId === undefined || root === undefined) return;
    const rootNodeValue = await ensureRoot(host, root, undefined, observedAt, `${key}:root`);
    const spawn = await claimSpawn(host, key);
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
    }, key);
  };

  const observeStop = async (observation: LineageObservation, observedAt: string): Promise<void> => {
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
    await dispatch('nodeStopped', { id: stopped, stoppedAt: observedAt }, observation.idempotencyKey);
  };

  const registry: AgentLineageRegistry = {
    async observe(observation) {
      await hydrate();
      const observedAt = observation.observedAt ?? new Date().toISOString();
      const { event, host, native } = observation;
      const carrier = lineageCarrier(host, native);
      switch (event) {
        case 'agent/start':
          await observeStart(observation, observedAt);
          break;
        case 'agent/stop':
          await observeStop(observation, observedAt);
          break;
        default:
          break;
      }
      // Every other carrier is known or becomes a root; Cursor children bind here.
      if (carrier.conversation !== undefined && nodeFor(carrier.conversation) === undefined) {
        const rootLike = host === 'cursor' || carrier.conversation === carrier.root;
        if (rootLike) await ensureRoot(host, carrier.conversation, carrier.generation, observedAt, `${observation.idempotencyKey}:carrier`);
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
          }, observation.idempotencyKey);
        } else if (event === 'tool/after' || event === 'tool/failure') {
          await dispatch('toolCallClosed', { conversation: carrier.conversation, toolCallId }, observation.idempotencyKey);
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
            const value: AgentLineage = {
              conversation,
              depth: known?.depth ?? (parent === undefined ? 0 : (nodeFor(parent)?.depth ?? 0) + 1),
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
