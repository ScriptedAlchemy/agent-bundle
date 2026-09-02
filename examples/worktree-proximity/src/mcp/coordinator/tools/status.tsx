import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { withTopology } from '../../../coordination.js';
import { ActorSchema } from '../../../state.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the mounted durable worktree topology, active intents, and refusals.',
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
    reason: z.string().optional(),
    refusals: z.number().int().nonnegative(),
    state: z.enum(['available', 'unavailable']),
  })
  .strict();

type StatusResult = z.output<typeof resultSchema>;

export default async function Status({
  input,
}: ToolRouteProps<typeof inputSchema>) {
  const topologyResult = await withTopology(async (store) => (await store.read()).state);
  let result: StatusResult;
  if (topologyResult.state === 'unavailable') {
    result = {
      activeActivities: 0,
      actors: [],
      reason: topologyResult.reason,
      refusals: 0,
      state: 'unavailable',
    };
  } else {
    const topology = topologyResult.value;
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
      refusals: topology.refusals.length,
      state: 'available',
    };
  }

  const markdown = result.state === 'available'
    ? [
        '# Worktree proximity status',
        '',
        `- Actors: ${String(result.actors.length)}`,
        `- Active activities: ${String(result.activeActivities)}`,
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
