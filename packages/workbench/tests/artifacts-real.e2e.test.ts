import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { buildWorkbench, e2e, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 12_000;

e2e('contains the mounted Artifacts page and its table at desktop and 390px widths', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto(workbenchUrl(server.url, 'artifacts'));
    await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.artifact-table').first()).toBeVisible({ timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
