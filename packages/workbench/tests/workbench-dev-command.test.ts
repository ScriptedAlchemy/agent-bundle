import { execFile as executeFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);

it('fails clearly instead of starting contributor HMR without a live foreground proxy target', async () => {
  await expect(execFile(process.execPath, ['scripts/dev.mjs'], {
    cwd: `${process.cwd()}/packages/workbench`,
    env: { PATH: process.env.PATH ?? '' },
  })).rejects.toMatchObject({
    stderr: expect.stringContaining('AGENT_BUNDLE_WORKBENCH_API_PROXY'),
  });
});
