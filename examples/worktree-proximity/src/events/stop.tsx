import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../api.js';
import { withIntent, withNotices } from '../coordination.js';
import {
  actorForWorktree,
  carriedChild,
  deliveryContexts,
  type ResolvedActor,
} from '../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function Stop({
  canonical,
}: AgentEventRouteProps<'stop'>) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{`Actor stop unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  // A stop names its own actor through the runtime lineage or the payload's
  // `agentId`; only an anonymous stop falls back to the worktree binding.
  // Releasing the actor drops its binding and any intent it still held; the
  // runtime's lineage registry records the stop itself.
  const carried = await carriedChild(canonical.payload);
  const intentResult = await withIntent(async (intent): Promise<ResolvedActor> => {
    const resolved: ResolvedActor = carried === undefined
      ? (await actorForWorktree(intent, currentWorktree, canonical)).actor
      : { id: carried.id, source: carried.source };
    await intent.dispatch('actorReleased', {
      actorId: resolved.id,
      observedAt: canonical.observedAt,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:released`,
    });
    return resolved;
  });
  if (intentResult.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{intentResult.reason}</Agent.Context>
      </Agent.Result>
    );
  }
  const noticeResult = await withNotices(async (notices) => notices.read());
  const contexts = noticeResult.state === 'available'
    ? deliveryContexts(noticeResult.value)
    : [noticeResult.reason];
  return (
    <Agent.Result>
      {contexts.map((context) =>
        <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
