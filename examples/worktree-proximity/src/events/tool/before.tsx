import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withIntent, withNotices } from '../../coordination.js';
import { findProximity } from '../../domain/proximity.js';
import {
  actorForWorktree,
  deliveryContexts,
  extractIntent,
  liveConversations,
  noticeRecipientFor,
  requestLineage,
} from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function BeforeTool({
  canonical,
}: AgentEventRouteProps<'tool/before'>) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{`Proximity detection unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  // `canonical.payload` is the framework's cross-host reading of the envelope:
  // `toolName`/`toolInput` under Claude's PreToolUse and Codex's alike.
  const intent = extractIntent(canonical.payload);
  // Who else is alive comes from the runtime's lineage registry, not from
  // this application's bookkeeping: an intent left behind by an agent the
  // registry no longer lists under our root is stale and warns nobody.
  const live = liveConversations(await requestLineage());
  const intentResult = await withIntent(async (store) => {
    const { actor } = await actorForWorktree(store, currentWorktree, canonical);
    const committed = await store.dispatch('intentRecorded', {
      actorId: actor.id,
      dependencies: [...intent.dependencies],
      idempotencyKey: canonical.idempotencyKey,
      observedAt: canonical.observedAt,
      paths: [...intent.paths],
      provenance: {
        actorId: actor.source,
        dependencies: 'native',
        paths: 'native',
      },
    }, {
      idempotencyKey: `${canonical.idempotencyKey}:intent`,
    });
    return {
      actor,
      bindings: committed.state.bindings,
      conflicts: findProximity(committed.state, currentWorktree.root, {
        actorId: actor.id,
        dependencies: intent.dependencies,
        paths: intent.paths,
      }, live === undefined ? {} : { liveConversations: live }),
    };
  });
  if (intentResult.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{intentResult.reason}</Agent.Context>
      </Agent.Result>
    );
  }
  const resolution = intentResult.value;

  const noticeResult = await withNotices(async (notices) => {
    const deliveries = await notices.read();
    for (const [index, conflict] of resolution.conflicts.entries()) {
      // The other actor's conversation is the recipient: only that agent
      // thread admits the notice, even when a sibling shares its worktree.
      // A derived actor has no conversation, so its worktree is addressed.
      const recipient = noticeRecipientFor(
        resolution.bindings.find((binding) => binding.actorId === conflict.actorId),
        conflict.worktreeRoot,
      );
      await notices.publish({
        content: {
          root: {
            kind: 'text',
            text: conflict.summary,
          },
          status: 'success',
          version: 1,
        },
        dedupeKey: `proximity:${resolution.actor.id}:${conflict.actorId}:${conflict.summary}`,
        priority: 'high',
        recipient,
      }, {
        idempotencyKey: `${canonical.idempotencyKey}:notice:${String(index)}`,
      });
    }
    return deliveryContexts(deliveries);
  });
  const deliveryAndPublication = noticeResult.state === 'available'
    ? noticeResult.value
    : [noticeResult.reason];
  const warnings = resolution.conflicts.map((conflict) =>
    `Proximity warning for ${resolution.actor.id}: ${conflict.summary}`);
  // Proximity warns; it never decides. `continue` leaves the host's own
  // permission flow untouched, and the warnings reach the agent as context
  // (a `reason` needs a decision to travel with, so none is attached).
  const value: JsonValue = { outcome: 'continue' as const };

  return (
    <Agent.Result value={value}>
      {deliveryAndPublication.map((context) =>
        <Agent.Context key={context}>{context}</Agent.Context>)}
      {warnings.map((warning) => <Agent.Context key={warning}>{warning}</Agent.Context>)}
    </Agent.Result>
  );
}
