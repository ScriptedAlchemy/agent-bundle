import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  createEventRuntimeServer,
  createEventRuntimeServerForTest,
  eventRuntimeEndpoint,
  EventRuntimeTransportError,
  requestEventRuntime,
} from '../src/events/ipc.ts';

interface EndpointClaimOwner {
  readonly linuxStartTime?: string;
  readonly pid: number;
}

const linuxProcessStartTime = async (pid: number): Promise<string> => {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const commEnd = processStat.lastIndexOf(')');
  if (commEnd === -1) throw new Error(`Unable to parse process stat for pid ${pid}.`);
  const fieldsAfterComm = processStat.slice(commEnd + 1).trim().split(/\s+/u);
  const startTime = fieldsAfterComm[19];
  if (startTime === undefined) throw new Error(`Process stat for pid ${pid} has no start time.`);
  return startTime;
};

const currentProcessOwner = async (): Promise<EndpointClaimOwner> => ({
  ...(process.platform === 'linux' ? { linuxStartTime: await linuxProcessStartTime(process.pid) } : {}),
  pid: process.pid,
});

const spawnChildOwner = async (): Promise<Readonly<{
  child: ChildProcess;
  owner: EndpointClaimOwner;
}>> => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    throw new Error('Spawned child has no pid.');
  }
  const owner: EndpointClaimOwner = {
    ...(process.platform === 'linux' ? { linuxStartTime: await linuxProcessStartTime(pid) } : {}),
    pid,
  };
  return { child, owner };
};

const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
};

const deadChildOwner = async (): Promise<EndpointClaimOwner> => {
  const { child, owner } = await spawnChildOwner();
  await killChild(child);
  return owner;
};

const writeEndpointClaim = async (endpointId: string, contents: string): Promise<string> => {
  const endpoint = eventRuntimeEndpoint(endpointId);
  await mkdir(dirname(endpoint), { mode: 0o700, recursive: true });
  const claimPath = `${endpoint}.lock`;
  await writeFile(claimPath, contents, { mode: 0o600 });
  return claimPath;
};

const expectBoundedClaimFailure = async (endpointId: string): Promise<void> => {
  await expect(createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => undefined,
  })).rejects.toMatchObject({
    code: 'runtime-failed',
    message: expect.stringMatching(/claim did not clear after bounded retries/u),
    name: EventRuntimeTransportError.name,
  });
};

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

it.live('rejects a second live server without disturbing the endpoint owner', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-owner-${crypto.randomUUID()}`;
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.promise(() => createEventRuntimeServer({
        artifactEpoch: 'epoch-1',
        endpointId,
        handle: async (request) => ({ owner: 'first', target: request.target }),
      })),
      (server) => Effect.promise(() => server.close()),
    );

    const alreadyRunning = yield* Effect.tryPromise({
      try: () => createEventRuntimeServer({
        artifactEpoch: 'epoch-1',
        endpointId,
        handle: async () => ({ owner: 'second' }),
      }),
      catch: (error) => error,
    }).pipe(Effect.flip);
    expect(alreadyRunning).toMatchObject({
      code: 'runtime-failed',
      message: expect.stringMatching(/already has a live server/u),
      name: EventRuntimeTransportError.name,
    });
    const response = yield* Effect.promise(() => requestEventRuntime({
      artifactEpoch: 'epoch-1',
      endpointId,
      event: 'session/start',
      hostContractRevision: '2.1.250',
      native: { hook_event_name: 'SessionStart' },
      signal: new AbortController().signal,
      target: 'claude',
      timeoutMs: 1_000,
    }));
    expect(response).toEqual({ owner: 'first', target: 'claude' });
  }));
}));

it.live('replaces a stale event runtime socket file', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-stale-${crypto.randomUUID()}`;
  const endpoint = yield* Effect.acquireUseRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => undefined,
    })),
    (server) => Effect.succeed(server.endpoint),
    (server) => Effect.promise(() => server.close()),
  );
  yield* Effect.promise(() => writeFile(endpoint, 'stale socket'));

  yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ replaced: true }),
    })),
    (server) => Effect.promise(() => server.close()),
  );
  const response = yield* Effect.promise(() => requestEventRuntime({
    artifactEpoch: 'epoch-1',
    endpointId,
    event: 'session/start',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'SessionStart' },
    signal: new AbortController().signal,
    target: 'claude',
    timeoutMs: 1_000,
  }));
  expect(response).toEqual({ replaced: true });
}));

