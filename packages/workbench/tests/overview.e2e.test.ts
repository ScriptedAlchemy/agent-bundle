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
  await writeFile(project.skillSource, `${project.skillMarkdown}\n\`\`\`mermaid\ngraph TD\n\`\`\`\n`);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const asyncScripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && request.url().includes('/static/js/async/')) asyncScripts.add(request.url());
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    for (const name of ['Normalization summary', 'Artifact epoch', 'Generated targets', 'Diagnostics (0)', 'Next action']) {
      await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });

    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.locator('#skills .skills-page-heading > div > h1')).toHaveText('Skills', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'review', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Rendered' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Source' }).click();
    await expect(page.locator('.skill-source')).toContainText('---', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Generated' }).click();
    await expect(page.getByText(/Generated base ·/)).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.setViewportSize({ height: 844, width: 390 });
    await expect(page.locator('#skills .skills-page-heading > div > h1')).toHaveText('Skills', { timeout: browserTimeout });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });

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

e2e('loads the lazy Shiki chunk only after a fenced non-Mermaid Skill is rendered', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeFile(project.skillSource, `${project.skillMarkdown}\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n`);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const asyncScripts = new Set<string>();
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && request.url().includes('/static/js/async/')) asyncScripts.add(request.url());
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    expect([...asyncScripts]).toEqual([]);
    await page.getByRole('link', { name: 'Skills' }).click();
    await expect(page.locator('.skill-code-block')).toContainText('const answer: number = 42;', { timeout: browserTimeout });
    await expect.poll(() => asyncScripts.size, { timeout: browserTimeout }).toBeGreaterThan(0);
    await expect(page.locator('.skill-shiki')).toContainText('const answer: number = 42;', { timeout: browserTimeout });
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('retains the Overview and marks the foreground connection unavailable after an event refresh fails', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await page.route('**/api/project/status', (route) => route.fulfill({
      body: JSON.stringify({ diagnostic: { code: 'AB8007', message: 'Request could not be completed.' } }),
      contentType: 'application/json',
      status: 500,
    }));

    await page.getByRole('button', { name: 'Rebuild' }).click();

    await expect(page.getByRole('status')).toContainText('Foreground server unavailable', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Project overview' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toBeVisible({ timeout: browserTimeout });
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
