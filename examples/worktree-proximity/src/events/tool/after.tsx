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
  native,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{`Activity completion unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const topologyResult = await withTopology(async (topology) => {
    const resolved = await actorForWorktree(topology, currentWorktree, canonical, native);
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
  if (topologyResult.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{topologyResult.reason}</Agent.Context>
      </Agent.Result>
    );
  }
  const noticeResult = await withNotices(async (notices) => notices.read());
  const contexts = noticeResult.state === 'available'
    ? deliveryContexts(noticeResult.value)
    : [noticeResult.reason];
  return (
    <Agent.Result value={{ outcome: 'continue' }}>
      {contexts.map((context) =>
        <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
