import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Duration, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  createEventRuntimeServer,
  createEventRuntimeServerForTest,
  eventRuntimeEndpoint,
  type EventRuntimeServer,
  type EventRuntimeServerRole,
  EventRuntimeTransportError,
  requestEventRuntime,
  requestEventRuntimeStatus,
} from '../src/events/ipc.ts';
import { deferred, eventually, within } from './support/eventually.ts';

type ContenderOutcome =
  | Readonly<{ readonly server: EventRuntimeServer; readonly status: 'opened' }>
  | Readonly<{ readonly error: unknown; readonly status: 'failed' }>;

/**
 * Attaches the settlement handler the moment a racing server is created. The
 * losing contender rejects as soon as the winner listens, while the test only
 * reaches its `await` after the winner has fully resolved; on a loaded machine
 * that gap is wide enough for the rejection to surface as an unhandled
 * file-level "already has a live server" failure.
 */
const settleContender = (server: Promise<EventRuntimeServer>): Promise<ContenderOutcome> => server.then(
  (opened): ContenderOutcome => ({ server: opened, status: 'opened' }),
  (error: unknown): ContenderOutcome => ({ error, status: 'failed' }),
);

interface EndpointClaimOwner {
  readonly linuxStartTime?: string;
  readonly pid: number;
}

interface LinuxProcessStat {
  readonly startTime: string;
  readonly state: string;
}

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

const spawnZombieOwner = async (): Promise<Readonly<{
  child: ChildProcess;
  owner: EndpointClaimOwner;
}>> => {
  const child = spawn('sh', ['-c', 'p=$$; { while [ "$(cat /proc/$p/comm 2>/dev/null)" != "sleep" ]; do :; done; } & echo $!; exec sleep 300'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pidLine = new Promise<string>((resolve, reject) => {
    child.stdout?.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8').trim()));
    child.stdout?.once('error', reject);
  });
  await once(child, 'spawn');
  const zombiePid = Number(await pidLine);
  if (!Number.isInteger(zombiePid) || zombiePid <= 0) {
    await killChild(child);
    throw new Error('Zombie child pid was not reported.');
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const processStat = await linuxProcessStat(zombiePid).catch(() => undefined);
    if (processStat?.state === 'Z') {
      return {
        child,
        owner: { linuxStartTime: processStat.startTime, pid: zombiePid },
      };
    }
    await delay(10);
  }
  await killChild(child);
  throw new Error(`Process ${zombiePid} did not become a zombie.`);
};

const writeEndpointClaim = async (endpointId: string, contents: string): Promise<string> => {
  const endpoint = eventRuntimeEndpoint(endpointId);
  await mkdir(dirname(endpoint), { mode: 0o700, recursive: true });
  const claimPath = `${endpoint}.lock`;
  await writeFile(claimPath, contents, { mode: 0o600 });
  return claimPath;
};

/** One `session/start` hook request against whichever server owns `endpointId`. */
const askRuntime = (endpointId: string): Effect.Effect<unknown> => Effect.promise(() => requestEventRuntime({
  artifactEpoch: 'epoch-1',
  endpointId,
  event: 'session/start',
  hostContractRevision: '2.1.250',
  native: { hook_event_name: 'SessionStart' },
  signal: new AbortController().signal,
  target: 'claude',
  timeoutMs: 1_000,
}));

/** Resolves with the next role the server reports; the standby loop settles within a probe interval plus jitter. */
const nextRole = (server: EventRuntimeServer): Promise<EventRuntimeServerRole> => within(
  new Promise<EventRuntimeServerRole>((resolve) => { server.onRoleChange(resolve); }),
  5_000,
);

const expectMissing = (path: string): Effect.Effect<void> => Effect.promise(() =>
  expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }));

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

it.live('reports read-only runtime identity without an artifact epoch gate', () => Effect.gen(function*() {
  const endpointId = `event-ipc-status-${crypto.randomUUID()}`;
  const server = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-server',
      endpointId,
      handle: async () => undefined,
      status: () => ({
        artifactEpoch: 'epoch-server',
        availability: 'available',
        instanceId: 'runtime-1',
        pid: 1234,
      }),
    })),
    (runtime) => Effect.promise(() => runtime.close()),
  );

  const byId = yield* Effect.promise(() => requestEventRuntimeStatus({
    endpointId,
    timeoutMs: 1_000,
  }));
  const byPath = yield* Effect.promise(() => requestEventRuntimeStatus({
    endpoint: server.endpoint,
    timeoutMs: 1_000,
  }));
  expect(byId).toEqual({
    artifactEpoch: 'epoch-server',
    availability: 'available',
    instanceId: 'runtime-1',
    pid: 1234,
    status: 'available',
  });
  expect(byPath).toEqual(byId);
}));