it.live('does not unlink a concurrent winner after both servers probe a stale endpoint', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-stale-race-${crypto.randomUUID()}`;
  const endpoint = yield* Effect.acquireUseRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => undefined,
    })),
    (server) => Effect.succeed(server.endpoint),
    (server) => Effect.promise(() => server.close()),
  );
  yield* Effect.promise(() => writeFile(endpoint, 'stale socket'));

  let markFirstProbed!: () => void;
  let releaseFirst!: () => void;
  const firstProbed = new Promise<void>((resolve) => { markFirstProbed = resolve; });
  const firstCanContinue = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstServer = createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }, {
    afterEndpointProbe: async (state) => {
      expect(state).toBe('stale');
      markFirstProbed();
      await firstCanContinue;
    },
  });
  yield* Effect.promise(() => firstProbed);

  let markSecondProbed!: () => void;
  let releaseSecond!: () => void;
  const secondProbed = new Promise<void>((resolve) => { markSecondProbed = resolve; });
  const secondCanContinue = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const secondServer = createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'second' }),
  }, {
    afterEndpointProbe: async (state) => {
      expect(state).toBe('stale');
      markSecondProbed();
      await secondCanContinue;
    },
  });
  yield* Effect.promise(() => secondProbed);

  releaseFirst();
  const winner = yield* Effect.acquireRelease(
    Effect.promise(() => firstServer),
    (server) => Effect.promise(() => server.close()),
  );
  expect(winner.endpoint).toBe(endpoint);

  releaseSecond();
  const loser = yield* Effect.promise(async () => {
    try {
      return { server: await secondServer, status: 'opened' as const };
    } catch (error) {
      return { error, status: 'failed' as const };
    }
  });
  if (loser.status === 'opened') {
    yield* Effect.promise(() => loser.server.close());
    expect(loser.status).toBe('failed');
    return;
  }
  expect(loser.error).toMatchObject({
    code: 'runtime-failed',
    message: expect.stringMatching(/already has a live server/u),
    name: EventRuntimeTransportError.name,
  });

  const response = yield* Effect.promise(() => requestEventRuntime({
    artifactEpoch: 'epoch-1',
    endpointId,
    event: 'session/start',
    hostContractRevision: '2.1.250',
    native: { hook_event_name: 'SessionStart' },
    signal: new AbortController().signal,
    target: 'claude',
    timeoutMs: 1_000,
  }));
  expect(response).toEqual({ owner: 'first' });
}));

it.live('reclaims an endpoint claim whose owner process was killed', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-dead-claim-${crypto.randomUUID()}`;
  const owner = yield* Effect.promise(deadChildOwner);
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, JSON.stringify(owner)));
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => undefined,
    })),
    (server) => Effect.promise(() => server.close()),
  );
  expect(server.endpoint).toBe(eventRuntimeEndpoint(endpointId));
  yield* Effect.promise(() => rm(claimPath, { force: true }));
}));

it.live('fails closed when an endpoint claim owner is still alive', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-live-claim-${crypto.randomUUID()}`;
  const owner = yield* Effect.promise(currentProcessOwner);
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, JSON.stringify(owner)));
  yield* Effect.promise(() => expectBoundedClaimFailure(endpointId)).pipe(
    Effect.ensuring(Effect.promise(() => rm(claimPath, { force: true }))),
  );
}));

it.live('fails closed when an endpoint claim has unparseable contents', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-garbage-claim-${crypto.randomUUID()}`;
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, 'not-json'));
  yield* Effect.promise(() => expectBoundedClaimFailure(endpointId)).pipe(
    Effect.ensuring(Effect.promise(() => rm(claimPath, { force: true }))),
  );
}));

it.live('reclaims an endpoint claim whose pid has been recycled', () => Effect.gen(function*() {
  if (process.platform !== 'linux') return;
  const endpointId = `event-ipc-recycled-claim-${crypto.randomUUID()}`;
  const { child, owner } = yield* Effect.acquireRelease(
    Effect.promise(spawnChildOwner),
    ({ child }) => Effect.promise(() => killChild(child)),
  );
  const recycledOwner = {
    ...owner,
    linuxStartTime: String(BigInt(owner.linuxStartTime ?? '0') + 1n),
  };
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, JSON.stringify(recycledOwner)));
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => undefined,
    })),
    (server) => Effect.promise(() => server.close()),
  );
  expect(server.endpoint).toBe(eventRuntimeEndpoint(endpointId));
  yield* Effect.promise(() => rm(claimPath, { force: true }));
  expect(child.exitCode).toBeNull();
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
