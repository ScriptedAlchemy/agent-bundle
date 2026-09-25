import * as actualFs from 'node:fs/promises' with { rstest: 'importActual' };
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, rs } from '@rstest/core';

import { writeGeneratedTestModule } from '../src/rstest/generated-module.ts';
import { removeTree } from './support/remove-tree.ts';

const renameFailures: string[] = [];

rs.mock('node:fs/promises', () => ({
  ...actualFs,
  rename: async (from: string, to: string) => {
    const code = renameFailures.shift();
    if (code !== undefined) throw Object.assign(new Error(`${code}: rename`), { code });
    return actualFs.rename(from, to);
  },
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const roots: string[] = [];

afterEach(async () => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, 'platform', platformDescriptor);
  renameFailures.splice(0);
  await Promise.all(roots.splice(0).map((root) => removeTree(root)));
});

const projectRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-module-win32-'));
  roots.push(root);
  return root;
};

it('retries a transient Windows rename rejection until the module lands', async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  renameFailures.push('EPERM', 'EBUSY');
  const target = await writeGeneratedTestModule(await projectRoot(), 'meta.mjs', 'export {};\n');
  expect(renameFailures).toEqual([]);
  expect(await readFile(target, 'utf8')).toBe('export {};\n');
});

it('rejects a POSIX rename failure without retrying or leaving the temp file', async () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  renameFailures.push('EPERM', 'EPERM');
  const root = await projectRoot();
  await expect(writeGeneratedTestModule(root, 'meta.mjs', 'export {};\n')).rejects.toMatchObject({ code: 'EPERM' });
  expect(renameFailures).toEqual(['EPERM']);
  expect(await readdir(join(root, '.agent-bundle', 'test'))).toEqual([]);
});
