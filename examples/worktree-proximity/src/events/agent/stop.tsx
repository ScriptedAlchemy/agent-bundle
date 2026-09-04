import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { withIntent, withNotices } from '../../coordination.js';
import { carriedChild, deliveryContexts, nativeString } from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

/**
 * A subagent finished. Routing this family is what lets the runtime's lineage
 * registry mark the child stopped — from then on no sibling lists it in
 * `request.lineage.tree` — and what releases the child's worktree binding and
 * any intent it left behind, so a stale path claim never warns anyone.
 */
export default async function AgentStop({
  canonical,
  native,
}: AgentEventRouteProps) {
  const child = await carriedChild(native);
  if (child === undefined) {
    return (
      <Agent.Result>
        <Agent.Context>
          {`Child stop ignored: agent/stop omitted native ${nativeString(native, 'agent_id') === undefined ? 'agent_id' : 'session_id'}; refused to release an actor by guess.`}
        </Agent.Context>
      </Agent.Result>
    );
  }
  const intentResult = await withIntent(async (intent) => {
    await intent.dispatch('actorReleased', {
      actorId: child.id,
      observedAt: canonical.observedAt,
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:released`,
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
