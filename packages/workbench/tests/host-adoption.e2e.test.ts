import { expect } from '@rstest/playwright';

import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import {
  DEV_CONTRACT_TOOL_ROUTE,
  devContractFixtureSource,
  writeDevContractProject,
  type DevContractProject,
} from '../../agent-bundle/tests/support/dev-contract-project.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { replaceWatchedSource } from './support/watched-files.ts';
import { buildWorkbench, e2e, startWorkbenchDevServer, withWorkbenchServer } from './support/workbench-e2e.ts';

const browserTimeout = 30_000 * timeScale;

interface ContractProjectFixture {
  readonly project: DevContractProject;
  readonly root: string;
}

/**
 * #218 stage 4 in the browser: a rebuild whose generated server no longer
 * satisfies the declared contract publishes to the Workbench but must not be
 * adopted by hosts. The header badge and Problems page have to say so rather
 * than silently applying it.
 */
e2e('shows a failed contract gate on Problems while hosts keep the last passing build', { timeout: 180_000 }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchServer<Awaited<ReturnType<typeof startWorkbenchDevServer>>, ContractProjectFixture, void>({
    close: (server) => server.close(),
    createProject: async () => {
      const fixture = await createProjectFixture({ config: 'export default {};\n', files: {} });
      const project = await writeDevContractProject(fixture.root, { contracts: true });
      return Object.freeze({ project, root: fixture.root });
    },
    dispose: (fixture) => removeProjectFixture(fixture.root),
    start: (fixture) => startWorkbenchDevServer({ root: fixture.root }),
  }, async (server, fixture) => {
    await page.goto(server.url);
    await expect(page.getByTestId('workbench-nav')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByTestId('shell-build-status')).toBeVisible({ timeout: browserTimeout });

    const timeout = { timeout: browserTimeout };
    const buildStatus = page.getByTestId('shell-build-status');
    const problemsBadge = page.getByTestId('problems-badge');
    await expect(buildStatus).toContainText('Current build', timeout);
    await expect(problemsBadge).toHaveAttribute('aria-label', 'No problems', timeout);
    const initial = server.status();
    if (initial.artifact.state !== 'active') throw new Error('Expected an active initial epoch.');
    await expect(buildStatus.locator('.identifier')).toContainText(initial.artifact.activeEpoch.id.slice(0, 12), timeout);

    await replaceWatchedSource(fixture.root, fixture.project.contractFixtures, devContractFixtureSource('tool:fixture/unknown'));

    await expect(problemsBadge).not.toHaveAttribute('aria-label', 'No problems', timeout);
    await page.goto(`${server.url}/problems`);
    await expect(page.getByRole('heading', { name: /^Problems \(/u })).toBeVisible(timeout);
    await expect(page.getByTestId('problems-summary')).toContainText('hosts keep the last passing build', timeout);
    await expect(page.getByText('AB7211')).toBeVisible(timeout);
    await expect(page.locator('.problems-page')).toContainText('tool:fixture/unknown', timeout);
    await expect(page.locator('.problems-page')).toContainText('coverage', timeout);
    await expect(page.locator('.problems-page')).toContainText(`hosts keep build ${initial.artifact.activeEpoch.id}`, timeout);

    const failed = server.status();
    if (failed.artifact.state !== 'active') throw new Error('Expected the failed-contract build to publish an artifact.');
    expect(failed.artifact.activeEpoch.id).not.toBe(initial.artifact.activeEpoch.id);
    expect(failed.hostAdoption).toMatchObject({
      adoptedEpochId: initial.artifact.activeEpoch.id,
      contracts: { epochId: failed.artifact.activeEpoch.id, state: 'failed' },
      mode: 'gated',
    });

    await replaceWatchedSource(fixture.root, fixture.project.contractFixtures, devContractFixtureSource(DEV_CONTRACT_TOOL_ROUTE));

    await expect(problemsBadge).toHaveAttribute('aria-label', 'No problems', timeout);
    await expect(page.getByTestId('problems-empty')).toBeVisible(timeout);
    await expect(page.getByTestId('problems-summary')).toHaveText('The current build matches your source', timeout);
  });
});
