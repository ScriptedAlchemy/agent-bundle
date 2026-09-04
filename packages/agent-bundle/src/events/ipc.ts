import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, stat, type FileHandle } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { Context, Duration, Effect, Exit, Fiber, Layer, Random, Ref, type Scope } from 'effect';
import { z } from 'zod';

import { isAbortError, makeScopedEffectRuntime, runPromise, type ScopedEffectRuntime } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';

const EVENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
const MAX_EVENT_MESSAGE_BYTES = 1024 * 1024;
const ENDPOINT_CLAIM_RETRY_COUNT = 100;
const ENDPOINT_CLAIM_RETRY_DELAY = Duration.millis(10);
/**
 * How often a standby server asks whether the owner is still there. The
 * interval bounds the hook-visible gap after an owner exits (hooks see
 * `runtime-unavailable` until the takeover lands); the jitter keeps several
 * standbys from probing — and claiming — in lockstep.
 */
const STANDBY_PROBE_INTERVAL = Duration.seconds(1);
const STANDBY_PROBE_JITTER_MS = 250;

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

/**
 * The one `runtime-failed` outcome a standby server recovers from: a live
 * server answered on the endpoint. It is the same `EventRuntimeTransportError`
 * (code, message, and name) the fail-closed path has always thrown; the
 * subclass exists only so `whenOwned: 'standby'` can tell "owned elsewhere"
 * from a genuinely broken endpoint, which still fails.
 */
class EventRuntimeEndpointOwnedError extends EventRuntimeTransportError {
  constructor() {
    super('runtime-failed', 'Event runtime endpoint already has a live server.');
  }
}

const endpointOwned = (): Effect.Effect<never, EventRuntimeEndpointOwnedError> =>
  Effect.fail(new EventRuntimeEndpointOwnedError());

const isEndpointOwned = (error: EventRuntimeTransportError): error is EventRuntimeEndpointOwnedError =>
  error instanceof EventRuntimeEndpointOwnedError;

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

/**
 * `owner` binds the endpoint and answers hooks; `standby` binds nothing and
 * waits for the owner to exit. A server only ever moves from `standby` to
 * `owner`, never back.
 */
export type EventRuntimeServerRole = 'owner' | 'standby';

/**
 * What `createEventRuntimeServer` does when a live server already owns the
 * endpoint. `fail` (the default) rejects with `runtime-failed`
 * (`Event runtime endpoint already has a live server.`); `standby` resolves a
 * server in the `standby` role that takes the endpoint over once the owner
 * exits. Every other startup failure fails closed under both policies.
 */
export type EventRuntimeOwnedEndpointPolicy = 'fail' | 'standby';

export interface CreateEventRuntimeServerOptions {
  readonly artifactEpoch: string;
  readonly endpointId: string;
  readonly handle: (request: EventRuntimeRequest, signal: AbortSignal) => Promise<unknown>;
  /**
   * Receives every failure the standby role recovers from by retrying, other
   * than "still owned": a takeover attempt that failed for any other reason
   * (a probe, claim, stale-path removal, listen, or release failure) and a
   * role listener that threw (`Event runtime role listener failed.`). The
   * standby keeps probing regardless — including when this callback itself
   * throws, which is swallowed; without this callback those failures are
   * invisible, and the process looks healthy while shared-only hooks stay
   * unavailable.
   */
  readonly onStandbyError?: (error: EventRuntimeTransportError) => void;
  readonly status?: () => EventRuntimeStatus;
  readonly whenOwned?: EventRuntimeOwnedEndpointPolicy;
}

