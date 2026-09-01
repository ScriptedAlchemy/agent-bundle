import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { Context, Duration, Effect, Layer } from 'effect';
import { z } from 'zod';

import { makeScopedEffectRuntime, runPromise, type ScopedEffectRuntime } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';

const EVENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
const MAX_EVENT_MESSAGE_BYTES = 1024 * 1024;

export type EventRuntimeTransportErrorCode =
  | 'epoch-mismatch'
  | 'invalid-message'
  | 'runtime-failed'
  | 'runtime-timeout'
  | 'runtime-unavailable';

export class EventRuntimeTransportError extends Error {
  readonly code: EventRuntimeTransportErrorCode;

  constructor(code: EventRuntimeTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'EventRuntimeTransportError';
  }
}

const eventRequestSchema = z.object({
  artifactEpoch: z.string().min(1),
  event: z.string().min(1),
  hostContractRevision: z.string().min(1),
  native: z.record(z.string(), z.unknown()),
  protocolVersion: z.literal(EVENT_RUNTIME_PROTOCOL_VERSION),
  target: z.string().min(1),
}).strict();

const eventResponseSchema = z.discriminatedUnion('status', [
  z.object({
    artifactEpoch: z.string().min(1),
    output: z.unknown().optional(),
    protocolVersion: z.literal(EVENT_RUNTIME_PROTOCOL_VERSION),
    status: z.literal('ok'),
  }).strict(),
  z.object({
    artifactEpoch: z.string().min(1),
    code: z.enum(['epoch-mismatch', 'invalid-message', 'runtime-failed']),
    message: z.string(),
    protocolVersion: z.literal(EVENT_RUNTIME_PROTOCOL_VERSION),
    status: z.literal('error'),
  }).strict(),
]);

export interface EventRuntimeRequest {
  readonly artifactEpoch: string;
  readonly event: string;
  readonly hostContractRevision: string;
  readonly native: Readonly<Record<string, unknown>>;
  readonly target: string;
}

export interface CreateEventRuntimeServerOptions {
  readonly artifactEpoch: string;
  readonly endpointId: string;
  readonly handle: (request: EventRuntimeRequest) => Promise<unknown>;
}

export interface EventRuntimeServer {
  readonly close: () => Promise<void>;
  readonly endpoint: string;
}

export interface RequestEventRuntimeOptions extends EventRuntimeRequest {
  readonly endpointId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export const eventRuntimeEndpoint = (endpointId: string): string => {
  const hash = createHash('sha256').update(endpointId, 'utf8').digest('hex').slice(0, 32);
  if (process.platform === 'win32') return `\\\\.\\pipe\\agent-bundle-event-${hash}`;
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join('/tmp', `agent-bundle-${user}`, `event-${hash}.sock`);
};

const transportError = (
  code: EventRuntimeTransportErrorCode,
  message: string,
  cause?: unknown,
): EventRuntimeTransportError => new EventRuntimeTransportError(
  code,
  message,
  cause === undefined ? undefined : { cause },
);

const writeResponse = (socket: Socket, value: unknown): void => {
  if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
};

const readOneMessage = Effect.fnUntraced(function*(
  socket: Socket,
): Effect.fn.Return<unknown, EventRuntimeTransportError> {
  return yield* Effect.callback<unknown, EventRuntimeTransportError>((resume) => {
    let raw = '';
    const cleanup = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
    };
    const finish = (effect: Effect.Effect<unknown, EventRuntimeTransportError>): void => {
      cleanup();
      resume(effect);
    };
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > MAX_EVENT_MESSAGE_BYTES) {
        finish(Effect.fail(transportError('invalid-message', 'Event runtime message exceeds the 1 MiB limit.')));
        socket.destroy();
      }
    };
    const onEnd = (): void => {
      try {
        finish(Effect.succeed(JSON.parse(raw)));
      } catch (error) {
        finish(Effect.fail(transportError('invalid-message', 'Event runtime message must be one JSON value.', error)));
      }
    };
    const onError = (error: Error): void => {
      finish(Effect.fail(transportError('runtime-failed', 'Event runtime socket failed.', error)));
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    return Effect.sync(() => {
      cleanup();
      socket.destroy();
    });
  });
});

const handleConnection = Effect.fnUntraced(function*(
  socket: Socket,
  options: CreateEventRuntimeServerOptions,
): Effect.fn.Return<void, never> {
  const raw = yield* readOneMessage(socket).pipe(Effect.exit);
  if (raw._tag === 'Failure') {
    writeResponse(socket, {
      artifactEpoch: options.artifactEpoch,
      code: 'invalid-message',
      message: 'Event runtime request is invalid.',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      status: 'error',
    });
    return;
  }
  const parsed = eventRequestSchema.safeParse(raw.value);
  if (!parsed.success) {
    writeResponse(socket, {
      artifactEpoch: options.artifactEpoch,
      code: 'invalid-message',
      message: 'Event runtime request does not match the wire schema.',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      status: 'error',
    });
    return;
  }
  if (parsed.data.artifactEpoch !== options.artifactEpoch) {
    writeResponse(socket, {
      artifactEpoch: options.artifactEpoch,
      code: 'epoch-mismatch',
      message: 'Event runtime artifact epoch does not match the hook client.',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      status: 'error',
    });
    return;
  }
  const handled = yield* liftPromise(() => options.handle({
    artifactEpoch: parsed.data.artifactEpoch,
    event: parsed.data.event,
    hostContractRevision: parsed.data.hostContractRevision,
    native: parsed.data.native,
    target: parsed.data.target,
  })).pipe(Effect.exit);
  if (handled._tag === 'Failure') {
    writeResponse(socket, {
      artifactEpoch: options.artifactEpoch,
      code: 'runtime-failed',
      message: 'Event route rendering failed.',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      status: 'error',
    });
    return;
  }
  writeResponse(socket, {
    artifactEpoch: options.artifactEpoch,
    output: handled.value,
    protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
    status: 'ok',
  });
});

