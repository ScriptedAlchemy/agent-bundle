import { mkdtemp, rm as removeDirectory, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { removeTree, type TreeRemoval } from './remove-tree.ts';

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
