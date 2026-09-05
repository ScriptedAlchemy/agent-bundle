import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  exampleRoot,
  expectHealthyExamplePage,
  waitForSettledWorkbench,
  writeExampleReport,
} from './support/example-acceptance.ts';
import {
  expectApplicationTree,
  expectPrimaryNav,
  expectUnknownRouteMessage,
  openWorkbench,
  selectApplicationLeaf,
  workbenchTestId,
} from './support/workbench-acceptance.ts';
import { buildWorkbench, e2e, waitForWorkbenchIdle, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';
import {
  applicationLeaves,
  findApplicationLeaf,
  inspectWorkbenchSurface,
  workbenchLeafPath,
} from './support/workbench-surface.ts';

const browserTimeout = 15_000 * timeScale;
/** One watcher debounce plus a full development rebuild of an example under gate load. */
const rebuildTimeout = 60_000 * timeScale;

/**
 * Edits one watched source and waits for the dev server's own rebuild of that
 * edit to complete before the browser is asked about it. A source write must
 * not be paired with an immediate manual rebuild: the watcher rebuilds the
 * same write on its own, and two builds per edit mint two epochs whose
 * relative timing depends on load — the second one flips the Workbench's
 * build identity while it may still be loading capabilities for the first.
 * Waiting on the coordinator's published attempt makes one edit exactly one
 * build, so no retry is needed to absorb that race.
 */
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
    const surface = await inspectWorkbenchSurface(exampleRoot('skills-starter'));
    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    await expectApplicationTree(page, surface.application);
    for (const skill of ['dependency-upgrade', 'incident-triage', 'release-review']) {
      const leaf = findApplicationLeaf(surface.application, (entry) => entry.ref.kind === 'skill' && (
        entry.ref.id === skill || entry.label === skill
      ));
      if (leaf === undefined) throw new Error(`Skills Starter surface is missing the ${skill} leaf.`);
      await selectApplicationLeaf(page, server.url, leaf);
      await expect(page.getByRole('heading', { name: skill, exact: true })).toBeVisible({ timeout: browserTimeout });
    }
    await captureExampleState(page, 'skills-starter', 'skills-populated');

    await openWorkbench(page, server.url, '/advanced/artifact');
    await expect(page.getByRole('tree').or(page.getByRole('treeitem')).first()).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'artifacts-populated');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
  }
});

