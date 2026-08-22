import { constants } from 'node:fs';
import { link, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  openPinnedContainedFile,
  publishFileByLink,
  readPinnedFile,
  readTornTailJsonl,
  syncDirectorySync,
  syncPath,
  writeJsonFileAtomically,
  writeNewPinnedFile,
  type DurableHandleOpen,
  type DurableStagingOpen,
} from '../src/core/durable-fs.ts';
import { acquireOwnerLockFile, isProcessAlive, OwnerMutationSerializer } from '../src/core/owner-lock.ts';

const errnoFailure = (code: string, message: string): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code });

const tornOptions = Object.freeze({
  decode: (value: unknown): { readonly sequence: number; readonly value: string } => {
    const record = value as { readonly sequence: number; readonly value: string };
    return Object.freeze({ sequence: record.sequence, value: record.value });
  },
  emptyRecord: () => new Error('empty record'),
  malformedRecord: () => new Error('malformed record'),
  sequenceViolation: () => new Error('sequence violation'),
});

const publicationMessages = Object.freeze({
  publicationCleanupFailed: 'publication and cleanup both failed',
  stagingCleanupFailed: 'staging cleanup failed',
});

it('decodes complete JSONL journals and tolerates exactly one torn trailing append', () => {
  const complete = readTornTailJsonl('{"sequence":1,"value":"a"}\n{"sequence":2,"value":"b"}\n', tornOptions);
  expect(complete.records).toEqual([
    { sequence: 1, value: 'a' },
    { sequence: 2, value: 'b' },
  ]);
  expect(complete.incompleteTrailingRecord).toBeUndefined();
  expect(Object.isFrozen(complete.records)).toBe(true);

  const torn = readTornTailJsonl('{"sequence":1,"value":"a"}\n{"sequence":2,"va', tornOptions);
  expect(torn.records).toEqual([{ sequence: 1, value: 'a' }]);
  expect(torn.incompleteTrailingRecord).toBe('{"sequence":2,"va');

  const empty = readTornTailJsonl('', tornOptions);
  expect(empty.records).toEqual([]);
  expect(empty.incompleteTrailingRecord).toBeUndefined();

  const tornFirstAppend = readTornTailJsonl('{"sequence":1', tornOptions);
  expect(tornFirstAppend.records).toEqual([]);
  expect(tornFirstAppend.incompleteTrailingRecord).toBe('{"sequence":1');
});

it('rejects empty lines, malformed or duplicate-key records, and sequence gaps in JSONL journals', () => {
  expect(() => readTornTailJsonl('\n{"sequence":1,"value":"a"}\n', tornOptions)).toThrow('empty record');
  expect(() => readTornTailJsonl('not json\n', tornOptions)).toThrow('malformed record');
  expect(() => readTornTailJsonl('{"sequence":1,"sequence":1,"value":"a"}\n', tornOptions)).toThrow('malformed record');
  expect(() => readTornTailJsonl('{"sequence":2,"value":"a"}\n', tornOptions)).toThrow('sequence violation');
  expect(() => readTornTailJsonl('{"sequence":1,"value":"a"}\n{"sequence":3,"value":"b"}\n', tornOptions))
    .toThrow('sequence violation');
});

