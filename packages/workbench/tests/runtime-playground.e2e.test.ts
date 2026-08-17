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
  const forbiddenRequests: string[] = [];
  const resetRequests: unknown[] = [];
  const forbiddenPrefixes = ['/api/mcp/sessions', '/api/runtime/mcp/sessions', '/api/mcp/apps', '/api/runtime/apps'];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === fixture.url && requestUrl.pathname === '/api/project/session') foregroundSessionRequests.push(request.url());
    if (forbiddenPrefixes.some((prefix) => requestUrl.pathname.startsWith(prefix))) forbiddenRequests.push(requestUrl.pathname);
    if (requestUrl.origin === fixture.url && requestUrl.pathname === '/api/runtime/state/reset' && request.method() === 'POST') {
      resetRequests.push(JSON.parse(request.postData() ?? 'null'));
    }
  });
  try {
    await page.goto(`${fixture.url}#overview`);
    await expect(page.getByRole('link', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Inspector' })).toHaveCount(0, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Runtime' })).toBeVisible({ timeout: browserTimeout });

    await page.goto(`${fixture.url}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1, { timeout: browserTimeout });
    await page.goto(`${fixture.url}#inspector`);
    await expect(page).toHaveURL(/#mcp$/u, { timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#inspector`);
    await expect(page).toHaveURL(/#mcp$/u, { timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Playground' }).click();
    await expect(page.getByRole('tab', { name: 'Playground' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1, { timeout: browserTimeout });

    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('[data-runtime-provider-session]')).toHaveCount(1, { timeout: browserTimeout });
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

    await page.getByLabel('Runtime surface').selectOption('mcp.recent_edits');
    await page.getByLabel('Schema form').check();
    await expect(page.getByLabel('Schema form')).toBeChecked();
    await page.getByLabel('limit').fill('2');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    const input = page.locator('#runtime-input-raw');
    await expect(input).toHaveValue(/"limit": 2/);
    await input.fill('{"broken":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    await page.goto(`${fixture.url}#inspector`);
    await expect(page).toHaveURL(/#mcp$/u, { timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('[data-runtime-provider-session]')).toHaveCount(1, { timeout: browserTimeout });
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
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByLabel('MCP App preview controls')).toHaveCount(1, { timeout: browserTimeout });
    expect(forbiddenRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

e2e('keeps Runtime controls at least 40px tall and inside the 390px viewport without horizontal scrolling', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('[data-runtime-provider-session]')).toHaveCount(1, { timeout: browserTimeout });
    const run = page.getByRole('button', { name: 'Run', exact: true });
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await page.getByLabel('Runtime surface').selectOption('mcp.runtime_status');
    await run.click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBeGreaterThan(0);
    await page.getByLabel('Runtime surface').selectOption('hook.claude');
    await page.getByLabel('Runtime fixture').selectOption('claude-post-tool-use-write');
    await run.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: browserTimeout });
    const layout = await page.evaluate(() => {
      const { body, documentElement } = globalThis.document;
      documentElement.scrollLeft = 0;
      if (body !== null) body.scrollLeft = 0;
      globalThis.scrollTo({ left: 0, top: globalThis.scrollY });
      const elements = [
        globalThis.document.querySelector('.runtime-playground'),
        globalThis.document.querySelector('.runtime-controls'),
        globalThis.document.querySelector('.runtime-stage'),
        ...[...globalThis.document.querySelectorAll('.runtime-controls label, .runtime-controls select')]
          .filter((element) => element.getClientRects().length > 0),
      ];
      const controls = [...globalThis.document.querySelectorAll<HTMLElement>([
        '.runtime-controls select',
        '.runtime-input select',
        '.runtime-input button',
        '.runtime-actions button',
        '.runtime-history button',
        '.runtime-confirmation button',
      ].join(','))].filter((element) => element.getClientRects().length > 0);
      return Object.freeze({
        bodyScrollLeft: body?.scrollLeft ?? 0,
        boxes: Object.freeze(elements.map((element) => {
          if (!(element instanceof globalThis.HTMLElement)) {
            throw new Error('Runtime mobile layout omitted a required visible control or stage.');
          }
          const rect = element.getBoundingClientRect();
          return Object.freeze({ left: rect.left, right: rect.right });
        })),
        controls: Object.freeze(controls.map((element) => {
          const rect = element.getBoundingClientRect();
          return Object.freeze({
            height: rect.height,
            label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
            left: rect.left,
            right: rect.right,
          });
        })),
        documentScrollLeft: documentElement.scrollLeft,
        viewportWidth: globalThis.innerWidth,
        windowScrollX: globalThis.scrollX,
      });
    });
    expect(layout.windowScrollX).toBe(0);
    expect(layout.documentScrollLeft).toBe(0);
    expect(layout.bodyScrollLeft).toBe(0);
    expect(layout.viewportWidth).toBe(390);
    expect(layout.controls.length).toBeGreaterThan(0);
    for (const box of layout.boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(layout.viewportWidth);
    }
    for (const control of layout.controls) {
      expect(control.height, control.label).toBeGreaterThanOrEqual(40);
      expect(control.left, control.label).toBeGreaterThanOrEqual(0);
      expect(control.right, control.label).toBeLessThanOrEqual(layout.viewportWidth);
    }
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

e2e('resets the selected Claude fixture to its seed without replacing prior runtime evidence', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const resetRequests: unknown[] = [];
  const pageErrors: Error[] = [];
  const claudeSeed = {
    cwd: '/tmp',
    hook_event_name: 'PostToolUse',
    session_id: 'fixture-claude-post-tool-use',
    tool_input: { file_path: 'fixture-claude-post-tool-use.txt' },
    tool_name: 'Write',
    tool_use_id: 'fixture-claude-post-tool-use-write',
  };
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === fixture.url && requestUrl.pathname === '/api/runtime/state/reset' && request.method() === 'POST') {
      resetRequests.push(JSON.parse(request.postData() ?? 'null'));
    }
  });
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const identity = page.locator('[data-runtime-provider-session]');
    await expect(identity).toHaveCount(1, { timeout: browserTimeout });
    const runtimeSessionToken = await page.evaluate(async () => {
      const response = await fetch('/api/project/session', { credentials: 'same-origin' });
      const body: unknown = await response.json();
      if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { readonly token?: unknown }).token !== 'string') {
        throw new Error(`Runtime session bootstrap failed with ${response.status}.`);
      }
      return (body as { readonly token: string }).token;
    });
    const runtimeJson = async (path: string): Promise<unknown> => page.evaluate(async ({ route, token }) => {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: { 'x-agent-bundle-session': token },
      });
      if (!response.ok) throw new Error(`Runtime request ${route} failed with ${response.status}.`);
      return response.json();
    }, { route: path, token: runtimeSessionToken });
    const surface = page.getByLabel('Runtime surface');
    const runtimeFixture = page.getByLabel('Runtime fixture');
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    const run = page.getByRole('button', { name: 'Run', exact: true });
    const reset = page.getByRole('button', { name: 'Reset fixture state' });
    const confirmation = page.getByRole('dialog');
    const cancel = confirmation.getByRole('button', { name: 'Cancel' });

    await surface.selectOption('hook.claude');
    await runtimeFixture.selectOption('claude-post-tool-use-write');
    await expect(runtimeFixture).toHaveValue('claude-post-tool-use-write');
    await run.click();
    await expect(confirmation).toContainText('Run mutable runtime surface?');
    await confirmation.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(1);
    await expect(run).toBeEnabled({ timeout: browserTimeout });

    const historyBeforeReset = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly runs: readonly Readonly<{
        readonly fixtureId?: string;
        readonly id: string;
        readonly input: unknown;
        readonly status: string;
        readonly surfaceId: string;
        readonly target: string;
        readonly vector: Readonly<{ readonly stateStoreId: string; readonly stateVersion: number }>;
      }> [];
    }>;
    expect(historyBeforeReset.runs).toHaveLength(1);
    expect(historyBeforeReset.runs[0]).toMatchObject({
      fixtureId: 'claude-post-tool-use-write',
      input: claudeSeed,
      status: 'succeeded',
      surfaceId: 'hook.claude',
      target: 'claude',
    });
    const oldRunIds = historyBeforeReset.runs.map((entry) => entry.id);
    const oldRunVectors = Object.fromEntries(await Promise.all(oldRunIds.map(async (runId) => {
      const response = await runtimeJson(`/api/runtime/runs/${encodeURIComponent(runId)}`) as Readonly<{
        readonly run: Readonly<{ readonly vector: unknown }>;
      }>;
      return [runId, JSON.parse(JSON.stringify(response.run.vector))] as const;
    })));
    const stateStoreId = historyBeforeReset.runs[0]!.vector.stateStoreId;
    const stateVersionBeforeReset = historyBeforeReset.runs[0]!.vector.stateVersion;
    const generationId = await identity.getAttribute('data-runtime-generation');
    expect(generationId).not.toBeNull();

    await reset.click();
    await expect(confirmation).toContainText('Reset fixture state?');
    await expect(confirmation).toContainText(JSON.stringify(claudeSeed));
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
    const resetResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return requestUrl.origin === fixture.url && requestUrl.pathname === '/api/runtime/state/reset' && response.request().method() === 'POST';
    });
    await confirmation.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => resetRequests, { timeout: browserTimeout }).toEqual([{
      expectedGenerationId: generationId,
      seed: claudeSeed,
      stateStoreId,
    }]);
    expect((await resetResponse).status()).toBe(200);
    await expect(identity).toHaveAttribute('data-runtime-state-version', String(stateVersionBeforeReset + 1), { timeout: browserTimeout });
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(oldRunIds.length + 1);
    await expect.poll(
      async () => page.locator('.runtime-status').evaluate((element) => element.ownerDocument.activeElement === element),
      { timeout: browserTimeout },
    ).toBe(true);

    const historyAfterReset = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly runs: readonly Readonly<{
        readonly id: string;
        readonly result?: Readonly<{ readonly state: Readonly<{ readonly snapshot?: unknown }> }>;
        readonly vector: Readonly<{ readonly stateStoreId: string; readonly stateVersion: number }>;
      }> [];
    }>;
    expect(historyAfterReset.runs).toHaveLength(oldRunIds.length + 1);
    const historyAfterResetIds = historyAfterReset.runs.map((entry) => entry.id);
    const resetFollowUp = historyAfterReset.runs.find((entry) => !oldRunIds.includes(entry.id));
    expect(resetFollowUp).toBeDefined();
    expect(historyAfterResetIds).toEqual([resetFollowUp!.id, ...oldRunIds]);
    expect(resetFollowUp!.vector).toMatchObject({ stateStoreId, stateVersion: stateVersionBeforeReset + 1 });
    expect(resetFollowUp!.result?.state.snapshot).toMatchObject({ seed: claudeSeed });

    for (const oldRunId of oldRunIds) {
      const response = await runtimeJson(`/api/runtime/runs/${encodeURIComponent(oldRunId)}`) as Readonly<{
        readonly run: Readonly<{ readonly vector: unknown }>;
      }>;
      expect(response.run.vector).toEqual(oldRunVectors[oldRunId]);
    }

    await history.first().getByRole('button').first().click();
    const stateTab = page.getByRole('tab', { name: 'State', exact: true });
    await stateTab.click();
    await expect(stateTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toContainText('fixture-claude-post-tool-use-write');
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

e2e('retains real MCP runtime history across reload and isolates a fresh provider', { timeout: 180_000 }, async ({ page }) => {
  const firstFixture = await startRuntimePlaygroundFixture();
  let secondFixture: Awaited<ReturnType<typeof startRuntimePlaygroundFixture>> | undefined;
  const context = page.context();
  const forbiddenRequests: string[] = [];
  const runtimeRunPosts: string[] = [];
  const pageErrors: Error[] = [];
  const forbiddenPrefixes = ['/api/mcp/sessions', '/api/runtime/mcp/sessions', '/api/mcp/apps', '/api/runtime/apps'];
  const expectedContent = [
    { text: 'Runtime state contains 1 edit.', type: 'text' },
    {
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      mimeType: 'image/png',
      type: 'image',
    },
  ];
  const recordRequest = (request: { method(): string; url(): string }): void => {
    const requestUrl = new URL(request.url());
    if (forbiddenPrefixes.some((prefix) => requestUrl.pathname.startsWith(prefix))) forbiddenRequests.push(requestUrl.pathname);
    if (requestUrl.origin === firstFixture.url && requestUrl.pathname === '/api/runtime/runs' && request.method() === 'POST') {
      runtimeRunPosts.push(requestUrl.pathname);
    }
  };
  context.on('request', recordRequest);
  page.on('pageerror', (error) => pageErrors.push(error));
  try {
    await page.goto(`${firstFixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const identity = page.locator('[data-runtime-provider-session]');
    await expect(identity).toHaveCount(1, { timeout: browserTimeout });
    const runtimeSessionToken = await page.evaluate(async () => {
      const response = await fetch('/api/project/session', { credentials: 'same-origin' });
      const body: unknown = await response.json();
      if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { readonly token?: unknown }).token !== 'string') {
        throw new Error(`Runtime session bootstrap failed with ${response.status}.`);
      }
      return (body as { readonly token: string }).token;
    });
    const runtimeJson = async (path: string): Promise<unknown> => page.evaluate(async ({ route, token }) => {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: { 'x-agent-bundle-session': token },
      });
      if (!response.ok) throw new Error(`Runtime request ${route} failed with ${response.status}.`);
      return response.json();
    }, { route: path, token: runtimeSessionToken });
    const surface = page.getByLabel('Runtime surface');
    const target = page.getByLabel('Runtime target');
    const input = page.locator('#runtime-input-raw');
    const run = page.getByRole('button', { name: 'Run', exact: true });
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');

    await surface.selectOption('hook.claude');
    await target.selectOption('claude');
    await input.fill(JSON.stringify({
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      session_id: 'runtime-history-hydration',
      tool_input: { file_path: 'runtime-history-hydration.txt' },
      tool_name: 'Write',
      tool_use_id: 'runtime-history-hydration-tool',
    }));
    await run.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(1);

    await surface.selectOption('mcp.runtime_status');
    await target.selectOption('portable');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await input.fill('{}');
    await expect(surface).toHaveValue('mcp.runtime_status');
    await expect(target).toHaveValue('portable');
    await expect(input).toHaveValue('{}');
    await run.click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(2);
    expect(runtimeRunPosts).toEqual(['/api/runtime/runs', '/api/runtime/runs']);

    const firstHistory = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly providerSessionId: string;
      readonly runs: readonly Readonly<{
        readonly id: string;
        readonly result: Readonly<{
          readonly agentVisible?: unknown;
          readonly modelVisible?: unknown;
          readonly protocol?: unknown;
          readonly trace: readonly Readonly<{ readonly id: string; readonly status: string }> [];
        }>;
        readonly status: string;
        readonly surfaceId: string;
        readonly target: string;
        readonly vector: Readonly<{
          readonly providerSessionId: string;
          readonly runtimeGenerationId: string;
          readonly stateStoreId: string;
          readonly stateVersion: number;
        }>;
      }> [];
    }>;
    const firstStatus = await runtimeJson('/api/runtime/status') as Readonly<{
      readonly status: Readonly<{ readonly activeVector: unknown }>;
    }>;
    expect(firstHistory.runs).toHaveLength(2);
    const firstRunIds = firstHistory.runs.map((entry) => entry.id);
    const statusRun = firstHistory.runs.find((entry) => entry.surfaceId === 'mcp.runtime_status');
    const hookRun = firstHistory.runs.find((entry) => entry.surfaceId === 'hook.claude');
    if (statusRun === undefined || hookRun === undefined) throw new Error('Expected distinguishable hook and Runtime status history entries.');
    const expectedSelectedId = statusRun.id;
    const expectedSelectedProtocol = {
      content: expectedContent,
      structuredContent: { editCount: 1, stateVersion: 1 },
    };
    expect(firstRunIds).toEqual([statusRun.id, hookRun.id]);
    expect(statusRun).toMatchObject({ status: 'succeeded', surfaceId: 'mcp.runtime_status', target: 'portable' });
    expect(statusRun.vector).toEqual(firstStatus.status.activeVector);
    expect(statusRun.vector.providerSessionId).toBe(firstHistory.providerSessionId);
    expect(statusRun.result.modelVisible).toEqual(expectedContent);
    expect(statusRun.result.protocol).toEqual(expectedSelectedProtocol);
    expect(statusRun.result.trace.map((entry) => entry.id)).toEqual(['normalize', 'worker', 'flight', 'decode', 'lower']);
    expect(statusRun.result.trace.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(hookRun).toMatchObject({
      result: { agentVisible: 'Recorded runtime-history-hydration.txt from claude. Shared state now contains 1 edit.' },
      status: 'succeeded',
      surfaceId: 'hook.claude',
      target: 'claude',
      vector: { stateStoreId: statusRun.vector.stateStoreId, stateVersion: 1 },
    });
    const historyRunIds = async (): Promise<readonly string[]> => history.evaluateAll((items) => items.map((item) => {
      const id = item.getAttribute('data-runtime-run-id');
      if (id === null) throw new Error('Runtime history item is missing its stable run ID.');
      return id;
    }));
    expect(await historyRunIds()).toEqual(firstRunIds);
    await page.locator(`[data-runtime-run-id="${expectedSelectedId}"]`).getByRole('button').first().click();
    await expect(history.locator('button[aria-pressed="true"]')).toHaveCount(1, { timeout: browserTimeout });
    await expect(page.locator(`[data-runtime-run-id="${expectedSelectedId}"] button[aria-pressed="true"]`)).toHaveCount(1, { timeout: browserTimeout });
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--model code'))
      .toHaveText(JSON.stringify(expectedContent, null, 2), { timeout: browserTimeout });
    const protocol = page.getByRole('tab', { name: 'Protocol', exact: true });
    await protocol.click();
    await expect(page.getByLabel('Runtime protocol evidence').getByLabel('Provider MCP protocol').locator('details pre code'))
      .toHaveText(JSON.stringify(expectedSelectedProtocol, null, 2), { timeout: browserTimeout });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(identity).toHaveAttribute('data-runtime-provider-session', firstHistory.providerSessionId);
    const reloadedHistory = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly providerSessionId: string;
      readonly runs: readonly Readonly<{ readonly id: string }> [];
    }>;
    expect(reloadedHistory.providerSessionId).toBe(firstHistory.providerSessionId);
    expect(reloadedHistory.runs.map((entry) => entry.id)).toEqual(firstRunIds);
    expect(reloadedHistory.runs).toHaveLength(firstRunIds.length);
    expect(reloadedHistory.runs.length).toBeLessThanOrEqual(50);
    await expect.poll(historyRunIds, { timeout: browserTimeout }).toEqual(firstRunIds);
    const selectedReloadedHistory = history.filter({ has: page.locator('button[aria-pressed="true"]') });
    await expect(selectedReloadedHistory).toHaveCount(1, { timeout: browserTimeout });
    expect(await selectedReloadedHistory.getAttribute('data-runtime-run-id')).toBe(expectedSelectedId);
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--model code'))
      .toHaveText(JSON.stringify(expectedContent, null, 2), { timeout: browserTimeout });
    await protocol.click();
    await expect(page.getByLabel('Runtime protocol evidence').getByLabel('Provider MCP protocol').locator('details pre code'))
      .toHaveText(JSON.stringify(expectedSelectedProtocol, null, 2), { timeout: browserTimeout });

    await firstFixture.close();
    secondFixture = await startRuntimePlaygroundFixture();
    await page.goto(`${secondFixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    await expect(identity).toHaveCount(1, { timeout: browserTimeout });
    await expect.poll(() => identity.getAttribute('data-runtime-provider-session'), { timeout: browserTimeout }).not.toBe(firstHistory.providerSessionId);
    const freshSessionToken = await page.evaluate(async () => {
      const response = await fetch('/api/project/session', { credentials: 'same-origin' });
      const body: unknown = await response.json();
      if (!response.ok || typeof body !== 'object' || body === null || typeof (body as { readonly token?: unknown }).token !== 'string') {
        throw new Error(`Runtime session bootstrap failed with ${response.status}.`);
      }
      return (body as { readonly token: string }).token;
    });
    const freshRuntimeJson = async (path: string): Promise<unknown> => page.evaluate(async ({ route, token }) => {
      const response = await fetch(route, {
        credentials: 'same-origin',
        headers: { 'x-agent-bundle-session': token },
      });
      if (!response.ok) throw new Error(`Runtime request ${route} failed with ${response.status}.`);
      return response.json();
    }, { route: path, token: freshSessionToken });
    const freshHistory = await freshRuntimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly providerSessionId: string;
      readonly runs: readonly Readonly<{
        readonly id: string;
        readonly vector: Readonly<{ readonly providerSessionId: string }>;
      }> [];
    }>;
    const freshStatus = await freshRuntimeJson('/api/runtime/status') as Readonly<{
      readonly status: Readonly<{ readonly activeVector?: Readonly<{ readonly providerSessionId: string }> }>;
    }>;
    expect(freshHistory.providerSessionId).not.toBe(firstHistory.providerSessionId);
    expect(freshHistory.runs.filter((entry) => firstRunIds.includes(entry.id))).toEqual([]);
    expect(freshHistory.runs.every((entry) => entry.vector.providerSessionId === freshHistory.providerSessionId)).toBe(true);
    expect(freshStatus.status.activeVector?.providerSessionId).toBe(freshHistory.providerSessionId);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(0);
    await expect(page.locator('[data-runtime-run-id]')).toHaveCount(0);
    await expect(history.locator('button[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.locator('[aria-label="Runtime output stage"]')).toContainText('No runtime output selected.');
    expect(forbiddenRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    context.off('request', recordRequest);
    await secondFixture?.close();
    await firstFixture.close();
  }
});
