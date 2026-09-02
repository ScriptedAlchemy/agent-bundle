import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withNotices, withTopology } from '../../coordination.js';
import { actorForWorktree, deliveryContexts } from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function AfterTool({
  canonical,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{`Activity completion unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const actor = await withTopology(currentWorktree, async (topology) => {
    const resolved = await actorForWorktree(topology, currentWorktree, canonical);
    await topology.dispatch('intentRecorded', {
      actorId: resolved.actor.id,
      dependencies: [],
      idempotencyKey: canonical.idempotencyKey,
      observedAt: canonical.observedAt,
      paths: [],
      provenance: {
        actorId: resolved.actor.source,
        dependencies: 'native',
        paths: 'native',
      },
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:completion`,
    });
    return resolved.actor;
  });
  const deliveries = await withNotices(
    currentWorktree,
    actor.id,
    actor.source,
    async (notices) => notices.read(),
  );
  return (
    <Agent.Result value={{ outcome: 'continue' }}>
      {deliveryContexts(deliveries).map((context) =>
        <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
