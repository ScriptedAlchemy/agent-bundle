import { stat } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import {
  createEventRuntimeServer,
  EventRuntimeTransportError,
  requestEventRuntime,
} from '../src/events/ipc.ts';

it('round-trips a bounded event envelope through the epoch-bound runtime socket', async () => {
  const endpointId = `event-ipc-${crypto.randomUUID()}`;
  const server = await createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async (request) => ({
      echoed: request.native,
      event: request.event,
    }),
  });

  try {
    if (process.platform !== 'win32') {
      expect((await stat(server.endpoint)).mode & 0o777).toBe(0o600);
    }
    await expect(requestEventRuntime({
      artifactEpoch: 'epoch-1',
      endpointId,
      event: 'tool/after',
      hostContractRevision: '2.1.250',
      native: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
      signal: new AbortController().signal,
      target: 'claude',
      timeoutMs: 1_000,
    })).resolves.toEqual({
      echoed: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
      event: 'tool/after',
    });
  } finally {
    await server.close();
  }
});

it('fails closed on artifact epoch mismatch and missing runtimes', async () => {
  const endpointId = `event-ipc-${crypto.randomUUID()}`;
  const server = await createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => undefined,
  });

  try {
    await expect(requestEventRuntime({
      artifactEpoch: 'epoch-2',
      endpointId,
      event: 'session/start',
      hostContractRevision: '2.1.250',
      native: { hook_event_name: 'SessionStart' },
      signal: new AbortController().signal,
      target: 'claude',
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      code: 'epoch-mismatch',
      name: EventRuntimeTransportError.name,
    });
  } finally {
    await server.close();
  }

  await expect(requestEventRuntime({
    artifactEpoch: 'epoch-1',
    endpointId,
    event: 'session/start',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'SessionStart' },
    signal: new AbortController().signal,
    target: 'claude',
    timeoutMs: 100,
  })).rejects.toMatchObject({
    code: 'runtime-unavailable',
    name: EventRuntimeTransportError.name,
  });
});
