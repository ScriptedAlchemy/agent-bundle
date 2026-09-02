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

export default async function AgentStart({
  canonical,
  native,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{`Child topology unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }

  const agentId = nativeString(native, 'agent_id');
  const sessionId = nativeString(native, 'session_id');
  const refusal = agentId === undefined
    ? 'agent/start omitted native agent_id; refused to fabricate a topology edge'
    : sessionId === undefined
      ? 'agent/start omitted native session_id; refused to fabricate a topology edge'
      : undefined;
  if (refusal !== undefined) {
    await withTopology(currentWorktree, async (topology) => {
      await topology.dispatch('edgeRefused', {
        idempotencyKey: canonical.idempotencyKey,
        observedAt: canonical.observedAt,
        reason: refusal,
        ...(sessionId === undefined ? {} : { sessionId }),
      }, {
        idempotencyKey: `${canonical.idempotencyKey}:refusal`,
      });
    });
    const deliveries = await withNotices(
      currentWorktree,
      undefined,
      'derived',
      async (notices) => notices.read(),
    );
    return (
      <Agent.Result>
        <Agent.Context>{`Parent identity unavailable; ${refusal}.`}</Agent.Context>
        {deliveryContexts(deliveries).map((context) =>
          <Agent.Context key={context}>{context}</Agent.Context>)}
      </Agent.Result>
    );
  }

  await withTopology(currentWorktree, async (topology) => {
    await topology.dispatch('actorObserved', {
      id: agentId,
      kind: 'child',
      parentSessionId: sessionId,
      provenance: {
        id: 'native',
        parentSessionId: 'native',
      },
      status: 'active',
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:actor`,
    });
    await topology.dispatch('actorBound', {
      actorId: agentId,
      provenance: 'native',
      worktreeRoot: currentWorktree.root,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:worktree`,
    });
  });
  const deliveries = await withNotices(
    currentWorktree,
    agentId,
    'native',
    async (notices) => notices.read(),
  );
  return (
    <Agent.Result>
      {deliveryContexts(deliveries).map((context) =>
        <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
