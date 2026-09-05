import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import {
  replaceWatchedSourceAndAwaitRebuild,
  type WatchedBuildSession,
} from '../../agent-bundle/tests/support/watched-files.ts';
import {
  captureExampleState,
  copyExample,
  createExampleErrorLedger,
  expectHealthyExamplePage,
  writeExampleReport,
} from './support/example-acceptance.ts';
import {
  expectApplicationTree,
  expectPrimaryNav,
  expectRenderedDocument,
  expectUnknownRouteMessage,
  openWorkbench,
  readBuildEpoch,
  selectApplicationLeaf,
  waitForBuildEpochAdvance,
  workbenchTestId,
  workbenchTestIds,
} from './support/workbench-acceptance.ts';
import { buildWorkbench, e2e, waitForWorkbenchIdle, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';
import {
  applicationLeafForRouteId,
  findApplicationLeaf,
  inspectWorkbenchSurface,
  workbenchLeafPath,
} from './support/workbench-surface.ts';

const browserTimeout = 15_000 * timeScale;
const rebuildTimeout = 60_000 * timeScale;
const runTimeout = 60_000 * timeScale;
const searchTitle = 'Dune';
const hmrMarker = 'WB600-HMR-MARKER';

const editWatchedSource = async (
  server: WatchedBuildSession,
  projectRoot: string,
  path: string,
  content: string,
  expectedOutcome: 'failed' | 'succeeded',
): Promise<void> => {
  const attempt = await replaceWatchedSourceAndAwaitRebuild(server, projectRoot, path, content, { timeoutMs: rebuildTimeout });
  expect(attempt.outcome).toBe(expectedOutcome);
};

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
    const surface = await inspectWorkbenchSurface(project.root);
    const searchLeaf = applicationLeafForRouteId(surface.application, 'tool:curator/search_audible')
      ?? findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'tool' && leaf.ref.name === 'search_audible');
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
    const firstLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.routeId === 'tool:curator/inventory_sources')
      ?? searchLeaf;
    await selectApplicationLeaf(page, server.url, firstLeaf);
    await expectApplicationTree(page, surface.application);
    await captureExampleState(page, 'audiobook-curator', 'application-populated');

    await selectApplicationLeaf(page, server.url, searchLeaf);
    await page.getByLabel(/^title/iu).fill(searchTitle);
    await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: 'Run' })).click();
    const rendered = await expectRenderedDocument(page, runTimeout);
    await expect(page.getByTestId(workbenchTestIds.resultTabStructured).or(page.getByRole('tab', { name: /Structured/u }))).toBeVisible();
    await expect(page.getByTestId(workbenchTestIds.resultTabRaw).or(page.getByRole('tab', { name: /Raw/u }))).toBeVisible();
    await expect(page.getByTestId(workbenchTestIds.resultTabMcp).or(page.getByRole('tab', { name: /^MCP/u }))).toBeVisible();

    const invocationUrl = new URL(page.url());
    const invocationId = invocationUrl.searchParams.get('invocation');
    expect(invocationId).toMatch(/\S/u);

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
    await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: 'Run' })).click();
    await expect(rendered).toContainText(hmrMarker, { timeout: runTimeout });
    await editWatchedSource(server, project.root, searchSource, healthySearch, 'succeeded');

    await page.goto(workbenchUrl(server.url, `${searchPath}?invocation=${encodeURIComponent(invocationId!)}`));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).searchParams.get('invocation')).toBe(invocationId);
    await expect(workbenchTestId(page, 'routeWorkspace')).toBeVisible({ timeout: browserTimeout });
    await expectRenderedDocument(page, runTimeout);

    await editWatchedSource(server, project.root, conversionSource, `${healthyConversion}\nconst = ;\n`, 'failed');
    await page.reload();
    await waitForWorkbenchIdle(page);
    const problemsBadge = workbenchTestId(page, 'problemsBadge').or(page.getByRole('link', { name: /Problems/u }));
    await expect(problemsBadge).toBeVisible({ timeout: browserTimeout });
    await expect(problemsBadge).toContainText(/[1-9]/u);
    await openWorkbench(page, server.url, '/problems');
    const staleBanner = workbenchTestId(page, 'problemsBanner').or(page.getByRole('status').filter({
      hasText: /stale|newer source|rebuild/iu,
    }));
    await expect(staleBanner).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'audiobook-curator', 'problems-stale');
    await editWatchedSource(server, project.root, conversionSource, healthyConversion, 'succeeded');
    await workbenchTestId(page, 'problemsRepair').or(page.getByRole('button', { name: /Repair|Rebuild/u })).click();
    await waitForWorkbenchIdle(page);
    await expect(staleBanner).toHaveCount(0, { timeout: browserTimeout });
    await expect(problemsBadge).not.toContainText(/[1-9]/u, { timeout: browserTimeout });

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

    await page.goto(workbenchUrl(server.url, '/routes/mcp/no-such-server/tool/missing'));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe('/');
    await expectUnknownRouteMessage(page);

    await openWorkbench(page, server.url, '/advanced/evals');
    await expect(page.getByRole('tab', { name: 'Runs' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Compare' })).toBeVisible({ timeout: browserTimeout });

    await openWorkbench(page, server.url, '/advanced/hosts');
    await expect(page.getByRole('heading', { name: /Host diagnostics/u })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText(/installed|version|path/iu).first()).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('table', { name: /finding|bundle|store|probe/iu })).toHaveCount(0);

    await openWorkbench(page, server.url, '/advanced/artifact');
    await expect(page.getByRole('tree').or(page.getByRole('treeitem')).first()).toBeVisible({ timeout: browserTimeout });
    const detailsToggle = page.getByTestId(workbenchTestIds.inspectorToggle)
      .or(page.getByRole('button', { name: /details/iu }))
      .first();
    await expect(detailsToggle).toBeVisible({ timeout: browserTimeout });
    await detailsToggle.click();
    await expect(page.getByText(/hash|mode|provenance/iu).first()).toBeVisible({ timeout: browserTimeout });

    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await writeFile(searchSource, healthySearch).catch(() => undefined);
    await writeFile(conversionSource, healthyConversion).catch(() => undefined);
    await server.close();
    await project.release();
  }
});