it('publishes JSON atomically, fsyncing the staging file and then the directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-atomic-'));
  try {
    const path = join(root, 'value.json');
    const temporaryPath = join(root, '.value.json.tmp');
    const synced: string[] = [];
    const openHandle: DurableHandleOpen = async (target, flags) => {
      const handle = await open(target, flags);
      return {
        close: async () => { await handle.close(); },
        sync: async () => {
          synced.push(target);
          await handle.sync();
        },
      };
    };
    await writeJsonFileAtomically(path, '{"ok":true}\n', { open: openHandle, temporaryPath });
    await expect(readFile(path, 'utf8')).resolves.toBe('{"ok":true}\n');
    expect(synced).toEqual([temporaryPath, root]);
    await expect(readdir(root)).resolves.toEqual(['value.json']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('removes the atomic-write staging file when publication fails before or after the rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-atomic-failure-'));
  try {
    const path = join(root, 'value.json');
    const temporaryPath = join(root, '.value.json.tmp');
    const failingSync = (failingTarget: string, failure: Error): DurableHandleOpen => async (target, flags) => {
      const handle = await open(target, flags);
      return {
        close: async () => { await handle.close(); },
        sync: async () => {
          if (target === failingTarget) throw failure;
          await handle.sync();
        },
      };
    };

    const stagingFailure = new Error('staging fsync failed');
    await expect(writeJsonFileAtomically(path, '{"ok":true}\n', {
      open: failingSync(temporaryPath, stagingFailure),
      temporaryPath,
    })).rejects.toBe(stagingFailure);
    await expect(readdir(root)).resolves.toEqual([]);

    const directoryFailure = new Error('directory fsync failed');
    await expect(writeJsonFileAtomically(path, '{"ok":true}\n', {
      open: failingSync(root, directoryFailure),
      temporaryPath,
    })).rejects.toBe(directoryFailure);
    // The rename already landed; only the staging path is guaranteed gone.
    await expect(readdir(root)).resolves.toEqual(['value.json']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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

it('applies the same Windows tolerance to the synchronous directory fsync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-sync-directory-'));
  try {
    const phases: string[] = [];
    syncDirectorySync(root, {
      beforeFsync: () => { phases.push('fsync'); },
      beforeOpen: () => { phases.push('open'); },
    });
    expect(phases).toEqual(['open', 'fsync']);
    expect(() => syncDirectorySync(root, {
      beforeFsync: () => { throw errnoFailure('EACCES', 'denied'); },
      platform: 'win32',
    })).not.toThrow();
    expect(() => syncDirectorySync(root, {
      beforeFsync: () => { throw errnoFailure('EACCES', 'denied'); },
      platform: 'linux',
    })).toThrow('denied');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('creates new pinned files exclusively and never follows an existing symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-new-pinned-'));
  try {
    const phases: string[] = [];
    const target = join(root, 'created.json');
    await writeNewPinnedFile(target, '{"created":true}\n', Object.freeze({
      afterFsync: () => { phases.push('after-fsync'); },
      beforeFsync: () => { phases.push('before-fsync'); },
      beforeWrite: () => { phases.push('before-write'); },
      invalid: () => new Error('not pinned'),
    }));
    expect(phases).toEqual(['before-write', 'before-fsync', 'after-fsync']);
    await expect(readFile(target, 'utf8')).resolves.toBe('{"created":true}\n');

    await expect(writeNewPinnedFile(target, 'again', { invalid: () => new Error('not pinned') }))
      .rejects.toMatchObject({ code: 'EEXIST' });

    // A dangling symlink at the path is never followed into a create.
    await symlink(join(root, 'elsewhere.json'), join(root, 'aliased.json'));
    await expect(writeNewPinnedFile(join(root, 'aliased.json'), 'aliased', { invalid: () => new Error('not pinned') }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(join(root, 'elsewhere.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects symlinked and multiply linked paths for pinned opens and pinned reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-durable-fs-pinned-'));
  try {
    const invalid = (): Error => new Error('pin rejected');
    await writeFile(join(root, 'real.json'), '{"pinned":true}\n', 'utf8');
    await symlink(join(root, 'real.json'), join(root, 'linked.json'));
    await link(join(root, 'real.json'), join(root, 'hard.json'));

    // Symlinks never open (O_NOFOLLOW) ...
    await expect(openPinnedContainedFile({ flags: constants.O_RDONLY, invalid, name: 'linked.json', root }))
      .rejects.toMatchObject({ code: 'ELOOP' });
    // ... and hardlinked files open but fail the single-link pin.
    await expect(openPinnedContainedFile({ flags: constants.O_RDONLY, invalid, name: 'hard.json', root }))
      .rejects.toThrow('pin rejected');

    const readOptions = Object.freeze({
      changedWhileOpening: () => new Error('changed while opening'),
      changedWhileReading: () => new Error('changed while reading'),
      maximumBytes: 1024,
      unsafe: () => new Error('unsafe read'),
    });
    await expect(readPinnedFile(join(root, 'linked.json'), readOptions)).rejects.toThrow('unsafe read');
    await expect(readPinnedFile(join(root, 'hard.json'), readOptions)).rejects.toThrow('unsafe read');
    // The original name is also multiply linked while the hardlink survives.
    await expect(readPinnedFile(join(root, 'real.json'), readOptions)).rejects.toThrow('unsafe read');

    await rm(join(root, 'hard.json'));
    const ancestry: string[] = [];
    await expect(readPinnedFile(join(root, 'real.json'), {
      ...readOptions,
      verifyAncestry: async () => { ancestry.push('verified'); },
    })).resolves.toBe('{"pinned":true}\n');
    expect(ancestry).toEqual(['verified', 'verified']);
    await expect(readPinnedFile(join(root, 'real.json'), { ...readOptions, maximumBytes: 4 }))
      .rejects.toThrow('unsafe read');

    const handle = await openPinnedContainedFile({ flags: constants.O_RDONLY, invalid, name: 'real.json', root });
    try {
      await expect(handle.readFile({ encoding: 'utf8' })).resolves.toBe('{"pinned":true}\n');
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
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

it('serializes owner mutations per path while distinct paths proceed concurrently', async () => {
  const serializer = new OwnerMutationSerializer();
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  const first = serializer.run('/lock-a', async () => {
    order.push('a1-start');
    await gate.promise;
    order.push('a1-end');
  });
  const second = serializer.run('/lock-a', async () => { order.push('a2'); });
  const other = serializer.run('/lock-b', async () => { order.push('b'); });
  await other;
  expect(order).toEqual(['a1-start', 'b']);
  gate.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
});
