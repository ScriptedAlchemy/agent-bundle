import { stat } from 'node:fs/promises';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  createEventRuntimeServer,
  EventRuntimeTransportError,
  requestEventRuntime,
} from '../src/events/ipc.ts';

it.live('round-trips a bounded event envelope through the epoch-bound runtime socket', () => Effect.gen(function*() {
  const endpointId = `event-ipc-${crypto.randomUUID()}`;
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async (request) => ({
        echoed: request.native,
        event: request.event,
      }),
    })),
    (server) => Effect.promise(() => server.close()),
  );

  if (process.platform !== 'win32') {
    const endpoint = yield* Effect.promise(() => stat(server.endpoint));
    expect(endpoint.mode & 0o777).toBe(0o600);
  }
  const response = yield* Effect.promise(() => requestEventRuntime({
    artifactEpoch: 'epoch-1',
    endpointId,
    event: 'tool/after',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    signal: new AbortController().signal,
    target: 'claude',
    timeoutMs: 1_000,
  }));
  expect(response).toEqual({
    echoed: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    event: 'tool/after',
  });
}));

it.live('fails closed on artifact epoch mismatch and missing runtimes', () => Effect.gen(function*() {
  const endpointId = `event-ipc-${crypto.randomUUID()}`;
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.promise(() => createEventRuntimeServer({
        artifactEpoch: 'epoch-1',
        endpointId,
        handle: async () => undefined,
      })),
      (server) => Effect.promise(() => server.close()),
    );

    const mismatch = yield* Effect.tryPromise({
      try: () => requestEventRuntime({
        artifactEpoch: 'epoch-2',
        endpointId,
        event: 'session/start',
        hostContractRevision: '2.1.250',
        native: { hook_event_name: 'SessionStart' },
        signal: new AbortController().signal,
        target: 'claude',
        timeoutMs: 1_000,
      }),
      catch: (error) => error,
    }).pipe(Effect.flip);
    expect(mismatch).toMatchObject({
      code: 'epoch-mismatch',
      name: EventRuntimeTransportError.name,
    });
  }));

  const unavailable = yield* Effect.tryPromise({
    try: () => requestEventRuntime({
      artifactEpoch: 'epoch-1',
      endpointId,
      event: 'session/start',
      hostContractRevision: '2.1.250',
      native: { hook_event_name: 'SessionStart' },
      signal: new AbortController().signal,
      target: 'claude',
      timeoutMs: 100,
    }),
    catch: (error) => error,
  }).pipe(Effect.flip);
  expect(unavailable).toMatchObject({
    code: 'runtime-unavailable',
    name: EventRuntimeTransportError.name,
  });
}));
