import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from '@rstest/playwright';

import { agentBundleNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { buildWorkbench, e2e, withWorkbenchProjectServer } from './support/workbench-e2e.ts';

const browserTimeout = 8_000;

const writeTimeoutProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      '',
      "const server = new McpServer({ name: 'timeout-fixture', version: '1.0.0' });",
      "server.registerTool('inspect', {}, async () => ({ content: [{ text: 'ready', type: 'text' }] }));",
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'timeout-e2e-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

e2e('opens one browser MCP session with an immutable timeout', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  await withWorkbenchProjectServer(async (server) => {
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected a generated fixture artifact epoch.');
    const foregroundOrigin = server.url;
    const pageErrors: Error[] = [];
    const creates: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() === `${foregroundOrigin}/api/mcp/sessions` && request.method() === 'POST') {
        creates.push(request.postData() ?? '');
      }
    });

    await page.goto(`${foregroundOrigin}#/mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    await page.getByLabel('Session timeout (ms)').fill('0');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.getByRole('alert')).toContainText('Session timeout must be a positive finite number.');
    expect(creates).toEqual([]);

    await page.getByLabel('Session timeout (ms)').fill('12345');
    const opened = page.waitForResponse((response) =>
      response.url() === `${foregroundOrigin}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const openedSession = await (await opened).json() as { readonly session: { readonly timeoutMs: number } };
    expect(openedSession.session.timeoutMs).toBe(12_345);
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await expect(page.getByText('Active session timeout: 12345 ms.')).toBeVisible();
    await expect(page.getByLabel('Session timeout (ms)')).toHaveValue('12345');

    await page.getByRole('button', { name: 'Restart MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    expect(await page.getByLabel('Session timeout (ms)').isDisabled()).toBe(true);
    await expect(page.getByLabel('Session timeout (ms)')).toHaveValue('12345');
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  }, { setup: (project) => writeTimeoutProject(project.root) });
});
