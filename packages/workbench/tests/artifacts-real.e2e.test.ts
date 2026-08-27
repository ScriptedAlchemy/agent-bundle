import { expect } from '@rstest/playwright';

import { buildWorkbench, e2e, withWorkbenchProjectServer } from './support/workbench-e2e.ts';

const browserTimeout = 12_000;

e2e('contains the mounted Artifacts page and its table at desktop and 390px widths', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchProjectServer(async (server) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto(`${server.url}#/artifacts`);
    await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.artifact-table').first()).toBeVisible({ timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
