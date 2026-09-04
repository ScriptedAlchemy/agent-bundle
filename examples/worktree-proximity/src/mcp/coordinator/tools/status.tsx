import { Agent, type AgentNoticeState, type JsonValue } from '@agent-bundle/runtime';
import { AGENT_NOTICE_STATES } from '@agent-bundle/runtime/notices';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { withNotices, withTopology } from '../../../coordination.js';
import { ActorSchema } from '../../../state.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the mounted durable worktree topology, active intents, refusals, and the state of the proximity notices this agent published.',
} satisfies ToolConfig;

export const inputSchema = z
  .object({
    actorId: z.string().min(1).optional(),
  })
  .strict();

const noticeCount = z.number().int().nonnegative();

/**
 * What became of the notices the calling agent published, counted by ledger
 * state. Scoped by the publisher identity the ledger recorded at publish —
 * the caller's lineage conversation — so it is this agent's own notices, never
 * the whole ledger and never another agent's ([#460](https://github.com/scriptedalchemy/agent-bundle/issues/460)).
 */
export const PublishedNoticesSchema = z
  .object({
    acknowledged: noticeCount,
    attempted: noticeCount,
    expired: noticeCount,
    pending: noticeCount,
    reason: z.string().optional(),
    state: z.enum(['available', 'unavailable']),
    total: noticeCount,
    unavailable: noticeCount,
    withdrawn: noticeCount,
  })
  .strict();

export const resultSchema = z
  .object({
    activeActivities: z.number().int().nonnegative(),
    actors: z.array(ActorSchema),
    notices: PublishedNoticesSchema,
    reason: z.string().optional(),
    refusals: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    state: z.enum(['available', 'unavailable']),
  })
  .strict();

type StatusResult = z.output<typeof resultSchema>;
type PublishedNotices = z.output<typeof PublishedNoticesSchema>;

const emptyCounts = (): Record<AgentNoticeState, number> =>
  Object.fromEntries(AGENT_NOTICE_STATES.map((state) => [state, 0])) as Record<AgentNoticeState, number>;

const publishedNotices = async (): Promise<PublishedNotices> => {
  const result = await withNotices(async (notices) => notices.published());
  if (result.state === 'unavailable') {
    return { ...emptyCounts(), reason: result.reason, state: 'unavailable', total: 0 };
  }
  const counts = emptyCounts();
  for (const notice of result.value) counts[notice.state] += 1;
  return { ...counts, state: 'available', total: result.value.length };
};

export default async function Status({
  input,
}: ToolRouteProps<typeof inputSchema>) {
  const topologyResult = await withTopology(async (store) => store.read());
  const notices = await publishedNotices();
  let result: StatusResult;
  if (topologyResult.state === 'unavailable') {
    result = {
      activeActivities: 0,
      actors: [],
      notices,
      reason: topologyResult.reason,
      refusals: 0,
      revision: 0,
      state: 'unavailable',
    };
  } else {
    const { revision, state: topology } = topologyResult.value;
    const actors = input.actorId === undefined
      ? topology.actors
      : topology.actors.filter((actor) => actor.id === input.actorId);
    const visibleIds = new Set(actors.map((actor) => actor.id));
    result = {
      activeActivities: topology.activities.filter(
        (activity) =>
          visibleIds.has(activity.actorId)
          && (activity.paths.length > 0 || activity.dependencies.length > 0),
      ).length,
      actors,
      notices,
      refusals: topology.refusals.length,
      revision,
      state: 'available',
    };
  }

  const noticeLine = notices.state === 'available'
    ? `- Published notices: ${String(notices.total)} (pending ${String(notices.pending)}, attempted ${String(notices.attempted)}, acknowledged ${String(notices.acknowledged)})`
    : `- Published notices unavailable: ${notices.reason ?? 'unknown reason'}`;
  const markdown = result.state === 'available'
    ? [
        '# Worktree proximity status',
        '',
        `- Actors: ${String(result.actors.length)}`,
        `- Active activities: ${String(result.activeActivities)}`,
        `- Refused edges: ${String(result.refusals)}`,
        noticeLine,
      ].join('\n')
    : `# Worktree proximity status\n\nUnavailable: ${result.reason ?? 'unknown reason'}\n\n${noticeLine}`;
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Markdown>{markdown}</Agent.Markdown>
      <Agent.Json value={result as unknown as JsonValue} />
    </Agent.Result>
  );
}