interface EventSocketServiceShape {
  readonly endpoint: string;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

class EventSocketService extends Context.Service<EventSocketService, EventSocketServiceShape>()(
  'agent-bundle/events/EventSocketService',
) {}

const openServer = (
  options: CreateEventRuntimeServerOptions,
): Effect.Effect<EventSocketServiceShape, EventRuntimeTransportError> => Effect.gen(function*() {
  const endpoint = eventRuntimeEndpoint(options.endpointId);
  if (process.platform !== 'win32') {
    yield* liftPromise(async () => {
      await mkdir(dirname(endpoint), { mode: 0o700, recursive: true });
      await chmod(dirname(endpoint), 0o700);
      await rm(endpoint, { force: true });
    }).pipe(
      Effect.mapError((error) => transportError('runtime-failed', 'Unable to prepare the event runtime endpoint.', error)),
    );
  }
  return yield* Effect.callback<EventSocketServiceShape, EventRuntimeTransportError>((resume) => {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      void runPromise(handleConnection(socket, options));
    });
    const onError = (error: Error): void => {
      resume(Effect.fail(transportError('runtime-failed', 'Unable to listen on the event runtime endpoint.', error)));
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.removeListener('error', onError);
      if (process.platform === 'win32') {
        resume(Effect.succeed({ endpoint, server, sockets }));
        return;
      }
      void chmod(endpoint, 0o600).then(
        () => resume(Effect.succeed({ endpoint, server, sockets })),
        (error: unknown) => {
          server.close();
          resume(Effect.fail(transportError('runtime-failed', 'Unable to secure the event runtime endpoint.', error)));
        },
      );
    });
    return Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
  });
});

const closeServer = (service: EventSocketServiceShape): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    for (const socket of service.sockets) socket.destroy();
    if (!service.server.listening) {
      resume(Effect.void);
      return undefined;
    }
    service.server.close(() => resume(Effect.void));
    return undefined;
  }).pipe(
    Effect.ensuring(
      process.platform === 'win32'
        ? Effect.void
        : liftPromise(() => rm(service.endpoint, { force: true })).pipe(Effect.ignore),
    ),
  );

const eventSocketLayer = (options: CreateEventRuntimeServerOptions): Layer.Layer<EventSocketService, EventRuntimeTransportError> =>
  Layer.effect(EventSocketService, Effect.acquireRelease(openServer(options), closeServer));

export const createEventRuntimeServer = async (
  options: CreateEventRuntimeServerOptions,
): Promise<EventRuntimeServer> => {
  const runtime: ScopedEffectRuntime<EventSocketService> = makeScopedEffectRuntime(eventSocketLayer(options));
  const service = await runtime.run(EventSocketService);
  return Object.freeze({
    close: () => runtime.close(),
    endpoint: service.endpoint,
  });
};

const connect = (endpoint: string): Effect.Effect<Socket, EventRuntimeTransportError> =>
  Effect.callback<Socket, EventRuntimeTransportError>((resume) => {
    const socket = createConnection(endpoint);
    const onConnect = (): void => {
      socket.removeListener('error', onError);
      resume(Effect.succeed(socket));
    };
    const onError = (error: Error): void => {
      socket.removeListener('connect', onConnect);
      resume(Effect.fail(transportError('runtime-unavailable', 'Shared event runtime is unavailable.', error)));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    return Effect.sync(() => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      socket.destroy();
    });
  });

const requestProgram = (
  options: RequestEventRuntimeOptions,
): Effect.Effect<unknown, EventRuntimeTransportError> => Effect.acquireUseRelease(
  connect(eventRuntimeEndpoint(options.endpointId)),
  (socket) => Effect.gen(function*() {
    socket.end(`${JSON.stringify({
      artifactEpoch: options.artifactEpoch,
      event: options.event,
      hostContractRevision: options.hostContractRevision,
      native: options.native,
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      target: options.target,
    })}\n`);
    const raw = yield* readOneMessage(socket);
    const response = eventResponseSchema.safeParse(raw);
    if (!response.success) {
      return yield* Effect.fail(transportError('invalid-message', 'Event runtime response does not match the wire schema.'));
    }
    if (response.data.artifactEpoch !== options.artifactEpoch || response.data.status === 'error' && response.data.code === 'epoch-mismatch') {
      return yield* Effect.fail(transportError('epoch-mismatch', 'Shared event runtime artifact epoch mismatch.'));
    }
    if (response.data.status === 'error') {
      return yield* Effect.fail(transportError('runtime-failed', response.data.message));
    }
    return response.data.output;
  }),
  (socket) => Effect.sync(() => socket.destroy()),
).pipe(
  Effect.raceFirst(
    Effect.sleep(Duration.millis(options.timeoutMs)).pipe(
      Effect.andThen(Effect.fail(transportError('runtime-timeout', 'Shared event runtime exceeded its deadline.'))),
    ),
  ),
);

export const requestEventRuntime = async (
  options: RequestEventRuntimeOptions,
): Promise<unknown> => runPromise(requestProgram(options), { signal: options.signal });
