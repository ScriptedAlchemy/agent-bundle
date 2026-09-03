import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withNotices, withTopology } from '../../coordination.js';
import { deliveryContexts, nativeString, requestLineage } from '../../event-support.js';

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
  // The runtime's lineage names the root conversation on every host; the
  // native `session_id` is the fallback when no lineage was resolved.
  const lineage = await requestLineage();
  const root = lineage.state === 'available'
    ? { id: lineage.value.root, source: lineage.value.resolution }
    : (() => {
        const sessionId = nativeString(native, 'session_id');
        return sessionId === undefined ? undefined : { id: sessionId, source: 'native' as const };
      })();
  if (root === undefined) {
    return (
      <Agent.Result>
        <Agent.Context>Root actor unavailable: session/start omitted native session_id.</Agent.Context>
      </Agent.Result>
    );
  }

  const actorId = `session:${root.id}`;
  const topologyResult = await withTopology(async (topology) => {
    await topology.dispatch('actorObserved', {
      id: actorId,
      kind: 'root',
      provenance: { id: root.source },
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
      {contexts.map((context) => <Agent.Context key={context}>{context}</Agent.Context>)}
    </Agent.Result>
  );
}
