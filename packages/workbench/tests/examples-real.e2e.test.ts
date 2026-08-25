import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import {
  captureExampleState,
  copyExample,
  createExampleErrorLedger,
  exampleRoot,
  expectHealthyExamplePage,
  waitForSettledWorkbench,
  writeExampleReport,
} from './support/example-acceptance.ts';
import { buildWorkbench, e2e, workbenchAssets } from './support/workbench-e2e.ts';

const browserTimeout = 15_000;

e2e('drives the populated Skills Starter in real Chrome', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: exampleRoot('skills-starter'),
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(`${server.url}#skills`);
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'release-review', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Markdown' }).click();
    await expect(page.locator('.skill-source')).toContainText('Release review', { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'skills-populated');

    await page.getByRole('link', { name: 'Artifacts' }).click();
    await waitForSettledWorkbench(page);
    for (const target of ['portable', 'codex', 'claude']) {
      await expect(page.locator(`#artifact-target option[value="${target}"]`)).toBeAttached({ timeout: browserTimeout });
    }
    await captureExampleState(page, 'skills-starter', 'artifacts-populated');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
  }
});

e2e('drives Hooks, scripts, logs, diagnostics, and repair in real Chrome', { timeout: 150_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('hooks-and-scripts');
  const hookSource = join(project.root, 'src', 'hooks', 'session-start.ts');
  const healthyHook = await readFile(hookSource, 'utf8');
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(`${server.url}#hooks`);
    await waitForSettledWorkbench(page);
    await expect(page.locator('#hook-binding option')).not.toHaveCount(0, { timeout: browserTimeout });
    const canonicalHookDraft = JSON.stringify({
      cwd: '/workspace',
      sessionId: 'workbench-preview',
      source: 'workbench',
      transcriptPath: '/workspace/transcript.json',
    }, null, 2);
    await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>('#hook-canonical-input')?.value === value, canonicalHookDraft, { timeout: browserTimeout });
    expect(await page.locator('#hook-canonical-input').inputValue()).toBe(canonicalHookDraft);
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Canonical result' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.hook-json').last()).toContainText('workbench-preview', { timeout: browserTimeout });
    const replayed = page.waitForResponse((response) => (
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/hooks/replays'
    ));
    await page.getByRole('button', { name: 'Replay saved simulation' }).click();
    expect((await replayed).ok()).toBe(true);
    await expect(page.locator('.hook-json').last()).toContainText('workbench-preview', { timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'hooks-populated');

    await page.getByRole('link', { name: 'Playground', exact: true }).click();
    await waitForSettledWorkbench(page);
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('#playground-script-id')?.value === 'script:verify-release', undefined, { timeout: browserTimeout });
    expect(await page.locator('#playground-target').inputValue()).toBe('claude');
    expect(await page.locator('#playground-operation').inputValue()).toBe('script.run');
    expect(await page.locator('#playground-script-id').inputValue()).toBe('script:verify-release');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.playground-trace')).toContainText('ready for packaging', { timeout: browserTimeout });
    await expect(page.locator('.playground-trace')).toContainText('is finalized', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Run script' })).toBeEnabled({ timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'script-success');

    await page.locator('#playground-target').selectOption('portable');
    await page.locator('#playground-script-id').selectOption('script:detect-risk');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.locator('.playground-trace')).toContainText('REL-204', { timeout: browserTimeout });
    await expect(page.locator('.playground-event-card').filter({ hasText: 'script.completed' }).last().locator('.playground-json')).toContainText('"exitCode": 2', { timeout: browserTimeout });
    await expect(page.locator('.playground-trace')).toContainText('is finalized', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Run script' })).toBeEnabled({ timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'script-failure');

    await page.getByRole('link', { name: 'Logs' }).click();
    await waitForSettledWorkbench(page);
    await expect(page.locator('.logs-entries > li').first()).toBeVisible({ timeout: browserTimeout });
    for (const filter of ['logs-producer', 'logs-level', 'logs-kind', 'logs-context']) {
      const select = page.locator(`#${filter}`);
      const value = await select.locator('option').nth(1).getAttribute('value');
      if (value === null) throw new Error(`Expected ${filter} to expose a populated option.`);
      await select.selectOption(value);
      await expect(page.locator('.logs-entries > li').first()).toBeVisible({ timeout: browserTimeout });
      await select.selectOption('');
    }
    await page.getByText('Details', { exact: true }).first().click();
    await expect(page.locator('.logs-details').first()).toHaveAttribute('open', '');
    await captureExampleState(page, 'hooks-and-scripts', 'logs-populated');

    await writeFile(hookSource, 'export default () => ({\n');
    await page.getByRole('link', { name: 'Overview' }).click();
    const failedRebuild = page.waitForResponse((response) => response.url() === `${server.url}/api/project/rebuild` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Rebuild' }).click();
    await failedRebuild;
    await expect(page.getByRole('heading', { name: /Diagnostics \([1-9]/u })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--stale')).toContainText('Last good artifact epoch', { timeout: browserTimeout });
    await expect(page.locator('#overview .status-text')).toHaveText('failed', { timeout: browserTimeout });
    await page.waitForTimeout(500);
    await expect(page.locator('#overview .status-text')).toHaveText('failed', { timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'diagnostic-stale');

    await writeFile(hookSource, healthyHook);
    const repaired = page.waitForResponse((response) => response.url() === `${server.url}/api/project/rebuild` && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Rebuild' }).click();
    await repaired;
    await expect(page.getByRole('heading', { name: 'Diagnostics (0)' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.epoch-row--active')).toContainText('Current artifact epoch', { timeout: browserTimeout });
    await expect(page.locator('#overview .status-text')).toHaveText('idle', { timeout: browserTimeout });
    await page.waitForTimeout(500);
    await expect(page.locator('#overview .status-text')).toHaveText('idle', { timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'diagnostic-repaired');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});

e2e('drives every populated MCP App workflow surface in real Chrome', { timeout: 150_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('mcp-app');
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(`${server.url}#overview`);
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('Author once, exercise host-ready behavior, and evaluate durable evidence.', { exact: true })).toBeVisible({ timeout: browserTimeout });
    for (const stage of ['Author', 'Build', 'Exercise', 'Evaluate']) {
      await expect(page.getByRole('heading', { name: stage, exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.getByRole('heading', { name: /^[1-4]\.\s/u })).toHaveCount(0, { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'overview-dashboard');

    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'service-readiness', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByLabel('Eval coverage')).toContainText('Indirect 1', { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'skills-populated');

    await page.getByRole('link', { name: 'Hooks', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Hooks', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('#hook-binding option')).not.toHaveCount(0, { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await expect(page.getByRole('heading', { name: 'Canonical result' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.hook-json').last()).toContainText('payments-api', { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'hooks-populated');

    await page.getByRole('link', { name: 'Playground', exact: true }).click();
    await waitForSettledWorkbench(page);
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('#playground-script-id')?.value === 'script:check-service-fixture', undefined, { timeout: browserTimeout });
    expect(await page.locator('#playground-target').inputValue()).toBe('claude');
    expect(await page.locator('#playground-operation').inputValue()).toBe('script.run');
    await page.getByRole('button', { name: 'Run script' }).click();
    await expect(page.getByText('script.completed')).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.playground-trace')).toContainText('Compiler fixture is healthy.', { timeout: browserTimeout });
    await expect(page.locator('.playground-trace')).toContainText('is finalized', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Run script' })).toBeEnabled({ timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'playground-script-success');

    await page.getByRole('link', { name: 'Logs', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entries > li').first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.logs-entries')).toContainText('script.completed', { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'logs-populated');

    await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Artifacts', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#artifact-target').selectOption('portable');
    await expect(page.locator('.artifact-table').first()).toContainText('mcp-apps/status.html', { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'artifacts-populated');

    await page.getByRole('link', { name: 'Comparisons', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Comparisons', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.comparisons-content [role="status"]')).toHaveText('At least two recorded runs are needed before a comparison can be aligned.', { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'comparisons-insufficient-runs');

    await page.getByRole('link', { name: 'MCP playground', exact: true }).click();
    await waitForSettledWorkbench(page);
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#mcp-server-name')?.value === 'status', undefined, { timeout: browserTimeout });
    expect(await page.locator('#mcp-target').inputValue()).toBe('portable');
    expect(await page.locator('#mcp-server-name').inputValue()).toBe('status');
    await page.locator('#mcp-session-timeout').fill(String(browserTimeout));
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'List tools' }).click();
    await expect(page.getByRole('button', { name: 'show-status', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.locator('.mcp-page-phase').scrollIntoViewIfNeeded();
    await captureExampleState(page, 'mcp-app', 'mcp-session-ready');

    await page.getByRole('button', { name: 'show-status', exact: true }).click();
    await page.locator('#mcp-tool-arguments-service').selectOption('payments-api');
    await page.waitForFunction(() => {
      const input = document.querySelector<HTMLSelectElement>('#mcp-tool-arguments-service');
      return input?.value === 'payments-api' && input.getAttribute('aria-invalid') === null;
    }, undefined, { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Call show-status' }).click();
    const history = page.getByRole('region', { name: 'Invocation history' });
    await expect(history).toContainText('Payment latency is above the release threshold.', { timeout: browserTimeout });
    await expect(history).toContainText('"status": "degraded"', { timeout: browserTimeout });
    await expect(history).toContainText('"label": "Availability"', { timeout: browserTimeout });
    await expect(history).toContainText('"label": "P95 latency"', { timeout: browserTimeout });
    await expect(history).toContainText('"status": "failing"', { timeout: browserTimeout });
    await history.locator('li').last().scrollIntoViewIfNeeded();
    await captureExampleState(page, 'mcp-app', 'mcp-degraded-tool-result');

    await page.getByRole('button', { name: /Open App preview/u }).click();
    const outerFrame = page.locator('iframe[title="MCP App preview: show-status"]');
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    const appText = async (selector: string): Promise<string | undefined> => {
      for (const frame of page.frames()) {
        try {
          const locator = frame.locator(selector);
          if (await locator.count() === 1) return await locator.textContent() ?? undefined;
        } catch {
          // The sandbox proxy replaces its inner frame once while installing the App document.
        }
      }
      return undefined;
    };
    await expect.poll(() => appText('#service'), { timeout: browserTimeout }).toBe('payments-api');
    await expect.poll(() => appText('#status'), { timeout: browserTimeout }).toBe('degraded');
    await expect.poll(() => appText('#summary'), { timeout: browserTimeout }).toBe('Payment latency is above the release threshold.');
    await expect.poll(() => appText('#checks'), { timeout: browserTimeout }).toContain('Availabilitypassing');
    await expect.poll(() => appText('#checks'), { timeout: browserTimeout }).toContain('P95 latencyfailing');
    await expect.poll(async () => {
      for (const frame of page.frames()) {
        try {
          const toggle = frame.locator('#toggle-details');
          if (await toggle.count() === 1) {
            await toggle.click();
            return true;
          }
        } catch {
          // Retry against the installed App frame if the proxy frame is being replaced.
        }
      }
      return false;
    }, { timeout: browserTimeout }).toBe(true);
    await expect.poll(async () => {
      for (const frame of page.frames()) {
        try {
          const details = frame.locator('#details');
          if (await details.count() === 1) return details.isVisible();
        } catch {
          // Retry against the current App frame.
        }
      }
      return false;
    }, { timeout: browserTimeout }).toBe(true);
    await captureExampleState(page, 'mcp-app', 'mcp-app-preview');
    await expectHealthyExamplePage(ledger);

    await page.getByRole('tab', { name: 'Raw protocol' }).click();
    await expect(page.locator('.mcp-page-trace li').first()).toBeVisible({ timeout: browserTimeout });
    const inspectorDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Inspector config' }).click();
    await (await inspectorDownload).path();
    await captureExampleState(page, 'mcp-app', 'mcp-trace');

    const restarted = page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/mcp\/sessions\/[^/]+\/restart$/u.test(new URL(response.url()).pathname));
    await page.getByRole('button', { name: 'Restart MCP session' }).click();
    expect((await restarted).status()).toBe(200);
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session closed', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Reset MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session idle', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });

    await page.getByRole('link', { name: 'Evals' }).click();
    await waitForSettledWorkbench(page);
    await expect(page.locator('#eval-suite option')).not.toHaveCount(0, { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Run deterministic suite' }).click();
    await expect(page.getByText(/finished:/u)).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.eval-counts')).toContainText(/1 passed · 0 failed · 0 inconclusive/u, { timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'eval-completed');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});
