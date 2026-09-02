import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withNotices, withTopology } from '../../coordination.js';
import { deliveryContexts, nativeString } from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function SessionStart({
  canonical,
  native,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{`Worktree topology unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const sessionId = nativeString(native, 'session_id');
  if (sessionId === undefined) {
    return (
      <Agent.Result>
        <Agent.Context>Root actor unavailable: session/start omitted native session_id.</Agent.Context>
      </Agent.Result>
    );
  }

  const actorId = `session:${sessionId}`;
  await withTopology(currentWorktree, async (topology) => {
    await topology.dispatch('actorObserved', {
      id: actorId,
      kind: 'root',
      provenance: { id: 'native' },
      status: 'active',
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:actor`,
    });
    await topology.dispatch('actorBound', {
      actorId,
      provenance: 'native',
      worktreeRoot: currentWorktree.root,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:worktree`,
    });
  });
  const deliveries = await withNotices(
    currentWorktree,
    actorId,
    'native',
    async (notices) => notices.read(),
  );
  const contexts = deliveryContexts(deliveries);
  return (
    <Agent.Result>
      {contexts.map((context) => <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
