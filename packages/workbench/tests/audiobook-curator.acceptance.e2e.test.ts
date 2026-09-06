import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import {
  captureExampleState,
  copyExample,
  createExampleErrorLedger,
  expectHealthyExamplePage,
  writeExampleReport,
} from './support/example-acceptance.ts';
import {
  editWatchedSource,
  expectApplicationTree,
  expectHeading,
  expectPrimaryNav,
  expectRenderedDocument,
  expectToolInvocationTraceGroup,
  expectUnknownRouteMessage,
  fillRouteInput,
  invokeRouteFromWorkbench,
  openWorkbench,
  readBuildEpoch,
  readCorrelationId,
  readInvocationId,
  rebuildTimeout,
  runSelectedRoute,
  selectApplicationLeaf,
  traceEntryRow,
  waitForBuildEpochAdvance,
  workbenchTestId,
} from './support/workbench-acceptance.ts';
import { buildWorkbench, e2e, waitForWorkbenchIdle, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';
import { inspectWorkbenchSurface, workbenchLeafPath } from '../../agent-bundle/src/test/index.ts';
import { applicationLeafForRouteId, applicationLeaves } from '../src/application/application-tree-model.ts';

const browserTimeout = 15_000 * timeScale;
const runTimeout = 60_000 * timeScale;
const searchTitle = 'Dune';
const hmrMarker = 'WB600-HMR-MARKER';

e2e('accepts the audiobook-curator Application workspace at 1440×900', { timeout: 240_000 * timeScale }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('audiobook-curator');
  const acceptanceLibrary = join(project.root, 'acceptance-library');
  await mkdir(acceptanceLibrary);
  await writeFile(join(acceptanceLibrary, 'invalid.mp3'), 'not an audio stream');
  const conversionSource = join(project.root, 'src', 'conversion.ts');
  const analysisSource = join(project.root, 'src', 'components', 'library-analysis.tsx');
  const searchSource = join(project.root, 'src', 'mcp', 'curator', 'tools', 'search_audible.tsx');
  const healthyConversion = await readFile(conversionSource, 'utf8');
  const healthyAnalysis = await readFile(analysisSource, 'utf8');
  const healthySearch = await readFile(searchSource, 'utf8');
  const delayedAnalysis = healthyAnalysis.replace(
    '  const measuredGroups = await Promise.all(',
    '  await new Promise((resolve) => setTimeout(resolve, 1_500));\n  const measuredGroups = await Promise.all(',
  );
  if (delayedAnalysis === healthyAnalysis) {
    throw new Error('library-analysis.tsx no longer contains the measured-groups anchor for the acceptance delay.');
  }
  await writeFile(analysisSource, delayedAnalysis);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    const surface = await inspectWorkbenchSurface({ root: project.root });
    const searchLeaf = applicationLeafForRouteId(surface.application, 'tool:curator/search_audible')
      ?? applicationLeaves(surface.application).find((leaf) => leaf.ref.kind === 'tool' && leaf.ref.name === 'search_audible');
    if (searchLeaf === undefined) {
      throw new Error('inspectWorkbenchSurface did not project tool:curator/search_audible as an Application leaf.');
    }
    if (searchLeaf.ref.kind !== 'tool') {
      throw new Error(`search_audible leaf was ${searchLeaf.ref.kind}, expected tool.`);
    }
    const inventoryLeaf = applicationLeafForRouteId(surface.application, 'tool:curator/inventory_sources');
    const auditLeaf = applicationLeafForRouteId(surface.application, 'tool:curator/audit_library');
    const inventoryCliLeaf = applicationLeaves(surface.application).find((leaf) =>
      leaf.routeId === 'cli:inventory' && leaf.ref.kind === 'cli');
    if (auditLeaf?.ref.kind !== 'tool' || inventoryLeaf?.ref.kind !== 'tool' || inventoryCliLeaf?.ref.kind !== 'cli') {
      throw new Error('inspectWorkbenchSurface did not project the audit, inventory, and CLI routes.');
    }
    expect(searchLeaf.ref.server).toBe('curator');
    const searchPath = workbenchLeafPath(searchLeaf);
    expect(searchPath).toBe('/routes/mcp/curator/tool/search_audible');

    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    await selectApplicationLeaf(page, server.url, inventoryLeaf);
    await expectApplicationTree(page, surface.application);
    await captureExampleState(page, 'audiobook-curator', 'application-populated');

    await selectApplicationLeaf(page, server.url, auditLeaf);
    await workbenchTestId(page, 'routeInputEditor').getByRole('button', { name: 'Raw JSON' }).click();
    await workbenchTestId(page, 'routeInputEditor').locator('textarea').fill(JSON.stringify({
      sources: [acceptanceLibrary],
    }));
    await workbenchTestId(page, 'routeRun').click();
    await expect(workbenchTestId(page, 'routeRunningStatus')).toBeVisible({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'routeCancel')).toBeVisible({ timeout: browserTimeout });
    const liveDocument = workbenchTestId(page, 'renderedDocument');
    await expect(liveDocument).toHaveAttribute('aria-busy', 'true');
    await expect(liveDocument.locator('.rendered-document-body')).toBeVisible({ timeout: browserTimeout });
    await expect(liveDocument.locator('.rendered-document-body')).not.toBeEmpty();
    const liveInvocationId = await readInvocationId(page);
    const liveCorrelationId = await readCorrelationId(page);
    const tracePage = await page.context().newPage();
    await openWorkbench(tracePage, server.url, `/trace?correlation=${encodeURIComponent(liveCorrelationId)}`);
    await expectHeading(tracePage, 'Trace');
    const runningGroup = workbenchTestId(tracePage, 'traceGroup').filter({ hasText: liveInvocationId });
    await expect(runningGroup).toBeVisible({ timeout: browserTimeout });
    await expect(runningGroup.locator('[data-kind="invocation.started"][data-status="running"]')).toBeVisible();
    await expect(runningGroup.locator('[data-testid="trace-entry"]')).not.toHaveCount(0);
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(/route-status--succeeded/u, { timeout: runTimeout });

    await workbenchTestId(page, 'routeRun').click();
    await expect(workbenchTestId(page, 'routeRunningStatus')).toBeVisible({ timeout: browserTimeout });
    await workbenchTestId(page, 'routeCancel').click();
    await expect(workbenchTestId(page, 'routeStatus')).toContainText('Cancelled', { timeout: runTimeout });
    const cancelledInvocationId = await readInvocationId(page);
    const cancelledCorrelationId = await readCorrelationId(page);
    await expect(workbenchTestId(page, 'routeOutcome')).toHaveCount(0);
    await openWorkbench(tracePage, server.url, `/trace?correlation=${encodeURIComponent(cancelledCorrelationId)}`);
    const cancelledGroup = workbenchTestId(tracePage, 'traceGroup').filter({ hasText: cancelledInvocationId });
    await expect(cancelledGroup.locator('[data-kind="invocation.cancelled"]')).toBeVisible({ timeout: browserTimeout });
    const cancelledEnvelope = await page.evaluate(async (invocationId) => {
      const session = await fetch('/api/project/session').then(async (response) => response.json()) as { token: string };
      const response = await fetch(`/api/routes/invocations/${encodeURIComponent(invocationId)}`, {
        headers: { 'x-agent-bundle-session': session.token },
      });
      return response.json() as Promise<{ invocation: { outcome?: unknown; status: string } }>;
    }, cancelledInvocationId);
    expect(cancelledEnvelope.invocation.status).toBe('cancelled');
    expect(cancelledEnvelope.invocation).not.toHaveProperty('outcome');
    await tracePage.close();

    await selectApplicationLeaf(page, server.url, inventoryLeaf);
    await fillRouteInput(page, { source: acceptanceLibrary });
    await workbenchTestId(page, 'routeInputEditor').getByLabel('Strict').selectOption('true');
    await runSelectedRoute(page, runTimeout);
    const inventoryStatus = workbenchTestId(page, 'routeStatus');
    await expect(page.getByText(/Loading/u)).toHaveCount(0, { timeout: browserTimeout });
    await expect(inventoryStatus).toContainText('Represented error', { timeout: runTimeout });
    await workbenchTestId(page, 'resultTabRendered').click();
    const inventoryDocument = workbenchTestId(page, 'renderedDocument');
    await expect(inventoryDocument).toHaveAttribute('aria-busy', 'false', { timeout: runTimeout });
    await expect(inventoryDocument.locator('.agent-document-error-node')).toBeVisible({ timeout: runTimeout });

    await selectApplicationLeaf(page, server.url, inventoryCliLeaf);
    await workbenchTestId(page, 'routeInputEditor').getByRole('button', { name: 'Raw JSON' }).click();
    const cliArgs = workbenchTestId(page, 'routeInputEditor').locator('textarea');
    await cliArgs.fill('[]');
    await workbenchTestId(page, 'routeRun').click();
    await expect(inventoryStatus).toHaveClass(/route-status--failed/u, { timeout: runTimeout });
    await expect(page.getByText(/Loading/u)).toHaveCount(0, { timeout: browserTimeout });
    await expect(page.locator('.route-diagnostic')).toContainText(/required|missing|usage/iu, { timeout: browserTimeout });
    await workbenchTestId(page, 'inspectorToggle').click();
    await page.getByRole('tab', { name: 'Providers' }).click();
    const libraryProvider = page.getByRole('row').filter({ hasText: 'library' });
    await expect(libraryProvider).toContainText('unobserved', { timeout: browserTimeout });
    await expect(libraryProvider).toContainText('—');

    await workbenchTestId(page, 'routeInputEditor').getByRole('button', { name: 'Form' }).click();
    await fillRouteInput(page, {
      report: join(project.root, 'inventory-report.json'),
      source: acceptanceLibrary,
    });
    await workbenchTestId(page, 'routeInputEditor').getByLabel('Strict').selectOption('true');
    await runSelectedRoute(page, runTimeout);
    await expect(page.getByText(/Loading/u)).toHaveCount(0, { timeout: browserTimeout });
    await expect(inventoryStatus).toContainText('Exit code 1', { timeout: runTimeout });

    await selectApplicationLeaf(page, server.url, searchLeaf);
    await fillRouteInput(page, { title: searchTitle });
    await runSelectedRoute(page, runTimeout);
    const rendered = await expectRenderedDocument(page, runTimeout);
    await expect(workbenchTestId(page, 'resultTabStructured')).toBeVisible();
    await expect(workbenchTestId(page, 'resultTabRaw')).toBeVisible();
    await expect(workbenchTestId(page, 'resultTabMcp')).toBeVisible();
    await expect(workbenchTestId(page, 'resultTabTrace')).toBeVisible();
    await captureExampleState(page, 'audiobook-curator', 'tool-rendered');
    const invocationId = await readInvocationId(page);
    const correlationId = await readCorrelationId(page);
    const finalEnvelope = await page.evaluate(async (id) => {
      const session = await fetch('/api/project/session').then(async (response) => response.json()) as { token: string };
      const response = await fetch(`/api/routes/invocations/${encodeURIComponent(id)}`, {
        headers: { 'x-agent-bundle-session': session.token },
      });
      return response.json() as Promise<{ invocation: {
        outcome?: { kind: string };
        providers: readonly { name: string; status: string }[];
        status: string;
        timings: readonly { durationMs: number; phase: string }[];
      } }>;
    }, invocationId);
    expect(finalEnvelope.invocation.providers.length).toBeGreaterThan(0);
    expect(finalEnvelope.invocation.timings.length).toBeGreaterThan(0);
    expect(finalEnvelope.invocation.outcome).toBeDefined();
    const finalOutcome = finalEnvelope.invocation.outcome!;
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(new RegExp(`route-status--${finalEnvelope.invocation.status}`, 'u'));
    await expect(workbenchTestId(page, 'routeOutcome')).toContainText(new RegExp(finalOutcome.kind, 'iu'));
    const finalProvider = finalEnvelope.invocation.providers[0]!;
    await workbenchTestId(page, 'inspectorToggle').click();
    await page.getByRole('tab', { name: 'Providers' }).click();
    await expect(page.getByRole('row').filter({ hasText: finalProvider.name })).toContainText(finalProvider.status);
    const finalTiming = finalEnvelope.invocation.timings[0]!;
    await page.getByRole('tab', { name: 'Timings' }).click();
    const timingRow = page.locator('.inspector-timings li').filter({ hasText: finalTiming.phase });
    await expect(timingRow).toContainText(`${String(finalTiming.durationMs)} ms`);
    await page.getByRole('tab', { name: 'Schema' }).click();
    const schemaPanel = page.getByRole('tabpanel', { name: 'Schema' });
    await expect(schemaPanel).toContainText('Declared · the compiler observed a resultSchema export.');
    await expect(schemaPanel).toContainText('Unknown · this invocation surface did not report resultSchema validation or transformation.');
    await expect(schemaPanel).toContainText('Available · open Structured result.');

    const epochBeforeEdit = await readBuildEpoch(page);
    const markedSearch = healthySearch.replace(
      '<Agent.Text>{audibleSearchHeadline(receipt)}</Agent.Text>',
      `<Agent.Text>{audibleSearchHeadline(receipt)}</Agent.Text>\n      <Agent.Text>${hmrMarker}</Agent.Text>`,
    );
    if (markedSearch === healthySearch) {
      throw new Error('search_audible.tsx no longer contains the Agent.Text headline the HMR edit anchors on.');
    }
    await editWatchedSource(server, project.root, searchSource, markedSearch, 'succeeded');
    await waitForBuildEpochAdvance(page, epochBeforeEdit, rebuildTimeout);
    await waitForWorkbenchIdle(page);
    await runSelectedRoute(page, runTimeout);
    await expect(rendered).toContainText(hmrMarker, { timeout: runTimeout });
    await editWatchedSource(server, project.root, searchSource, healthySearch, 'succeeded');

    await page.goto(workbenchUrl(server.url, `${searchPath}?invocation=${encodeURIComponent(invocationId)}`));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).searchParams.get('invocation')).toBe(invocationId);
    await expect(workbenchTestId(page, 'routeWorkspace')).toBeVisible({ timeout: browserTimeout });
    await expectRenderedDocument(page, runTimeout);
    expect(await readInvocationId(page)).toBe(invocationId);
    await page.reload();
    await waitForWorkbenchIdle(page);
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(new RegExp(`route-status--${finalEnvelope.invocation.status}`, 'u'));
    await expect(workbenchTestId(page, 'routeOutcome')).toContainText(new RegExp(finalOutcome.kind, 'iu'));
    await expect(workbenchTestId(page, 'routeStatus')).toContainText(correlationId);

    const routeId = searchLeaf.routeId ?? 'tool:curator/search_audible';
    await openWorkbench(page, server.url, '/trace');
    await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expectToolInvocationTraceGroup(page, { invocationId, routeId });
    await captureExampleState(page, 'audiobook-curator', 'trace-populated');

    await openWorkbench(page, server.url, `/trace?correlation=${encodeURIComponent(correlationId)}`);
    await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.locator('.trace-scope')).toContainText(correlationId, { timeout: browserTimeout });
    const scopedGroup = await expectToolInvocationTraceGroup(page, { invocationId, routeId });
    await expect(workbenchTestId(page, 'traceGroup')).toHaveCount(1);
    const scopedCompleted = scopedGroup.locator(`[data-testid="trace-entry"][data-kind="invocation.completed"]`);
    await expect(scopedCompleted).toHaveCount(1);

    await scopedCompleted.click();
    await waitForWorkbenchIdle(page);
    const detailPath = new URL(page.url()).pathname;
    expect(detailPath).toMatch(/^\/trace\/trc_\d+$/u);
    await expect(workbenchTestId(page, 'traceDetail')).toBeVisible({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'traceDetail')).toContainText(routeId, { timeout: browserTimeout });
    const entryId = detailPath.slice('/trace/'.length);

    await page.goto(workbenchUrl(server.url, `/trace/${encodeURIComponent(entryId)}`));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(`/trace/${entryId}`);
    await expect(workbenchTestId(page, 'traceDetail')).toBeVisible({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'traceDetail')).toHaveAttribute('data-entry-id', entryId);
    await expect(workbenchTestId(page, 'traceDetail')).toContainText(correlationId);
    await page.reload();
    await waitForWorkbenchIdle(page);
    await expect(workbenchTestId(page, 'traceDetail')).toHaveAttribute('data-entry-id', entryId);
    await expect(workbenchTestId(page, 'traceDetail')).toContainText(correlationId);

    await workbenchTestId(page, 'traceDetail').getByRole('link', { name: 'Open route', exact: true }).click();
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(searchPath);
    expect(new URL(page.url()).searchParams.get('invocation')).toBe(invocationId);
    await expect(workbenchTestId(page, 'routeWorkspace')).toBeVisible({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(/route-status--succeeded/u, { timeout: browserTimeout });
    expect(await readInvocationId(page)).toBe(invocationId);
    await expectRenderedDocument(page, runTimeout);
    await page.reload();
    await waitForWorkbenchIdle(page);
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(new RegExp(`route-status--${finalEnvelope.invocation.status}`, 'u'));
    await expect(workbenchTestId(page, 'routeOutcome')).toContainText(new RegExp(finalOutcome.kind, 'iu'));
    await expect(workbenchTestId(page, 'routeStatus')).toContainText(correlationId);

    await openWorkbench(page, server.url, '/trace');
    const completedBeforeLive = await traceEntryRow(page, 'invocation.completed').count();
    const liveUrl = page.url();
    const traceLiveInvocationId = await invokeRouteFromWorkbench(page, { input: { title: searchTitle }, routeId });
    expect(traceLiveInvocationId).not.toBe(invocationId);
    await expect.poll(
      async () => traceEntryRow(page, 'invocation.completed').count(),
      { timeout: browserTimeout },
    ).toBeGreaterThan(completedBeforeLive);
    await expectToolInvocationTraceGroup(page, { invocationId: traceLiveInvocationId, routeId });
    expect(page.url()).toBe(liveUrl);

    await openWorkbench(page, server.url, '/advanced/protocol');
    await expectHeading(page, 'MCP playground');
    await page.locator('#mcp-target').selectOption('claude');
    await page.locator('#mcp-server-name').fill('curator');
    const openedMcp = page.waitForResponse((response) =>
      response.url() === `${server.url}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const mcpSession = await (await openedMcp).json() as { session: { id: string } };
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'search_audible', exact: true }).click();
    const mcpArguments = page.locator('#mcp-tool-arguments-raw');
    if (await mcpArguments.count() === 0) await page.getByLabel('Raw JSON').check();
    await mcpArguments.fill(JSON.stringify({ title: searchTitle }));
    await page.getByRole('button', { name: 'Call search_audible' }).click();
    await expect(page.getByRole('region', { name: 'Invocation history' })).toContainText(searchTitle, { timeout: runTimeout });
    const receiptEndpoint = JSON.parse(
      await readFile(join(project.root, '.agent-bundle', 'hook-receipts.json'), 'utf8'),
    ) as { token: string; url: string };
    const receiptResponse = await fetch(`${receiptEndpoint.url}/api/trace/receipts`, {
      body: JSON.stringify({
        events: [
          { at: 0, kind: 'execute.start', phase: 'execute', runtime: 'standalone', sequence: 0 },
          { at: 1, durationMs: 1, kind: 'render.finish', phase: 'render', sequence: 1 },
        ],
        execution: {
          event: 'tool/before',
          executionId: `execution-${mcpSession.session.id}`,
          host: 'claude',
          nativeEvent: 'PreToolUse',
        },
        identity: {
          conversationId: mcpSession.session.id,
          requestId: 'request-browser-correlation',
          sessionId: mcpSession.session.id,
        },
        lineage: { reason: 'not-provided', state: 'unavailable' },
        startedAt: new Date().toISOString(),
        version: 1,
      }),
      headers: {
        authorization: `Bearer ${receiptEndpoint.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(receiptResponse.status).toBe(204);
    await openWorkbench(page, server.url, `/trace?correlation=${encodeURIComponent(mcpSession.session.id)}`);
    await expectHeading(page, 'Trace');
    const sessionGroup = workbenchTestId(page, 'traceGroup');
    await expect(sessionGroup).toHaveCount(1, { timeout: browserTimeout });
    await expect(sessionGroup.locator('[data-kind="mcp.request"]').filter({ hasText: 'tools/call search_audible' })).toBeVisible({ timeout: browserTimeout });
    await expect(sessionGroup.locator('[data-kind="hook.received"]').first()).toBeVisible({ timeout: browserTimeout });

    await editWatchedSource(server, project.root, conversionSource, `${healthyConversion}\nconst = ;\n`, 'failed');
    await page.reload();
    await waitForWorkbenchIdle(page);
    const problemsBadge = workbenchTestId(page, 'problemsBadge');
    await expect(problemsBadge).toBeVisible({ timeout: browserTimeout });
    await expect(problemsBadge).toContainText(/[1-9]/u, { timeout: browserTimeout });
    await openWorkbench(page, server.url, '/problems');
    const staleBanner = workbenchTestId(page, 'problemsBanner');
    await expect(staleBanner).toBeVisible({ timeout: browserTimeout });
    await expect(staleBanner).toContainText(/stale|newer source|rebuild|last good build/iu);
    await captureExampleState(page, 'audiobook-curator', 'problems-stale');
    await editWatchedSource(server, project.root, conversionSource, healthyConversion, 'succeeded');
    await workbenchTestId(page, 'problemsRepair').click();
    await waitForWorkbenchIdle(page);
    await expect(staleBanner).toHaveCount(0, { timeout: browserTimeout });
    await expect(problemsBadge).not.toContainText(/[1-9]/u, { timeout: browserTimeout });
    await captureExampleState(page, 'audiobook-curator', 'problems-repaired');

    await page.goto(workbenchUrl(server.url, searchPath));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(searchPath);
    await page.reload();
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(searchPath);
    await page.goto(workbenchUrl(server.url, '/trace'));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe('/trace');
    await page.goBack();
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(searchPath);
    await page.goForward();
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe('/trace');

    // A well-formed deep link to a route the catalog does not contain keeps its
    // URL and reports the unknown route; its escape hatch returns to the tree.
    const missingPath = '/routes/mcp/no-such-server/tool/missing';
    await page.goto(workbenchUrl(server.url, missingPath));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(missingPath);
    await expectUnknownRouteMessage(page);
    await workbenchTestId(page, 'unknownRoute').getByRole('link', { name: /application tree/iu }).click();
    await expect(workbenchTestId(page, 'workspaceEmpty')).toBeVisible({ timeout: browserTimeout });
    expect(new URL(page.url()).pathname).toBe('/');

    await openWorkbench(page, server.url, '/advanced/evals');
    await expect(page.getByRole('tab', { name: 'Runs' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Compare' })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'audiobook-curator', 'advanced-evals');

    await openWorkbench(page, server.url, '/advanced/hosts');
    await expect(page.getByRole('heading', { name: 'Host diagnostics', exact: true })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText(/installed|version|path/iu).first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('table', { name: /finding|bundle|store|probe/iu })).toHaveCount(0);

    await openWorkbench(page, server.url, '/advanced/artifact');
    await expectHeading(page, 'Emitted files');
    const detailsToggle = page.locator('.artifact-table').getByRole('button', { name: 'Details' }).first();
    await expect(detailsToggle).toBeVisible({ timeout: browserTimeout });
    await detailsToggle.click();
    const fileDetails = page.locator('.artifact-file-details').first();
    await expect(fileDetails).toBeVisible({ timeout: browserTimeout });
    await expect(fileDetails).toContainText(/SHA-256/u);
    await expect(fileDetails).toContainText(/Mode/u);
    await expect(fileDetails).toContainText(/Provenance/u);

    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await writeFile(searchSource, healthySearch).catch(() => undefined);
    await writeFile(conversionSource, healthyConversion).catch(() => undefined);
    await server.close();
    await project.release();
  }
});
