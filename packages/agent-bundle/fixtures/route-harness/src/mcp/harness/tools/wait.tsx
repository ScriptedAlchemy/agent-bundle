import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

const maxHoldMs = 5000;

export const config = {
  description: 'Waits until aborted or holdMs elapses, for cancellation contract proof.',
  title: 'Wait',
};

export const inputSchema = z.object({ holdMs: z.number().int().positive().optional() });

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
  const outcome = await waitForAbortOrTimeout(signal, holdMs);
  if (outcome === 'aborted') {
    throw new DOMException('Wait was aborted', 'AbortError');
  }
  return (
    <Agent.Result value={{ waitedMs: holdMs }}>
      <Agent.Text>{`waited ${String(holdMs)}ms`}</Agent.Text>
    </Agent.Result>
  );
}
