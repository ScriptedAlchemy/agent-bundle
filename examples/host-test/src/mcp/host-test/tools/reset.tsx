import { Agent, agent, type AgentStateHandle, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { clearLog, resolveLog } from '../../../log.js';
import type { CaptureEvents, CapturesState } from '../../../state.js';

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Clear the host-test capture log and the durable capture summary so the next probe starts empty.',
} satisfies ToolConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  clearedAt: z.string(),
  log: z.string(),
  state: z.enum(['cleared', 'unavailable']),
  stateReason: z.string().optional(),
}).strict();

export default async function Reset(_props: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const log = resolveLog();
  await clearLog(log);
  const clearedAt = new Date().toISOString();
  const handle = context.state as AgentStateHandle<CapturesState, CaptureEvents> | undefined;
  let result: z.output<typeof resultSchema>;
  if (handle === undefined) {
    result = { clearedAt, log: log.path, state: 'unavailable', stateReason: 'no state handle mounted on this request' };
  } else {
    try {
      await handle.dispatch('cleared', { clearedAt }, { idempotencyKey: `reset:${context.invocation.id}`, signal: context.signal });
      result = { clearedAt, log: log.path, state: 'cleared' };
    } catch (error) {
      result = {
        clearedAt,
        log: log.path,
        state: 'unavailable',
        stateReason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Text>{`Cleared ${log.path}; durable state ${result.state}.`}</Agent.Text>
    </Agent.Result>
  );
}
