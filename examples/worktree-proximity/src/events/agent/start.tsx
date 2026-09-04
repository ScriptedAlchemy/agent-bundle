import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withIntent, withNotices } from '../../coordination.js';
import { carriedChild, deliveryContexts, nonEmpty } from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function AgentStart({
  canonical,
}: AgentEventRouteProps<'agent/start'>) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result>
        <Agent.Context>{`Child topology unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }

  // The runtime's `request.lineage` names the child and its parent when the
  // registry resolved this start; the payload's `agentId` + `sessionId` pair
  // is the fallback. Neither present is a refusal, never a guess. The edge
  // itself (parent, depth, root) is the registry's to keep: this route
  // records only which worktree the child works in.
  const child = await carriedChild(canonical.payload);
  if (child === undefined) {
    const sessionId = nonEmpty(canonical.payload.sessionId?.value);
    const refusal = nonEmpty(canonical.payload.agentId?.value) === undefined
      ? 'agent/start omitted native agent_id; refused to fabricate a topology edge'
      : 'agent/start omitted native session_id; refused to fabricate a topology edge';
    const intentResult = await withIntent(async (intent) => {
      await intent.dispatch('edgeRefused', {
        idempotencyKey: canonical.idempotencyKey,
        observedAt: canonical.observedAt,
        reason: refusal,
        ...(sessionId === undefined ? {} : { sessionId }),
      }, {
        idempotencyKey: `${canonical.idempotencyKey}:refusal`,
      });
    });
    const noticeResult = await withNotices(async (notices) => notices.read());
    const contexts = [
      ...(intentResult.state === 'unavailable' ? [intentResult.reason] : []),
      ...(noticeResult.state === 'available'
        ? deliveryContexts(noticeResult.value)
        : [noticeResult.reason]),
    ];
    return (
      <Agent.Result>
        <Agent.Context>{`Parent identity unavailable; ${refusal}.`}</Agent.Context>
        {contexts.map((context) =>
          <Agent.Context key={context}>{context}</Agent.Context>)}
      </Agent.Result>
    );
  }

  const intentResult = await withIntent(async (intent) => {
    await intent.dispatch('actorBound', {
      actorId: child.id,
      provenance: { actorId: child.source, worktreeRoot: 'native' },
      worktreeRoot: currentWorktree.root,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:worktree`,
    });
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
