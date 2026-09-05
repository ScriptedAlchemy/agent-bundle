import { readFile, writeFile } from 'node:fs/promises';
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
  expectPrimaryNav,
  expectRenderedDocument,
  expectUnknownRouteMessage,
  fillRouteInput,
  openWorkbench,
  readBuildEpoch,
  readInvocationId,
  rebuildTimeout,
  runSelectedRoute,
  selectApplicationLeaf,
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
  const conversionSource = join(project.root, 'src', 'conversion.ts');
  const searchSource = join(project.root, 'src', 'mcp', 'curator', 'tools', 'search_audible.tsx');
  const healthyConversion = await readFile(conversionSource, 'utf8');
  const healthySearch = await readFile(searchSource, 'utf8');
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
    expect(searchLeaf.ref.server).toBe('curator');
    const searchPath = workbenchLeafPath(searchLeaf);
    expect(searchPath).toBe('/routes/mcp/curator/tool/search_audible');

    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    const firstLeaf = applicationLeaves(surface.application).find((leaf) => leaf.routeId === 'tool:curator/inventory_sources')
      ?? searchLeaf;
    await selectApplicationLeaf(page, server.url, firstLeaf);
    await expectApplicationTree(page, surface.application);
    await captureExampleState(page, 'audiobook-curator', 'application-populated');

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

    await openWorkbench(page, server.url, '/trace');
    await expect(page.getByRole('heading', { name: 'Trace', exact: true })).toBeVisible({ timeout: browserTimeout });
    const traceRow = page.locator(`.trace-table tr[data-invocation-id=${JSON.stringify(invocationId)}]`);
    await expect(traceRow).toBeVisible({ timeout: browserTimeout });
    await expect(traceRow).toContainText(searchLeaf.routeId ?? 'tool:curator/search_audible');
    await captureExampleState(page, 'audiobook-curator', 'trace-populated');
    await traceRow.getByRole('link').first().click();
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe(`/trace/${encodeURIComponent(invocationId)}`);
    await expect(page.getByTestId('trace-entry')).toBeVisible({ timeout: browserTimeout });

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
    await expect(page.getByRole('heading', { name: 'Emitted files' })).toBeVisible({ timeout: browserTimeout });
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
