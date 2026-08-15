import { readFile, writeFile } from 'node:fs/promises';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';

const browserTimeout = 30_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const hookInput = Object.freeze({
  cwd: '/tmp',
  hook_event_name: 'PostToolUse',
  session_id: 'runtime-playground-hmr',
  tool_input: Object.freeze({ file_path: 'runtime-playground-hmr.txt' }),
  tool_name: 'Write',
  tool_use_id: 'runtime-playground-hmr-tool',
});

e2e('activates an edited RSC generation and replays the selected hook without replacing the document', { timeout: 180_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const source = await readFile(fixture.serverComponentSource, 'utf8');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const context = page.context();
  const forbiddenRequests: string[] = [];
  const forbiddenPrefixes = ['/api/mcp/sessions', '/api/runtime/mcp/sessions', '/api/mcp/apps', '/api/runtime/apps'];
  const recordRequest = (request: { url(): string }): void => {
    const pathname = new URL(request.url()).pathname;
    if (forbiddenPrefixes.some((prefix) => pathname.startsWith(prefix))) forbiddenRequests.push(pathname);
  };
  context.on('request', recordRequest);
  let clientPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
    const identity = page.locator('[data-runtime-provider-session]');
    await expect(identity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: browserTimeout });
    const hmrClientCount = page.locator('[aria-label="Runtime identity"] > div').filter({ has: page.locator('dt', { hasText: 'Browser HMR clients' }) }).locator('dd');
    const surface = page.getByLabel('Runtime surface');
    await surface.selectOption('mcp.edit-timeline');
    await expect(identity).toHaveAttribute('data-runtime-hmr-client-count', 'Unknown');
    await expect(hmrClientCount).toHaveText('Unknown');
    clientSurface = await fixture.openRuntimeClientSurface('mcp.edit-timeline');
    if (clientSurface === undefined) throw new Error('Runtime client surface was not available.');
    clientPage = await context.newPage();
    clientPage.on('pageerror', (error) => pageErrors.push(error));
    const bootstrapResponse = await clientPage.goto(clientSurface.bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(bootstrapResponse?.status()).toBe(200);
    await expect.poll(async () => identity.getAttribute('data-runtime-hmr-client-count'), { timeout: browserTimeout }).toBe('1');
    await expect(hmrClientCount).toHaveText('1');

    await surface.selectOption('hook.claude');
    const profile = page.getByLabel('Runtime profile');
    await profile.selectOption('portable');
    const raw = page.locator('#runtime-input-raw');
    await raw.fill(JSON.stringify(hookInput));
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(1);

    await raw.fill('{"repair":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    const diagnostics = page.getByRole('tab', { name: 'Diagnostics', exact: true });
    await diagnostics.click();
    const selectedHistory = history.locator('button[aria-pressed="true"]');
    await expect(selectedHistory).toHaveCount(1);
    const selectedHistoryLabel = await selectedHistory.textContent();
    const before = await identity.evaluate((element) => ({
      attributes: Object.fromEntries([...element.attributes]
        .filter((attribute) => attribute.name.startsWith('data-runtime-'))
        .map((attribute) => [attribute.name, attribute.value])),
      timeOrigin: performance.timeOrigin,
    }));
    const marker = `runtime-hmr-${Math.random().toString(36).slice(2)}`;
    await page.evaluate((value) => { document.documentElement.dataset.runtimeMarker = value; }, marker);

    const editedSource = source.replace('Shared state now contains', 'Live runtime state now contains');
    expect(editedSource).not.toBe(source);
    await writeFile(fixture.serverComponentSource, editedSource);
    await expect.poll(async () => identity.getAttribute('data-runtime-generation'), { timeout: browserTimeout }).not.toBe(before.attributes['data-runtime-generation']);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(2);
    const after = await identity.evaluate((element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-runtime-'))
      .map((attribute) => [attribute.name, attribute.value])));
    expect(after['data-runtime-artifact-epoch']).toBe(before.attributes['data-runtime-artifact-epoch']);
    expect(after['data-runtime-hmr-client-count']).toBe(before.attributes['data-runtime-hmr-client-count']);
    expect(after['data-runtime-hmr-ready']).toBe(before.attributes['data-runtime-hmr-ready']);
    expect(after['data-runtime-provider-session']).toBe(before.attributes['data-runtime-provider-session']);
    expect(after['data-runtime-state-version']).toBe(before.attributes['data-runtime-state-version']);
    expect(after['data-runtime-generation']).not.toBe(before.attributes['data-runtime-generation']);
    expect(after['data-runtime-source-revision']).not.toBe(before.attributes['data-runtime-source-revision']);
    expect(Number(after['data-runtime-event-sequence'])).toBeGreaterThan(Number(before.attributes['data-runtime-event-sequence']));
    await expect(selectedHistory).toHaveText(selectedHistoryLabel ?? '');
    await expect(selectedHistory).toHaveAttribute('aria-pressed', 'true');
    const automaticReplay = history.locator('button[aria-pressed="false"]');
    await expect(automaticReplay).toHaveCount(1);
    await automaticReplay.click();
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(/Live runtime state now contains \d+ edits?\./u, { timeout: browserTimeout });

    const sourceBuildDiagnostic = page.getByLabel('Runtime diagnostics evidence');
    const sourceBuildFailed = await identity.evaluate((element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-runtime-'))
      .map((attribute) => [attribute.name, attribute.value])));
    const historyBeforeSourceBuildFailure = await history.count();
    await writeFile(fixture.serverComponentSource, `${editedSource}\nconst = ;\n`);
    await expect.poll(async () => identity.getAttribute('data-runtime-event-sequence'), { timeout: browserTimeout })
      .toBe(String(Number(sourceBuildFailed['data-runtime-event-sequence']) + 1));
    await expect(sourceBuildDiagnostic).toContainText('source/build');
    await expect(sourceBuildDiagnostic).toContainText('AB8206');
    await expect(sourceBuildDiagnostic).toContainText('RSC runtime source build failed.');
    const afterSourceBuildFailure = await identity.evaluate((element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-runtime-'))
      .map((attribute) => [attribute.name, attribute.value])));
    expect(afterSourceBuildFailure['data-runtime-artifact-epoch']).toBe(sourceBuildFailed['data-runtime-artifact-epoch']);
    expect(afterSourceBuildFailure['data-runtime-generation']).toBe(sourceBuildFailed['data-runtime-generation']);
    expect(afterSourceBuildFailure['data-runtime-hmr-client-count']).toBe(sourceBuildFailed['data-runtime-hmr-client-count']);
    expect(afterSourceBuildFailure['data-runtime-hmr-ready']).toBe(sourceBuildFailed['data-runtime-hmr-ready']);
    expect(afterSourceBuildFailure['data-runtime-provider-session']).toBe(sourceBuildFailed['data-runtime-provider-session']);
    expect(afterSourceBuildFailure['data-runtime-source-revision']).toBe(sourceBuildFailed['data-runtime-source-revision']);
    expect(afterSourceBuildFailure['data-runtime-state-version']).toBe(sourceBuildFailed['data-runtime-state-version']);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(historyBeforeSourceBuildFailure);
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(/Live runtime state now contains \d+ edits?\./u);
    await expect(selectedHistory).toHaveAttribute('aria-pressed', 'true');

    await writeFile(fixture.serverComponentSource, editedSource);
    await expect.poll(async () => identity.getAttribute('data-runtime-generation'), { timeout: browserTimeout })
      .not.toBe(sourceBuildFailed['data-runtime-generation']);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(historyBeforeSourceBuildFailure + 1);
    await expect(sourceBuildDiagnostic).toContainText('No provider diagnostics.');
    await history.locator('button[aria-pressed="false"]').first().click();
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(/Live runtime state now contains \d+ edits?\./u);
    await expect(surface).toHaveValue('hook.claude');
    await expect(raw).toHaveValue('{"repair":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    await expect(diagnostics).toHaveAttribute('aria-selected', 'true');
    await expect(profile).toHaveValue('portable');
    await expect.poll(() => page.evaluate(() => ({ marker: document.documentElement.dataset.runtimeMarker, timeOrigin: performance.timeOrigin }))).toEqual({ marker, timeOrigin: before.timeOrigin });
    await surface.selectOption('mcp.edit-timeline');
    await expect(identity).toHaveAttribute('data-runtime-hmr-client-count', '1');
    await expect(hmrClientCount).toHaveText('1');
    await clientPage.close();
    clientPage = undefined;
    await expect.poll(async () => identity.getAttribute('data-runtime-hmr-client-count'), { timeout: browserTimeout }).toBe('0');
    await expect(hmrClientCount).toHaveText('0');
    await clientSurface.close();
    clientSurface = undefined;
    expect(forbiddenRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    context.off('request', recordRequest);
    await clientPage?.close();
    await clientSurface?.close();
    await fixture.close();
  }
});
