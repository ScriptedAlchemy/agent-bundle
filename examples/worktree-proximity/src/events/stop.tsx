import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../api.js';
import { withNotices, withTopology } from '../coordination.js';
import {
  actorForWorktree,
  deliveryContexts,
  nativeString,
  type ResolvedActor,
} from '../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function Stop({
  canonical,
  native,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{`Actor stop unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const nativeActorId = nativeString(native, 'agent_id');
  const topologyResult = await withTopology(async (topology): Promise<ResolvedActor> => {
    const resolved = nativeActorId === undefined
      ? (await actorForWorktree(topology, currentWorktree, canonical)).actor
      : { id: nativeActorId, source: 'native' as const };
    await topology.dispatch('actorStopped', {
      actorId: resolved.id,
      observedAt: canonical.observedAt,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:stopped`,
    });
    return resolved;
  });
  if (topologyResult.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{topologyResult.reason}</Agent.Context>
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
