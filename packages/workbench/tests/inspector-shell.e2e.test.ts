import { execFile as executeFile } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 5_000;

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const buildWorkbench = async (mode: 'development' | 'production' = 'production'): Promise<void> => {
  const { NODE_ENV: _nodeEnv, RSTEST: _rstest, ...environment } = process.env;
  const isProduction = mode === 'production';
  await execFile('npm', isProduction
    ? ['run', 'build', '--workspace', 'agent-bundle-workbench']
    : ['exec', 'rsbuild', '--', 'build', '--mode', mode], {
    cwd: isProduction ? workspaceRoot : join(workspaceRoot, 'packages', 'workbench'),
    env: { ...environment, NODE_ENV: mode },
  });
};

const writeInspectorProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    symlink(join(workspaceRoot, 'node_modules', '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workspaceRoot, 'node_modules', 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import { z } from 'zod';",
      '',
      "const server = new McpServer({ name: 'inspector-fixture', version: '1.0.0' }, { capabilities: { logging: {} } });",
      "server.registerTool('echo', { description: 'Echo one message.', inputSchema: z.object({ message: z.string() }) }, async ({ message }) => {",
      "  await server.sendLoggingMessage({ data: `echo ${message}`, level: 'info' });",
      "  return { content: [{ type: 'text', text: `Echo: ${message}` }] };",
      '});',
      "server.registerResource('fixture', 'ui://fixture/resource.txt', { mimeType: 'text/plain' }, async (uri) => ({",
      "  contents: [{ mimeType: 'text/plain', text: 'fixture resource', uri: uri.href }],",
      '}));',
      "server.registerPrompt('fixture', { description: 'Fixture prompt.' }, async () => ({",
      "  messages: [{ role: 'user', content: { type: 'text', text: 'fixture prompt' } }],",
      '}));',
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'workbench-inspector-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

e2e('canonicalizes the legacy Inspector hash into the internal MCP Inspector presentation without opening a session', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    let sessionPosts = 0;
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() === `${server.url}/api/mcp/sessions` && request.method() === 'POST') sessionPosts += 1;
    });

    await page.goto(`${server.url}#inspector`);
    await expect(page).toHaveURL(/#mcp$/u, { timeout: browserTimeout });
    await expect(page.getByRole('link', { name: 'Inspector' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('Negotiated protocol: Not negotiated')).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByRole('navigation', { name: 'Inspector screens' })).toHaveText(/Tools.*Resources.*Prompts.*Protocol.*Logging/u);
    const playgroundTab = page.getByRole('tab', { name: 'Playground' });
    const inspectorTab = page.getByRole('tab', { name: 'Inspector' });
    await expect(inspectorTab).toHaveAttribute('tabindex', '0');
    await expect(playgroundTab).toHaveAttribute('tabindex', '-1');
    await inspectorTab.focus();
    await page.keyboard.press('Home');
    await expect(playgroundTab).toBeFocused({ timeout: browserTimeout });
    await expect(playgroundTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/#mcp$/u);
    await page.keyboard.press('End');
    await expect(inspectorTab).toBeFocused({ timeout: browserTimeout });
    await expect(inspectorTab).toHaveAttribute('aria-selected', 'true');
    expect(sessionPosts).toBe(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('shares one real session between the MCP Playground and Inspector presentations', { timeout: 90_000 }, async ({ page }) => {
  await buildWorkbench();
  const project = await createProjectFixture();
  await writeInspectorProject(project.root);
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    let sessionPosts = 0;
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      if (request.url() === `${server.url}/api/mcp/sessions` && request.method() === 'POST') sessionPosts += 1;
    });

    await page.goto(`${server.url}#mcp`);
    const playgroundTab = page.getByRole('tab', { name: 'Playground' });
    const inspectorTab = page.getByRole('tab', { name: 'Inspector' });
    await expect(playgroundTab).toHaveAttribute('aria-selected', 'true');
    await expect(playgroundTab).toHaveAttribute('tabindex', '0');
    await expect(inspectorTab).toHaveAttribute('tabindex', '-1');
    await playgroundTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(inspectorTab).toBeFocused({ timeout: browserTimeout });
    await expect(inspectorTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/#mcp$/u);
    await page.keyboard.press('ArrowDown');
    await expect(playgroundTab).toBeFocused({ timeout: browserTimeout });
    await expect(playgroundTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(inspectorTab).toBeFocused({ timeout: browserTimeout });
    await expect(inspectorTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(playgroundTab).toBeFocused({ timeout: browserTimeout });
    await expect(playgroundTab).toHaveAttribute('aria-selected', 'true');
    expect(sessionPosts).toBe(0);
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page).toHaveURL(/#mcp$/u);
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');

    const inspector = page.locator('#mcp-inspector-presentation');
    await expect(inspector.getByText(/Negotiated protocol: \d{4}-\d{2}-\d{2}/u)).toBeVisible({ timeout: browserTimeout });
    await inspector.getByRole('button', { name: 'echo' }).click();
    await inspector.getByRole('textbox', { name: 'message' }).fill('inspector');
    await inspector.getByRole('button', { name: 'Execute Tool' }).click();
    await expect(inspector.getByText('Echo: inspector')).toBeVisible({ timeout: browserTimeout });

    const screens = inspector.getByRole('navigation', { name: 'Inspector screens' });
    await screens.getByRole('button', { name: 'Resources' }).click();
    await expect(inspector.getByText('fixture', { exact: true })).toBeVisible({ timeout: browserTimeout });
    await screens.getByRole('button', { name: 'Prompts' }).click();
    await expect(inspector.getByText('fixture', { exact: true })).toBeVisible({ timeout: browserTimeout });
    await screens.getByRole('button', { name: 'Protocol' }).click();
    const protocolHistory = inspector.getByLabel('Protocol history', { exact: true });
    await expect(protocolHistory).toBeVisible({ timeout: browserTimeout });
    const sequences = await protocolHistory.locator('[data-protocol-sequence]').evaluateAll((frames) =>
      frames.map((frame) => Number(frame.getAttribute('data-protocol-sequence'))));
    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    await expect(protocolHistory).toContainText('tools/call');
    await expect(protocolHistory).toContainText('inspector');

    await screens.getByRole('button', { name: 'Logging' }).click();
    await expect(inspector.getByRole('region', { name: 'Logging inspector' })).toContainText('echo inspector', { timeout: browserTimeout });
    await page.getByRole('tab', { name: 'Playground' }).click();
    await expect(page.getByRole('tab', { name: 'Playground' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#mcp-server-name')).toHaveValue('fixture');
    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await page.getByRole('button', { name: 'Reset MCP session' }).click();
    await page.getByRole('tab', { name: 'Inspector' }).click();
    await expect(page.getByText('Negotiated protocol: Not negotiated')).toBeVisible({ timeout: browserTimeout });
    expect(sessionPosts).toBe(1);
    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});

e2e('mounts the internal Inspector presentation from an explicit development-mode artifact', { timeout: 60_000 }, async ({ page }) => {
  await buildWorkbench('development');
  const project = await createProjectFixture();
  const server = await startDevServer({
    assets: createWorkbenchAssetSource({ root: workbenchAssets }),
    open: false,
    port: 0,
    root: project.root,
  });
  try {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto(`${server.url}#inspector`);
    await expect(page).toHaveURL(/#mcp$/u, { timeout: browserTimeout });
    await expect(page.getByRole('tab', { name: 'Inspector' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible({ timeout: browserTimeout });
    await expect(page.getByText('Negotiated protocol: Not negotiated')).toBeVisible({ timeout: browserTimeout });
    await expect(await readFile(join(workbenchAssets, 'static', 'js', 'lib-react.js'), 'utf8')).toContain('react.development.js');
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
    await removeProjectFixture(project.root);
  }
});
