import { execFile as executeFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { test, type PlaywrightOptions } from '@rstest/playwright';

export const execFile = promisify(executeFile);
export const workspaceRoot = process.cwd();
export const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');

export const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

let workbenchBuild: Promise<void> | undefined;

export const buildWorkbench = (): Promise<void> => workbenchBuild ??= (async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
})();
