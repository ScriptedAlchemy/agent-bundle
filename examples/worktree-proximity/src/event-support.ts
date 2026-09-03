import {
  agent,
  type AgentDocumentNode,
  type AgentLineage,
  type AgentNoticeDelivery,
  type Observed,
} from '@agent-bundle/runtime';

import type { AvailableWorktree } from './api.js';
import type { TopologyAccess } from './coordination.js';
import type { IdentityProvenance, TopologyState } from './state.js';

export interface EventIdentity {
  readonly idempotencyKey: string;
  readonly observedAt: string;
}

export interface ExtractedIntent {
  readonly dependencies: readonly string[];
  readonly paths: readonly string[];
}

export interface ResolvedActor {
  readonly id: string;
  readonly source: IdentityProvenance;
}

/** A child actor plus the conversation that spawned it, as one envelope names them. */
export interface CarriedChild extends ResolvedActor {
  readonly parentSessionId: string;
}

/** The conversation lineage the runtime resolved for the current request. */
export const requestLineage = async (): Promise<Observed<AgentLineage>> => (await agent()).lineage;

/**
 * The subagent a request speaks for, when the runtime's `request.lineage`
 * places it below the root. The runtime resolves the same shape on every
 * host, so the route never has to know that Claude and Codex spell the child
 * `agent_id` while Cursor gives it a fresh `conversation_id`. A root request
 * (depth 0) is deliberately not a child; the root actor is observed at
 * `session/start`.
 */
export const childFromLineage = (lineage: Observed<AgentLineage>): CarriedChild | undefined => {
  if (lineage.state !== 'available' || lineage.value.depth === 0) return undefined;
  return {
    id: lineage.value.subagent?.id ?? lineage.value.conversation,
    parentSessionId: lineage.value.parent ?? lineage.value.root,
    source: lineage.value.resolution,
  };
};

/**
 * The child actor one envelope carries: the runtime lineage first, then the
 * host's own `agent_id` (Claude and Codex put the subagent's id on every one
 * of its hook payloads) with the root `session_id` as its parent. `undefined`
 * means the envelope names no subagent.
 */
export const carriedChild = async (
  native: Readonly<Record<string, unknown>>,
): Promise<CarriedChild | undefined> => {
  const fromLineage = childFromLineage(await requestLineage());
  if (fromLineage !== undefined) return fromLineage;
  const agentId = nativeString(native, 'agent_id');
  const sessionId = nativeString(native, 'session_id');
  if (agentId === undefined || sessionId === undefined) return undefined;
  return { id: agentId, parentSessionId: sessionId, source: 'native' };
};

export const nativeString = (
  native: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = native[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const inputRecord = (native: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const input = native.tool_input;
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Readonly<Record<string, unknown>>
    : {};
};

const dependenciesFrom = (input: Readonly<Record<string, unknown>>): readonly string[] => {
  const convention = input.deps;
  if (typeof convention !== 'string' || !convention.trim().toLowerCase().startsWith('deps:')) return [];
  return convention
    .trim()
    .slice('deps:'.length)
    .split(/[\s,]+/u)
    .map((dependency) => dependency.trim())
    .filter((dependency) => dependency !== '');
};

export const extractIntent = (
  native: Readonly<Record<string, unknown>>,
): ExtractedIntent => {
  const input = inputRecord(native);
  const toolName = nativeString(native, 'tool_name');
  const path = input.file_path;
  const paths =
    (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read')
    && typeof path === 'string'
    && path.trim() !== ''
      ? [path]
      : [];
  return {
    dependencies: dependenciesFrom(input),
    paths,
  };
};

/**
 * The actor a tool or stop envelope belongs to, in order of evidence: the
 * child the envelope itself names (runtime lineage, then native `agent_id`),
 * the active actor already bound to the event worktree, and finally the
 * explicit derived identity `worktree:<root>`. A carried child the topology
 * has not seen yet (its `agent/start` was missed) is observed and bound with
 * the provenance the evidence carried; a derived actor is never upgraded.
 */
export const actorForWorktree = async (
  topology: TopologyAccess,
  worktree: AvailableWorktree,
  canonical: EventIdentity,
  native: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly actor: ResolvedActor; readonly snapshot: TopologyState }> => {
  const before = await topology.read();
  const carried = await carriedChild(native);
  if (carried !== undefined) {
    const known = before.state.actors.find((actor) => actor.id === carried.id);
    if (known !== undefined) {
      return { actor: { id: known.id, source: known.provenance.id }, snapshot: before.state };
    }
    await topology.dispatch('actorObserved', {
      id: carried.id,
      kind: 'child',
      parentSessionId: carried.parentSessionId,
      provenance: { id: carried.source, parentSessionId: carried.source },
      status: 'active',
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:carried-actor`,
    });
    const boundResult = await topology.dispatch('actorBound', {
      actorId: carried.id,
      provenance: 'native',
      worktreeRoot: worktree.root,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:carried-worktree`,
    });
    return { actor: { id: carried.id, source: carried.source }, snapshot: boundResult.state };
  }
  const bound = before.state.actors.find(
    (actor) => actor.status === 'active' && actor.worktreeRoot === worktree.root && actor.kind === 'child',
  ) ?? before.state.actors.find(
    (actor) => actor.status === 'active' && actor.worktreeRoot === worktree.root,
  );
  if (bound !== undefined) {
    return {
      actor: { id: bound.id, source: bound.provenance.id },
      snapshot: before.state,
    };
  }

  const actor: ResolvedActor = {
    id: `worktree:${worktree.root}`,
    source: 'derived',
  };
  await topology.dispatch('actorObserved', {
    id: actor.id,
    kind: 'child',
    provenance: { id: 'derived' },
    status: 'active',
  }, {
    idempotencyKey: `${canonical.idempotencyKey}:derived-actor`,
  });
  const boundResult = await topology.dispatch('actorBound', {
    actorId: actor.id,
    provenance: 'derived',
    worktreeRoot: worktree.root,
  }, {
    idempotencyKey: `${canonical.idempotencyKey}:derived-worktree`,
  });
  return { actor, snapshot: boundResult.state };
};

const nodeText = (node: AgentDocumentNode): string => {
  switch (node.kind) {
    case 'result':
      return node.children.map(nodeText).filter(Boolean).join('\n');
    case 'context':
    case 'markdown':
    case 'text':
      return node.text;
    case 'error':
      return `${node.code}: ${node.message}`;
    case 'resource':
      return `${node.name} (${node.uri})`;
    case 'progress':
      return node.message ?? '';
    case 'audio':
    case 'image':
    case 'json':
      return '';
    default: {
      const unreachable: never = node;
      throw new Error(`Unhandled Agent Document node ${String(unreachable)}`);
    }
  }
};

export const deliveryContexts = (
  deliveries: readonly AgentNoticeDelivery[],
): readonly string[] => deliveries.map((delivery) => {
  const text = nodeText(delivery.notice.content.root);
  return `Directed proximity notice (${delivery.notice.state}, ${delivery.receipt.channel}): ${text}`;
});
