import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { acquireDevLock } from '../src/dev/dev-lock.ts';

const lockPathFor = (root: string): string => join(root, '.agent-bundle', 'dev.lock');

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
        version: 1,
      },
    });
    const published = JSON.parse(await readFile(lockPathFor(root), 'utf8')) as {
      readonly createdAt: string;
      readonly nonce: unknown;
      readonly pid: number;
      readonly projectRoot: string;
      readonly version: number;
    };
    expect(published).toMatchObject({
      createdAt: '2026-08-14T12:00:00.000Z',
      pid: process.pid,
      projectRoot: root,
      version: 1,
    });
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
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":${stalePid},"projectRoot":${JSON.stringify(root)},"version":1}\n`,
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

it('serializes eight stale-lock recoveries into one complete owner record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle dev lock recovery race '));
  const stalePid = 2_147_483_647;

  try {
    await mkdir(join(root, '.agent-bundle'), { recursive: true });
    await writeFile(
      lockPathFor(root),
      `{"createdAt":"2026-08-14T11:59:00.000Z","nonce":"stale-owner","pid":${stalePid},"projectRoot":${JSON.stringify(root)},"version":1}\n`,
    );

    const attempts = await Promise.all(Array.from({ length: 8 }, async () => {
      try {
        return { lock: await acquireDevLock({
          now: () => new Date('2026-08-14T12:00:00.000Z'),
          probeProcess: (pid) => pid !== stalePid,
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

    await acquired[0]!.lock.close();
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
