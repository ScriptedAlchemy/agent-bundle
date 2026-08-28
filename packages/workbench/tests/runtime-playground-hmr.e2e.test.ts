import { readFile, writeFile } from 'node:fs/promises';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { workbenchUrl } from './support/workbench-e2e.ts';

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

const runtimeStatusImage = Object.freeze({
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  mimeType: 'image/png',
  type: 'image',
});

type RuntimeVector = Readonly<{
  readonly providerSessionId: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}>;

type RuntimeStatusRun = Readonly<{
  readonly id: string;
  readonly result: Readonly<{
    readonly agentVisible?: unknown;
    readonly modelVisible: unknown;
    readonly protocol: unknown;
    readonly state: Readonly<{
      readonly identity: Readonly<{
        readonly stateStoreId: string;
        readonly stateVersion: number;
      }>;
      readonly snapshot: Readonly<{
        readonly edits: readonly Readonly<{
          readonly host: string;
          readonly path: string;
          readonly sessionId: string;
          readonly toolName: string;
        }> [];
        readonly stateVersion: number;
      }>;
    }>;
    readonly trace: readonly Readonly<{
      readonly id: string;
      readonly phase: string;
      readonly startedAt: string;
      readonly status: string;
    }>[];
  }>;
  readonly status: string;
  readonly surfaceId: string;
  readonly target: string;
  readonly vector: RuntimeVector;
}>;

const expectRuntimeStatusEvidence = (run: RuntimeStatusRun, expected: Readonly<{
  readonly providerSessionId: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}>, textPrefix = 'Runtime state contains'): void => {
  const editCount = expected.stateVersion;
  const editNoun = editCount === 1 ? 'edit' : 'edits';
  const content = [
    { text: `${textPrefix} ${editCount} ${editNoun}.`, type: 'text' },
    runtimeStatusImage,
  ];
  expect(run).toMatchObject({ status: 'succeeded', surfaceId: 'mcp.runtime_status' });
  expect(run.vector).toEqual(expected);
  expect(run.result.modelVisible).toEqual(content);
  expect(run.result.protocol).toEqual({
    content,
    structuredContent: { editCount, stateVersion: expected.stateVersion },
  });
  const trace = run.result.trace;
  expect(trace.map((span) => ({ id: span.id, phase: span.phase, status: span.status }))).toEqual([
    { id: 'normalize', phase: 'normalize', status: 'succeeded' },
    { id: 'worker', phase: 'worker', status: 'succeeded' },
    { id: 'flight', phase: 'flight', status: 'succeeded' },
    { id: 'decode', phase: 'decode', status: 'succeeded' },
    { id: 'lower', phase: 'lower', status: 'succeeded' },
  ]);
  const startedAt = trace[0]?.startedAt;
  expect(startedAt).toBeDefined();
  for (const span of trace) {
    expect(Object.keys(span).sort()).toEqual(['id', 'phase', 'startedAt', 'status']);
    expect(Date.parse(span.startedAt)).toBeGreaterThanOrEqual(0);
    expect(span.startedAt).toBe(startedAt);
    expect('details' in span).toBe(false);
    expect('durationMs' in span).toBe(false);
    expect('parentId' in span).toBe(false);
  }
};

