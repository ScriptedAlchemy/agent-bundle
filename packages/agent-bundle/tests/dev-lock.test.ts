import { link, lstat, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { acquireDevLock, discoverDevServerUrl, type DevLockStorage } from '../src/dev/dev-lock.ts';

const lockPathFor = (root: string): string => join(root, '.agent-bundle', 'dev.lock');
const recoveryPathFor = (root: string): string => `${lockPathFor(root)}.recovery`;

it('discovers only a URL published by a live development lock owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev discovery '));
  const lock = await acquireDevLock({ projectRoot: root });
  try {
    await lock.publishServerUrl('http://127.0.0.1:48721');
    await expect(discoverDevServerUrl({ projectRoot: root })).resolves.toBe('http://127.0.0.1:48721');
    await expect(discoverDevServerUrl({
      probeProcess: () => false,
      projectRoot: root,
    })).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
  } finally {
    await lock.close();
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a second writer with the live owning process URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock with spaces '));

  try {
    const first = await acquireDevLock({
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      projectRoot: root,
    });
    await first.publishServerUrl('http://127.0.0.1:48721');

    await expect(acquireDevLock({ projectRoot: root })).rejects.toMatchObject({
      code: 'DEV_LOCK_HELD',
      message: `Another agent-bundle dev process owns this project (pid ${process.pid}, http://127.0.0.1:48721).`,
      owner: {
        createdAt: '2026-08-14T12:00:00.000Z',
        pid: process.pid,
        projectRoot: root,
        url: 'http://127.0.0.1:48721',
      },
    });
    expect(first.owner).not.toHaveProperty('version');
    const published = JSON.parse(await readFile(lockPathFor(root), 'utf8')) as {
      readonly createdAt: string;
      readonly nonce: unknown;
      readonly pid: number;
      readonly projectRoot: string;
    };
    expect(published).toMatchObject({
      createdAt: '2026-08-14T12:00:00.000Z',
      pid: process.pid,
      projectRoot: root,
    });
    expect(published).not.toHaveProperty('url');
    expect(published).not.toHaveProperty('version');
    expect(first.owner).toMatchObject({ url: 'http://127.0.0.1:48721' });
    expect((await lstat(lockPathFor(root))).mode & 0o777).toBe(0o600);
    expect(typeof published.nonce).toBe('string');
    expect(published.nonce).not.toBe('');

    await first.close();
    await first.close();
    await expect(readFile(lockPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not overwrite a replacement lock while publishing the server URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock publication race '));
  let replaceOnLink = false;
  let replacement: Awaited<ReturnType<typeof acquireDevLock>> | undefined;
  const storage: DevLockStorage = {
    link: async (existingPath, newPath) => {
      await link(existingPath, newPath);
      if (replaceOnLink && newPath !== lockPathFor(root)) {
        replaceOnLink = false;
        await rm(lockPathFor(root), { force: true });
        replacement = await acquireDevLock({ projectRoot: root });
      }
    },
    lstat,
    mkdir,
    open,
    readFile,
    remove: rm,
  };

  const first = await acquireDevLock({ projectRoot: root, storage });
  try {
    replaceOnLink = true;
    await expect(first.publishServerUrl('http://127.0.0.1:48721')).rejects.toMatchObject({
      code: 'DEV_LOCK_INVALID',
    });

    const published = JSON.parse(await readFile(lockPathFor(root), 'utf8')) as { readonly nonce: string };
    expect(published.nonce).toBe(replacement?.owner.nonce);
  } finally {
    await Promise.allSettled([first.close(), replacement?.close()]);
    await rm(root, { force: true, recursive: true });
  }
});

it('recovers a dead lock only after probing its recorded pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock recovery '));
  const stalePid = 2_147_483_647;
  const observedPids: number[] = [];

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":${stalePid},"projectRoot":${JSON.stringify(root)}}\n`,
    );

    const recovered = await acquireDevLock({
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      probeProcess: (pid) => {
        observedPids.push(pid);
        return false;
      },
      projectRoot: root,
    });

    expect(observedPids).toEqual([stalePid, stalePid]);
    const published = JSON.parse(await readFile(lockPathFor(root), 'utf8')) as {
      readonly nonce: unknown;
      readonly pid: number;
    };
    expect(published.pid).toBe(process.pid);
    expect(typeof published.nonce).toBe('string');
    await recovered.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('recovers an abandoned recovery gate and serializes eight stale-lock contenders into one owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock recovery race '));
  const staleLockPid = 2_147_483_647;
  const staleRecoveryPid = 2_147_483_646;
  const observedPids: number[] = [];

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":${staleLockPid},"projectRoot":${JSON.stringify(root)}}\n`,
    );
    await writeFile(
      recoveryPathFor(root),
      `{"owner":{"createdAt":"2026-08-14T11:59:30.000Z","nonce":"stale-recovery","pid":${staleRecoveryPid},"projectRoot":${JSON.stringify(root)}}}\n`,
    );

    const attempts = await Promise.all(Array.from({ length: 8 }, async () => {
      try {
        return { lock: await acquireDevLock({
          now: () => new Date('2026-08-14T12:00:00.000Z'),
          probeProcess: (pid) => {
            observedPids.push(pid);
            return pid !== staleLockPid && pid !== staleRecoveryPid;
          },
          projectRoot: root,
        }) } as const;
      } catch (error) {
        return { error } as const;
      }
    }));
    const acquired = attempts.filter(
      (attempt): attempt is { readonly lock: Awaited<ReturnType<typeof acquireDevLock>> } =>
        'lock' in attempt,
    );
    const rejected = attempts.filter(
      (attempt): attempt is { readonly error: unknown } => 'error' in attempt,
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(rejected.map(({ error }) =>
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined,
    )).toEqual(Array.from({ length: 7 }, () => 'DEV_LOCK_HELD'));
    const published = JSON.parse(await readFile(lockPathFor(root), 'utf8')) as { readonly nonce?: unknown };
    expect(typeof published.nonce).toBe('string');
    expect(published.nonce).not.toBe('');
    expect(observedPids).toContain(staleLockPid);
    expect(observedPids).toContain(staleRecoveryPid);
    await expect(readFile(recoveryPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await acquired[0]!.lock.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const CORRUPT_CURRENT_LOCK_CASES = [
  [
    'rejects a versioned current lock instead of accepting an obsolete record shape',
    'agent bundle versioned dev lock ',
    (root: string) =>
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"obsolete-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)},"version":1}\n`,
  ],
  [
    'rejects duplicate keys in a current lock record',
    'agent bundle duplicate lock key ',
    (root: string) =>
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"first-owner","nonce":"second-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
  ],
  [
    'rejects noncanonical current lock serialization',
    'agent bundle noncanonical lock ',
    (root: string) =>
      ` {"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
  ],
  [
    'rejects a current lock belonging to a different project root',
    'agent bundle mismatched lock root ',
    () => '{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":2147483647,"projectRoot":"/different-project"}\n',
  ],
  [
    'rejects a current lock with a noncanonical timestamp',
    'agent bundle noncanonical lock timestamp ',
    (root: string) =>
      `{"createdAt":"2026-08-14T11:59:00Z","nonce":"stale-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
  ],
] as const;

for (const [label, tmpPrefix, corruptPayload] of CORRUPT_CURRENT_LOCK_CASES) {
  it(label, async () => {
    const root = await mkdtemp(join(tmpdir(), tmpPrefix));

    try {
      await mkdir(join(root, '.agent-bundle'), { recursive: true });
      await writeFile(lockPathFor(root), corruptPayload(root));

      await expect(acquireDevLock({
        probeProcess: () => false,
        projectRoot: root,
      })).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
}

it('rejects a versioned recovery gate instead of accepting an obsolete record shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle versioned dev lock recovery '));

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
    );
    await writeFile(
      recoveryPathFor(root),
      `{"owner":{"createdAt":"2026-08-14T11:59:30.000Z","nonce":"obsolete-recovery","pid":2147483646,"projectRoot":${JSON.stringify(root)}},"version":1}\n`,
    );

    await expect(acquireDevLock({
      probeProcess: () => false,
      projectRoot: root,
    })).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not let an old handle remove a lock acquired after its record disappeared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle old dev lock handle '));

  try {
    const oldLock = await acquireDevLock({ projectRoot: root });
    await rm(lockPathFor(root));
    const replacement = await acquireDevLock({ projectRoot: root });
    const replacementRecord = await readFile(lockPathFor(root), 'utf8');

    await oldLock.close();

    await expect(readFile(lockPathFor(root), 'utf8')).resolves.toBe(replacementRecord);
    await replacement.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('makes concurrent close callers wait for the same cleanup operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle concurrent dev lock close '));
  let recoveryGateHeld = true;

  try {
    const lock = await acquireDevLock({
      probeProcess: () => recoveryGateHeld,
      projectRoot: root,
    });
    await writeFile(recoveryPathFor(root), `${JSON.stringify({ owner: lock.owner })}\n`);

    const firstClose = lock.close();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    const secondClose = lock.close();
    const secondResolvedBeforeCleanup = await Promise.race([
      secondClose.then(() => true),
      new Promise<false>((resolvePromise) => setImmediate(() => resolvePromise(false))),
    ]);

    recoveryGateHeld = false;
    await Promise.all([firstClose, secondClose]);
    expect(secondResolvedBeforeCleanup).toBe(false);
    await expect(readFile(lockPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    recoveryGateHeld = false;
    await rm(root, { force: true, recursive: true });
  }
});

it('allows close to retry after cleanup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle retry dev lock close '));

  try {
    const lock = await acquireDevLock({ projectRoot: root });
    await writeFile(recoveryPathFor(root), '{}\n');

    await expect(lock.close()).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
    await rm(recoveryPathFor(root));
    await lock.close();

    await expect(readFile(lockPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a symlinked agent-bundle directory without writing outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle symlinked lock root '));
  const outside = await mkdtemp(join(tmpdir(), 'agent bundle symlinked lock outside '));

  try {
    await symlink(outside, join(root, '.agent-bundle'), 'dir');

    await expect(acquireDevLock({ projectRoot: root })).rejects.toMatchObject({
      code: 'DEV_LOCK_INVALID',
    });
    await expect(readFile(join(outside, 'dev.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

it('rejects duplicate keys in a recovery gate record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle duplicate recovery key '));
  const firstRecovery = `{"createdAt":"2026-08-14T11:59:10.000Z","nonce":"first-recovery","pid":2147483646,"projectRoot":${JSON.stringify(root)}}`;
  const secondRecovery = `{"createdAt":"2026-08-14T11:59:20.000Z","nonce":"second-recovery","pid":2147483645,"projectRoot":${JSON.stringify(root)}}`;

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
    );
    await writeFile(recoveryPathFor(root), `{"owner":${firstRecovery},"owner":${secondRecovery}}\n`);

    await expect(acquireDevLock({
      probeProcess: () => false,
      projectRoot: root,
    })).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('syncs candidate contents and the containing directory before acquisition resolves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle durable lock publication '));
  const directory = join(root, '.agent-bundle');
  const syncBoundaries: string[] = [];
  const controlledOpen = async (path: string, flags: string | number, mode?: number) => {
    const handle = await open(path, flags as Parameters<typeof open>[1], mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') return async () => {
          syncBoundaries.push(path === directory ? 'directory' : 'candidate');
          await target.sync();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  try {
    const lock = await acquireDevLock({
      projectRoot: root,
      storage: {
        link,
        lstat,
        mkdir,
        open: controlledOpen as typeof open,
        readFile,
        remove: rm,
      },
    } as Parameters<typeof acquireDevLock>[0]);

    expect(syncBoundaries).toEqual(['candidate', 'directory']);
    await lock.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('unpublishes the lock and fails loudly when candidate cleanup fails after publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle lock candidate cleanup '));
  const cleanupFailure = new Error('candidate cleanup failed');
  let candidatePath: string | undefined;
  let injectCleanupFailure = true;
  const controlledRemove: typeof rm = async (path, options) => {
    if (injectCleanupFailure && String(path).includes('.candidate-')) {
      injectCleanupFailure = false;
      candidatePath = String(path);
      throw cleanupFailure;
    }
    await rm(path, options);
  };

  try {
    await expect(acquireDevLock({
      projectRoot: root,
      storage: {
        link,
        lstat,
        mkdir,
        open,
        readFile,
        remove: controlledRemove,
      },
    } as Parameters<typeof acquireDevLock>[0])).rejects.toMatchObject({
      errors: [cleanupFailure],
      message: 'Development lock candidate cleanup failed.',
    });

    expect(candidatePath).toContain('.candidate-');
    // The rollback unpublished the failed acquisition: neither the lock nor
    // its candidate survives, so nothing holds the project.
    await expect(readFile(lockPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(candidatePath!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // A fresh acquisition succeeds immediately because nothing leaked.
    const lock = await acquireDevLock({ projectRoot: root });
    await lock.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('removes an abandoned candidate hardlink while recovering its stale owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle abandoned lock candidate '));
  const staleNonce = 'abandoned-candidate-owner';
  const candidatePath = join(root, '.agent-bundle', `.dev.lock.candidate-${staleNonce}`);

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"${staleNonce}","pid":2147483647,"projectRoot":${JSON.stringify(root)}}\n`,
    );
    await link(lockPathFor(root), candidatePath);

    const recovered = await acquireDevLock({
      probeProcess: () => false,
      projectRoot: root,
    });

    await expect(readFile(candidatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await recovered.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
