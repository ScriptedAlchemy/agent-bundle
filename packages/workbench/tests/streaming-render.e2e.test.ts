import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';

import { inspectWorkbenchSurface } from '../../agent-bundle/src/test/index.ts';
import { gatedRouteFiles } from '../../agent-bundle/tests/helpers/gated-routes.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { agentBundleNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { applicationLeafForRouteId } from '../src/application/application-tree-model.ts';
import {
  expectRenderedDocument,
  fillRouteInput,
  runSelectedRoute,
  selectApplicationLeaf,
  workbenchTestId,
} from './support/workbench-acceptance.ts';
import { buildWorkbench, e2e, startWorkbenchDevServer, withWorkbenchServer } from './support/workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;
const runTimeout = 60_000 * timeScale;

/**
 * #686: the production MCP surface streams the compiled tool's authored
 * Suspense fallback into the Rendered pane while the child is still blocked,
 * and the document that replaces it is the one the unblocked run renders.
 */
e2e('renders a compiled MCP tool\'s Suspense fallback before its gated child releases', { timeout: 180_000 * timeScale }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchServer({
    createProject: () => createProjectFixture({
      config: [
        'export default {',
        "  plugin: { name: 'streaming-render-e2e', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      files: {
        ...gatedRouteFiles,
        'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      },
      prefix: 'agent-bundle-streaming-render-e2e-',
    }),
    dispose: (project) => removeProjectFixture(project.root),
    setup: async (project) => {
      await mkdir(join(project.root, '.agent-bundle'), { recursive: true });
      await symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir');
    },
    start: (project) => startWorkbenchDevServer(project),
  }, async (server, project) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    const surface = await inspectWorkbenchSurface({ root: project.root });
    const leaf = applicationLeafForRouteId(surface.application, 'tool:status/live');
    if (leaf?.ref.kind !== 'tool') throw new Error('inspectWorkbenchSurface did not project tool:status/live as a tool leaf.');
    await selectApplicationLeaf(page, server.url, leaf);

    const gate = join(project.root, '.agent-bundle', 'browser-gate');
    await fillRouteInput(page, { gate: 'browser-gate' });
    await workbenchTestId(page, 'routeRun').click();
    await expect(workbenchTestId(page, 'routeRunningStatus')).toBeVisible({ timeout: browserTimeout });
    await workbenchTestId(page, 'resultTabRendered').click();
    const document = workbenchTestId(page, 'renderedDocument');
    const body = document.locator('.rendered-document-body');
    await expect(body.locator('.agent-document-progress')).toContainText('streaming', { timeout: browserTimeout });
    await expect(document).toHaveAttribute('aria-busy', 'true');
    expect(existsSync(gate)).toBe(false);

    await writeFile(gate, 'open\n');
    await expect(workbenchTestId(page, 'routeStatus')).toHaveClass(/route-status--succeeded/u, { timeout: runTimeout });
    const streamed = await expectRenderedDocument(page, runTimeout);
    const streamedText = await streamed.locator('.rendered-document-body').innerText();
    expect(streamedText).toContain('stream complete');
    expect(streamedText).not.toContain('streaming');

    // Parity control: the same route with an already-open gate never suspends
    // and renders the same final document.
    await runSelectedRoute(page, runTimeout);
    const control = await expectRenderedDocument(page, runTimeout);
    expect(await control.locator('.rendered-document-body').innerText()).toBe(streamedText);
    expect(pageErrors).toEqual([]);
  });
});
