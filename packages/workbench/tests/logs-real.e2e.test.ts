import { writeFile } from 'node:fs/promises';

import { expect } from '@rstest/playwright';

import { buildWorkbench, e2e, withWorkbenchProjectServer } from './support/workbench-e2e.ts';

const browserTimeout = 12_000;

e2e('shows real producer logs with replay, filters, redaction, responsive layout, and no browser errors', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchProjectServer(async (server, project) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    const replayed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === server.url && url.pathname === '/api/logs/replay' && url.searchParams.get('after') === '0' && response.ok();
    });
    await page.goto(`${server.url}#/logs`);
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
    const replay = await (await replayed).json() as { readonly replay: Readonly<{ readonly records: readonly unknown[] }> };
    expect(replay.replay.records.length).toBeGreaterThan(0);

    await writeFile(project.skillSource, `${project.skillMarkdown}\nSource change for Logs E2E.\n`);
    await expect(page.getByText('Project source changed.')).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entries > li').first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entry-level').first()).toBeVisible();
    await expect(page.getByText('Details', { exact: true }).first()).toBeVisible();

    await page.locator('#logs-producer').selectOption('project');
    await expect(page.locator('.logs-entry-source').first()).toHaveText('project', { timeout: browserTimeout });
    await page.locator('#logs-producer').selectOption('');
    const replayCount = await page.locator('.logs-entries > li').count();
    await page.goto(`${server.url}#/overview`);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${server.url}#/logs`);
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entries > li')).not.toHaveCount(0, { timeout: browserTimeout });
    const reconnectedSequences = await page.locator('.logs-entries > li').evaluateAll((rows) => rows.map((row) => row.querySelector('.logs-entry-sequence')?.textContent));
    expect(reconnectedSequences.length).toBeGreaterThanOrEqual(replayCount);
    expect(new Set(reconnectedSequences).size).toBe(reconnectedSequences.length);

    const unauthenticated = await page.evaluate(async () => {
      const response = await fetch('/api/logs/replay');
      return response.status;
    });
    expect(unauthenticated).toBe(403);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain(project.root);
    expect(bodyText).not.toContain('fixture-secret');

    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
