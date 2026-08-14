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
    await expect(readFile(lockPathFor(root), 'utf8')).resolves.toBe(
      `{"createdAt":"2026-08-14T12:00:00.000Z","pid":${process.pid},"projectRoot":${JSON.stringify(root)},"version":1}\n`,
    );

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
      `{"createdAt":"2026-08-14T11:59:00.000Z","pid":${stalePid},"projectRoot":${JSON.stringify(root)},"version":1}\n`,
    );

    const recovered = await acquireDevLock({
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      probeProcess: (pid) => {
        observedPids.push(pid);
        return false;
      },
      projectRoot: root,
    });

    expect(observedPids).toEqual([stalePid]);
    await expect(readFile(lockPathFor(root), 'utf8')).resolves.toBe(
      `{"createdAt":"2026-08-14T12:00:00.000Z","pid":${process.pid},"projectRoot":${JSON.stringify(root)},"version":1}\n`,
    );
    await recovered.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
