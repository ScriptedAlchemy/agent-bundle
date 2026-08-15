import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';

const browserTimeout = 12_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

e2e('renders the capability-gated Runtime sibling in the real RSC workbench', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const pageErrors: Error[] = [];
  const foregroundSessionRequests: string[] = [];
  const resetRequests: unknown[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === fixture.url && requestUrl.pathname === '/api/project/session') foregroundSessionRequests.push(request.url());
    if (requestUrl.origin === fixture.url && requestUrl.pathname === '/api/runtime/state/reset' && request.method() === 'POST') {
      resetRequests.push(JSON.parse(request.postData() ?? 'null'));
    }
  });
  try {
    await page.goto(`${fixture.url}#overview`);
    await expect(page.getByRole('link', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Runtime' })).toBeVisible({ timeout: browserTimeout });

    await page.goto(`${fixture.url}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1);
    await page.goto(`${fixture.url}#inspector`);
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#inspector`);
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#mcp`);
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1);

    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('[data-runtime-provider-session]')).toHaveCount(1);
    const runtimeIdentity = await page.evaluate(async () => {
      const response = await fetch('/api/runtime/status');
      const { status } = await response.json() as { readonly status: Readonly<{
        readonly activeVector?: Readonly<{
          readonly artifactEpochId?: string;
          readonly providerSessionId: string;
          readonly runtimeGenerationId: string;
          readonly sourceRevision: string;
          readonly stateStoreId: string;
          readonly stateVersion: number;
        }>;
        readonly hmrReady: boolean;
        readonly lastGoodVector?: unknown;
        readonly state: string;
      }> | null };
      if (status?.activeVector === undefined || status.lastGoodVector === undefined) throw new Error('Expected active Runtime provider identity.');
      return { activeVector: status.activeVector, hmrReady: status.hmrReady, state: status.state };
    });
    expect(runtimeIdentity.state).toBe('active');
    const identity = page.locator('[data-runtime-provider-session]');
    await expect(identity).toHaveAttribute('data-runtime-artifact-epoch', runtimeIdentity.activeVector.artifactEpochId ?? 'Not packaged');
    await expect(identity).toHaveAttribute('data-runtime-generation', runtimeIdentity.activeVector.runtimeGenerationId);
    expect(Number(await identity.getAttribute('data-runtime-event-sequence'))).toBeGreaterThanOrEqual(0);
    await expect(identity).toHaveAttribute('data-runtime-hmr-client-count', 'Unknown');
    await expect(identity).toHaveAttribute('data-runtime-hmr-ready', String(runtimeIdentity.hmrReady));
    await expect(identity).toHaveAttribute('data-runtime-provider-session', runtimeIdentity.activeVector.providerSessionId);
    await expect(identity).toHaveAttribute('data-runtime-source-revision', runtimeIdentity.activeVector.sourceRevision);
    await expect(identity).toHaveAttribute('data-runtime-state-version', String(runtimeIdentity.activeVector.stateVersion));
    await expect.poll(() => foregroundSessionRequests).toHaveLength(1);

    await page.goto(`${fixture.url}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('timeline');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await expect(foregroundSessionRequests).toHaveLength(1);
    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await expect(page.getByRole('button', { name: 'Reset MCP session' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'Reset MCP session' }).click();
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await expect(foregroundSessionRequests).toHaveLength(1);
    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await expect(page.getByRole('button', { name: 'Reset MCP session' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });

    await page.getByLabel('Runtime surface').selectOption('mcp.recent_edits');
    await page.getByLabel('Schema form').check();
    await expect(page.getByLabel('Schema form')).toBeChecked();
    await page.getByLabel('limit').fill('2');
    await page.getByLabel('Raw JSON').check();
    const input = page.locator('#runtime-input-raw');
    await expect(input).toHaveValue(/"limit": 2/);
    await input.fill('{"broken":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    await page.goto(`${fixture.url}#inspector`);
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#runtime`);
    await expect(input).toHaveValue('{"broken":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();

    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await page.getByLabel('Runtime surface').selectOption('mcp.runtime_status');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBeGreaterThan(0);

    await page.getByLabel('Runtime surface').selectOption('hook.claude');
    await input.fill(JSON.stringify({
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      session_id: 'runtime-playground',
      tool_input: { file_path: 'runtime-playground.txt' },
      tool_name: 'Write',
      tool_use_id: 'runtime-playground-tool',
    }));
    const run = page.getByRole('button', { name: 'Run', exact: true });
    await expect(run).toBeEnabled({ timeout: browserTimeout });
    await run.focus();
    await page.keyboard.press('Enter');
    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toContainText('Run mutable runtime surface?');
    const cancel = confirmation.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused({ timeout: browserTimeout });
    await expect(run).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(page.locator('.runtime-history button').first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Replay exact' }).first()).toBeDisabled();
    await expect(page.getByLabel('Runtime surface')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await expect(run).toBeFocused({ timeout: browserTimeout });

    const historyBeforeRun = await history.count();
    await page.keyboard.press('Enter');
    await expect(confirmation).toContainText('Run mutable runtime surface?');
    await confirmation.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBeGreaterThan(historyBeforeRun);

    await page.getByLabel('Runtime surface').selectOption('mcp.runtime_status');
    await input.fill('{}');
    await run.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBeGreaterThan(historyBeforeRun);

    const reset = page.getByRole('button', { name: 'Reset fixture state' });
    const stateVersionBeforeReset = await identity.getAttribute('data-runtime-state-version');
    await reset.click();
    await expect(confirmation).toContainText('Reset fixture state?');
    await expect(confirmation).toContainText('State store');
    await expect(confirmation).toContainText(runtimeIdentity.activeVector.stateStoreId);
    await expect(confirmation).toContainText('Fixture seed');
    await expect(confirmation).toContainText('No fixture seed');
    await expect(reset).toBeDisabled();
    await expect(cancel).toBeFocused({ timeout: browserTimeout });
    await page.keyboard.press('Tab');
    await expect(confirmation.getByRole('button', { name: 'Confirm' })).toBeFocused({ timeout: browserTimeout });
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused({ timeout: browserTimeout });
    await page.keyboard.press('Shift+Tab');
    await expect(confirmation.getByRole('button', { name: 'Confirm' })).toBeFocused({ timeout: browserTimeout });
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await expect(reset).toBeFocused({ timeout: browserTimeout });
    expect(resetRequests).toEqual([]);
    await reset.click();
    await expect(confirmation).toContainText('State store');
    await confirmation.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => resetRequests).toHaveLength(1);
    expect(resetRequests).toEqual([{
      expectedGenerationId: runtimeIdentity.activeVector.runtimeGenerationId,
      stateStoreId: runtimeIdentity.activeVector.stateStoreId,
    }]);
    await expect.poll(async () => identity.getAttribute('data-runtime-state-version'), { timeout: browserTimeout }).not.toBe(stateVersionBeforeReset);
    await expect(page.locator('.runtime-status')).toBeFocused({ timeout: browserTimeout });

    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(6);
    const stateTab = page.getByRole('tab', { name: 'State', exact: true });
    await stateTab.click();
    await expect(stateTab).toHaveAttribute('aria-selected', 'true');
    await page.goto(`${fixture.url}#mcp`);
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
