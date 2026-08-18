import { execFile as executeFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { seedEvalProject, writeEvalSuite } from '../../agent-bundle/tests/support/eval-project.ts';

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

const seedGatedEvalProject = async (root: string): Promise<{ readonly release: () => Promise<void> }> => {
  await seedEvalProject(root);
  const gate = join(root, 'evals', '.release-gated-run');
  await writeEvalSuite(root, 'gated.eval.ts', {
    cases: [{ id: 'wait-for-cancel', kind: 'pass' }],
    name: 'gated-cancel',
  });
  await writeFile(join(root, 'evals', 'graders', 'reads-result.ts'), [
    "import { access } from 'node:fs/promises';",
    '',
    `const gate = ${JSON.stringify(gate)};`,
    'const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));',
    '',
    'export default async () => {',
    '  for (let attempt = 0; attempt < 400; attempt += 1) {',
    '    try {',
    '      await access(gate);',
    "      return { detail: 'The gate was released.', outcome: 'pass' as const };",
    '    } catch {',
    '      await wait(25);',
    '    }',
    '  }',
    "  throw new Error('The deterministic cancel gate was not released.');",
    '};',
    '',
  ].join('\n'));
  return { release: async () => writeFile(gate, 'released\n') };
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

    await expect(page.getByText(`Run ${runId} finished:`)).toBeVisible({ timeout: browserTimeout });
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
    await expect(page.getByText(`Run ${replacement.run.id} finished:`)).toBeVisible({ timeout: browserTimeout });
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

e2e('keeps a gated deterministic run cancellable exactly once and rejects stale run-list refreshes', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const gate = await seedGatedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  let releaseStaleList: (() => void) | undefined;
  let releaseCancel: (() => void) | undefined;
  try {
    let listRequests = 0;
    let resolveSecondList: (() => void) | undefined;
    const secondList = new Promise<void>((resolve) => { resolveSecondList = resolve; });
    const staleList = new Promise<void>((resolve) => { releaseStaleList = resolve; });
    const heldCancel = new Promise<void>((resolve) => { releaseCancel = resolve; });
    let cancellations = 0;
    let resolveCancellation: (() => void) | undefined;
    const cancellationSeen = new Promise<void>((resolve) => { resolveCancellation = resolve; });
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(`${server.url}/api/evals/runs`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      listRequests += 1;
      if (listRequests === 1) {
        await staleList;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ runs: [] }), status: 200 });
        return;
      }
      resolveSecondList?.();
      await route.continue();
    });
    await page.route(`${server.url}/api/evals/runs/*/cancel`, async (route) => {
      cancellations += 1;
      resolveCancellation?.();
      await heldCancel;
      await route.continue();
    });
    await page.goto(`${server.url}#evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await page.getByLabel('Suite').selectOption('gated-cancel');
    const admitted = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const admission = await (await admitted).json() as { readonly run: Readonly<{ readonly id: string }> };
    const runId = admission.run.id;
    await secondList;
    releaseStaleList?.();
    await expect(page.getByLabel('Recorded run')).toHaveValue(runId, { timeout: browserTimeout });

    const cancel = page.getByRole('button', { name: 'Cancel run' });
    await expect(cancel).toBeVisible({ timeout: browserTimeout });
    await cancel.evaluate((button) => {
      if (button instanceof HTMLButtonElement) {
        button.click();
        button.click();
      }
    });
    await cancellationSeen;
    await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(cancellations).toBe(1);
    releaseCancel?.();
    await expect(page.getByText('Cancellation was recorded for this run.')).toBeVisible({ timeout: browserTimeout });
    await gate.release();
    await expect(page.getByText(`Run ${runId} was cancelled after recording`)).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('run.cancelled')).toBeVisible({ timeout: browserTimeout });
    expect(cancellations).toBe(1);
    expect(pageErrors).toEqual([]);
  } finally {
    releaseStaleList?.();
    releaseCancel?.();
    await gate.release();
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('does not cancel a gated run when a newer admission replaces it or the Eval page unmounts', { timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const gate = await seedGatedEvalProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    let cancellations = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/cancel')) cancellations += 1;
    });
    await page.goto(`${server.url}#evals`);
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible({ timeout: browserTimeout });
    await page.getByLabel('Suite').selectOption('gated-cancel');
    const firstAdmission = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const first = await (await firstAdmission).json() as { readonly run: Readonly<{ readonly id: string }> };
    await expect(page.getByRole('button', { name: 'Cancel run' })).toBeVisible({ timeout: browserTimeout });

    const replacementAdmission = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/evals/runs` && response.request().method() === 'POST' && response.status() === 202);
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    const replacement = await (await replacementAdmission).json() as { readonly run: Readonly<{ readonly id: string }> };
    await expect(page.locator('.eval-summary')).toContainText(replacement.run.id, { timeout: browserTimeout });
    await page.waitForTimeout(150);
    await expect(page.locator('.eval-summary')).not.toContainText(first.run.id);
    await page.goto(`${server.url}#overview`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({ timeout: browserTimeout });
    expect(cancellations).toBe(0);
  } finally {
    await gate.release();
    await server.close();
    await removeProjectFixture(project.root);
  }
});
