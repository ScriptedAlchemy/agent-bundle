import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

const maxHoldMs = 5000;

export const config = {
  description: 'Waits until aborted or holdMs elapses, for cancellation contract proof.',
  // The long-poll shape of #454: a route whose legitimate wait outlives the
  // runtime's default render session declares its own budget.
  render: { maxElapsedMs: 120_000 },
  title: 'Wait',
};

export const inputSchema = z.object({
  holdMs: z.number().int().positive().optional(),
  /** Report progress every `tickMs` while holding; omitted means no progress reports. */
  tickMs: z.number().int().positive().optional(),
});

export const resultSchema = z.object({ waitedMs: z.number().int().nonnegative() });

const waitForAbortOrTimeout = async (
  signal: AbortSignal,
  holdMs: number,
): Promise<'aborted' | 'elapsed'> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve('aborted');
    return;
  }
  const timeout = setTimeout(() => resolve('elapsed'), holdMs);
  signal.addEventListener('abort', () => {
    clearTimeout(timeout);
    resolve('aborted');
  }, { once: true });
});

export default async function Wait({
  input,
  signal,
}: {
  readonly input: z.infer<typeof inputSchema>;
  readonly signal: AbortSignal;
}) {
  const holdMs = Math.min(input.holdMs ?? maxHoldMs, maxHoldMs);
  let outcome: 'aborted' | 'elapsed';
  if (input.tickMs === undefined) {
    outcome = await waitForAbortOrTimeout(signal, holdMs);
  } else {
    const { progress } = await agent();
    const ticks = Math.ceil(holdMs / input.tickMs);
    outcome = 'elapsed';
    for (let tick = 0; tick < ticks; tick += 1) {
      const slice = Math.min(input.tickMs, holdMs - tick * input.tickMs);
      outcome = await waitForAbortOrTimeout(signal, slice);
      if (outcome === 'aborted') break;
      await progress.report({ completed: tick + 1, message: 'waiting', total: ticks });
    }
  }
  if (outcome === 'aborted') {
    throw new DOMException('Wait was aborted', 'AbortError');
  }
  return (
    <Agent.Result value={{ waitedMs: holdMs }}>
      <Agent.Text>{`waited ${String(holdMs)}ms`}</Agent.Text>
    </Agent.Result>
  );
}
