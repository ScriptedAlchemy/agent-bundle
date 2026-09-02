import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { worktree } from '../../../api.js';
import {
  readNoticeLedger,
  stateRootFor,
  withTopology,
} from '../../../coordination.js';
import { ActorSchema } from '../../../state.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the durable worktree topology, active intents, refusals, and pending directed notices.',
} satisfies ToolConfig;

export const inputSchema = z
  .object({
    actorId: z.string().min(1).optional(),
  })
  .strict();

export const resultSchema = z
  .object({
    activeActivities: z.number().int().nonnegative(),
    actors: z.array(ActorSchema),
    pendingNotices: z.number().int().nonnegative(),
    reason: z.string().optional(),
    refusals: z.number().int().nonnegative(),
    state: z.enum(['available', 'unavailable']),
    stateRoot: z.string().optional(),
  })
  .strict();

type StatusResult = z.output<typeof resultSchema>;

export default async function Status({
  input,
}: ToolRouteProps<typeof inputSchema>) {
  const currentWorktree = await worktree();
  let result: StatusResult;
  if (currentWorktree.state === 'unavailable') {
    result = {
      activeActivities: 0,
      actors: [],
      pendingNotices: 0,
      reason: currentWorktree.reason,
      refusals: 0,
      state: 'unavailable',
    };
  } else {
    const topology = await withTopology(currentWorktree, async (store) => (await store.read()).state);
    const notices = await readNoticeLedger(currentWorktree);
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
      pendingNotices: notices.notices.filter((notice) => notice.state === 'pending').length,
      refusals: topology.refusals.length,
      state: 'available',
      stateRoot: stateRootFor(currentWorktree),
    };
  }

  const markdown = result.state === 'available'
    ? [
        '# Worktree proximity status',
        '',
        `- Actors: ${String(result.actors.length)}`,
        `- Active activities: ${String(result.activeActivities)}`,
        `- Pending notices: ${String(result.pendingNotices)}`,
        `- Refused edges: ${String(result.refusals)}`,
      ].join('\n')
    : `# Worktree proximity status\n\nUnavailable: ${result.reason ?? 'unknown reason'}`;
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Markdown>{markdown}</Agent.Markdown>
      <Agent.Json value={result as unknown as JsonValue} />
    </Agent.Result>
  );
}
