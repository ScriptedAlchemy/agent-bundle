import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { replaceWatchedSource } from '../../agent-bundle/tests/support/watched-files.ts';
import { buildWorkbench, e2e, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;

const waitForExampleValue = async <Value>(
  page: Parameters<typeof captureExampleState>[0],
  read: () => Promise<Value>,
  accepts: (value: Value) => boolean,
  label: string,
): Promise<Value> => {
  const deadline = Date.now() + browserTimeout;
  let value = await read();
  while (!accepts(value) && Date.now() < deadline) {
    await page.waitForTimeout(50);
    value = await read();
  }
  if (!accepts(value)) {
    throw new Error(
      `Timed out waiting for ${label}; last value was ${JSON.stringify(value)}; frames were ${JSON.stringify(page.frames().map((frame) => frame.url()))}.`,
    );
  }
  return value;
};

const rebuildFromCurrentPage = async (page: Parameters<typeof captureExampleState>[0]): Promise<void> => {
  const status = await page.evaluate(async () => {
    const sessionResponse = await fetch('/api/project/session');
    const session = await sessionResponse.json() as { readonly token: string };
    const response = await fetch('/api/project/rebuild', {
      body: JSON.stringify({ paths: [] }),
      headers: { 'content-type': 'application/json', 'x-agent-bundle-session': session.token },
      method: 'POST',
    });
    return response.status;
  });
  expect(status).toBe(200);
};

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
    await page.goto(workbenchUrl(server.url, 'skills'));
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'dependency-upgrade', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.skill-tree-item')).toHaveCount(3, { timeout: browserTimeout });
    for (const skill of ['dependency-upgrade', 'incident-triage', 'release-review']) {
      await page.getByRole('button', { name: new RegExp(skill, 'u') }).click();
      await expect(page.getByRole('heading', { name: skill, exact: true })).toBeVisible({ timeout: browserTimeout });
      await expect(page.getByLabel('Eval coverage')).toContainText('Indirect 1', { timeout: browserTimeout });
      await expect(page.getByLabel('Resource tree').getByRole('link')).not.toHaveCount(0, { timeout: browserTimeout });
    }
    for (const unavailable of ['Hooks', 'MCP playground', 'Playground']) {
      await expect(page.getByRole('link', { name: unavailable, exact: true })).toHaveCount(0, { timeout: browserTimeout });
    }
    await page.getByRole('button', { name: /release-review/u }).click();
    await expect(page.getByRole('heading', { name: 'release-review', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Markdown' }).click();
    await expect(page.locator('.skill-source')).toContainText('Release review', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Generated' }).click();
    await page.getByLabel('Target').selectOption('codex');
    await expect(page.locator('.skill-translation-note')).toHaveText(
      'This target keeps the authored instructions unchanged. Agent Bundle only changes the codex package layout.',
      { timeout: browserTimeout },
    );
    await captureExampleState(page, 'skills-starter', 'skills-populated');

    await page.goto(workbenchUrl(server.url, 'hooks'));
    await waitForSettledWorkbench(page);
    await expect(page).toHaveURL(new URL('#overview', server.url).href, { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Bundle dashboard', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Hooks', exact: true })).toHaveCount(0, { timeout: browserTimeout });

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

e2e('reveals, retains, repairs, and removes capabilities without reloading Chrome', { retry: 2, timeout: 120_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('skills-starter');
  const configPath = join(project.root, 'agent-bundle.config.ts');
  const hookSource = join(project.root, 'src', 'hooks', 'session-start.ts');
  const originalConfig = await readFile(configPath, 'utf8');
  const healthyHook = `export default () => ({\n  additionalContext: 'Review the current operational evidence before changing production.',\n  outcome: 'continue' as const,\n});\n`;
  const hookConfig = originalConfig.replace(
    '  plugin:',
    "  hooks: { sessionStart: { handler: './src/hooks/session-start.ts' } },\n  plugin:",
  );
  await mkdir(join(project.root, 'src', 'hooks'), { recursive: true });
  await writeFile(hookSource, healthyHook);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(workbenchUrl(server.url, 'hooks'));
    await waitForSettledWorkbench(page);
    await expect(page).toHaveURL(new URL('#overview', server.url).href, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Hooks', exact: true })).toHaveCount(0, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Playground', exact: true })).toHaveCount(0, { timeout: browserTimeout });

    await writeFile(configPath, hookConfig);
    await rebuildFromCurrentPage(page);
    await expect(page.getByRole('link', { name: 'Hooks', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Playground', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Hooks', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.locator('#hook-binding option')).not.toHaveCount(0, { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-revealed');

    await writeFile(hookSource, 'export default () => ({\n');
    await rebuildFromCurrentPage(page);
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: /Diagnostics \([1-9]/u })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.build-health')).toContainText('Last good build', { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Hooks', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Playground', exact: true })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-stale');

    await writeFile(hookSource, healthyHook);
    await rebuildFromCurrentPage(page);
    await expect(page.getByRole('heading', { name: 'Diagnostics (0)' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-repaired');

    await page.getByRole('link', { name: 'Hooks', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.locator('#hook-binding option')).not.toHaveCount(0, { timeout: browserTimeout });
    await writeFile(configPath, originalConfig);
    await rebuildFromCurrentPage(page);
    await expect(page).toHaveURL(new URL('#overview', server.url).href, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Hooks', exact: true })).toHaveCount(0, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Playground', exact: true })).toHaveCount(0, { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-removed');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});

e2e('drives Hooks, scripts, logs, diagnostics, and repair in real Chrome', { retry: 2, timeout: 150_000 }, async ({ page }) => {
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
    await page.goto(workbenchUrl(server.url, 'hooks'));
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

    await page.getByRole('link', { name: 'Routes', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Routes', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('This catalog is the compiled route graph the published build was produced from.', { exact: true })).toBeVisible({ timeout: browserTimeout });
    // verify-release is discovered by convention; detect-risk is configured, so
    // the compiled catalog must show exactly one script route.
    await expect(page.getByRole('heading', { name: 'Scripts', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.route-table')).toContainText('script:verify-release', { timeout: browserTimeout });
    await expect(page.locator('.route-table')).toContainText('src/scripts/verify-release.ts', { timeout: browserTimeout });
    await expect(page.locator('.route-table')).not.toContainText('script:detect-risk');
    await expect(page.locator('.route-state')).toHaveText('current', { timeout: browserTimeout });
    // Provenance renders under its source rather than running into it, which is
    // only true when the catalog stylesheet actually reached the document.
    await expect(page.locator('.route-provenance')).toHaveText('conventional', { timeout: browserTimeout });
    expect(await page.locator('.route-provenance').evaluate((node) => getComputedStyle(node).display)).toBe('block');
    await captureExampleState(page, 'hooks-and-scripts', 'routes-catalog');

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
    await expect(page.locator('.build-health')).toContainText('Last good build', { timeout: browserTimeout });
    await page.waitForTimeout(500);
    await expect(page.locator('.build-health')).toContainText('Last good build', { timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'diagnostic-stale');

    await writeFile(hookSource, healthyHook);
    const repaired = page.waitForResponse((response) => response.url() === `${server.url}/api/project/rebuild` && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Rebuild' }).click();
    await repaired;
    await expect(page.getByRole('heading', { name: 'Diagnostics (0)' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });
    await page.waitForTimeout(500);
    await expect(page.locator('.build-health')).toContainText('Current build', { timeout: browserTimeout });
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
    await page.goto(workbenchUrl(server.url, 'overview'));
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('See what this bundle publishes, try supported workflows, and rebuild after source changes.', { exact: true })).toBeVisible({ timeout: browserTimeout });
    for (const capability of ['1 Skill', '2 Hooks', '3 scripts', '3 MCP servers', '1 Eval suite', '3 generated targets']) {
      await expect(page.getByLabel('Bundle capabilities').getByText(capability, { exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.getByLabel('Recommended next actions').getByRole('link')).toHaveCount(3, { timeout: browserTimeout });
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

    await page.getByRole('link', { name: 'Routes', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Routes', exact: true })).toBeVisible({ timeout: browserTimeout });
    // Every capability here is configured rather than routed: the compiled
    // catalog reports an empty graph while all nine pages stay navigable.
    await expect(page.getByText('This project declares no conventional route modules.', { exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.route-table')).toHaveCount(0);
    for (const preserved of ['Overview', 'Skills', 'Hooks', 'MCP playground', 'Artifacts', 'Playground', 'Logs', 'Evals', 'Comparisons']) {
      await expect(page.getByRole('link', { name: preserved, exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await captureExampleState(page, 'mcp-app', 'routes-empty-graph');

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
    try {
      await waitForExampleValue(
        page,
        () => appText('#service'),
        (value) => value === 'payments-api',
        'the App service',
      );
    } catch (error) {
      await expectHealthyExamplePage(ledger);
      throw error;
    }
    await waitForExampleValue(
      page,
      () => appText('#status'),
      (value) => value === 'degraded',
      'the App status',
    );
    await waitForExampleValue(
      page,
      () => appText('#summary'),
      (value) => value === 'Payment latency is above the release threshold.',
      'the App summary',
    );
    await waitForExampleValue(
      page,
      () => appText('#checks'),
      (value) => value?.includes('Availabilitypassing') === true,
      'the App availability check',
    );
    await waitForExampleValue(
      page,
      () => appText('#checks'),
      (value) => value?.includes('P95 latencyfailing') === true,
      'the App latency check',
    );
    const appPreviewVisualState = async () => {
      for (const frame of page.frames()) {
        try {
          const marker = frame.locator('#status-indicator');
          if (await marker.count() !== 1) continue;
          return await marker.evaluate((indicator) => {
            const parseColor = (value: string) => {
              const channels = value.match(/[\d.]+/gu)?.map(Number) ?? [];
              return {
                alpha: channels[3] ?? 1,
                blue: channels[2] ?? 0,
                green: channels[1] ?? 0,
                red: channels[0] ?? 0,
              };
            };
            const relativeLuminance = ({ red, green, blue }: ReturnType<typeof parseColor>) => {
              const channel = (value: number) => {
                const normalized = value / 255;
                return normalized <= 0.04045
                  ? normalized / 12.92
                  : ((normalized + 0.055) / 1.055) ** 2.4;
              };
              return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
            };
            const statusText = indicator.querySelector<HTMLElement>('#status')!;
            const dot = indicator.querySelector<HTMLElement>('.dot')!;
            const panel = document.querySelector<HTMLElement>('main')!;
            const bodyBackground = parseColor(getComputedStyle(document.body).backgroundColor);
            const panelBackground = parseColor(getComputedStyle(panel).backgroundColor);
            const contrast = (relativeLuminance(parseColor(getComputedStyle(statusText).color)) + 0.05)
              / (relativeLuminance(panelBackground) + 0.05);
            return {
              bodyBackground,
              contrast: Math.max(contrast, 1 / contrast),
              dotBackground: parseColor(getComputedStyle(dot).backgroundColor),
              panelBackground,
              state: indicator.getAttribute('data-state'),
            };
          });
        } catch {
          // Retry against the App frame if the sandbox proxy is being replaced.
        }
      }
      return undefined;
    };
    await waitForExampleValue(
      page,
      appPreviewVisualState,
      (value) => value?.state === 'degraded',
      'the degraded App preview',
    );
    const appPreviewVisual = await appPreviewVisualState();
    expect(appPreviewVisual?.dotBackground.red).toBeGreaterThan(appPreviewVisual?.dotBackground.green ?? Number.POSITIVE_INFINITY);
    expect(appPreviewVisual?.bodyBackground.alpha).toBe(1);
    expect(appPreviewVisual?.panelBackground.alpha).toBe(1);
    expect(appPreviewVisual?.contrast).toBeGreaterThanOrEqual(4.5);
    await waitForExampleValue(page, async () => {
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
    }, (value) => value, 'the App details toggle');
    await waitForExampleValue(page, async () => {
      for (const frame of page.frames()) {
        try {
          const details = frame.locator('#details');
          if (await details.count() === 1) return details.isVisible();
        } catch {
          // Retry against the current App frame.
        }
      }
      return false;
    }, (value) => value, 'the App details panel');
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

e2e('renders the flagship compiled route catalog by server and kind in real Chrome', { retry: 2, timeout: 150_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('audiobook-curator');
  const conversionSource = join(project.root, 'src', 'conversion.ts');
  const healthyConversion = await readFile(conversionSource, 'utf8');
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(workbenchUrl(server.url, 'routes'));
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Routes', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.route-state')).toHaveText('current', { timeout: browserTimeout });

    // One generated server owns every MCP kind the curator declares, so each
    // kind must appear as its own server-scoped group rather than a flat list.
    for (const group of ['curator · Tools', 'curator · Resources', 'curator · Prompts']) {
      await expect(page.getByRole('heading', { name: group, exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await expect(page.locator('.route-group-heading').filter({ hasText: 'curator · Tools' })).toContainText('generated', { timeout: browserTimeout });
    const tools = page.getByRole('region', { name: 'curator · Tools' });
    await expect(tools.locator('tbody tr')).toHaveCount(16, { timeout: browserTimeout });
    await expect(tools).toContainText('tool:curator/convert_audiobook', { timeout: browserTimeout });
    await expect(tools).toContainText('src/mcp/curator/tools/convert_audiobook.tsx', { timeout: browserTimeout });
    await expect(tools).toContainText('tool:curator/review_curation_shelf', { timeout: browserTimeout });
    // The extracted config is summarized, never inlined as nested JSON.
    await expect(tools).toContainText('annotations: 2 keys', { timeout: browserTimeout });

    const inventoryTool = tools.getByRole('row').filter({ hasText: 'tool:curator/inventory_sources' });
    await expect(inventoryTool.getByText('Generated input editor', { exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(inventoryTool.getByLabel('Source (required)')).toBeVisible({ timeout: browserTimeout });
    await expect(inventoryTool.getByLabel('Report')).toBeVisible({ timeout: browserTimeout });
    await expect(inventoryTool.getByLabel('Strict')).toBeVisible({ timeout: browserTimeout });
    await expect(inventoryTool.getByLabel('Strict')).toHaveValue('', { timeout: browserTimeout });
    await inventoryTool.getByRole('button', { name: 'Validate input' }).click();
    await expect(inventoryTool.getByRole('alert')).toHaveText('Source is required.', { timeout: browserTimeout });
    await inventoryTool.getByLabel('Source (required)').fill('/tmp/audiobooks');
    await expect(inventoryTool.getByRole('button', { name: 'Open in MCP session' })).toBeEnabled({ timeout: browserTimeout });
    await inventoryTool.getByRole('button', { name: 'Open in MCP session' }).click();
    await waitForSettledWorkbench(page);
    await expect(page).toHaveURL(new URL('#mcp', server.url).href, { timeout: browserTimeout });
    await expect(page.locator('#mcp-server-name')).toHaveValue('curator', { timeout: browserTimeout });
    const prefill = page.getByRole('status').filter({ hasText: 'Tool call prefilled from Routes' });
    await expect(prefill).toContainText('inventory_sources', { timeout: browserTimeout });
    await expect(prefill).toContainText('"source": "/tmp/audiobooks"', { timeout: browserTimeout });
    await expect(prefill).not.toContainText('"strict"', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'Open MCP session' })).toBeEnabled({ timeout: browserTimeout });
    await page.getByRole('link', { name: 'Routes', exact: true }).click();
    await waitForSettledWorkbench(page);

    const resources = page.getByRole('region', { name: 'curator · Resources' });
    await expect(resources).toContainText('resource:curator/catalog', { timeout: browserTimeout });
    await expect(resources).toContainText('uri: audiobook-curator://catalog', { timeout: browserTimeout });
    await expect(page.getByRole('region', { name: 'curator · Prompts' })).toContainText('prompt:curator/curate', { timeout: browserTimeout });
    await expect(page.locator('.route-provenance').first()).toHaveText('conventional', { timeout: browserTimeout });

    // The generated CLI is a project surface rather than a server one. It
    // contains the 16 authored CLI routes plus one projected command for each
    // MCP tool, preserving the tool route IDs rather than duplicating either
    // category. Each command carries the argv projection compiled from its
    // input schema.
    const cli = page.getByRole('region', { name: 'CLI commands' });
    const cliRouteIds = await cli.locator('.route-id').allTextContents();
    const authoredCliRouteIds = cliRouteIds.filter((routeId) => routeId.startsWith('cli:'));
    const projectedMcpRouteIds = cliRouteIds.filter((routeId) => routeId.startsWith('tool:'));
    expect(authoredCliRouteIds).toEqual([
      'cli:acoustic-identify',
      'cli:acoustic-verify',
      'cli:apply-chapters',
      'cli:apply-metadata',
      'cli:audible-cache',
      'cli:audible-search',
      'cli:audible-select',
      'cli:audit',
      'cli:convert',
      'cli:inspect',
      'cli:inventory',
      'cli:library-audit',
      'cli:prepare',
      'cli:select',
      'cli:shelf',
      'cli:whisper-verify',
    ]);
    expect(projectedMcpRouteIds).toEqual(await tools.locator('.route-id').allTextContents());
    expect(new Set(cliRouteIds).size).toBe(cliRouteIds.length);
    expect(cliRouteIds).toHaveLength(authoredCliRouteIds.length + projectedMcpRouteIds.length);
    await expect(cli).toContainText('cli:library-audit', { timeout: browserTimeout });
    await expect(cli).toContainText('src/cli/library-audit.tsx', { timeout: browserTimeout });
    await expect(cli).toContainText('src/cli/shelf.tsx', { timeout: browserTimeout });
    await expect(cli.locator('.route-command').filter({ hasText: 'library-audit' }))
      .toHaveText('library-audit <sources...> [--concurrency <number>] --report <string> [--strict]', { timeout: browserTimeout });
    const inspectCli = cli.getByRole('row').filter({ hasText: 'cli:inspect' });
    await expect(inspectCli.locator('.route-command'))
      .toHaveText('inspect <root> [--max-files <number>]', { timeout: browserTimeout });

    await inspectCli.getByLabel('Root (required)').fill('/library');
    await inspectCli.getByLabel('Max files').fill('10');
    await inspectCli.getByRole('button', { name: 'Validate input' }).click();
    await expect(inspectCli.getByLabel('Generated argv invocation')).toHaveValue(
      'inspect /library --max-files 10',
      { timeout: browserTimeout },
    );

    // 18 MCP routes plus 16 authored and 16 projected CLI routes, and nothing
    // invented: the curator declares no conventional event routes or scripts
    // and discovers one conventional context provider.
    await expect(page.getByRole('region', { name: 'Route graph identity' }).locator('dd').first())
      .toHaveText('50', { timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'Event routes', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Scripts', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Context providers', exact: true })).toBeVisible({ timeout: browserTimeout });
    const providers = page.getByRole('region', { name: 'Context providers' });
    const libraryProvider = providers.getByRole('row').filter({ hasText: 'provider:library' });
    await expect(libraryProvider).toContainText('src/providers/library.ts', { timeout: browserTimeout });
    await expect(page.locator('.route-diagnostics')).toHaveCount(0);
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-by-server');

    // A prepared source revision can move ahead while a failed rebuild keeps
    // the published epoch intact. Reloading the same browser page re-reads that
    // prepared manifest and must identify it as stale until a repair publishes.
    await replaceWatchedSource(project.root, conversionSource, `${healthyConversion}\nconst = ;\n`);
    await rebuildFromCurrentPage(page);
    await page.reload();
    await waitForSettledWorkbench(page);
    await expect(page.locator('.route-state')).toHaveText('stale', { timeout: browserTimeout });
    await expect(page.locator('.routes-page-heading')).toContainText(
      'The dev server has compiled newer source than the published build. Rebuild to publish these routes.',
      { timeout: browserTimeout },
    );
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-stale');

    await replaceWatchedSource(project.root, conversionSource, healthyConversion);
    await rebuildFromCurrentPage(page);
    await waitForSettledWorkbench(page);
    await expect(page.locator('.route-state')).toHaveText('current', { timeout: browserTimeout });
    await expect(page.locator('.routes-page-heading')).toContainText(
      'This catalog is the compiled route graph the published build was produced from.',
      { timeout: browserTimeout },
    );
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-repaired');

    for (const preserved of ['Overview', 'Skills', 'Artifacts', 'Logs']) {
      await expect(page.getByRole('link', { name: preserved, exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});
