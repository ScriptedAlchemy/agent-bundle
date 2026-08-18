import { execFile as executeFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { seedEvalProject } from '../../agent-bundle/tests/support/eval-project.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 12_000;
const runCompletionTimeout = 60_000;

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

e2e('admits a deterministic Eval promptly and renders refreshed durable evidence without desktop overflow', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await seedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    const durableReads: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/evals/runs/')) durableReads.push(request.url());
    });
    await page.goto(`${server.url}#evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Run deterministic suite' })).toBeEnabled({ timeout: browserTimeout });
    await expect(page.getByLabel('Harness')).toHaveValue('deterministic');
    await expect(page.getByText('Authored model pins are read-only')).toBeVisible();

    const started = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const admissionResponse = await started;
    const admission = await admissionResponse.json() as { readonly run: Readonly<{ readonly id: string }> };
    const runId = admission.run.id;
    expect(admissionResponse.request().postDataJSON()).toEqual({ harness: 'deterministic', suites: ['review-change'] });

    await expect(page.getByText(`Run ${runId} finished:`)).toBeVisible({ timeout: runCompletionTimeout });
    expect(durableReads).toContain(`${server.url}/api/evals/runs/${encodeURIComponent(runId)}`);
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Durable event timeline' })).toBeVisible({ timeout: browserTimeout });
    const sequences = await page.locator('.eval-timeline .eval-event-sequence').allTextContents();
    expect(sequences.map((value) => Number(value.slice(1)))).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences.length).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('heading', { name: 'Host / model matrix' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('unavailable evidence').first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('observed evidence').first()).toBeVisible({ timeout: browserTimeout });

    const artifactResponse = page.waitForResponse((response) => response.url().includes(`/api/evals/runs/${encodeURIComponent(runId)}/artifacts/`));
    await page.getByRole('button', { name: 'Preview safe text' }).first().click();
    expect((await artifactResponse).status()).toBe(200);
    const rawArtifact = page.locator('.eval-raw-artifact').first();
    await expect(rawArtifact).toContainText('Download evidence.json', { timeout: browserTimeout });
    const downloadLink = page.getByRole('link', { name: 'Download evidence.json' }).first();
    await expect(downloadLink).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.eval-raw-result pre code').first()).not.toHaveText('');
    const download = page.waitForEvent('download');
    await downloadLink.click();
    await (await download).path();

    const restarted = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const replacement = await (await restarted).json() as { readonly run: Readonly<{ readonly id: string }> };
    expect(replacement.run.id).not.toBe(runId);
    await expect(page.getByText(`Run ${replacement.run.id} finished:`)).toBeVisible({ timeout: runCompletionTimeout });
    await expect(page.getByRole('link', { name: 'Download evidence.json' })).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
