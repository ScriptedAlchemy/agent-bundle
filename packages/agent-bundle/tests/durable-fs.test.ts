import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  publishFileByLink,
  syncPath,
  type DurableHandleOpen,
  type DurableStagingOpen,
} from '../src/core/durable-fs.ts';
import { acquireOwnerLockFile, isProcessAlive } from '../src/core/owner-lock.ts';
import { errnoFailure } from './support/errors.ts';

const publicationMessages = Object.freeze({
  publicationCleanupFailed: 'publication and cleanup both failed',
  stagingCleanupFailed: 'staging cleanup failed',
});

it('tolerates only documented Windows directory fsync capability failures', async () => {
  const closed: string[] = [];
  const failingOpen = (code: string): DurableHandleOpen => async (target) => ({
    close: async () => { closed.push(target); },
    sync: async () => { throw errnoFailure(code, `${code} sync failed`); },
  });

  for (const code of ['EACCES', 'EINVAL'] as const) {
    await expect(syncPath('/ignored', { directory: true, open: failingOpen(code), platform: 'win32' }))
      .resolves.toBeUndefined();
  }
  await expect(syncPath('/ignored', { directory: true, open: failingOpen('EPERM'), platform: 'win32' }))
    .rejects.toMatchObject({ code: 'EPERM' });
  await expect(syncPath('/ignored', { directory: true, open: failingOpen('EACCES'), platform: 'linux' }))
    .rejects.toMatchObject({ code: 'EACCES' });
  // Regular files never tolerate the gap, even on Windows.
  await expect(syncPath('/ignored', { open: failingOpen('EACCES'), platform: 'win32' }))
    .rejects.toMatchObject({ code: 'EACCES' });
  expect(closed).toHaveLength(5);
});