e2e('activates an edited RSC generation and replays the selected hook without replacing the document', { timeout: 180_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const source = await readFile(fixture.serverComponentSource, 'utf8');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  const context = page.context();
  const forbiddenRequests: string[] = [];
  const runtimeRunPosts: string[] = [];
  const forbiddenPrefixes = ['/api/mcp/sessions', '/api/runtime/mcp/sessions', '/api/mcp/apps', '/api/runtime/apps'];
  const recordRequest = (request: { method(): string; url(): string }): void => {
    const requestUrl = new URL(request.url());
    const pathname = requestUrl.pathname;
    if (forbiddenPrefixes.some((prefix) => pathname.startsWith(prefix))) forbiddenRequests.push(pathname);
    if (requestUrl.origin === fixture.url && pathname === '/api/runtime/runs' && request.method() === 'POST') {
      runtimeRunPosts.push(pathname);
    }
  };
  context.on('request', recordRequest);
  let clientPage: Awaited<ReturnType<typeof context.newPage>> | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  try {
    await page.goto(workbenchUrl(fixture.url, 'runtime'));
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: browserTimeout });
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

    const initialProviderStatus = await runtimeJson('/api/runtime/status') as Readonly<{
      readonly status: Readonly<{ readonly activeVector: RuntimeVector }>;
    }>;
    const initialActiveVector = initialProviderStatus.status.activeVector;
    const activatedStateVersion = initialActiveVector.stateVersion + 2;
    const activatedEditNoun = activatedStateVersion === 1 ? 'edit' : 'edits';
    const activatedHookText = `Recorded fixture-claude-post-tool-use.txt from claude. Live runtime state now contains ${activatedStateVersion} ${activatedEditNoun}.`;
    const repairedHookText = `Recorded fixture-claude-post-tool-use.txt from claude. Repaired runtime state now contains ${activatedStateVersion} ${activatedEditNoun}.`;
    await surface.selectOption('hook.claude');
    const profile = page.getByLabel('Runtime profile');
    await profile.selectOption('portable');
    const raw = page.locator('#runtime-input-raw');
    await raw.fill(JSON.stringify(hookInput));
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(1);

    await surface.selectOption('mcp.runtime_status');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await raw.fill('{}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(2);
    expect(runtimeRunPosts).toEqual(['/api/runtime/runs', '/api/runtime/runs']);
    const historyBeforeHmr = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly providerSessionId: string;
      readonly runs: readonly RuntimeStatusRun[];
    }>;
    const statusBeforeHmr = historyBeforeHmr.runs.find((run) => run.surfaceId === 'mcp.runtime_status');
    const hookBeforeHmr = historyBeforeHmr.runs.find((run) => run.surfaceId === 'hook.claude');
    if (statusBeforeHmr === undefined || hookBeforeHmr === undefined) {
      throw new Error('Expected the hook mutation and Runtime status runs before HMR.');
    }
    const providerStatusBeforeHmr = await runtimeJson('/api/runtime/status') as Readonly<{
      readonly status: Readonly<{ readonly activeVector: RuntimeVector }>;
    }>;
    expect(statusBeforeHmr.vector).toEqual(providerStatusBeforeHmr.status.activeVector);
    expect(statusBeforeHmr.vector.providerSessionId).toBe(historyBeforeHmr.providerSessionId);
    expect(hookBeforeHmr).toMatchObject({
      result: {
        agentVisible: 'Recorded runtime-playground-hmr.txt from claude. Shared state now contains 1 edit.',
        state: {
          identity: {
            stateStoreId: initialActiveVector.stateStoreId,
            stateVersion: initialActiveVector.stateVersion + 1,
          },
          snapshot: {
            edits: [expect.objectContaining({
              host: 'claude',
              path: '/tmp/runtime-playground-hmr.txt',
              sessionId: 'runtime-playground-hmr',
              toolName: 'Write',
            })],
            stateVersion: initialActiveVector.stateVersion + 1,
          },
        },
      },
      status: 'succeeded',
      vector: {
        providerSessionId: initialActiveVector.providerSessionId,
        runtimeGenerationId: initialActiveVector.runtimeGenerationId,
        stateStoreId: initialActiveVector.stateStoreId,
        stateVersion: initialActiveVector.stateVersion + 1,
      },
    });
    expect(hookBeforeHmr.result.state.snapshot.edits).toHaveLength(1);
    expect(statusBeforeHmr.vector.stateStoreId).toBe(hookBeforeHmr.vector.stateStoreId);
    expect(statusBeforeHmr.vector.stateVersion).toBe(hookBeforeHmr.vector.stateVersion);
    expectRuntimeStatusEvidence(statusBeforeHmr, providerStatusBeforeHmr.status.activeVector);
    expect(statusBeforeHmr.result.state).toEqual(hookBeforeHmr.result.state);
    const statusBeforeHmrDetail = await runtimeJson(`/api/runtime/runs/${encodeURIComponent(statusBeforeHmr.id)}`) as Readonly<{
      readonly run: RuntimeStatusRun;
    }>;
    const immutableStatusBeforeHmr = JSON.parse(JSON.stringify(statusBeforeHmrDetail.run)) as RuntimeStatusRun;

    await surface.selectOption('hook.claude');

    await raw.fill('{"repair":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    const diagnostics = page.getByRole('tab', { name: 'Diagnostics', exact: true });
    const result = page.getByRole('tab', { name: 'Result', exact: true });
    await result.click();
    await expect(result).toHaveAttribute('aria-selected', 'true');
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
    const historyCountBeforeActivation = await history.count();
    const automaticReplayCountBeforeActivation = await history.locator('button[aria-pressed="false"]').count();

    const hookEditedSource = source.replace('Shared state now contains', 'Live runtime state now contains');
    const editedSource = hookEditedSource.replace('Runtime state contains', 'Live runtime state contains');
    expect(hookEditedSource).not.toBe(source);
    expect(editedSource).not.toBe(hookEditedSource);
    await writeFile(fixture.serverComponentSource, editedSource);
    expect(await readFile(fixture.serverComponentSource, 'utf8')).toBe(editedSource);
    await expect.poll(async () => identity.getAttribute('data-runtime-generation'), { timeout: browserTimeout }).not.toBe(before.attributes['data-runtime-generation']);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(historyCountBeforeActivation + 1);
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
    await expect(automaticReplay).toHaveCount(automaticReplayCountBeforeActivation + 1);
    await expect(automaticReplay.first()).toContainText(`generation ${after['data-runtime-generation']?.slice(-8) ?? ''}`);
    await automaticReplay.first().click();
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(
      activatedHookText,
      { timeout: browserTimeout },
    );

    const sourceBuildFailed = await identity.evaluate((element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-runtime-'))
      .map((attribute) => [attribute.name, attribute.value])));
    const historyBeforeSourceBuildFailure = await history.count();
    await writeFile(fixture.serverComponentSource, `${editedSource}\nconst = ;\n`);
    await expect.poll(async () => Number(await identity.getAttribute('data-runtime-event-sequence')), { timeout: browserTimeout })
      .toBeGreaterThan(Number(sourceBuildFailed['data-runtime-event-sequence']));
    await expect(page.locator('.runtime-announcement[role="alert"]').last()).toHaveText(
      'Runtime generation failed. The last good result remains available.',
      { timeout: browserTimeout },
    );
    await expect(result).toHaveAttribute('aria-selected', 'true', { timeout: browserTimeout });
    await expect(diagnostics).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(
      activatedHookText,
      { timeout: browserTimeout },
    );
    await diagnostics.click();
    const sourceBuildDiagnostic = page.getByLabel('Runtime diagnostics evidence');
    await expect(sourceBuildDiagnostic).toContainText('source/build', { timeout: browserTimeout });
    await expect(sourceBuildDiagnostic).toContainText('AB8206', { timeout: browserTimeout });
    await expect(sourceBuildDiagnostic).toContainText('RSC runtime source build failed.', { timeout: browserTimeout });
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
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(
      activatedHookText,
      { timeout: browserTimeout },
    );
    await expect(selectedHistory).toHaveAttribute('aria-pressed', 'true', { timeout: browserTimeout });

    const repairedHookSource = editedSource.replace('Live runtime state now contains', 'Repaired runtime state now contains');
    const repairedSource = repairedHookSource.replace('Live runtime state contains', 'Repaired runtime state contains');
    expect(repairedHookSource).not.toBe(editedSource);
    expect(repairedSource).not.toBe(repairedHookSource);
    await writeFile(fixture.serverComponentSource, repairedSource);
    expect(await readFile(fixture.serverComponentSource, 'utf8')).toBe(repairedSource);
    await expect.poll(async () => identity.getAttribute('data-runtime-generation'), { timeout: browserTimeout })
      .not.toBe(sourceBuildFailed['data-runtime-generation']);
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(historyBeforeSourceBuildFailure + 1);
    await expect(sourceBuildDiagnostic).toContainText('No provider diagnostics.');
    await history.locator('button[aria-pressed="false"]').first().click();
    await expect(page.locator('[aria-label="Runtime output stage"] .runtime-stage-output--agent code')).toContainText(
      repairedHookText,
    );
    await expect(surface).toHaveValue('hook.claude');
    await expect(raw).toHaveValue('{"repair":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
    await expect(diagnostics).toHaveAttribute('aria-selected', 'true');
    await expect(profile).toHaveValue('portable');
    await expect.poll(() => page.evaluate(() => ({ marker: document.documentElement.dataset.runtimeMarker, timeOrigin: performance.timeOrigin }))).toEqual({ marker, timeOrigin: before.timeOrigin });
    await surface.selectOption('mcp.runtime_status');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await raw.fill('{}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(async () => history.count(), { timeout: browserTimeout }).toBe(historyBeforeSourceBuildFailure + 2);
    // Initial hook + status, then exactly one replay for each recovered activation, then final status.
    expect(runtimeRunPosts).toEqual([
      '/api/runtime/runs',
      '/api/runtime/runs',
      '/api/runtime/runs',
      '/api/runtime/runs',
      '/api/runtime/runs',
    ]);
    const historyAfterHmr = await runtimeJson('/api/runtime/runs?limit=50') as Readonly<{
      readonly providerSessionId: string;
      readonly runs: readonly RuntimeStatusRun[];
    }>;
    const statusAfterHmr = historyAfterHmr.runs.find((run) => run.surfaceId === 'mcp.runtime_status' && run.id !== statusBeforeHmr.id);
    if (statusAfterHmr === undefined) throw new Error('Expected a new Runtime status run after HMR recovery.');
    const providerStatusAfterHmr = await runtimeJson('/api/runtime/status') as Readonly<{
      readonly status: Readonly<{ readonly activeVector: RuntimeVector }>;
    }>;
    expect(statusAfterHmr.vector).toEqual(providerStatusAfterHmr.status.activeVector);
    expect(statusAfterHmr.vector.providerSessionId).toBe(historyAfterHmr.providerSessionId);
    expect(statusAfterHmr.vector.providerSessionId).toBe(statusBeforeHmr.vector.providerSessionId);
    expect(statusAfterHmr.vector.runtimeGenerationId).not.toBe(statusBeforeHmr.vector.runtimeGenerationId);
    expect(statusAfterHmr.vector.sourceRevision).not.toBe(statusBeforeHmr.vector.sourceRevision);
    await expect(identity).toHaveAttribute('data-runtime-generation', statusAfterHmr.vector.runtimeGenerationId);
    await expect(identity).toHaveAttribute('data-runtime-source-revision', statusAfterHmr.vector.sourceRevision);
    expect(statusAfterHmr.vector.stateStoreId).toBe(statusBeforeHmr.vector.stateStoreId);
    expect(statusAfterHmr.vector.stateVersion).toBe(activatedStateVersion);
    expectRuntimeStatusEvidence(statusAfterHmr, providerStatusAfterHmr.status.activeVector, 'Repaired runtime state contains');
    expect(statusAfterHmr.result.state).toMatchObject({
      identity: {
        stateStoreId: initialActiveVector.stateStoreId,
        stateVersion: activatedStateVersion,
      },
      snapshot: {
        edits: [
          expect.objectContaining({ path: '/tmp/runtime-playground-hmr.txt' }),
          expect.objectContaining({ path: '/tmp/fixture-claude-post-tool-use.txt' }),
        ],
        stateVersion: activatedStateVersion,
      },
    });
    expect(statusAfterHmr.result.state.snapshot.edits).toHaveLength(2);
    const persistedStatusBeforeHmr = await runtimeJson(`/api/runtime/runs/${encodeURIComponent(statusBeforeHmr.id)}`) as Readonly<{
      readonly run: RuntimeStatusRun;
    }>;
    expect(persistedStatusBeforeHmr.run).toEqual(immutableStatusBeforeHmr);

    await surface.selectOption('hook.claude');
    await raw.fill('{"repair":');
    await expect(page.locator('#runtime-input-raw-error')).toBeVisible();
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
