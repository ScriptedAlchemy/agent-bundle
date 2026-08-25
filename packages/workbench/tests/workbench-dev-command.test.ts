import { execFile as executeFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);

it('launches contributor HMR through the workspace pnpm toolchain', async () => {
  const source = await readFile(`${process.cwd()}/packages/workbench/scripts/dev.mjs`, 'utf8');

  expect(source).toContain("process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'");
  expect(source).not.toMatch(/\bnpm(?:\.cmd)?\b/u);
});

it('fails clearly instead of starting contributor HMR without a live foreground proxy target', async () => {
  await expect(execFile(process.execPath, ['scripts/dev.mjs'], {
    cwd: `${process.cwd()}/packages/workbench`,
    env: { PATH: process.env.PATH ?? '' },
  })).rejects.toMatchObject({
    stderr: expect.stringContaining('AGENT_BUNDLE_WORKBENCH_API_PROXY'),
  });
});
