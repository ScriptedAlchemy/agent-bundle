import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withIntent, withNotices } from '../../coordination.js';
import { actorForWorktree, deliveryContexts } from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function AfterTool({
  canonical,
}: AgentEventRouteProps<'tool/after'>) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{`Activity completion unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const intentResult = await withIntent(async (intent) => {
    const resolved = await actorForWorktree(intent, currentWorktree, canonical);
    await intent.dispatch('intentRecorded', {
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
  if (intentResult.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{intentResult.reason}</Agent.Context>
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
