import { writeFile } from 'node:fs/promises';

import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { buildWorkbench, e2e, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 12_000 * timeScale;

e2e('shows real producer logs with replay, filters, redaction, responsive layout, and no browser errors', { timeout: 90_000 }, async ({ page }) => {
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
    const replayed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === server.url && url.pathname === '/api/logs/replay' && url.searchParams.get('after') === '0' && response.ok();
    });
    await page.goto(workbenchUrl(server.url, 'logs'));
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
    await page.goto(workbenchUrl(server.url, 'overview'));
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(workbenchUrl(server.url, 'logs'));
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
    const replayedSequences = await page.waitForFunction(
      ({ count, selector }) => {
        const rows = [...globalThis.document.querySelectorAll(selector)];
        return rows.length >= count
          ? rows.map((row) => row.querySelector('.logs-entry-sequence')?.textContent ?? null)
          : false;
      },
      { count: replayCount, selector: '.logs-entries > li' },
      { timeout: browserTimeout },
    );
    const reconnectedSequences = await replayedSequences.jsonValue();
    if (reconnectedSequences === false) throw new Error('Logs replay readiness returned before the replay was complete.');
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
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