it('publishes files by hard link, adopts raced winners, and never leaves staging behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-publish-'));
  try {
    const path = join(root, 'published.json');
    await expect(publishFileByLink(path, '{"first":true}\n', {
      ...publicationMessages,
      stagingPath: join(root, '.stage-first'),
    })).resolves.toBe(true);
    await expect(readFile(path, 'utf8')).resolves.toBe('{"first":true}\n');

    // The loser of a link race adopts the winner instead of replacing it.
    await expect(publishFileByLink(path, '{"second":true}\n', {
      ...publicationMessages,
      stagingPath: join(root, '.stage-second'),
    })).resolves.toBe(false);
    await expect(readFile(path, 'utf8')).resolves.toBe('{"first":true}\n');
    await expect(readdir(root)).resolves.toEqual(['published.json']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('propagates staging failures raw while removing the staging file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-publish-staging-'));
  try {
    const writeFailure = new Error('staging write failed');
    const openExclusive: DurableStagingOpen = async (target, flags, mode) => {
      const handle = await open(target, flags, mode);
      return {
        close: async () => { await handle.close(); },
        sync: async () => { await handle.sync(); },
        writeFile: async () => { throw writeFailure; },
      };
    };
    await expect(publishFileByLink(join(root, 'published.json'), 'contents\n', {
      ...publicationMessages,
      openExclusive,
      stagingPath: join(root, '.stage'),
    })).rejects.toBe(writeFailure);
    await expect(readdir(root)).resolves.toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rolls back a linked publication when the directory fsync fails and aggregates cleanup failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-publish-rollback-'));
  try {
    const path = join(root, 'published.json');
    const stagingPath = join(root, '.stage');
    const directoryFailure = errnoFailure('EIO', 'directory fsync failed');
    const failingDirectorySync: DurableHandleOpen = async (target, flags) => {
      const handle = await open(target, flags);
      return {
        close: async () => { await handle.close(); },
        sync: async () => {
          if (target === root) throw directoryFailure;
          await handle.sync();
        },
      };
    };

    const rolledBack: string[] = [];
    await expect(publishFileByLink(path, 'contents\n', {
      ...publicationMessages,
      open: failingDirectorySync,
      rollback: async () => {
        rolledBack.push(path);
        await rm(path, { force: true });
      },
      stagingPath,
    })).rejects.toBe(directoryFailure);
    expect(rolledBack).toEqual([path]);
    await expect(readdir(root)).resolves.toEqual([]);

    const rollbackFailure = new Error('rollback failed');
    await expect(publishFileByLink(path, 'contents\n', {
      ...publicationMessages,
      open: failingDirectorySync,
      rollback: async () => { throw rollbackFailure; },
      stagingPath,
    })).rejects.toMatchObject({
      errors: [directoryFailure, rollbackFailure],
      message: 'publication and cleanup both failed',
    });
    await rm(path, { force: true });

    // Staging cleanup failures fail even an otherwise successful publication.
    const removeFailure = new Error('staging remove failed');
    await expect(publishFileByLink(path, 'contents\n', {
      ...publicationMessages,
      remove: async () => { throw removeFailure; },
      stagingPath,
    })).rejects.toMatchObject({ errors: [removeFailure], message: 'staging cleanup failed' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('tolerates documented Windows directory fsync gaps during link publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-publish-windows-'));
  try {
    const failingOpen: DurableHandleOpen = async () => ({
      close: async () => undefined,
      sync: async () => { throw errnoFailure('EACCES', 'denied'); },
    });
    const path = join(root, 'published.json');
    await expect(publishFileByLink(path, 'contents\n', {
      ...publicationMessages,
      open: failingOpen,
      platform: 'win32',
      stagingPath: join(root, '.stage'),
    })).resolves.toBe(true);
    await expect(readFile(path, 'utf8')).resolves.toBe('contents\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('probes process liveness through ESRCH only', () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(2_147_483_647)).toBe(false);
});

it('drives owner acquisition through creation, adoption, stale clearing, and exhaustion', async () => {
  const judged: string[] = [];
  await expect(acquireOwnerLockFile({
    create: async () => 'created',
    exhausted: () => new Error('exhausted'),
    onContention: async () => {
      judged.push('unexpected');
      return 'adopted';
    },
  })).resolves.toBe('created');
  expect(judged).toEqual([]);

  // EEXIST routes to the judge, which may adopt the surviving owner ...
  await expect(acquireOwnerLockFile({
    create: async () => { throw errnoFailure('EEXIST', 'occupied'); },
    exhausted: () => new Error('exhausted'),
    onContention: async () => 'adopted',
  })).resolves.toBe('adopted');

  // ... or clear a stale owner so the create retries within its budget.
  let creates = 0;
  await expect(acquireOwnerLockFile({
    attempts: 2,
    create: async () => {
      creates += 1;
      if (creates === 1) throw errnoFailure('EEXIST', 'occupied');
      return 'recovered';
    },
    exhausted: () => new Error('exhausted'),
    onContention: async () => undefined,
  })).resolves.toBe('recovered');
  expect(creates).toBe(2);

  // The default single attempt concedes with the store's exhausted error.
  await expect(acquireOwnerLockFile({
    create: async () => { throw errnoFailure('EEXIST', 'occupied'); },
    exhausted: () => new Error('exhausted'),
    onContention: async () => undefined,
  })).rejects.toThrow('exhausted');

  // Judge failures and non-EEXIST create failures propagate unchanged.
  await expect(acquireOwnerLockFile({
    create: async () => { throw errnoFailure('EEXIST', 'occupied'); },
    exhausted: () => new Error('exhausted'),
    onContention: async () => { throw new Error('owned by a live process'); },
  })).rejects.toThrow('owned by a live process');
  const denied = errnoFailure('EACCES', 'denied');
  await expect(acquireOwnerLockFile({
    create: async () => { throw denied; },
    exhausted: () => new Error('exhausted'),
    onContention: async () => 'adopted',
  })).rejects.toBe(denied);
});
