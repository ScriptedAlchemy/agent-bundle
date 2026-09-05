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
 * adopted by hosts, and the Overview has to say so rather than silently
 * applying it.
 */
e2e('shows a failed contract gate on the Overview while hosts keep the last passing build', { timeout: 180_000 }, async ({ page }) => {
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
    const hostAdoption = page.locator('section.host-adoption');
    await expect(hostAdoption).toHaveAttribute('data-state', 'passed', timeout);
    await expect(hostAdoption).toContainText('Contract matrix passed; hosts serve the current build', timeout);
    const initial = server.status();
    if (initial.artifact.state !== 'active') throw new Error('Expected an active initial epoch.');
    await expect(hostAdoption.locator('dd.identifier').first()).toHaveText(initial.artifact.activeEpoch.id, timeout);

    await replaceWatchedSource(fixture.root, fixture.project.contractFixtures, devContractFixtureSource('tool:fixture/unknown'));

    await expect(hostAdoption).toHaveAttribute('data-state', 'failed', timeout);
    await expect(hostAdoption).toContainText(`hosts keep build ${initial.artifact.activeEpoch.id}`, timeout);
    const violations = hostAdoption.getByRole('table', { name: 'Contract violations' });
    await expect(violations).toContainText('tool:fixture/unknown', timeout);
    await expect(violations).toContainText('coverage', timeout);
    await expect(page.getByTestId('problems-badge').or(page.getByRole('heading', { name: /^Diagnostics \(1\)$/u }))).toBeVisible(timeout);
    await page.goto(`${server.url}/problems`);
    await expect(page.getByText('AB7211')).toBeVisible(timeout);

    const failed = server.status();
    if (failed.artifact.state !== 'active') throw new Error('Expected the failed-contract build to publish an artifact.');
    expect(failed.artifact.activeEpoch.id).not.toBe(initial.artifact.activeEpoch.id);
    expect(failed.hostAdoption).toMatchObject({
      adoptedEpochId: initial.artifact.activeEpoch.id,
      contracts: { epochId: failed.artifact.activeEpoch.id, state: 'failed' },
      mode: 'gated',
    });
    await expect(hostAdoption.locator('dd.identifier').nth(0)).toHaveText(initial.artifact.activeEpoch.id, timeout);
    await expect(hostAdoption.locator('dd.identifier').nth(1)).toHaveText(failed.artifact.activeEpoch.id, timeout);

    await replaceWatchedSource(fixture.root, fixture.project.contractFixtures, devContractFixtureSource(DEV_CONTRACT_TOOL_ROUTE));

    await expect(hostAdoption).toHaveAttribute('data-state', 'passed', timeout);
    await expect(hostAdoption).toContainText('Contract matrix passed; hosts serve the current build', timeout);
    await expect(page.getByTestId('problems-badge').or(page.getByRole('heading', { name: /^Diagnostics \(0\)$/u }))).toBeVisible(timeout);
  });
});