export interface EventRuntimeServer {
  readonly close: () => Promise<void>;
  readonly endpoint: string;
  /**
   * Observes role changes — today only `standby` → `owner`, when this server
   * takes the endpoint over. Returns the unsubscribe. Listeners run on the
   * takeover's own turn, after the socket is bound and before any hook is
   * answered through it.
   */
  readonly onRoleChange: (listener: (role: EventRuntimeServerRole) => void) => () => void;
  readonly role: () => EventRuntimeServerRole;
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

/** The bound endpoint: what an owner holds and a standby is waiting to become. */
interface EventSocketListener {
  readonly endpoint: string;
  readonly endpointIdentity?: Readonly<{ readonly device: number; readonly inode: number }>;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

/**
 * One server's lifetime state. `listener` is set exactly once — at open for
 * an owner, at takeover for a standby — and only ever by the fiber that bound
 * it; `standby` is the takeover loop, present only for a server that started
 * behind a live owner, and interrupted by the scope or by `close()`.
 */
interface EventRuntimeServerState {
  readonly endpoint: string;
  readonly listener: Ref.Ref<EventSocketListener | undefined>;
  readonly roleListeners: Set<(role: EventRuntimeServerRole) => void>;
  readonly standby: Fiber.Fiber<void> | undefined;
}

class EventSocketService extends Context.Service<EventSocketService, EventRuntimeServerState>()(
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
  /** Runs after the claim handle closed and before its lock file is removed; a rejection stands in for a failing release. */
  readonly beforeEndpointClaimRelease?: () => Promise<void>;
  /**
   * Runs at the start of the owned-endpoint removal on close — the server has
   * stopped listening and still holds the claim; a rejection stands in for a
   * failing removal.
   */
  readonly beforeEndpointRemoval?: () => Promise<void>;
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

/**
 * The endpoint claim is an inode lock and stays raw `node:fs` on purpose:
 * exclusive create (`open` with `wx`), the owner record written through the
 * same handle, and the handle's `dev`/`ino` as the identity every later
 * removal must match. Effect's `FileSystem` cannot express that identity
 * (`stat` follows links and returns no handle-bound inode), so this helper and
 * `readEndpointClaimSnapshot` / `removeFileIfIdentityMatches` are lifted as
 * one imperative unit (`docs/effect-conventions.md` § Effect platform
 * services); only the orchestration around them is Effect.
 */
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
  });

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

/**
 * Releases the claim lock: close the exclusive handle, then remove the lock
 * file only while it is still the inode this process created. A failure is a
 * typed transport error, not a swallowed one — `openServer` decides how it
 * combines with the open outcome (last failure wins).
 */
const releaseEndpointClaim = (
  claim: EndpointClaim,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.Effect<void, EventRuntimeTransportError> =>
  liftPromise(async () => {
    await claim.handle.close();
    await testHooks?.beforeEndpointClaimRelease?.();
    await removeFileIfIdentityMatches(claim.path, claim.identity);
  }).pipe(
    Effect.mapError((error) => transportError('runtime-failed', 'Unable to release the event runtime endpoint claim.', error)),
  );

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
    if (endpointState === 'live') return yield* endpointOwned();
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
): Effect.Effect<EventSocketListener, EventRuntimeTransportError> =>
  Effect.callback<EventSocketListener, EventRuntimeTransportError>((resume) => {
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
    const onError = (error: NodeJS.ErrnoException): void => {
      // The path (or, on Windows, the pipe name — the only owner check that
      // platform has) is bound by a server this process did not probe: owned.
      if (error.code === 'EADDRINUSE') {
        resume(endpointOwned());
        return;
      }
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

/**
 * Probes, claims, and binds the endpoint — the whole owner path. A live
 * server on the endpoint fails with the `EventRuntimeEndpointOwnedError`
 * marker at every site that can see one (before the claim, inside the claim
 * loop, and under the claim), so a standby retries exactly that and nothing
 * else.
 */
const openServer = Effect.fnUntraced(function*(
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<EventSocketListener, EventRuntimeTransportError> {
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
  if (endpointState === 'live') return yield* endpointOwned();

  const listenUnderClaim = Effect.gen(function*() {
    const claimedEndpointState = yield* probeEndpoint(endpoint);
    if (claimedEndpointState === 'live') return yield* endpointOwned();
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
  });
  // The claim is held only across the probe and listen (and, on close, across
  // the shutdown and identity-checked removal — `releaseOwnedEndpoint`). Its
  // release must *propagate* a failure, so this is an explicit exit sequence
  // rather than a scope finalizer: capture the listen `Exit`, release the
  // claim, and let the release failure win — after shutting down a server that
  // did come up, so a failed claim release never leaks a listening socket. The
  // mask keeps the acquire→release pairing intact under interruption, as
  // `acquireUseRelease` would.
  return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const claim = yield* claimEndpoint(endpoint, testHooks);
    const listened = yield* Effect.exit(restore(listenUnderClaim));
    const released = yield* Effect.exit(releaseEndpointClaim(claim, testHooks));
    if (Exit.isFailure(released)) {
      if (Exit.isSuccess(listened)) yield* shutdownServer(listened.value);
      return yield* Effect.failCause(released.cause);
    }
    return yield* listened;
  }));
});

/** Destroys every accepted socket and stops listening. Idempotent and infallible: the scope finalizer. */
const shutdownServer = (listener: EventSocketListener): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    for (const socket of listener.sockets) socket.destroy();
    if (!listener.server.listening) {
      resume(Effect.void);
      return undefined;
    }
    listener.server.close(() => resume(Effect.void));
    return undefined;
  });

