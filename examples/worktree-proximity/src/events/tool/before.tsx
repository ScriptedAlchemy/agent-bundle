import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { worktree } from '../../api.js';
import { withNotices, withTopology } from '../../coordination.js';
import { findProximity } from '../../domain/proximity.js';
import {
  actorForWorktree,
  deliveryContexts,
  extractIntent,
  noticeRecipientFor,
} from '../../event-support.js';

export const config = {
  runtime: 'shared',
  targets: ['claude', 'codex'],
};

export default async function BeforeTool({
  canonical,
  native,
}: AgentEventRouteProps) {
  const currentWorktree = await worktree();
  if (currentWorktree.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{`Proximity detection unavailable: ${currentWorktree.reason}`}</Agent.Context>
      </Agent.Result>
    );
  }
  const intent = extractIntent(native);
  const topologyResult = await withTopology(async (topology) => {
    const { actor } = await actorForWorktree(topology, currentWorktree, canonical, native);
    const committed = await topology.dispatch('intentRecorded', {
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
      actors: committed.state.actors,
      conflicts: findProximity(committed.state, currentWorktree.root, {
        actorId: actor.id,
        dependencies: intent.dependencies,
        paths: intent.paths,
      }),
    };
  });
  if (topologyResult.state === 'unavailable') {
    return (
      <Agent.Result value={{ outcome: 'continue' }}>
        <Agent.Context>{topologyResult.reason}</Agent.Context>
      </Agent.Result>
    );
  }
  const resolution = topologyResult.value;

  const noticeResult = await withNotices(async (notices) => {
    const deliveries = await notices.read();
    for (const [index, conflict] of resolution.conflicts.entries()) {
      // The other actor's conversation is the recipient: only that agent
      // thread admits the notice, even when a sibling shares its worktree.
      // A derived actor has no conversation, so its worktree is addressed.
      const recipient = noticeRecipientFor(
        resolution.actors.find((actor) => actor.id === conflict.actorId),
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
