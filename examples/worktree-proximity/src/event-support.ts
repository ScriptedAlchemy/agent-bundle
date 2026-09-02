import type {
  AgentDocumentNode,
  AgentNoticeDelivery,
  ObservedSource,
} from '@agent-bundle/runtime';

import type { AvailableWorktree } from './api.js';
import type { TopologyAccess } from './coordination.js';
import type { TopologyState } from './state.js';

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
  readonly source: ObservedSource;
}

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

export const actorForWorktree = async (
  topology: TopologyAccess,
  worktree: AvailableWorktree,
  canonical: EventIdentity,
): Promise<{ readonly actor: ResolvedActor; readonly snapshot: TopologyState }> => {
  const before = await topology.read();
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
