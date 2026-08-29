import { expect, test } from '@rstest/core';

import { readFinalizedEvalRun } from '../src/evals/evals-page.tsx';

test('retries a terminal canonical read until the durable run finalization is visible', async () => {
  let reads = 0;
  const waits: number[] = [];
  const result = await readFinalizedEvalRun({
    client: {
      read: async () => ++reads === 1
        ? { run: { completedAt: undefined } } as never
        : { run: { completedAt: '2026-08-18T00:00:02.000Z' } } as never,
    },
    runId: 'run-terminal-race',
    signal: new AbortController().signal,
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  expect(reads).toBe(2);
  expect(waits).toHaveLength(1);
  expect(result.run.completedAt).toBe('2026-08-18T00:00:02.000Z');
});

test('surfaces a terminal canonical-read error without retrying it', async () => {
  let reads = 0;
  let waits = 0;

  await expect(readFinalizedEvalRun({
    client: { read: async () => { reads += 1; throw new Error('invalid durable DTO'); } },
    runId: 'run-terminal-error',
    signal: new AbortController().signal,
    wait: async () => { waits += 1; },
  })).rejects.toThrow('invalid durable DTO');

  expect(reads).toBe(1);
  expect(waits).toBe(0);
});

test('stops bounded terminal finalization polling instead of looping forever', async () => {
  let reads = 0;
  let waits = 0;

  await expect(readFinalizedEvalRun({
    client: { read: async () => { reads += 1; return { run: { completedAt: undefined } } as never; } },
    runId: 'run-terminal-timeout',
    signal: new AbortController().signal,
    wait: async () => { waits += 1; },
  })).rejects.toThrow('Recorded eval results were not finalized in time.');

  expect(reads).toBe(8);
  expect(waits).toBe(7);
});
