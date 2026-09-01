import { describe, expect, it } from '@rstest/core';

import {
  AgentRuntimeError,
  createWarmFlightHost,
  type AgentFlightExecutionHost,
  type AgentRenderDispatch,
} from '../src/index.js';

const invocation = {
  kind: 'tool' as const,
  props: { input: {}, operationId: 'warmth' },
};

const dispatch = (overrides: Partial<AgentRenderDispatch> = {}): AgentRenderDispatch => ({
  invocation,
  signal: new AbortController().signal,
  ...overrides,
});

const emptyFlight = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

describe('createWarmFlightHost', () => {
  it('serves consecutive requests from one process-lifetime identity', async () => {
    let executes = 0;
    const inner: AgentFlightExecutionHost = {
      execute: async () => {
        executes += 1;
        return emptyFlight();
      },
    };
    const host = createWarmFlightHost({ artifactEpoch: 'epoch-a', host: inner, instanceId: 'runtime-1' });

    await host.execute(dispatch());
    await host.execute(dispatch());

    expect(executes).toBe(2);
    expect(host.identity).toEqual({ artifactEpoch: 'epoch-a', instanceId: 'runtime-1' });
  });

  it('fails closed on artifact-epoch mismatch with a typed error', async () => {
    let executes = 0;
    const host = createWarmFlightHost({
      artifactEpoch: 'epoch-a',
      host: {
        execute: async () => {
          executes += 1;
          return emptyFlight();
        },
      },
    });

    await expect(host.execute(dispatch({ artifactEpoch: 'epoch-b' }))).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(host.execute(dispatch({ artifactEpoch: 'epoch-b' }))).rejects.toMatchObject({
      code: 'artifact-epoch-mismatch',
      expectedEpoch: 'epoch-a',
      receivedEpoch: 'epoch-b',
    });
    expect(executes).toBe(0);
    await expect(host.execute(dispatch({ artifactEpoch: 'epoch-a' }))).resolves.toBeDefined();
    expect(executes).toBe(1);
  });

  it('fails closed after a runtime restart and never fabricates success', async () => {
    const host = createWarmFlightHost({
      artifactEpoch: 'epoch-a',
      host: { execute: async () => emptyFlight() },
    });

    await host.execute(dispatch());
    host.markUnavailable('runtime-restarted');

    await expect(host.execute(dispatch())).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(host.execute(dispatch())).rejects.toMatchObject({ code: 'runtime-restarted' });
  });

  it('yields a typed unavailable error when the runtime is missing', async () => {
    const host = createWarmFlightHost({
      artifactEpoch: 'epoch-a',
      host: { execute: async () => emptyFlight() },
    });
    host.markUnavailable('runtime-unavailable');

    await expect(host.execute(dispatch())).rejects.toBeInstanceOf(AgentRuntimeError);
    await expect(host.execute(dispatch())).rejects.toMatchObject({ code: 'runtime-unavailable' });
  });
});
