import { stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';

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

it.live('interrupts an in-flight event handler when the client disconnects', () => Effect.gen(function*() {
  const endpointId = `event-ipc-disconnect-${crypto.randomUUID()}`;
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async (_request, signal?: AbortSignal) => {
        markStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => {
            markAborted();
            resolve();
          }, { once: true });
        });
      },
    })),
    (server) => Effect.promise(() => server.close()),
  );
  const socket = yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(server.endpoint);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    })),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  socket.on('error', () => undefined);
  socket.write(`${JSON.stringify({
    artifactEpoch: 'epoch-1',
    event: 'tool/after',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'PostToolUse' },
    protocolVersion: 1,
    target: 'claude',
  })}\n`);
  yield* Effect.promise(() => started);
  socket.destroy();
  const observed = yield* Effect.promise(() => aborted);
  expect(observed).toBeUndefined();
}));

it.live('decodes a JSON request whose multibyte UTF-8 code point spans socket writes', () => Effect.gen(function*() {
  const endpointId = `event-ipc-utf8-${crypto.randomUUID()}`;
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async (request) => request.native['label'],
    })),
    (server) => Effect.promise(() => server.close()),
  );
  const socket = yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(server.endpoint);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    })),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const response = new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
  const request = Buffer.from(`${JSON.stringify({
    artifactEpoch: 'epoch-1',
    event: 'tool/after',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'PostToolUse', label: 'café 🚀' },
    protocolVersion: 1,
    target: 'claude',
  })}\n`, 'utf8');
  const codePoint = Buffer.from('🚀', 'utf8');
  const codePointOffset = request.indexOf(codePoint);
  expect(codePointOffset).toBeGreaterThanOrEqual(0);
  socket.write(request.subarray(0, codePointOffset + 1));
  socket.write(request.subarray(codePointOffset + 1));

  const output = yield* Effect.promise(() => response);
  expect(output).toMatchObject({
    output: 'café 🚀',
    status: 'ok',
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
