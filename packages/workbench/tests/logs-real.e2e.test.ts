import { execFile as executeFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 12_000;

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
    await page.goto(`${server.url}#logs`);
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
    await page.goto(`${server.url}#overview`);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${server.url}#logs`);
    await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entries > li')).not.toHaveCount(0, { timeout: browserTimeout });
    const reconnectedCount = await page.locator('.logs-entries > li').count();
    expect(reconnectedCount).toBeGreaterThanOrEqual(replayCount);
    const sequences = await page.locator('.logs-entry-sequence').allTextContents();
    expect(new Set(sequences).size).toBe(reconnectedCount);

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
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
