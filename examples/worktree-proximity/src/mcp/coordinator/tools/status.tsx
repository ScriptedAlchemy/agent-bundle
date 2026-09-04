import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { withIntent } from '../../../coordination.js';
import { agentTree } from '../../../event-support.js';
import { ActivitySchema, BindingSchema } from '../../../state.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the live agent tree the runtime resolved for this call, the worktree bindings, active intents, and refusals.',
} satisfies ToolConfig;

export const inputSchema = z
  .object({
    actorId: z.string().min(1).optional(),
  })
  .strict();

const resolutionSchema = z.enum(['native', 'registry', 'confirmed', 'transcript', 'inferred']);

const peerSchema = z
  .object({
    conversation: z.string().min(1),
    depth: z.number().int().nonnegative(),
    parent: z.string().min(1).optional(),
    resolution: resolutionSchema,
    startedAt: z.string().min(1),
    subagent: z
      .object({
        id: z.string().min(1),
        isParallelWorker: z.boolean().optional(),
        toolCallId: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** The agent tree as the runtime's lineage registry holds it around this call; never this application's guess. */
export const agentsSchema = z.discriminatedUnion('state', [
  z
    .object({
      children: z.array(peerSchema).readonly(),
      conversation: z.string().min(1),
      depth: z.number().int().nonnegative(),
      parent: z.string().min(1).optional(),
      resolution: resolutionSchema,
      root: z.string().min(1),
      roots: z.array(peerSchema).readonly(),
      siblings: z.array(peerSchema).readonly(),
      state: z.literal('available'),
    })
    .strict(),
  z
    .object({
      reason: z.string().min(1),
      state: z.literal('unavailable'),
    })
    .strict(),
]);

export const resultSchema = z
  .object({
    activeActivities: z.number().int().nonnegative(),
    activities: z.array(ActivitySchema),
    agents: agentsSchema,
    bindings: z.array(BindingSchema),
    reason: z.string().optional(),
    refusals: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    state: z.enum(['available', 'unavailable']),
  })
  .strict();

type StatusResult = z.output<typeof resultSchema>;

export default async function Status({
  input,
}: ToolRouteProps<typeof inputSchema>) {
  const agents = await agentTree();
  const intentResult = await withIntent(async (store) => store.read());
  let result: StatusResult;
  if (intentResult.state === 'unavailable') {
    result = {
      activeActivities: 0,
      activities: [],
      agents,
      bindings: [],
      reason: intentResult.reason,
      refusals: 0,
      revision: 0,
      state: 'unavailable',
    };
  } else {
    const { revision, state: intent } = intentResult.value;
    const bindings = input.actorId === undefined
      ? intent.bindings
      : intent.bindings.filter((binding) => binding.actorId === input.actorId);
    const visibleIds = new Set(bindings.map((binding) => binding.actorId));
    const activities = intent.activities.filter((activity) => visibleIds.has(activity.actorId));
    result = {
      activeActivities: activities.filter(
        (activity) => activity.paths.length > 0 || activity.dependencies.length > 0,
      ).length,
      activities,
      agents,
      bindings,
      refusals: intent.refusals.length,
      revision,
      state: 'available',
    };
  }

  const agentLines = result.agents.state === 'available'
    ? [
        `- This call: ${result.agents.conversation} at depth ${String(result.agents.depth)} under ${result.agents.root} (${result.agents.resolution})`,
        `- Live under the same root: ${result.agents.siblings.length === 0 ? 'none' : result.agents.siblings.map((peer) => `${peer.conversation} (depth ${String(peer.depth)}, ${peer.resolution})`).join(', ')}`,
        `- Children: ${String(result.agents.children.length)}; other live roots: ${String(result.agents.roots.length)}`,
      ]
    : [`- Agent tree unavailable: ${result.agents.reason}`];
  const markdown = result.state === 'available'
    ? [
        '# Worktree proximity status',
        '',
        ...agentLines,
        `- Worktree bindings: ${String(result.bindings.length)}`,
        `- Active activities: ${String(result.activeActivities)}`,
        `- Refused edges: ${String(result.refusals)}`,
      ].join('\n')
    : [
        '# Worktree proximity status',
        '',
        ...agentLines,
        `- Intent state unavailable: ${result.reason ?? 'unknown reason'}`,
      ].join('\n');
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Markdown>{markdown}</Agent.Markdown>
      <Agent.Json value={result as unknown as JsonValue} />
    </Agent.Result>
  );
}
