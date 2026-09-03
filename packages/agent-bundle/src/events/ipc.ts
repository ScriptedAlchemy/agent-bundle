import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { Context, Duration, Effect, Layer } from 'effect';
import { z } from 'zod';

import { isAbortError, makeScopedEffectRuntime, runPromise, type ScopedEffectRuntime } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';

const EVENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
const MAX_EVENT_MESSAGE_BYTES = 1024 * 1024;
const ENDPOINT_CLAIM_RETRY_COUNT = 100;
const ENDPOINT_CLAIM_RETRY_DELAY = Duration.millis(10);

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

const eventStatusRequestSchema = z.object({
  kind: z.literal('status'),
  protocolVersion: z.literal(EVENT_RUNTIME_PROTOCOL_VERSION),
}).strict();

const runtimeAvailabilitySchema = z.enum(['available', 'runtime-restarted', 'runtime-unavailable']);
const eventRuntimeStatusPayloadSchema = z.object({
  artifactEpoch: z.string().min(1),
  availability: runtimeAvailabilitySchema,
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).optional(),
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

const eventStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({
    kind: z.literal('status'),
    protocolVersion: z.literal(EVENT_RUNTIME_PROTOCOL_VERSION),
    runtime: eventRuntimeStatusPayloadSchema,
    status: z.literal('ok'),
  }).strict(),
  z.object({
    artifactEpoch: z.string().min(1),
    code: z.literal('invalid-message'),
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

export type EventRuntimeAvailability = z.infer<typeof runtimeAvailabilitySchema>;
export interface EventRuntimeStatus {
  readonly artifactEpoch: string;
  readonly availability: EventRuntimeAvailability;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt?: string;
}

export interface CreateEventRuntimeServerOptions {
  readonly artifactEpoch: string;
  readonly endpointId: string;
  readonly handle: (request: EventRuntimeRequest, signal: AbortSignal) => Promise<unknown>;
  readonly status?: () => EventRuntimeStatus;
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

export type RequestEventRuntimeStatusOptions = Readonly<{
  readonly timeoutMs: number;
}> & (
  | Readonly<{ readonly endpoint: string; readonly endpointId?: never }>
  | Readonly<{ readonly endpoint?: never; readonly endpointId: string }>
);

export type EventRuntimeStatusResult =
  | Readonly<EventRuntimeStatus & { readonly status: 'available' }>
  | Readonly<{ readonly status: 'unavailable' | 'unsupported' }>;

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
    const decoder = new StringDecoder('utf8');
    let receivedBytes = 0;
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
    const parse = (message: string): void => {
      try {
        finish(Effect.succeed(JSON.parse(message)));
      } catch (error) {
        finish(Effect.fail(transportError('invalid-message', 'Event runtime message must be one JSON value.', error)));
      }
    };
    const onData = (chunk: Buffer): void => {
      receivedBytes += chunk.byteLength;
      raw += decoder.write(chunk);
      if (receivedBytes > MAX_EVENT_MESSAGE_BYTES) {
        finish(Effect.fail(transportError('invalid-message', 'Event runtime message exceeds the 1 MiB limit.')));
        socket.destroy();
        return;
      }
      const delimiter = raw.indexOf('\n');
      if (delimiter !== -1) parse(raw.slice(0, delimiter));
    };
    const onEnd = (): void => {
      raw += decoder.end();
      parse(raw);
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
  signal: AbortSignal,
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
  const statusRequest = eventStatusRequestSchema.safeParse(raw.value);
  if (statusRequest.success) {
    if (options.status === undefined) {
      writeResponse(socket, {
        artifactEpoch: options.artifactEpoch,
        code: 'invalid-message',
        message: 'Event runtime request does not match the wire schema.',
        protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
        status: 'error',
      });
      return;
    }
    writeResponse(socket, {
      kind: 'status',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
      runtime: options.status(),
      status: 'ok',
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
  }, signal)).pipe(Effect.exit);
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
  readonly endpointIdentity?: Readonly<{ readonly device: number; readonly inode: number }>;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

class EventSocketService extends Context.Service<EventSocketService, EventSocketServiceShape>()(
  'agent-bundle/events/EventSocketService',
) {}

type EndpointProbe = 'live' | 'missing' | 'stale';

export interface EventRuntimeServerTestHooks {
  readonly afterEndpointProbe?: (state: EndpointProbe) => Promise<void>;
  readonly afterEndpointClaimAcquired?: () => Promise<void>;
  readonly afterEndpointClaimReclamation?: (removed: boolean) => Promise<void>;
  readonly afterEndpointClaimReclamationSnapshot?: (
    identity: Readonly<{ readonly device: number; readonly inode: number }>,
  ) => Promise<void>;
  readonly beforeEndpointClaimRemoval?: () => Promise<void>;
}

interface EndpointClaim {
  readonly handle: FileHandle;
  readonly identity: Readonly<{ readonly device: number; readonly inode: number }>;
  readonly path: string;
}

interface EndpointClaimOwner {
  readonly linuxStartTime?: string;
  readonly pid: number;
}

interface EndpointClaimSnapshot {
  readonly identity: Readonly<{ readonly device: number; readonly inode: number }>;
  readonly owner: EndpointClaimOwner;
}

interface LinuxProcessStat {
  readonly startTime: string;
  readonly state: string;
}

const endpointClaimOwnerSchema = z.object({
  linuxStartTime: z.string().regex(/^\d+$/u).optional(),
  pid: z.number().int().positive(),
}).strict();

const probeEndpoint = (endpoint: string): Effect.Effect<EndpointProbe, EventRuntimeTransportError> =>
  Effect.callback<EndpointProbe, EventRuntimeTransportError>((resume) => {
    const socket = createConnection(endpoint);
    const cleanup = (): void => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };
    const finish = (effect: Effect.Effect<EndpointProbe, EventRuntimeTransportError>): void => {
      cleanup();
      socket.destroy();
      resume(effect);
    };
    const onConnect = (): void => {
      finish(Effect.succeed('live'));
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'ENOENT') {
        finish(Effect.succeed('missing'));
        return;
      }
      if (error.code === 'ECONNREFUSED') {
        finish(Effect.succeed('stale'));
        return;
      }
      finish(Effect.fail(transportError(
        'runtime-failed',
        'Unable to inspect the existing event runtime endpoint.',
        error,
      )));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    return Effect.sync(() => {
      cleanup();
      socket.destroy();
    });
  });

const linuxProcessStat = async (pid: number): Promise<LinuxProcessStat> => {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const commEnd = processStat.lastIndexOf(')');
  if (commEnd === -1) throw new Error(`Unable to parse process stat for pid ${pid}.`);
  const fieldsAfterComm = processStat.slice(commEnd + 1).trim().split(/\s+/u);
  const state = fieldsAfterComm[0];
  const startTime = fieldsAfterComm[19];
  if (state === undefined) throw new Error(`Process stat for pid ${pid} has no state.`);
  if (startTime === undefined) throw new Error(`Process stat for pid ${pid} has no start time.`);
  return { startTime, state };
};

const linuxProcessStartTime = async (pid: number): Promise<string> => (await linuxProcessStat(pid)).startTime;

const currentEndpointClaimOwner = async (): Promise<EndpointClaimOwner> => ({
  ...(process.platform === 'linux' ? { linuxStartTime: await linuxProcessStartTime(process.pid) } : {}),
  pid: process.pid,
});

const removeFileIfIdentityMatches = async (
  path: string,
  identity: Readonly<{ readonly device: number; readonly inode: number }>,
): Promise<boolean> => {
  let current;
  try {
    current = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (current.dev !== identity.device || current.ino !== identity.inode) return false;
  await rm(path, { force: true });
  return true;
};

const tryClaimEndpoint = (
  endpoint: string,
): Effect.Effect<EndpointClaim | undefined, EventRuntimeTransportError> =>
  liftPromise(async () => {
    const path = `${endpoint}.lock`;
    const owner = await currentEndpointClaimOwner();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      const lockStat = await handle.stat();
      return {
        handle,
        identity: { device: lockStat.dev, inode: lockStat.ino },
        path,
      };
    } catch (error) {
      if (handle !== undefined) {
        const lockStat = await handle.stat().catch(() => undefined);
        await handle.close();
        if (lockStat !== undefined) {
          await removeFileIfIdentityMatches(path, { device: lockStat.dev, inode: lockStat.ino });
        }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }
  }).pipe(
    Effect.mapError((error) => transportError('runtime-failed', 'Unable to claim the event runtime endpoint.', error)),
  );

const readEndpointClaimSnapshot = async (path: string): Promise<EndpointClaimSnapshot | 'missing' | undefined> => {
  try {
    const handle = await open(path, 'r');
    try {
      const rawOwner = await handle.readFile('utf8');
      const lockStat = await handle.stat();
      const owner = endpointClaimOwnerSchema.safeParse(JSON.parse(rawOwner));
      if (!owner.success) return undefined;
      return {
        identity: { device: lockStat.dev, inode: lockStat.ino },
        owner: owner.data,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return undefined;
  }
};

const isEndpointClaimOwnerProvablyDead = async (owner: EndpointClaimOwner): Promise<boolean> => {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code !== 'EPERM') return false;
  }
  if (process.platform !== 'linux' || owner.linuxStartTime === undefined) return false;
  try {
    const processStat = await linuxProcessStat(owner.pid);
    return processStat.state === 'Z'
      || processStat.state === 'X'
      || processStat.state === 'x'
      || processStat.startTime !== owner.linuxStartTime;
  } catch {
    return false;
  }
};

const endpointRecoveryGate = (endpoint: string): string => {
  const hash = createHash('sha256').update(endpoint, 'utf8').digest('hex').slice(0, 32);
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return `\0agent-bundle-${user}-event-recovery-${hash}`;
};

const tryAcquireEndpointRecoveryGate = (
  endpoint: string,
): Effect.Effect<Server | undefined, EventRuntimeTransportError> =>
  Effect.callback<Server | undefined, EventRuntimeTransportError>((resume) => {
    const server = createServer();
    const cleanup = (): void => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.code === 'EADDRINUSE') {
        resume(Effect.succeed(undefined));
        return;
      }
      resume(Effect.fail(transportError(
        'runtime-failed',
        'Unable to claim the event runtime recovery gate.',
        error,
      )));
    };
    const onListening = (): void => {
      cleanup();
      resume(Effect.succeed(server));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpointRecoveryGate(endpoint));
    return Effect.sync(() => {
      cleanup();
      if (server.listening) server.close();
    });
  });

const releaseEndpointRecoveryGate = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return undefined;
    }
    server.close(() => resume(Effect.void));
    return undefined;
  }).pipe(Effect.ignore);

