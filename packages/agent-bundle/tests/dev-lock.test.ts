import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { acquireDevLock } from '../src/dev/dev-lock.ts';

const lockPathFor = (root: string): string => join(root, '.agent-bundle', 'dev.lock');
const recoveryPathFor = (root: string): string => `${lockPathFor(root)}.recovery`;

it('rejects a second writer with stable metadata for the live owning process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock with spaces '));

  try {
    const first = await acquireDevLock({
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      projectRoot: root,
    });

    await expect(acquireDevLock({ projectRoot: root })).rejects.toMatchObject({
      code: 'DEV_LOCK_HELD',
      owner: {
        createdAt: '2026-08-14T12:00:00.000Z',
        pid: process.pid,
        projectRoot: root,
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
    expect(published).not.toHaveProperty('version');
    expect(typeof published.nonce).toBe('string');
    expect(published.nonce).not.toBe('');

    await first.close();
    await first.close();
    await expect(readFile(lockPathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
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

it('rejects a versioned current lock instead of accepting an obsolete record shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle versioned dev lock '));

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"obsolete-owner","pid":2147483647,"projectRoot":${JSON.stringify(root)},"version":1}\n`,
    );

    await expect(acquireDevLock({
      probeProcess: () => false,
      projectRoot: root,
    })).rejects.toMatchObject({ code: 'DEV_LOCK_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

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