it.live('reports unsupported and unavailable status endpoints distinctly', () => Effect.gen(function*() {
  const endpointId = `event-ipc-status-unsupported-${crypto.randomUUID()}`;
  yield* Effect.scoped(Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.promise(() => createEventRuntimeServer({
        artifactEpoch: 'epoch-1',
        endpointId,
        handle: async () => undefined,
      })),
      (runtime) => Effect.promise(() => runtime.close()),
    );
    expect(yield* Effect.promise(() => requestEventRuntimeStatus({
      endpointId,
      timeoutMs: 1_000,
    }))).toEqual({ status: 'unsupported' });
  }));

  expect(yield* Effect.promise(() => requestEventRuntimeStatus({
    endpointId: `event-ipc-status-missing-${crypto.randomUUID()}`,
    timeoutMs: 100,
  }))).toEqual({ status: 'unavailable' });
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

it.live('keeps rejecting a second live server when the caller asks for the fail policy explicitly', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-owner-explicit-fail-${crypto.randomUUID()}`;
  yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: 'first' }),
    })),
    (server) => Effect.promise(() => server.close()),
  );
  const alreadyRunning = yield* Effect.tryPromise({
    try: () => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: 'second' }),
      whenOwned: 'fail',
    }),
    catch: (error) => error,
  }).pipe(Effect.flip);
  expect(alreadyRunning).toMatchObject({
    code: 'runtime-failed',
    message: 'Event runtime endpoint already has a live server.',
    name: EventRuntimeTransportError.name,
  });
  expect(yield* askRuntime(endpointId)).toEqual({ owner: 'first' });
}));

it.live('stands by behind a live owner and takes the endpoint over once the owner closes', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-standby-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  // A free endpoint under the standby policy opens as owner straight away.
  const owner = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
    whenOwned: 'standby',
  }));
  expect(owner.role()).toBe('owner');

  yield* Effect.scoped(Effect.gen(function*() {
    const standby = yield* Effect.acquireRelease(
      Effect.promise(() => createEventRuntimeServer({
        artifactEpoch: 'epoch-1',
        endpointId,
        handle: async () => ({ owner: 'second' }),
        whenOwned: 'standby',
      })),
      (server) => Effect.promise(() => server.close()),
    );
    const roles: EventRuntimeServerRole[] = [];
    standby.onRoleChange((role) => { roles.push(role); });
    const takeover = nextRole(standby);
    expect(standby.role()).toBe('standby');
    expect(standby.endpoint).toBe(endpoint);
    // The owner keeps answering; the standby bound nothing.
    expect(yield* askRuntime(endpointId)).toEqual({ owner: 'first' });

    yield* Effect.promise(() => owner.close());
    expect(yield* Effect.promise(() => takeover)).toBe('owner');
    expect(standby.role()).toBe('owner');
    expect(roles).toEqual(['owner']);
    expect(yield* askRuntime(endpointId)).toEqual({ owner: 'second' });
    const bound = yield* Effect.promise(() => stat(endpoint));
    expect(bound.mode & 0o777).toBe(0o600);
  }));
  // The last owner out removes the socket it bound, and no claim lingers.
  yield* expectMissing(endpoint);
  yield* expectMissing(`${endpoint}.lock`);
}), 20_000);

it.live('closes a standby before any takeover without disturbing the owner or leaving files behind', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-standby-close-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const owner = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }));
  const standby = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'second' }),
    whenOwned: 'standby',
  }));
  expect(standby.role()).toBe('standby');
  yield* Effect.promise(() => standby.close());
  expect(standby.role()).toBe('standby');
  expect(yield* askRuntime(endpointId)).toEqual({ owner: 'first' });
  yield* expectMissing(`${endpoint}.lock`);

  yield* Effect.promise(() => owner.close());
  yield* expectMissing(endpoint);
  // A closed standby's loop is gone: nothing takes the freed endpoint over.
  yield* Effect.sleep(Duration.seconds(2));
  yield* expectMissing(endpoint);
  yield* expectMissing(`${endpoint}.lock`);
}), 20_000);

it.live('lets exactly one of several standbys take over and keeps the rest standing by', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-standby-race-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const owner = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }));
  const standbys = yield* Effect.forEach(['second', 'third'] as const, (label) => Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: label }),
      whenOwned: 'standby',
    })),
    (server) => Effect.promise(() => server.close()),
  ));
  expect(standbys.map((server) => server.role())).toEqual(['standby', 'standby']);
  const takeovers = standbys.map((server) => nextRole(server).then(() => server));

  yield* Effect.promise(() => owner.close());
  const winner = yield* Effect.promise(() => Promise.race(takeovers));
  // Give the loser at least one more probe after the winner bound the socket:
  // it must see a live endpoint and stay standby rather than unlink the winner.
  yield* Effect.sleep(Duration.millis(1_600));
  const roles = standbys.map((server) => server.role());
  expect(roles.filter((role) => role === 'owner')).toHaveLength(1);
  expect(winner.role()).toBe('owner');
  const loser = standbys.find((server) => server !== winner)!;
  expect(loser.role()).toBe('standby');
  const served = yield* askRuntime(endpointId);
  expect([{ owner: 'second' }, { owner: 'third' }]).toContainEqual(served);

  // The loser is next in line: closing the new owner hands the endpoint on.
  const succession = nextRole(loser);
  yield* Effect.promise(() => winner.close());
  expect(yield* Effect.promise(() => succession)).toBe('owner');
  expect(yield* askRuntime(endpointId)).not.toEqual(served);
  yield* Effect.promise(() => loser.close());
  yield* expectMissing(endpoint);
  yield* expectMissing(`${endpoint}.lock`);
}), 30_000);

it.live('holds the endpoint claim across close() so no standby can bind while the old owner is still tearing down', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-close-takeover-race-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const removalStarted = deferred();
  const removalMayContinue = deferred();
  // The owner's close pauses after it has stopped listening — the path is
  // already unlinked — and before its identity-checked removal: the window in
  // which an unserialized takeover would bind a new socket at the path, quite
  // possibly on the inode the kernel just freed, and hand it to the resumed
  // identity check as this server's own.
  const owner = yield* Effect.promise(() => createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }, {
    beforeEndpointRemoval: async () => {
      removalStarted.resolve();
      await removalMayContinue.promise;
    },
  }));
  const standbyErrors: EventRuntimeTransportError[] = [];
  const standby = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: 'second' }),
      onStandbyError: (error) => { standbyErrors.push(error); },
      whenOwned: 'standby',
    })),
    (server) => Effect.promise(() => server.close()),
  );
  expect(standby.role()).toBe('standby');

  const closing = owner.close();
  yield* Effect.promise(() => removalStarted.promise);
  // Let the standby probe and spend its whole bounded claim-retry budget
  // inside that window: the closing owner's claim must hold it off, which it
  // reports as a claim that did not clear.
  yield* Effect.promise(() => eventually(() => standbyErrors.length > 0 || standby.role() === 'owner', 10_000));
  expect(standby.role()).toBe('standby');
  expect(yield* Effect.promise(() => requestEventRuntimeStatus({ endpoint, timeoutMs: 500 })))
    .toEqual({ status: 'unavailable' });
  // The attempt it held off was reported, not swallowed.
  expect(standbyErrors.map((error) => error.message))
    .toContain('Event runtime endpoint claim did not clear after bounded retries.');
  removalMayContinue.resolve();
  yield* Effect.promise(() => closing);

  // Once the old owner has released the claim the standby takes over, and its
  // socket is the one on the path.
  yield* Effect.promise(() => eventually(() => standby.role() === 'owner', 5_000));
  const bound = yield* Effect.promise(() => stat(endpoint));
  expect(bound.isSocket()).toBe(true);
  expect(yield* askRuntime(endpointId)).toEqual({ owner: 'second' });
  yield* Effect.promise(() => standby.close());
  yield* expectMissing(endpoint);
  yield* expectMissing(`${endpoint}.lock`);
}), 30_000);

it.live('reports a takeover that fails for a reason other than "still owned" and keeps standing by until one succeeds', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-standby-error-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const owner = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }));
  const hookFailure = new Error('probe hook failed once');
  let failedAttempts = 0;
  const standbyErrors: EventRuntimeTransportError[] = [];
  const standby = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServerForTest({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: 'second' }),
      onStandbyError: (error) => { standbyErrors.push(error); },
      whenOwned: 'standby',
    }, {
      // The first takeover attempt — the first open that finds the endpoint
      // free — fails before it claims anything; the next one is left alone.
      afterEndpointProbe: async (state) => {
        if (state === 'live' || failedAttempts > 0) return;
        failedAttempts += 1;
        throw hookFailure;
      },
    })),
    (server) => Effect.promise(() => server.close()),
  );
  expect(standby.role()).toBe('standby');
  const takeover = nextRole(standby);

  yield* Effect.promise(() => owner.close());
  expect(yield* Effect.promise(() => takeover)).toBe('owner');
  expect(failedAttempts).toBe(1);
  expect(standbyErrors).toHaveLength(1);
  expect(standbyErrors[0]).toBeInstanceOf(EventRuntimeTransportError);
  expect(standbyErrors[0]).toMatchObject({
    cause: hookFailure,
    code: 'runtime-failed',
    message: 'Event runtime endpoint probe hook failed.',
  });
  expect(yield* askRuntime(endpointId)).toEqual({ owner: 'second' });
  yield* expectMissing(`${endpoint}.lock`);
}), 20_000);

it.live('keeps notifying the remaining role listeners when an earlier one throws, and reports the throw', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-role-listener-${crypto.randomUUID()}`;
  const owner = yield* Effect.promise(() => createEventRuntimeServer({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }));
  const standbyErrors: EventRuntimeTransportError[] = [];
  const standby = yield* Effect.acquireRelease(
    Effect.promise(() => createEventRuntimeServer({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => ({ owner: 'second' }),
      onStandbyError: (error) => { standbyErrors.push(error); },
      whenOwned: 'standby',
    })),
    (server) => Effect.promise(() => server.close()),
  );
  const listenerFailure = new Error('listener exploded');
  standby.onRoleChange(() => { throw listenerFailure; });
  const roles: EventRuntimeServerRole[] = [];
  standby.onRoleChange((role) => { roles.push(role); });
  const takeover = nextRole(standby);

  yield* Effect.promise(() => owner.close());
  expect(yield* Effect.promise(() => takeover)).toBe('owner');
  expect(roles).toEqual(['owner']);
  expect(standby.role()).toBe('owner');
  expect(standbyErrors).toHaveLength(1);
  expect(standbyErrors[0]).toBeInstanceOf(EventRuntimeTransportError);
  expect(standbyErrors[0]).toMatchObject({
    cause: listenerFailure,
    code: 'runtime-failed',
    message: 'Event runtime role listener failed.',
  });
  expect(yield* askRuntime(endpointId)).toEqual({ owner: 'second' });
}), 20_000);

