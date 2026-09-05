import { expect } from '@rstest/playwright';
import type { Locator, Page } from 'playwright-core';

import type { CompletedBuildAttempt } from '../../../agent-bundle/src/dev/types.ts';
import { workbenchLeafPath } from '../../../agent-bundle/src/test/index.ts';
import { timeScale } from '../../../agent-bundle/tests/support/time-scale.ts';
import { replaceWatchedSourceAndAwaitRebuild, type WatchedBuildSession } from '../../../agent-bundle/tests/support/watched-files.ts';
import { applicationLeaves, type ApplicationLeaf, type ApplicationTree } from '../../src/application/application-tree-model.ts';
import { routeInputLabel } from '../../src/routes/routes-model.ts';
import { waitForWorkbenchIdle, workbenchUrl } from './workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;
/** Upper bound for the watcher's debounce plus one full development rebuild. */
export const rebuildTimeout = 60_000 * timeScale;

export const workbenchTestIds = Object.freeze({
  advancedNav: 'advanced-nav',
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
  routeInputEditor: 'route-input-editor',
  routeRun: 'route-run',
  routeStatus: 'route-status',
  routeWorkspace: 'route-workspace',
  shellBuildStatus: 'shell-build-status',
  unknownRoute: 'unknown-route',
  workbenchLoading: 'workbench-loading',
  workbenchNav: 'workbench-nav',
  workspaceEmpty: 'workspace-empty',
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
  workbenchTestId(page, 'workbenchNav').locator('.nav-label').allInnerTexts();

export const expectPrimaryNav = async (page: Page, timeout = browserTimeout): Promise<void> => {
  const nav = workbenchTestId(page, 'workbenchNav');
  await expect(nav).toBeVisible({ timeout });
  expect(await navLinkLabels(page)).toEqual([...primaryNavLabels]);
};

/**
 * The tree items for one leaf. Leaves carry their node key in
 * `data-application-leaf`, so a label that is a prefix of another (`select`
 * vs `audible-select`) still resolves by key. Scope with `within` (a
 * `role=group` locator) when the same node is listed in more than one
 * branch — a tool routed as a CLI command appears under its server and
 * under CLI.
 */
export const applicationLeafItem = (page: Page, leaf: ApplicationLeaf, within?: Locator): Locator =>
  (within ?? workbenchTestId(page, 'applicationTree')).locator(`[data-application-leaf=${JSON.stringify(leaf.key)}]`);

const treeGroup = (within: Locator, label: string): Locator => within.getByRole('group', { exact: true, name: label });

const expectLeafItem = async (item: Locator, leaf: ApplicationLeaf, timeout: number): Promise<void> => {
  await expect(item).toBeVisible({ timeout });
  await expect(item).toHaveAttribute('role', 'treeitem');
  await expect(item).toContainText(leaf.label);
};

export const expectApplicationTree = async (
  page: Page,
  tree: ApplicationTree,
  timeout = browserTimeout,
): Promise<void> => {
  const treeRoot = workbenchTestId(page, 'applicationTree');
  await expect(treeRoot).toBeVisible({ timeout });
  const expectedGroups = tree.groups.map((group) => group.label);
  expect(expectedGroups).toEqual(
    applicationGroupOrder.filter((label) => expectedGroups.includes(label)),
  );
  const renderedGroups = await treeRoot.getByRole('group').evaluateAll((groups) =>
    groups.map((group) => group.getAttribute('aria-label') ?? ''));
  expect(renderedGroups.filter((label) => (applicationGroupOrder as readonly string[]).includes(label))).toEqual(expectedGroups);
  for (const group of tree.groups) {
    const groupNode = treeGroup(treeRoot, group.label);
    await expect(groupNode).toBeVisible({ timeout });
    if (group.kind !== 'mcp') {
      for (const leaf of group.leaves) await expectLeafItem(applicationLeafItem(page, leaf, groupNode), leaf, timeout);
      continue;
    }
    for (const server of group.servers) {
      const serverNode = treeGroup(groupNode, server.label);
      await expect(serverNode).toBeVisible({ timeout });
      for (const subgroup of server.subgroups) {
        const subgroupNode = treeGroup(serverNode, subgroup.label);
        await expect(subgroupNode).toBeVisible({ timeout });
        for (const leaf of subgroup.leaves) await expectLeafItem(applicationLeafItem(page, leaf, subgroupNode), leaf, timeout);
      }
    }
  }
  expect(await treeRoot.locator('[data-application-leaf]').count()).toBe(applicationLeaves(tree).length);
};

export const expectUnknownRouteMessage = async (page: Page, timeout = browserTimeout): Promise<void> => {
  await expect(workbenchTestId(page, 'unknownRoute')).toBeVisible({ timeout });
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
  const items = applicationLeafItem(page, leaf);
  await expect(items.first()).toHaveAttribute('aria-selected', 'true', { timeout: browserTimeout });
  for (const item of await items.all()) await expect(item).toHaveAttribute('aria-selected', 'true');
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

/**
 * Enters a route input the way the editor offers it: the generated form when
 * the leaf's schema fits the static grammar, raw JSON otherwise.
 */
export const fillRouteInput = async (page: Page, input: Readonly<Record<string, boolean | number | string>>): Promise<void> => {
  const editor = workbenchTestId(page, 'routeInputEditor');
  await expect(editor).toBeVisible({ timeout: browserTimeout });
  const raw = editor.locator('.route-input-raw textarea');
  if (await raw.count() > 0) {
    await raw.fill(JSON.stringify(input, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    const field = editor.getByLabel(new RegExp(`^${routeInputLabel(key)}(?: \\(required\\))?$`, 'u'));
    if (typeof value === 'boolean') await field.setChecked(value);
    else await field.fill(String(value));
  }
};

const buildPollMs = 50;

/**
 * Waits until the dev server reports no build in flight. The coordinator
 * coalesces invalidations that land during a build into one follow-up
 * attempt, so an edit made while a rebuild is still running would be judged
 * by an attempt that read the file before the write.
 */
export const waitForBuildIdle = async (server: WatchedBuildSession, timeout = rebuildTimeout): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (server.status().build.state === 'building') {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${String(timeout)}ms waiting for the dev server build to settle.`);
    await new Promise((resolve) => setTimeout(resolve, buildPollMs));
  }
};

/** `AB7101`: the artifact service rejected publication because the source changed while it compiled. */
const sourceChangedMidCompile = (attempt: CompletedBuildAttempt): boolean =>
  attempt.diagnostics.some((diagnostic) => diagnostic.code === 'AB7101');

const awaitFollowUpAttempt = async (
  server: WatchedBuildSession,
  previous: CompletedBuildAttempt,
  timeout: number,
): Promise<CompletedBuildAttempt> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { build } = server.status();
    if (build.state !== 'building' && build.lastAttempt !== undefined && build.lastAttempt.id !== previous.id) return build.lastAttempt;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${String(timeout)}ms waiting for the follow-up to build attempt ${previous.id}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, buildPollMs));
  }
};

/**
 * Replaces one watched source once the server is idle and asserts the outcome
 * of the rebuild that write caused — naming the attempt's diagnostics when it
 * does not match. A write that lands while a late watcher event is already
 * compiling the previous content is rejected with `AB7101` and queued as one
 * follow-up attempt (`DevCoordinator.rebuild`); that follow-up is the write's
 * build, so it is the one judged. Finally lets any coalesced attempt finish,
 * so the browser is never asked about a build header that still reads
 * "Building…".
 */
export const editWatchedSource = async (
  server: WatchedBuildSession,
  projectRoot: string,
  path: string,
  content: string,
  expectedOutcome: 'failed' | 'succeeded',
  timeout = rebuildTimeout,
): Promise<void> => {
  await waitForBuildIdle(server, timeout);
  let attempt = await replaceWatchedSourceAndAwaitRebuild(server, projectRoot, path, content, { timeoutMs: timeout });
  while (attempt.outcome !== expectedOutcome && sourceChangedMidCompile(attempt)) {
    attempt = await awaitFollowUpAttempt(server, attempt, timeout);
  }
  expect(attempt.outcome, `rebuild of ${path} (${attempt.sourceRevision}): ${JSON.stringify(attempt.diagnostics)}`).toBe(expectedOutcome);
  await waitForBuildIdle(server, timeout);
};

export const runSelectedRoute = async (page: Page, timeout = browserTimeout): Promise<void> => {
  await workbenchTestId(page, 'routeRun').click();
  const status = workbenchTestId(page, 'routeStatus');
  await expect(status).toHaveClass(/route-status--succeeded/u, { timeout });
};

export const readInvocationId = async (page: Page, timeout = browserTimeout): Promise<string> => {
  const id = workbenchTestId(page, 'routeStatus').locator('.route-status-id');
  await expect(id).toBeVisible({ timeout });
  const text = (await id.innerText()).trim();
  if (text.length === 0) throw new Error('route-status rendered an invocation without an id.');
  return text;
};

/**
 * Selects the Rendered tab and waits for a complete, error-free Agent Document.
 * A pending stream (`aria-busy`) and the empty placeholder are not accepted.
 */
export const expectRenderedDocument = async (page: Page, timeout = browserTimeout): Promise<Locator> => {
  await workbenchTestId(page, 'resultTabRendered').click();
  const document = workbenchTestId(page, 'renderedDocument');
  await expect(document).toBeVisible({ timeout });
  await expect(document).toHaveAttribute('aria-busy', 'false', { timeout });
  await expect(document.locator('.rendered-document-body')).toBeVisible({ timeout });
  await expect(document.locator('.rendered-document-diagnostics, .agent-document-error-node')).toHaveCount(0);
  return document;
};