/**
 * Stops listening and removes the socket path, holding the endpoint claim
 * from before the first step until after the last. Closing the server already
 * unlinks the path (libuv removes a listening pipe's name on close); the
 * identity-matched `stat` + `rm` that follows, kept raw like the claim lock,
 * only ever removes a path that still carries the inode this server bound. The
 * claim is what makes that check trustworthy: a standby's takeover holds the
 * same claim across its probe → unlink → listen, so no successor can bind a
 * new socket at this path between the unlink and the identity read — and the
 * inode the kernel just freed is exactly the one a new socket is likely to be
 * handed, which would let the check match the successor's live socket and
 * remove it. Standbys only claim an endpoint that is not live, so the claim is
 * uncontended while this server listens; a claim that fails anyway is a
 * foreign lock, and the server is shut down regardless before the failure
 * propagates. A removal or release failure is a typed transport error so
 * `close()` can surface it instead of leaving a stale endpoint behind
 * silently; a missing path is already gone.
 */
const releaseOwnedEndpoint = Effect.fnUntraced(function*(
  listener: EventSocketListener,
  identity: Readonly<{ readonly device: number; readonly inode: number }>,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<void, EventRuntimeTransportError> {
  const removeIfStillOurs = liftPromise(async () => {
    await testHooks?.beforeEndpointRemoval?.();
    let current;
    try {
      current = await stat(listener.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (current.dev !== identity.device || current.ino !== identity.inode) return;
    await rm(listener.endpoint, { force: true });
  }).pipe(
    Effect.mapError((error) => transportError('runtime-failed', 'Unable to remove the event runtime endpoint.', error)),
  );
  // The same claim discipline as `openServer`: an explicit exit sequence so a
  // release failure propagates (and wins), under a mask that keeps the
  // acquire→release pairing intact if `close()` is interrupted.
  return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const claimed = yield* Effect.exit(claimEndpoint(listener.endpoint, testHooks).pipe(
      Effect.mapError((error) => isEndpointOwned(error)
        ? transportError('runtime-failed', 'Event runtime endpoint claim is held by another process during teardown.', error)
        : error),
    ));
    if (Exit.isFailure(claimed)) {
      yield* shutdownServer(listener);
      return yield* Effect.failCause(claimed.cause);
    }
    yield* shutdownServer(listener);
    const removed = yield* Effect.exit(restore(removeIfStillOurs));
    const released = yield* Effect.exit(releaseEndpointClaim(claimed.value, testHooks));
    if (Exit.isFailure(released)) return yield* Effect.failCause(released.cause);
    return yield* removed;
  }));
});

/**
 * The explicit teardown `EventRuntimeServer.close()` runs: stop the standby
 * loop, then shut the bound server down and remove the owned endpoint under
 * the claim. The loop is interrupted — and awaited, so an in-flight takeover
 * finishes its claim→listen→release before this reads the listener — first,
 * or a takeover could bind a socket nobody removes. The removal is fallible on
 * purpose: the scope finalizer only ever repeats the (idempotent) shutdown, so
 * the one teardown step that can fail reports to the caller rather than to a
 * finalizer that would have to swallow it.
 */
const closeServer = Effect.fnUntraced(function*(
  state: EventRuntimeServerState,
  testHooks?: EventRuntimeServerTestHooks,
): Effect.fn.Return<void, EventRuntimeTransportError> {
  if (state.standby !== undefined) yield* Fiber.interrupt(state.standby);
  const listener = yield* Ref.get(state.listener);
  if (listener === undefined) return;
  // Windows binds a named pipe, not a path: nothing to claim or remove.
  if (process.platform === 'win32' || listener.endpointIdentity === undefined) {
    yield* shutdownServer(listener);
    return;
  }
  yield* releaseOwnedEndpoint(listener, listener.endpointIdentity, testHooks);
});

type StandbyErrorReporter = (error: EventRuntimeTransportError) => void;

/**
 * The one way the standby path ever calls `onStandbyError`. The reporter is
 * the caller's last line of diagnostics, so a reporter that itself throws has
 * nowhere safe left to report to and is swallowed: it must never end the
 * standby fiber (which would leave the process looking healthy and never
 * taking over) or stop the role listeners after it.
 */
const guardedStandbyErrorReporter = (onStandbyError: StandbyErrorReporter | undefined): StandbyErrorReporter =>
  (error) => {
    try {
      onStandbyError?.(error);
    } catch {
      // Nothing safe is left to report to.
    }
  };

/**
 * Delivers the one `standby` → `owner` notification to every listener. Each
 * runs in its own guard: a listener that throws is reported through the
 * (guarded) reporter and neither stops the listeners after it nor the role
 * transition, which has already happened.
 */