it.live('reports a failed endpoint removal from close() after the server has stopped listening', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-close-failure-${crypto.randomUUID()}`;
  const removalFailure = new Error('endpoint removal failed');
  let removals = 0;
  const server = yield* Effect.promise(() => createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => undefined,
  }, {
    beforeEndpointRemoval: async () => {
      removals += 1;
      throw removalFailure;
    },
  }));

  const closeFailure = yield* Effect.tryPromise({ try: () => server.close(), catch: (error) => error }).pipe(Effect.flip);
  expect(closeFailure).toMatchObject({
    cause: removalFailure,
    code: 'runtime-failed',
    message: 'Unable to remove the event runtime endpoint.',
    name: EventRuntimeTransportError.name,
  });
  // The server stopped listening before the removal ran, and a repeated close
  // returns the same settled teardown instead of retrying it.
  expect(yield* Effect.promise(() => requestEventRuntimeStatus({ endpoint: server.endpoint, timeoutMs: 500 })))
    .toEqual({ status: 'unavailable' });
  expect(yield* Effect.tryPromise({ try: () => server.close(), catch: (error) => error }).pipe(Effect.flip)).toBe(closeFailure);
  expect(removals).toBe(1);
  yield* Effect.promise(() => rm(server.endpoint, { force: true }));
}));

it.live('reports a failed claim release from open() and shuts down the server it had started', () => Effect.gen(function*() {
  if (process.platform === 'win32') return;
  const endpointId = `event-ipc-claim-release-failure-${crypto.randomUUID()}`;
  const endpoint = eventRuntimeEndpoint(endpointId);
  const releaseFailure = new Error('claim release failed');
  const openFailure = yield* Effect.tryPromise({
    try: () => createEventRuntimeServerForTest({
      artifactEpoch: 'epoch-1',
      endpointId,
      handle: async () => undefined,
    }, {
      beforeEndpointClaimRelease: async () => { throw releaseFailure; },
    }),
    catch: (error) => error,
  }).pipe(Effect.flip);
  expect(openFailure).toMatchObject({
    cause: releaseFailure,
    code: 'runtime-failed',
    message: 'Unable to release the event runtime endpoint claim.',
    name: EventRuntimeTransportError.name,
  });
  // The listening server that had come up under the claim is shut down again.
  expect(yield* Effect.promise(() => requestEventRuntimeStatus({ endpoint, timeoutMs: 500 })))
    .toEqual({ status: 'unavailable' });
  yield* Effect.promise(() => rm(`${endpoint}.lock`, { force: true }));
  yield* Effect.promise(() => rm(endpoint, { force: true }));
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
  const secondServer = settleContender(createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'second' }),
  }, {
    afterEndpointProbe: async (state) => {
      expect(state).toBe('stale');
      markSecondProbed();
      await secondCanContinue;
    },
  }));
  yield* Effect.promise(() => secondProbed);

  releaseFirst();
  const winner = yield* Effect.acquireRelease(
    Effect.promise(() => firstServer),
    (server) => Effect.promise(() => server.close()),
  );
  expect(winner.endpoint).toBe(endpoint);

  releaseSecond();
  const loser = yield* Effect.promise(() => secondServer);
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

it.live('serializes concurrent reclamation before either contender can unlink a replacement claim', () => Effect.gen(function*() {
  if (process.platform !== 'linux') return;
  const endpointId = `event-ipc-reclaim-race-${crypto.randomUUID()}`;
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
  const deadOwner = yield* Effect.promise(deadChildOwner);
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, JSON.stringify(deadOwner)));
  const originalClaim = yield* Effect.promise(() => stat(claimPath));

  let firstSnapshotIdentity: Readonly<{ readonly device: number; readonly inode: number }> | undefined;
  let markFirstSnapshot!: () => void;
  let releaseFirstSnapshot!: () => void;
  let markFirstClaimed!: () => void;
  let releaseFirstClaim!: () => void;
  const firstSnapshot = new Promise<void>((resolve) => { markFirstSnapshot = resolve; });
  const firstCanReclaim = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });
  const firstClaimed = new Promise<void>((resolve) => { markFirstClaimed = resolve; });
  const firstCanBind = new Promise<void>((resolve) => { releaseFirstClaim = resolve; });
  const firstServer = createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }, {
    afterEndpointClaimAcquired: async () => {
      markFirstClaimed();
      await firstCanBind;
    },
    afterEndpointClaimReclamationSnapshot: async (identity) => {
      firstSnapshotIdentity = identity;
      markFirstSnapshot();
      await firstCanReclaim;
    },
  });

  let secondSnapshotIdentity: Readonly<{ readonly device: number; readonly inode: number }> | undefined;
  let markSecondSnapshot!: () => void;
  let releaseSecondSnapshot!: () => void;
  let markSecondReclamation!: () => void;
  let secondRemovedClaim: boolean | undefined;
  const secondSnapshot = new Promise<void>((resolve) => { markSecondSnapshot = resolve; });
  const secondCanReclaim = new Promise<void>((resolve) => { releaseSecondSnapshot = resolve; });
  const secondReclamation = new Promise<void>((resolve) => { markSecondReclamation = resolve; });
  const secondServer = settleContender(createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'second' }),
  }, {
    afterEndpointClaimReclamation: async (removed) => {
      secondRemovedClaim = removed;
      markSecondReclamation();
    },
    afterEndpointClaimReclamationSnapshot: async (identity) => {
      secondSnapshotIdentity = identity;
      markSecondSnapshot();
      await secondCanReclaim;
    },
  }));

  yield* Effect.promise(() => Promise.all([firstSnapshot, secondSnapshot]));
  expect(firstSnapshotIdentity).toEqual({ device: originalClaim.dev, inode: originalClaim.ino });
  expect(secondSnapshotIdentity).toEqual(firstSnapshotIdentity);

  releaseFirstSnapshot();
  yield* Effect.promise(() => firstClaimed);
  const replacementBeforeSecond = yield* Effect.promise(() => readFile(claimPath, 'utf8'));
  expect(JSON.parse(replacementBeforeSecond)).toEqual(yield* Effect.promise(currentProcessOwner));

  releaseSecondSnapshot();
  yield* Effect.promise(() => secondReclamation);
  expect(secondRemovedClaim).toBe(false);
  const replacementAfterSecond = yield* Effect.promise(() => readFile(claimPath, 'utf8'));
  expect(replacementAfterSecond).toBe(replacementBeforeSecond);

  releaseFirstClaim();
  const winner = yield* Effect.acquireRelease(
    Effect.promise(() => firstServer),
    (server) => Effect.promise(() => server.close()),
  );
  const loser = yield* Effect.promise(() => secondServer);
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
  expect(winner.endpoint).toBe(endpoint);
}));

it.live('excludes a second orphan-claim remover while the recovery gate is held', () => Effect.gen(function*() {
  if (process.platform !== 'linux') return;
  const endpointId = `event-ipc-recovery-gate-${crypto.randomUUID()}`;
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
  const deadOwner = yield* Effect.promise(deadChildOwner);
  const claimPath = yield* Effect.promise(() => writeEndpointClaim(endpointId, JSON.stringify(deadOwner)));
  const originalClaim = yield* Effect.promise(() => stat(claimPath));

  let markFirstSnapshot!: () => void;
  let releaseFirstSnapshot!: () => void;
  let markFirstInsideGate!: () => void;
  let releaseFirstInsideGate!: () => void;
  const firstSnapshot = new Promise<void>((resolve) => { markFirstSnapshot = resolve; });
  const firstCanEnterGate = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });
  const firstInsideGate = new Promise<void>((resolve) => { markFirstInsideGate = resolve; });
  const firstCanRemove = new Promise<void>((resolve) => { releaseFirstInsideGate = resolve; });
  const firstServer = createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'first' }),
  }, {
    afterEndpointClaimReclamationSnapshot: async () => {
      markFirstSnapshot();
      await firstCanEnterGate;
    },
    beforeEndpointClaimRemoval: async () => {
      markFirstInsideGate();
      await firstCanRemove;
    },
  });

  let markSecondSnapshot!: () => void;
  let releaseSecondSnapshot!: () => void;
  let markSecondReclamation!: () => void;
  let releaseSecondReclamation!: () => void;
  const secondRemovalResults: boolean[] = [];
  const secondSnapshot = new Promise<void>((resolve) => { markSecondSnapshot = resolve; });
  const secondCanAttemptReclamation = new Promise<void>((resolve) => { releaseSecondSnapshot = resolve; });
  const secondReclamation = new Promise<void>((resolve) => { markSecondReclamation = resolve; });
  const secondCanRetry = new Promise<void>((resolve) => { releaseSecondReclamation = resolve; });
  const secondServer = settleContender(createEventRuntimeServerForTest({
    artifactEpoch: 'epoch-1',
    endpointId,
    handle: async () => ({ owner: 'second' }),
  }, {
    afterEndpointClaimReclamation: async (removed) => {
      secondRemovalResults.push(removed);
      markSecondReclamation();
      await secondCanRetry;
    },
    afterEndpointClaimReclamationSnapshot: async () => {
      markSecondSnapshot();
      await secondCanAttemptReclamation;
    },
  }));

  yield* Effect.promise(() => Promise.all([firstSnapshot, secondSnapshot]));
  releaseFirstSnapshot();
  yield* Effect.promise(() => firstInsideGate);

  releaseSecondSnapshot();
  yield* Effect.promise(() => secondReclamation);
  expect(secondRemovalResults).toEqual([false]);
  const claimWhileGateHeld = yield* Effect.promise(() => stat(claimPath));
  expect({
    device: claimWhileGateHeld.dev,
    inode: claimWhileGateHeld.ino,
  }).toEqual({
    device: originalClaim.dev,
    inode: originalClaim.ino,
  });

  releaseFirstInsideGate();
  const winner = yield* Effect.acquireRelease(
    Effect.promise(() => firstServer),
    (server) => Effect.promise(() => server.close()),
  );
  releaseSecondReclamation();
  const loser = yield* Effect.promise(() => secondServer);
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
  expect(winner.endpoint).toBe(endpoint);
}));

it.live('reclaims an endpoint claim owned by a zombie process', () => Effect.gen(function*() {
  if (process.platform !== 'linux') return;
  const endpointId = `event-ipc-zombie-claim-${crypto.randomUUID()}`;
  const { child, owner } = yield* Effect.acquireRelease(
    Effect.promise(spawnZombieOwner),
    ({ child }) => Effect.promise(() => killChild(child)),
  );
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
  expect(child.exitCode).toBeNull();
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