const reclaimOrphanedEndpointClaim = Effect.fnUntraced(function*(
  endpoint: string,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<boolean, EventRuntimeTransportError> {
  const path = `${endpoint}.lock`;
  const snapshot = yield* liftPromise(async () => {
    const candidate = await readEndpointClaimSnapshot(path);
    if (candidate === 'missing') return 'missing' as const;
    if (candidate === undefined || !await isEndpointClaimOwnerProvablyDead(candidate.owner)) return undefined;
    return candidate;
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (snapshot === 'missing') return true;
  if (snapshot === undefined) return false;

  const afterSnapshot = testHooks?.afterEndpointClaimReclamationSnapshot;
  if (afterSnapshot !== undefined) {
    yield* liftPromise(() => afterSnapshot(snapshot.identity)).pipe(
      Effect.mapError((error) => transportError('runtime-failed', 'Event runtime claim snapshot hook failed.', error)),
    );
  }

  let removed: boolean;
  if (process.platform !== 'linux') {
    // Other POSIX platforms retain the existing identity-checked fallback:
    // Node exposes no auto-released filesystem gate, and a pathname gate can
    // itself become an unrecoverable orphan.
    removed = yield* liftPromise(() => removeFileIfIdentityMatches(path, snapshot.identity)).pipe(
      Effect.catch(() => Effect.succeed(false)),
    );
  } else {
    // Abstract socket binds serialize every Linux reclamation vacancy and are
    // released by the kernel on process death. A namespace squatter can only
    // force bounded fail-closed retries, never concurrent claim ownership.
    removed = yield* Effect.acquireUseRelease(
      tryAcquireEndpointRecoveryGate(endpoint),
      (gate) => {
        if (gate === undefined) return Effect.succeed(false);
        return Effect.gen(function*() {
          const freshSnapshot = yield* liftPromise(async () => {
            const candidate = await readEndpointClaimSnapshot(path);
            if (candidate === 'missing') return 'missing' as const;
            if (candidate === undefined || !await isEndpointClaimOwnerProvablyDead(candidate.owner)) return undefined;
            return candidate;
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (freshSnapshot === 'missing') return true;
          if (freshSnapshot === undefined) return false;

          const beforeRemoval = testHooks?.beforeEndpointClaimRemoval;
          if (beforeRemoval !== undefined) {
            yield* liftPromise(beforeRemoval).pipe(
              Effect.mapError((error) => transportError('runtime-failed', 'Event runtime claim removal hook failed.', error)),
            );
          }
          return yield* liftPromise(() => removeFileIfIdentityMatches(path, freshSnapshot.identity)).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
        });
      },
      (gate) => gate === undefined ? Effect.void : releaseEndpointRecoveryGate(gate),
    );
  }

  const afterReclamation = testHooks?.afterEndpointClaimReclamation;
  if (afterReclamation !== undefined) {
    yield* liftPromise(() => afterReclamation(removed)).pipe(
      Effect.mapError((error) => transportError('runtime-failed', 'Event runtime claim reclamation hook failed.', error)),
    );
  }
  return removed;
});

const releaseEndpointClaim = (claim: EndpointClaim): Effect.Effect<void> =>
  liftPromise(async () => {
    await claim.handle.close();
    await removeFileIfIdentityMatches(claim.path, claim.identity);
  }).pipe(Effect.ignore);

const claimEndpoint = Effect.fnUntraced(function*(
  endpoint: string,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<EndpointClaim, EventRuntimeTransportError> {
  for (let attempt = 0; attempt < ENDPOINT_CLAIM_RETRY_COUNT; attempt += 1) {
    const claim = yield* tryClaimEndpoint(endpoint);
    if (claim !== undefined) {
      const afterClaimAcquired = testHooks?.afterEndpointClaimAcquired;
      if (afterClaimAcquired !== undefined) {
        yield* liftPromise(afterClaimAcquired).pipe(
          Effect.mapError((error) => transportError('runtime-failed', 'Event runtime claim hook failed.', error)),
        );
      }
      return claim;
    }

    const endpointState = yield* probeEndpoint(endpoint);
    if (endpointState === 'live') {
      return yield* Effect.fail(transportError(
        'runtime-failed',
        'Event runtime endpoint already has a live server.',
      ));
    }
    if (yield* reclaimOrphanedEndpointClaim(endpoint, testHooks)) continue;
    if (attempt + 1 < ENDPOINT_CLAIM_RETRY_COUNT) {
      yield* Effect.sleep(ENDPOINT_CLAIM_RETRY_DELAY);
    }
  }

  // Unverifiable claims remain fail-closed rather than being stolen.
  return yield* Effect.fail(transportError(
    'runtime-failed',
    'Event runtime endpoint claim did not clear after bounded retries.',
  ));
});

const listenServer = (
  options: CreateEventRuntimeServerOptions,
  endpoint: string,
): Effect.Effect<EventSocketServiceShape, EventRuntimeTransportError> =>
  Effect.callback<EventSocketServiceShape, EventRuntimeTransportError>((resume) => {
    const sockets = new Set<Socket>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const controller = new AbortController();
      const interrupt = (): void => controller.abort();
      socket.once('close', interrupt);
      socket.once('end', interrupt);
      socket.once('error', interrupt);
      void runPromise(handleConnection(socket, options, controller.signal), { signal: controller.signal })
        .catch((error: unknown) => {
          if (!isAbortError(error)) throw error;
        })
        .finally(() => {
          socket.removeListener('close', interrupt);
          socket.removeListener('end', interrupt);
          socket.removeListener('error', interrupt);
        });
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
      void chmod(endpoint, 0o600).then(() => stat(endpoint)).then(
        (endpointStat) => resume(Effect.succeed({
          endpoint,
          endpointIdentity: { device: endpointStat.dev, inode: endpointStat.ino },
          server,
          sockets,
        })),
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

const openServer = Effect.fnUntraced(function*(
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<EventSocketServiceShape, EventRuntimeTransportError> {
  const endpoint = eventRuntimeEndpoint(options.endpointId);
  if (process.platform === 'win32') return yield* listenServer(options, endpoint);

  yield* liftPromise(async () => {
    await mkdir(dirname(endpoint), { mode: 0o700, recursive: true });
    await chmod(dirname(endpoint), 0o700);
  }).pipe(
    Effect.mapError((error) => transportError('runtime-failed', 'Unable to prepare the event runtime endpoint.', error)),
  );
  const endpointState = yield* probeEndpoint(endpoint);
  const afterEndpointProbe = testHooks?.afterEndpointProbe;
  if (afterEndpointProbe !== undefined) {
    yield* liftPromise(() => afterEndpointProbe(endpointState)).pipe(
      Effect.mapError((error) => transportError('runtime-failed', 'Event runtime endpoint probe hook failed.', error)),
    );
  }
  if (endpointState === 'live') {
    return yield* Effect.fail(transportError(
      'runtime-failed',
      'Event runtime endpoint already has a live server.',
    ));
  }

  return yield* Effect.acquireUseRelease(
    claimEndpoint(endpoint, testHooks),
    () => Effect.gen(function*() {
      const claimedEndpointState = yield* probeEndpoint(endpoint);
      if (claimedEndpointState === 'live') {
        return yield* Effect.fail(transportError(
          'runtime-failed',
          'Event runtime endpoint already has a live server.',
        ));
      }
      if (claimedEndpointState === 'stale') {
        yield* liftPromise(() => rm(endpoint)).pipe(
          Effect.mapError((error) => transportError(
            'runtime-failed',
            'Unable to remove the stale event runtime endpoint.',
            error,
          )),
        );
      }
      return yield* listenServer(options, endpoint);
    }),
    releaseEndpointClaim,
  );
});

const removeOwnedEndpoint = (service: EventSocketServiceShape): Effect.Effect<void> =>
  liftPromise(async () => {
    if (service.endpointIdentity === undefined) return;
    let current;
    try {
      current = await stat(service.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (
      current.dev === service.endpointIdentity.device
      && current.ino === service.endpointIdentity.inode
    ) {
      await rm(service.endpoint, { force: true });
    }
  }).pipe(Effect.ignore);

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
        : removeOwnedEndpoint(service),
    ),
  );

const eventSocketLayer = (
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Layer.Layer<EventSocketService, EventRuntimeTransportError> =>
  Layer.effect(EventSocketService, Effect.acquireRelease(openServer(options, testHooks), closeServer));

const createEventRuntimeServerWithHooks = async (
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Promise<EventRuntimeServer> => {
  const runtime: ScopedEffectRuntime<EventSocketService> = makeScopedEffectRuntime(eventSocketLayer(options, testHooks));
  const service = await runtime.run(EventSocketService);
  return Object.freeze({
    close: () => runtime.close(),
    endpoint: service.endpoint,
  });
};

export const createEventRuntimeServer = async (
  options: CreateEventRuntimeServerOptions,
): Promise<EventRuntimeServer> => createEventRuntimeServerWithHooks(options);

export const createEventRuntimeServerForTest = async (
  options: CreateEventRuntimeServerOptions,
  testHooks: EventRuntimeServerTestHooks,
): Promise<EventRuntimeServer> => createEventRuntimeServerWithHooks(options, testHooks);

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
    socket.write(`${JSON.stringify({
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

const statusProgram = (
  options: RequestEventRuntimeStatusOptions,
): Effect.Effect<EventRuntimeStatusResult, EventRuntimeTransportError> => Effect.acquireUseRelease(
  connect(options.endpoint ?? eventRuntimeEndpoint(options.endpointId)),
  (socket) => Effect.gen(function*() {
    socket.write(`${JSON.stringify({
      kind: 'status',
      protocolVersion: EVENT_RUNTIME_PROTOCOL_VERSION,
    })}\n`);
    const raw = yield* readOneMessage(socket);
    const response = eventStatusResponseSchema.safeParse(raw);
    if (!response.success) {
      return yield* Effect.fail(transportError(
        'invalid-message',
        'Event runtime status response does not match the wire schema.',
      ));
    }
    if (response.data.status === 'error') return Object.freeze({ status: 'unsupported' as const });
    return Object.freeze({
      ...response.data.runtime,
      status: 'available' as const,
    });
  }),
  (socket) => Effect.sync(() => socket.destroy()),
).pipe(
  Effect.raceFirst(
    Effect.sleep(Duration.millis(options.timeoutMs)).pipe(
      Effect.andThen(Effect.fail(transportError('runtime-timeout', 'Event runtime status exceeded its deadline.'))),
    ),
  ),
  Effect.catch((error) => error.code === 'runtime-unavailable'
    ? Effect.succeed(Object.freeze({ status: 'unavailable' as const }))
    : Effect.fail(error)),
);

export const requestEventRuntimeStatus = async (
  options: RequestEventRuntimeStatusOptions,
): Promise<EventRuntimeStatusResult> => runPromise(statusProgram(options));