e2e('reveals, retains, repairs, and removes capabilities without reloading Chrome', { timeout: 120_000 * timeScale }, async ({ page }) => {
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
    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    const before = await inspectWorkbenchSurface(project.root);
    expect(applicationLeaves(before.application).some((leaf) => leaf.ref.kind === 'event')).toBe(false);

    await editWatchedSource(server, project.root, configPath, hookConfig, 'succeeded');
    await waitForWorkbenchIdle(page);
    const revealed = await inspectWorkbenchSurface(project.root);
    const eventLeaf = findApplicationLeaf(revealed.application, (leaf) => leaf.ref.kind === 'event');
    if (eventLeaf === undefined) throw new Error('Adding a sessionStart hook did not project an Events leaf.');
    await expect(page.getByRole('treeitem', { name: new RegExp(eventLeaf.label, 'u') })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-revealed');

    await editWatchedSource(server, project.root, hookSource, 'export default () => ({\n', 'failed');
    await openWorkbench(page, server.url, '/problems');
    await expect(workbenchTestId(page, 'problemsBanner').or(page.getByRole('heading', { name: /Diagnostics \([1-9]/u })))
      .toBeVisible({ timeout: browserTimeout });
    await expect(workbenchTestId(page, 'shellBuildStatus')).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-stale');

    await editWatchedSource(server, project.root, hookSource, healthyHook, 'succeeded');
    await waitForWorkbenchIdle(page);
    await expect(workbenchTestId(page, 'problemsBanner')).toHaveCount(0, { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-repaired');

    await editWatchedSource(server, project.root, configPath, originalConfig, 'succeeded');
    await openWorkbench(page, server.url, '/');
    await expect(page.getByRole('treeitem', { name: new RegExp(eventLeaf.label, 'u') })).toHaveCount(0, { timeout: browserTimeout });
    await captureExampleState(page, 'skills-starter', 'capability-removed');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});

e2e('drives event, script, logs, diagnostics, and repair in real Chrome', { timeout: 150_000 * timeScale }, async ({ page }) => {
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
    const surface = await inspectWorkbenchSurface(project.root);
    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    const eventLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'event')
      ?? findApplicationLeaf(surface.application, (leaf) => /session/iu.test(leaf.label));
    if (eventLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, eventLeaf);
      await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: /Run/u })).click();
      await expect(workbenchTestId(page, 'routeWorkspace')).toBeVisible({ timeout: browserTimeout });
    }
    await captureExampleState(page, 'hooks-and-scripts', 'hooks-populated');

    const scriptLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.routeId === 'script:verify-release')
      ?? findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'script' && /verify-release/u.test(leaf.label));
    if (scriptLeaf === undefined) throw new Error('hooks-and-scripts surface is missing script:verify-release.');
    await selectApplicationLeaf(page, server.url, scriptLeaf);
    await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: /Run/u })).click();
    await expect(page.getByText(/script\.completed|ready for packaging/iu)).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'script-success');

    const riskLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.routeId === 'script:detect-risk')
      ?? findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'script' && /detect-risk/u.test(leaf.label));
    if (riskLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, riskLeaf);
      await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: /Run/u })).click();
      await expect(page.getByText(/REL-204|exitCode/iu)).toBeVisible({ timeout: browserTimeout });
      await captureExampleState(page, 'hooks-and-scripts', 'script-failure');
    }

    await openWorkbench(page, server.url, '/advanced/logs');
    await expect(page.locator('.logs-entries > li').first()).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'logs-populated');

    await editWatchedSource(server, project.root, hookSource, 'export default () => ({\n', 'failed');
    await openWorkbench(page, server.url, '/problems');
    await expect(workbenchTestId(page, 'problemsBanner').or(page.getByRole('heading', { name: /Diagnostics \([1-9]/u })))
      .toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'hooks-and-scripts', 'diagnostic-stale');

    await editWatchedSource(server, project.root, hookSource, healthyHook, 'succeeded');
    await workbenchTestId(page, 'problemsRepair').or(page.getByRole('button', { name: /Repair|Rebuild/u })).click();
    await waitForWorkbenchIdle(page);
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
    const surface = await inspectWorkbenchSurface(project.root);
    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    await expectApplicationTree(page, surface.application);
    await captureExampleState(page, 'mcp-app', 'application-populated');

    const skillLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'skill');
    if (skillLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, skillLeaf);
      await captureExampleState(page, 'mcp-app', 'skills-populated');
    }

    const eventLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'event');
    if (eventLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, eventLeaf);
      await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: /Run/u })).click();
      await captureExampleState(page, 'mcp-app', 'hooks-populated');
    }

    const scriptLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'script');
    if (scriptLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, scriptLeaf);
      await workbenchTestId(page, 'routeRun').or(page.getByRole('button', { name: /Run/u })).click();
      await captureExampleState(page, 'mcp-app', 'playground-script-success');
    }

    await openWorkbench(page, server.url, '/advanced/logs');
    await captureExampleState(page, 'mcp-app', 'logs-populated');

    await openWorkbench(page, server.url, '/advanced/artifact');
    await captureExampleState(page, 'mcp-app', 'artifacts-populated');

    await openWorkbench(page, server.url, '/advanced/evals');
    await expect(page.getByRole('tab', { name: 'Compare' })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'comparisons-insufficient-runs');

    await openWorkbench(page, server.url, '/advanced/protocol');
    await expect(page.getByRole('heading', { name: /Protocol/u })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'mcp-session-ready');

    const appLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.ref.kind === 'app' || leaf.execution === 'preview');
    if (appLeaf !== undefined) {
      await selectApplicationLeaf(page, server.url, appLeaf);
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
        await waitForExampleValue(page, () => appText('#service'), (value) => value !== undefined, 'the App service');
      } catch (error) {
        await expectHealthyExamplePage(ledger);
        throw error;
      }
      await captureExampleState(page, 'mcp-app', 'mcp-app-preview');
    }

    await openWorkbench(page, server.url, '/advanced/evals');
    await expect(page.getByRole('tab', { name: 'Runs' })).toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'mcp-app', 'eval-completed');
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});

e2e('renders the flagship compiled Application tree by server and kind in real Chrome', { timeout: 150_000 * timeScale }, async ({ page }) => {
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
    const surface = await inspectWorkbenchSurface(project.root);
    const searchLeaf = findApplicationLeaf(surface.application, (leaf) => leaf.routeId === 'tool:curator/search_audible');
    if (searchLeaf === undefined) throw new Error('audiobook-curator surface is missing tool:curator/search_audible.');
    await openWorkbench(page, server.url, '/');
    await expectPrimaryNav(page);
    await selectApplicationLeaf(page, server.url, searchLeaf);
    await expectApplicationTree(page, surface.application);
    expect(workbenchLeafPath(searchLeaf)).toBe('/routes/mcp/curator/tool/search_audible');
    const cliLeaves = applicationLeaves(surface.application).filter((leaf) => leaf.ref.kind === 'cli');
    expect(cliLeaves.map((leaf) => leaf.routeId).filter((id): id is string => id !== undefined).filter((id) => id.startsWith('cli:')).toSorted())
      .toEqual([
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
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-by-server');

    await editWatchedSource(server, project.root, conversionSource, `${healthyConversion}\nconst = ;\n`, 'failed');
    await page.reload();
    await waitForSettledWorkbench(page);
    await openWorkbench(page, server.url, '/problems');
    await expect(workbenchTestId(page, 'problemsBanner').or(page.getByText(/stale|newer source|Rebuild/iu)))
      .toBeVisible({ timeout: browserTimeout });
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-stale');

    await editWatchedSource(server, project.root, conversionSource, healthyConversion, 'succeeded');
    await workbenchTestId(page, 'problemsRepair').or(page.getByRole('button', { name: /Repair|Rebuild/u })).click();
    await waitForWorkbenchIdle(page);
    await captureExampleState(page, 'audiobook-curator', 'routes-catalog-repaired');

    await page.goto(workbenchUrl(server.url, '/routes/not-a-leaf/missing'));
    await waitForWorkbenchIdle(page);
    expect(new URL(page.url()).pathname).toBe('/');
    await expectUnknownRouteMessage(page);
    await expectHealthyExamplePage(ledger);
    await writeExampleReport();
  } finally {
    await server.close();
    await project.release();
  }
});
