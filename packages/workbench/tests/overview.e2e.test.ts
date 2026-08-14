import { execFile as executeFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 5_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const buildWorkbench = async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
};

e2e('renders and rebuilds the complete responsive Overview against a real foreground server', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    for (const name of ['Normalization summary', 'Artifact epoch', 'Generated targets', 'Diagnostics (0)', 'Next action']) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    const rebuild = page.getByRole('button', { name: 'Rebuild' });
    let rebuildPosts = 0;
    await page.route('**/api/project/rebuild', async (route) => {
      rebuildPosts += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      await route.continue();
    });
    const response = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST' && candidate.url() === `${server.url}/api/project/rebuild`);
    await rebuild.click();
    await expect(page.getByRole('button', { name: 'Rebuilding…' })).toBeDisabled({ timeout: browserTimeout });
    await response;
    expect(rebuildPosts).toBe(1);
    await expect(rebuild).toBeEnabled({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
