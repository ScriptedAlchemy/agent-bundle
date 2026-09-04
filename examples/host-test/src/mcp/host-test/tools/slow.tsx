import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { capture } from '../../../capture.js';

/** The longest hold a single call may ask for; hosts bound tool calls well above this. */
export const MAX_SLOW_HOLD_MS = 30_000;

export const config = {
  annotations: { readOnlyHint: true },
  description:
    'Hold a tool call open for holdMs (at most 30 s), reporting progress every tickMs, to probe how the host drives a long-running tool: whether it runs it as an MCP task (tools/call answered by a task, result through tasks/result), whether it forwards progress, and when it gives up. Records the call like every other probe.',
  // The 2025-11-25 Tasks utility: a task-aware host may run this call as a
  // task and poll it; a host that never asks gets the ordinary result.
  execution: { taskSupport: 'optional' },
} satisfies ToolConfig;

export const inputSchema = z.object({
  holdMs: z.number().int().min(1).max(MAX_SLOW_HOLD_MS).default(3000)
    .describe('How long the call stays open, in milliseconds (1–30000).'),
  tickMs: z.number().int().min(50).max(MAX_SLOW_HOLD_MS).default(500)
    .describe('Report progress every tickMs milliseconds.'),
}).strict();

export const resultSchema = z.object({
  heldMs: z.number().int().nonnegative(),
  log: z.string(),
  ticks: z.number().int().nonnegative(),
}).strict();

const sleep = (ms: number, signal: AbortSignal): Promise<'aborted' | 'elapsed'> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve('aborted');
    return;
  }
  const timer = setTimeout(() => resolve('elapsed'), ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    resolve('aborted');
  }, { once: true });
});

export default async function Slow({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const observed = await capture({ kind: 'mcp', observed: { holdMs: input.holdMs, tickMs: input.tickMs, tool: 'slow' } });
  const { progress } = await agent();
  const total = Math.ceil(input.holdMs / input.tickMs);
  const startedAt = Date.now();
  let ticks = 0;
  while (ticks < total) {
    const slice = Math.min(input.tickMs, input.holdMs - ticks * input.tickMs);
    if (await sleep(slice, signal) === 'aborted') {
      // The host (or a tasks/cancel) gave up: end the call the way an aborted request ends.
      throw new DOMException('The slow probe was aborted', 'AbortError');
    }
    ticks += 1;
    await progress.report({ completed: ticks, message: `held ${String(ticks * input.tickMs)}ms`, total });
  }
  const result: z.output<typeof resultSchema> = { heldMs: Date.now() - startedAt, log: observed.log.path, ticks };
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Text>{`Held the call for ${String(result.heldMs)}ms across ${String(ticks)} progress ticks; recorded in ${observed.log.path}.`}</Agent.Text>
    </Agent.Result>
  );
}
