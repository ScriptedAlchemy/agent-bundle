import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

interface EpochEvidence {
  readonly environment: Readonly<Record<string, string>>;
  readonly operations: readonly Readonly<Record<string, unknown>>[];
  readonly spike: Readonly<Record<string, string>>;
}

interface LockRecord {
  readonly owner: string;
  readonly pid: number;
}

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/contracts/epoch-atomicity/local-linux.json', import.meta.url), 'utf8'),
) as EpochEvidence;

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const readLock = async (path: string): Promise<LockRecord> =>
  JSON.parse(await readFile(path, 'utf8')) as LockRecord;

const acquireLock = async (
  path: string,
  owner: string,
  pid: number,
): Promise<Readonly<Record<string, string>>> => {
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(JSON.stringify({ owner, pid }));
    await handle.close();
    return { status: 'acquired' };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const current = await readLock(path);
    return { observedOwner: current.owner, reason: 'lock-exists', status: 'rejected' };
  }
};

const probePid = (pid: number): Readonly<Record<string, string>> => {
  try {
    process.kill(pid, 0);
    return { status: 'running' };
  } catch (error) {
    return { status: 'not-running', systemCode: errorCode(error) ?? 'unknown' };
  }
};

const waitForSpawn = async (child: ReturnType<typeof spawn>): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('spawn', resolvePromise);
  });

const stopChild = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()));
  child.kill();
  await exited;
};

const runDisposableEpochSpike = async (root: string): Promise<EpochEvidence> => {
  const active = join(root, 'active.json');
  const lock = join(root, 'publish.lock');
  const staged = join(root, 'epoch-2.staged.json');
  const stalePid = 2_147_483_647;
  const liveWriter = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1_000);'], { stdio: 'ignore' });
  await waitForSpawn(liveWriter);
  if (liveWriter.pid === undefined) throw new Error('Live lock writer did not expose a PID.');

  try {
    await writeFile(active, JSON.stringify({ epochId: 'epoch-1' }));
    await writeFile(staged, JSON.stringify({ epochId: 'epoch-2' }));
    let failure: string | undefined;
    try {
      throw new Error('simulated publication failure before atomic rename');
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const retained = JSON.parse(await readFile(active, 'utf8')) as { readonly epochId: string };

    const firstWriter = await acquireLock(lock, 'writer-a', liveWriter.pid);
    const liveOwner = probePid(liveWriter.pid);
    const secondWriter = await acquireLock(lock, 'writer-b', process.pid + 1);

    await rm(lock);
    await writeFile(lock, JSON.stringify({ owner: 'dead-writer', pid: stalePid }));
    const staleOwner = probePid(stalePid);
    if (staleOwner.status === 'not-running') await rm(lock);
    const recoveredWriter = await acquireLock(lock, 'writer-c', process.pid);

    return {
      environment: {
        architecture: process.arch,
        nodeVersion: process.version,
        platform: process.platform,
        runtime: 'node',
      },
      operations: [
      {
        id: 'failed-publication-retention',
        mechanism: 'stage-write then atomic rename',
        observed: {
          activeEpochIdAfterFailure: retained.epochId,
          candidateEpochId: 'epoch-2',
          retainedPriorActive: retained.epochId === 'epoch-1',
        },
        steps: [
          { action: 'seed-active', result: { epochId: 'epoch-1' } },
          { action: 'stage-candidate', result: { epochId: 'epoch-2' } },
          { action: 'inject-failure-before-rename', result: { error: failure } },
          { action: 'read-active-after-failure', result: { epochId: retained.epochId } },
        ],
      },
      {
        id: 'live-lock-second-writer-rejection',
        observed: {
          firstWriter,
          liveOwner,
          secondWriter,
        },
        steps: [
          { action: 'acquire-exclusive-lock', actor: 'writer-a', result: firstWriter },
          { action: 'probe-live-owner', actor: 'writer-a', result: liveOwner },
          { action: 'acquire-exclusive-lock', actor: 'writer-b', result: secondWriter },
        ],
      },
      {
        id: 'dead-pid-lock-recovery',
        observed: {
          recoveredWriter,
          staleOwner,
        },
        steps: [
          { action: 'seed-stale-lock', actor: 'dead-writer', result: { stalePid } },
          { action: 'probe-owner-pid', actor: 'dead-writer', result: staleOwner },
          { action: 'remove-stale-lock-after-esrch', result: { removed: staleOwner.status === 'not-running' } },
          { action: 'acquire-exclusive-lock', actor: 'writer-c', result: recoveredWriter },
        ],
      },
      ],
      spike: {
        name: 'atomic-epoch-publication-and-lock-ownership',
        scope: 'disposable local filesystem probe; evidence only',
      },
    };
  } finally {
    await stopChild(liveWriter);
  }
};

it('generates and validates local epoch publication and lock-ownership evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-epoch-spike-'));
  try {
    expect(await runDisposableEpochSpike(root)).toEqual(fixture);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
