import { expect } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { copyExample, createExampleErrorLedger, waitForSettledWorkbench } from './support/example-acceptance.ts';
import { buildWorkbench, e2e, workbenchAssets, workbenchUrl } from './support/workbench-e2e.ts';

const browserTimeout = 15_000 * timeScale;

/**
 * Browser acceptance for task-augmented tool calls (#369) on the desktop
 * Workbench (1440×900): the MCP page runs the host-test example's `slow` probe
 * as a task against the real generated stdio server, polls `tasks/get` at the
 * server's interval until the task settles, fetches the final `CallToolResult`
 * through `tasks/result`, and cancels a second task through `tasks/cancel`.
 */
e2e('runs, polls, collects, and cancels a task-augmented tool call in real Chrome', { timeout: 180_000 * timeScale }, async ({ page }) => {
  await buildWorkbench();
  const project = await copyExample('host-test');
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  const ledger = createExampleErrorLedger(page, server.url);
  try {
    await page.goto(workbenchUrl(server.url, '/advanced/protocol'));
    await waitForSettledWorkbench(page);
    await expect(page.getByRole('heading', { name: /Protocol/u })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('host-test');
    await page.locator('#mcp-session-timeout').fill(String(browserTimeout * 4));
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout * 4 });
    // The generated server negotiated the tasks capability with the browser client.
    await expect(page.getByLabel('Negotiated connection')).toContainText('"tasks"', { timeout: browserTimeout });
    await expect(page.getByRole('button', { name: 'List tasks' })).toBeEnabled({ timeout: browserTimeout });

    await page.getByRole('button', { name: 'List tools' }).click();
    await expect(page.getByRole('button', { name: 'slow', exact: true })).toBeVisible({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'slow', exact: true }).click();
    // The tool advertised execution.taskSupport "optional": the toggle is offered, off by default.
    const runAsTask = page.getByLabel(/^Run as task/u);
    await expect(runAsTask).toBeVisible({ timeout: browserTimeout });
    await expect(runAsTask).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Call slow' })).toBeVisible({ timeout: browserTimeout });
    await runAsTask.check();
    await expect(page.getByRole('button', { name: 'Run slow as task' })).toBeVisible({ timeout: browserTimeout });
    // Arguments through the raw JSON editor: the same request shape a host sends.
    const fillArguments = async (value: Readonly<Record<string, unknown>>): Promise<void> => {
      await page.locator('input[name="mcp-tool-arguments-mode"]').nth(1).check();
      await page.locator('#mcp-tool-arguments-raw').fill(JSON.stringify(value));
    };
    await fillArguments({ holdMs: 2000, tickMs: 500 });
    await page.getByRole('button', { name: 'Run slow as task' }).click();

    // tools/call answered with a task: the panel shows it working before the render ends.
    const tasks = page.getByLabel('MCP tasks');
    await expect(tasks).toBeVisible({ timeout: browserTimeout });
    const first = tasks.locator('li[data-task-id]').first();
    await expect(first).toHaveAttribute('data-task-status', 'working', { timeout: browserTimeout });
    await expect(first).toContainText('slow', { timeout: browserTimeout });
    const firstTaskId = await first.getAttribute('data-task-id');
    if (firstTaskId === null) throw new Error('Expected the task panel to name the created task.');
    // Polled through tasks/get until the render settled.
    await expect(first).toHaveAttribute('data-task-status', 'completed', { timeout: browserTimeout * 2 });
    await expect(first).toContainText('Progress 4 / 4 · held 2000ms', { timeout: browserTimeout });
    await expect(first.getByRole('button', { name: `Cancel ${firstTaskId.slice(0, 8)}` })).toBeDisabled();
    await first.getByRole('button', { name: `Fetch result ${firstTaskId.slice(0, 8)}` }).click();
    await expect(first.locator('pre')).toContainText('Held the call for', { timeout: browserTimeout });
    await expect(first.locator('pre')).toContainText('"heldMs"', { timeout: browserTimeout });
    await expect(first.locator('pre')).toContainText(`"taskId": "${firstTaskId}"`, { timeout: browserTimeout });

    // Every step was an ordinary invocation: creation, polls, and the result fetch are in the history.
    const history = page.getByLabel('Invocation history');
    await expect(history).toContainText('callToolTask', { timeout: browserTimeout });
    await expect(history).toContainText('getTask', { timeout: browserTimeout });
    await expect(history).toContainText('getTaskResult', { timeout: browserTimeout });

    // A second, long task is cancelled through tasks/cancel while it is working.
    await fillArguments({ holdMs: 25_000, tickMs: 500 });
    await page.getByRole('button', { name: 'Run slow as task' }).click();
    const second = tasks.locator('li[data-task-id]').filter({ hasNot: page.locator(`[data-task-id="${firstTaskId}"]`) }).last();
    await expect(second).toHaveAttribute('data-task-status', 'working', { timeout: browserTimeout });
    const secondTaskId = await second.getAttribute('data-task-id');
    if (secondTaskId === null || secondTaskId === firstTaskId) throw new Error('Expected a second, distinct task.');
    await second.getByRole('button', { name: `Cancel ${secondTaskId.slice(0, 8)}` }).click();
    await expect(second).toHaveAttribute('data-task-status', 'cancelled', { timeout: browserTimeout });
    await expect(second).toContainText('The task was cancelled by request.', { timeout: browserTimeout });
    await expect(history).toContainText('cancelTask', { timeout: browserTimeout });

    // tasks/list still retains both, in creation order.
    await page.getByRole('button', { name: 'List tasks' }).click();
    await expect(history).toContainText('listTasks', { timeout: browserTimeout });
    await expect(tasks.locator('li[data-task-id]')).toHaveCount(2, { timeout: browserTimeout });
    if (process.env['AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR'] !== undefined) {
      await tasks.scrollIntoViewIfNeeded();
      await page.screenshot({ animations: 'disabled', path: `${process.env['AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR']}/host-test-mcp-tasks.png` });
    }

    expect(ledger.pageErrors).toEqual([]);
    expect(ledger.consoleErrors).toEqual([]);
  } finally {
    await server.close();
    await project.release();
  }
});
