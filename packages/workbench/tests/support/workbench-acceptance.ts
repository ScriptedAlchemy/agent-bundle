import { expect } from '@rstest/playwright';
import type { Locator, Page } from 'playwright-core';

import { workbenchLeafPath } from '../../../agent-bundle/src/test/index.ts';
import { timeScale } from '../../../agent-bundle/tests/support/time-scale.ts';
import { applicationLeaves, type ApplicationLeaf, type ApplicationTree } from '../../src/application/application-tree-model.ts';
import { waitForWorkbenchIdle, workbenchUrl } from './workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;

export const workbenchTestIds = Object.freeze({
  applicationTree: 'application-tree',
  inspectorToggle: 'inspector-toggle',
  problemsBadge: 'problems-badge',
  problemsBanner: 'problems-banner',
  problemsRepair: 'problems-repair',
  renderedDocument: 'rendered-document',
  resultTabCli: 'result-tab-cli',
  resultTabMcp: 'result-tab-mcp',
  resultTabRaw: 'result-tab-raw',
  resultTabRendered: 'result-tab-rendered',
  resultTabStructured: 'result-tab-structured',
  resultTabTrace: 'result-tab-trace',
  routeRun: 'route-run',
  routeWorkspace: 'route-workspace',
  shellBuildStatus: 'shell-build-status',
  unknownRoute: 'unknown-route',
  workbenchLoading: 'workbench-loading',
  workbenchNav: 'workbench-nav',
} as const);

export const primaryNavLabels = Object.freeze(['Application', 'Trace', 'Problems', 'Advanced'] as const);

export const applicationGroupOrder = Object.freeze([
  'MCP',
  'Events / Hooks',
  'CLI',
  'Scripts',
  'Skills',
  'Rules / Commands',
] as const);

export const workbenchTestId = (page: Page, id: keyof typeof workbenchTestIds): Locator =>
  page.getByTestId(workbenchTestIds[id]);

const navLinkLabels = async (page: Page): Promise<readonly string[]> =>
  workbenchTestId(page, 'workbenchNav').getByRole('link').evaluateAll((links) =>
    links.map((link) => Array.from(link.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim()
      .replace(/\s+/gu, ' '))
      .filter((label) => label.length > 0));

export const expectPrimaryNav = async (page: Page, timeout = browserTimeout): Promise<void> => {
  const nav = workbenchTestId(page, 'workbenchNav');
  await expect(nav).toBeVisible({ timeout });
  expect(await navLinkLabels(page)).toEqual([...primaryNavLabels]);
};

export const expectApplicationTree = async (
  page: Page,
  tree: ApplicationTree,
  timeout = browserTimeout,
): Promise<void> => {
  const treeRoot = page.getByTestId(workbenchTestIds.applicationTree).or(page.getByRole('tree'));
  await expect(treeRoot).toBeVisible({ timeout });
  const renderedGroups = await treeRoot.getByRole('group').evaluateAll((groups) =>
    groups.map((group) => group.getAttribute('aria-label') ?? group.textContent?.split('\n')[0]?.trim() ?? ''));
  const expectedGroups = tree.groups.map((group) => group.label);
  expect(expectedGroups).toEqual(
    applicationGroupOrder.filter((label) => expectedGroups.includes(label)),
  );
  for (const label of expectedGroups) {
    expect(renderedGroups.some((rendered) => rendered.includes(label))).toBe(true);
  }
  for (const leaf of applicationLeaves(tree)) {
    await expect(page.getByRole('treeitem', { name: new RegExp(leaf.label, 'u') }))
      .toBeVisible({ timeout });
  }
};

export const expectUnknownRouteMessage = async (page: Page, timeout = browserTimeout): Promise<void> => {
  const message = workbenchTestId(page, 'unknownRoute').or(page.getByRole('status').filter({
    hasText: /unknown (?:route|path)|not found/iu,
  }));
  await expect(message).toBeVisible({ timeout });
};

export const openWorkbench = async (
  page: Page,
  origin: string,
  path = '/',
): Promise<void> => {
  await page.goto(workbenchUrl(origin, path));
  await waitForWorkbenchIdle(page);
};

export const selectApplicationLeaf = async (
  page: Page,
  origin: string,
  leaf: ApplicationLeaf,
): Promise<string> => {
  const path = workbenchLeafPath(leaf);
  await openWorkbench(page, origin, path);
  await expect(workbenchTestId(page, 'routeWorkspace')).toBeVisible({ timeout: browserTimeout });
  await expect(page).toHaveURL(new URL(path, `${origin}/`).href);
  return path;
};

export const readBuildEpoch = async (page: Page): Promise<string> => {
  const status = workbenchTestId(page, 'shellBuildStatus');
  await expect(status).toBeVisible({ timeout: browserTimeout });
  const text = (await status.innerText()).trim();
  if (text.length === 0) throw new Error('shell-build-status rendered without an epoch or state.');
  return text;
};

export const waitForBuildEpochAdvance = async (
  page: Page,
  previous: string,
  timeout = 60_000 * timeScale,
): Promise<string> => {
  await expect.poll(async () => readBuildEpoch(page), { timeout }).not.toBe(previous);
  return readBuildEpoch(page);
};

export const expectRenderedDocument = async (page: Page, timeout = browserTimeout): Promise<Locator> => {
  await workbenchTestId(page, 'resultTabRendered').or(page.getByRole('tab', { name: 'Rendered' })).click();
  const document = workbenchTestId(page, 'renderedDocument').or(page.getByRole('document'));
  await expect(document).toBeVisible({ timeout });
  await expect(document).not.toHaveText('', { timeout });
  await expect(document.locator('[data-kind="error"], .agent-document-error').first()).toHaveCount(0);
  return document;
};