const notifyRoleListeners = (
  roleListeners: ReadonlySet<(role: EventRuntimeServerRole) => void>,
  role: EventRuntimeServerRole,
  report: StandbyErrorReporter,
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const notify of roleListeners) {
      try {
        notify(role);
      } catch (error) {
        report(transportError('runtime-failed', 'Event runtime role listener failed.', error));
      }
    }
  });

/**
 * The standby role's one job: notice the owner leaving and run the same
 * `openServer` path an unowned start runs. Losing that race — another standby
 * claimed first, or the endpoint is live again by the time this probe lands —
 * is the expected outcome and leaves it standing by for the next tick in
 * silence. Every other typed failure also leaves it standing by, because the
 * MCP server this runtime serves is already up and there is no caller left to
 * fail, but is reported through `onStandbyError` so a takeover that can never
 * succeed (an endpoint directory it cannot write, a claim that never clears)
 * does not look like a healthy wait. Bound to the scope: `close()` interrupts
 * it before reading the listener, and the layer scope interrupts it on
 * dispose.
 */
const standByForEndpoint = Effect.fnUntraced(function*(
  endpoint: string,
  acquire: Effect.Effect<EventSocketListener, EventRuntimeTransportError, Scope.Scope>,
  roleListeners: ReadonlySet<(role: EventRuntimeServerRole) => void>,
  report: StandbyErrorReporter,
): Effect.fn.Return<void, never, Scope.Scope> {
  const reportAndStandBy = (error: EventRuntimeTransportError): Effect.Effect<undefined> => Effect.sync(() => {
    report(error);
    return undefined;
  });
  while (true) {
    const jitter = yield* Random.nextIntBetween(0, STANDBY_PROBE_JITTER_MS);
    yield* Effect.sleep(Duration.sum(STANDBY_PROBE_INTERVAL, Duration.millis(jitter)));
    const endpointState = yield* probeEndpoint(endpoint).pipe(Effect.catch(reportAndStandBy));
    if (endpointState === undefined || endpointState === 'live') continue;
    const listener = yield* acquire.pipe(
      Effect.catchIf(isEndpointOwned, () => Effect.succeed(undefined)),
      Effect.catch(reportAndStandBy),
    );
    if (listener === undefined) continue;
    yield* notifyRoleListeners(roleListeners, 'owner', report);
    return;
  }
});

const eventSocketLayer = (
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Layer.Layer<EventSocketService, EventRuntimeTransportError> =>
  Layer.effect(EventSocketService, Effect.gen(function*() {
    const endpoint = eventRuntimeEndpoint(options.endpointId);
    const listener = yield* Ref.make<EventSocketListener | undefined>(undefined);
    const roleListeners = new Set<(role: EventRuntimeServerRole) => void>();
    // Binding and recording the listener are one uninterruptible acquire, so
    // a `close()` that interrupts a takeover mid-flight still finds — and
    // removes — the socket that takeover had just bound.
    const acquire = Effect.acquireRelease(
      openServer(options, testHooks).pipe(Effect.tap((bound) => Ref.set(listener, bound))),
      shutdownServer,
    );
    if (options.whenOwned !== 'standby') {
      yield* acquire;
      return { endpoint, listener, roleListeners, standby: undefined };
    }
    const opened = yield* acquire.pipe(Effect.catchIf(isEndpointOwned, () => Effect.succeed(undefined)));
    if (opened !== undefined) return { endpoint, listener, roleListeners, standby: undefined };
    const standby = yield* Effect.forkScoped(
      standByForEndpoint(endpoint, acquire, roleListeners, guardedStandbyErrorReporter(options.onStandbyError)),
    );
    return { endpoint, listener, roleListeners, standby };
  }));

const createEventRuntimeServerWithHooks = async (
  options: CreateEventRuntimeServerOptions,
  testHooks?: EventRuntimeServerTestHooks,
): Promise<EventRuntimeServer> => {
  const runtime: ScopedEffectRuntime<EventSocketService> = makeScopedEffectRuntime(eventSocketLayer(options, testHooks));
  const state = await runtime.run(EventSocketService);
  let closing: Promise<void> | undefined;
  return Object.freeze({
    close: () => {
      closing ??= runtime.run(closeServer(state, testHooks)).finally(() => runtime.close());
      return closing;
    },
    endpoint: state.endpoint,
    onRoleChange: (listener: (role: EventRuntimeServerRole) => void) => {
      state.roleListeners.add(listener);
      return () => {
        state.roleListeners.delete(listener);
      };
    },
    role: () => (Ref.getUnsafe(state.listener) === undefined ? 'standby' : 'owner'),
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
