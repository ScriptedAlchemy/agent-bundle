import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm as removeDirectory, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { removeTree, removeTreeSync, type TreeRemoval } from './remove-tree.ts';

const emptyError = Object.assign(new Error('ENOTEMPTY: directory not empty, rmdir'), { code: 'ENOTEMPTY' });

it('removeTree deletes a directory after one ENOTEMPTY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remove-tree-'));
  await writeFile(join(root, 'kept.txt'), 'x\n');
  let declined = false;
  const fs: TreeRemoval = {
    rm: async (path, options) => {
      if (!declined) {
        declined = true;
        throw emptyError;
      }
      await removeDirectory(path, options);
    },
  };
  await removeTree(root, fs);
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removeTree surfaces a persistent ENOTEMPTY', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remove-tree-busy-'));
  await writeFile(join(root, 'kept.txt'), 'x\n');
  const fs: TreeRemoval = {
    rm: async () => {
      throw emptyError;
    },
  };
  await expect(removeTree(root, fs)).rejects.toBe(emptyError);
  expect((await stat(root)).isDirectory()).toBe(true);
  await removeTree(root);
});

it('removeTreeSync deletes a nested tree and tolerates a missing path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remove-tree-sync-'));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'kept.txt'), 'x\n');
  removeTreeSync(root);
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  removeTreeSync(root);
});

it('removeTreeSync retries ENOTEMPTY with backoff and surfaces a persistent one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remove-tree-sync-retry-'));
  await writeFile(join(root, 'kept.txt'), 'x\n');
  let attempts = 0;
  const started = Date.now();
  removeTreeSync(root, (path, options) => {
    attempts += 1;
    if (attempts === 1) throw emptyError;
    rmSync(path, options);
  });
  expect(attempts).toBe(2);
  expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });

  let persistent = 0;
  expect(() => removeTreeSync(root, () => {
    persistent += 1;
    throw emptyError;
  })).toThrow(emptyError);
  expect(persistent).toBe(6);
});
