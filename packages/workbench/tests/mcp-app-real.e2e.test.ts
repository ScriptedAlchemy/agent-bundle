import { execFile as executeFile } from 'node:child_process';
import { access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';

const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 8_000;
const execFile = promisify(executeFile);

const e2e = test.extend({
  playwright: {
    launchOptions: { channel: 'chrome' },
    contextOptions: { viewport: { height: 900, width: 1440 } },
  } satisfies PlaywrightOptions,
});

const buildWorkbench = async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build', '--workspace', 'agent-bundle-workbench'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
};

const appFixtureHtml = [
  '<!doctype html><html><body><main data-testid="app-state">waiting</main>',
  '<script>',
  "const state = Object.create(null);",
  "const post = (message) => parent.postMessage(message, '*');",
  "const render = () => { document.querySelector('[data-testid=app-state]').textContent = JSON.stringify(state); };",
  "const callHost = () => {",
  "  if (state.sentActions) return;",
  "  state.sentActions = true;",
  "  post({ id: 'app-tool', jsonrpc: '2.0', method: 'tools/call', params: { arguments: { message: 'from-real-sandbox' }, name: 'inner-echo' } });",
  "  post({ id: 'resource-read', jsonrpc: '2.0', method: 'resources/read', params: { uri: 'ui://fixture/app.html' } });",
  "  post({ id: 'display-mode', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'inline' } });",
  "  post({ jsonrpc: '2.0', method: 'notifications/message', params: { data: { event: 'real-app-ready' }, level: 'info', logger: 'fixture-app' } });",
  "};",
  "addEventListener('message', (event) => {",
  "  const message = event.data;",
  "  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') return;",
  "  if (message.id === 'fixture-initialize' && message.method === undefined) {",
  "    state.hostContext = message.result.hostContext;",
  "    post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });",
  "  }",
  "  if (message.method === 'ui/notifications/tool-input') state.originalInput = message.params.arguments;",
  "  if (message.method === 'ui/notifications/tool-result') { state.originalResult = message.params; callHost(); }",
  "  if (message.id === 'app-tool' && message.method === undefined) state.toolReply = message.result;",
  "  if (message.id === 'resource-read' && message.method === undefined) state.resourceReply = message.result;",
  "  if (message.id === 'display-mode' && message.method === undefined) state.displayReply = message.result ?? { error: message.error };",
  "  if (message.method === 'ui/resource-teardown' && typeof message.id === 'string') {",
  "    state.teardown = message.id;",
  "    post({ id: message.id, jsonrpc: '2.0', result: { acknowledged: true } });",
  "  }",
  "  render();",
  "});",
  "post({",
  "  id: 'fixture-initialize',",
  "  jsonrpc: '2.0',",
  "  method: 'ui/initialize',",
  "  params: { appCapabilities: { availableDisplayModes: ['inline'] }, appInfo: { name: 'real-app-fixture', version: '1.0.0' }, protocolVersion: '2026-01-26' },",
  "});",
  'render();',
  '</script></body></html>',
].join('');

const writeRealAppProject = async (root: string): Promise<void> => {
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
      "const server = new McpServer({ name: 'real-app-fixture', version: '1.0.0' });",
      `const appHtml = ${JSON.stringify(appFixtureHtml)};`,
      "server.registerResource('app', 'ui://fixture/app.html', { mimeType: 'text/html;profile=mcp-app' }, async (uri) => ({",
      "  contents: [{ mimeType: 'text/html;profile=mcp-app', text: appHtml, uri: uri.href }],",
      '}));',
      "server.registerTool('show-app', { _meta: { ui: { resourceUri: 'ui://fixture/app.html' } } }, async () => ({",
      "  content: [{ text: 'Real App result.', type: 'text' }], structuredContent: { source: 'real-sdk-v2' },",
      '}));',
      "server.registerTool('inner-echo', { inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({",
      "  content: [{ text: `Inner echo: ${message}`, type: 'text' }],",
      '}));',
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
      "  plugin: { name: 'real-app-e2e-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

const writeBundledAppProject = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    mkdir(join(root, 'views'), { recursive: true }),
    symlink(join(workspaceRoot, 'node_modules', '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'views', 'dashboard.ts'), "document.querySelector('#view')!.textContent = 'packed release dashboard';\n"),
    writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><main id="view"></main></body></html>\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import apps from 'agent-bundle/mcp-apps';",
      '',
      "const server = new McpServer({ name: 'bundled-app-fixture', version: '1.0.0' });",
      'for (const app of apps) {',
      '  server.registerResource(app.name, app.resourceUri, { mimeType: app.mimeType }, async (uri) => ({',
      '    contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],',
      '  }));',
      '}',
      'const [app] = apps;',
      "if (app === undefined) throw new Error('Expected one bundled MCP App.');",
      "server.registerTool('show-dashboard', { _meta: { ui: { resourceUri: app.resourceUri } } }, async () => ({",
      "  content: [{ text: 'Packed release dashboard.', type: 'text' }],",
      '}));',
      'await server.connect(new StdioServerTransport());',
      '',
    ].join('\n')),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      "import { defineConfig } from 'agent-bundle';",
      '',
      'export default defineConfig({',
      '  mcp: { servers: { fixture: {',
      "    apps: { dashboard: { entry: './views/dashboard.ts', resourceUri: 'ui://packed-release/dashboard.html', template: './views/shell.html' } },",
      "    entry: './src/server.ts',",
      '  } } },',
      "  plugin: { name: 'bundled-app-e2e-fixture', version: '1.0.0' },",
      "  skills: ['skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

interface AppRouteRequest {
  readonly body: unknown;
  readonly path: string;
}

const requestBody = (body: string | null): unknown => {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

e2e('runs a generated SDK-v2 App through the real foreground session and separate-origin sandbox', { timeout: 90_000 }, async ({ page }) => {
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await buildWorkbench();
    project = await createProjectFixture();
    await writeRealAppProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });
    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected a generated fixture artifact epoch.');
    const foregroundOrigin = server.url;
    const epochRoot = join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id);
    const consoleErrors: string[] = [];
    const pageErrors: Error[] = [];
    const appRequests: AppRouteRequest[] = [];
    let foregroundToken: string | undefined;
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      const token = request.headers()['x-agent-bundle-session'];
      if (token !== undefined) foregroundToken = token;
      if (requestUrl.origin !== foregroundOrigin || !requestUrl.pathname.startsWith('/api/mcp/apps/')) return;
      appRequests.push({ body: requestBody(request.postData()), path: requestUrl.pathname });
    });

    await page.goto(`${foregroundOrigin}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    const opened = page.waitForResponse((response) =>
      response.url() === `${foregroundOrigin}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const openedSession = await (await opened).json() as { readonly session: Readonly<{
      readonly binding: Readonly<{ readonly epochId: string; readonly serverName: string; readonly target: string }>;
      readonly id: string;
    }> };
    expect(openedSession.session.binding).toEqual({ epochId: artifact.activeEpoch.id, serverName: 'fixture', target: 'portable' });
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });

    await page.getByRole('button', { name: 'show-app', exact: true }).click();
    await page.getByRole('button', { name: 'Call show-app' }).click();
    const history = page.getByRole('region', { name: 'Invocation history' });
    const historyEntries = history.locator('ol > li');
    await expect(historyEntries).toHaveCount(1, { timeout: browserTimeout });
    const invocation = JSON.parse(await historyEntries.first().locator('pre > code').textContent() ?? 'null');
    const originalInput = { arguments: {}, name: 'show-app' };
    const originalResult = {
      content: [{ text: 'Real App result.', type: 'text' }],
      structuredContent: { source: 'real-sdk-v2' },
    };
    expect({ request: invocation.request, result: invocation.result }).toEqual({ request: originalInput, result: originalResult });

    const createdPreview = page.waitForRequest((request) =>
      request.url() === `${foregroundOrigin}/api/mcp/sessions/${openedSession.session.id}/apps` && request.method() === 'POST');
    await page.getByRole('button', { name: 'Open App preview for mcp-page-1' }).click();
    const createRequest = requestBody((await createdPreview).postData()) as Readonly<{
      readonly input: unknown;
      readonly previewProfile: unknown;
      readonly result: unknown;
      readonly toolName: unknown;
    }>;
    expect(createRequest).toMatchObject({
      input: originalInput.arguments,
      previewProfile: 'portable',
      result: originalResult,
      toolName: originalInput.name,
    });

    const outerFrame = page.locator('iframe[title="MCP App preview: show-app"]');
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    const outerSource = await outerFrame.getAttribute('src');
    if (outerSource === null) throw new Error('Expected the App preview iframe to have a source.');
    const sandboxOrigin = new URL(outerSource).origin;
    expect(sandboxOrigin).not.toBe(foregroundOrigin);
    await expect(outerFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect(outerFrame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
    const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
    if (appFrame === undefined) throw new Error('Expected the sandbox proxy to create the App srcdoc frame.');
    const appState = appFrame.getByTestId('app-state');
    await expect(appState).toContainText('real-sdk-v2', { timeout: browserTimeout });
    const appSnapshot = JSON.parse(await appState.textContent() ?? 'null') as Readonly<Record<string, unknown>>;
    expect(appSnapshot.hostContext).toMatchObject({ availableDisplayModes: ['inline'], displayMode: 'inline' });
    expect(appSnapshot.originalInput).toEqual(originalInput.arguments);
    expect(appSnapshot.originalResult).toEqual(originalResult);
    expect(appSnapshot.toolReply).toEqual({ content: [{ text: 'Inner echo: from-real-sandbox', type: 'text' }] });
    expect(appSnapshot.resourceReply).toMatchObject({ contents: [{ mimeType: 'text/html;profile=mcp-app', uri: 'ui://fixture/app.html' }] });
    await expect.poll(async () => JSON.parse(await appState.textContent() ?? 'null').displayReply, { timeout: browserTimeout }).toMatchObject({
      error: { code: -32601 },
    });
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'tools/call';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'resources/read';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'notifications/message';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'ui/request-display-mode';
    }), { timeout: browserTimeout }).toBe(true);
    expect(foregroundToken).toBeDefined();
    expect(await appFrame.content()).not.toContain(foregroundToken!);

    await page.setViewportSize({ height: 844, width: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const firstClose = page.waitForRequest((request) => request.url().startsWith(`${foregroundOrigin}/api/mcp/apps/`) && request.url().endsWith('/close'));
    await page.getByRole('button', { name: 'Close App preview' }).click();
    const firstCloseBody = requestBody((await firstClose).postData()) as Readonly<{ readonly id: string }>;
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly id?: string; readonly result?: unknown } } | undefined)?.message;
      return message?.id === firstCloseBody.id && message.result !== undefined;
    }), { timeout: browserTimeout }).toBe(true);
    await expect(outerFrame).toBeHidden({ timeout: browserTimeout });
    await page.getByRole('button', { name: 'List tools' }).click();
    await expect(historyEntries).toHaveCount(2, { timeout: browserTimeout });
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });

    await page.getByRole('button', { name: 'Open App preview for mcp-page-1' }).click();
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    const secondClose = page.waitForRequest((request) => request.url().startsWith(`${foregroundOrigin}/api/mcp/apps/`) && request.url().endsWith('/close'));
    const closedSession = page.waitForRequest((request) =>
      request.url() === `${foregroundOrigin}/api/mcp/sessions/${openedSession.session.id}` && request.method() === 'DELETE');
    await page.getByRole('button', { name: 'Close MCP session' }).click();
    await secondClose;
    await closedSession;
    await expect(page.locator('.mcp-page-phase')).toContainText('Session closed', { timeout: browserTimeout });
    await expect(outerFrame).toBeHidden({ timeout: browserTimeout });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    await server.close();
    server = undefined;
    await expect(fetch(foregroundOrigin)).rejects.toThrow();
    await expect(fetch(sandboxOrigin)).rejects.toThrow();
    const projectRoot = project.root;
    await removeProjectFixture(projectRoot);
    project = undefined;
    await expect(access(epochRoot)).rejects.toThrow();
  } catch (error) {
    testFailure = error;
  } finally {
    const serverCleanup = await Promise.allSettled(server === undefined ? [] : [server.close()]);
    const projectCleanup = await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
    const failedCleanup = [...serverCleanup, ...projectCleanup].find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});

e2e('renders a compiler-bundled App template through the canonical sandbox URL', { timeout: 90_000 }, async ({ page }) => {
  let project: Awaited<ReturnType<typeof createProjectFixture>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];
  const appRequests: Array<{ readonly method: string; readonly path: string }> = [];
  try {
    await buildWorkbench();
    project = await createProjectFixture();
    await writeBundledAppProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      port: 0,
      root: project.root,
    });
    const foregroundOrigin = server.url;
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === foregroundOrigin && url.pathname.startsWith('/api/mcp/apps/')) {
        appRequests.push({ method: request.method(), path: url.pathname });
      }
    });

    await page.goto(`${foregroundOrigin}#mcp`);
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    await expect(page.locator('.mcp-page-phase')).toContainText('Session ready', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'show-dashboard', exact: true }).click();
    await page.getByRole('button', { name: 'Call show-dashboard' }).click();
    await expect(page.getByRole('region', { name: 'Invocation history' }).locator('ol > li')).toHaveCount(1, { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Open App preview for mcp-page-1' }).click();

    const outerFrame = page.locator('iframe[title="MCP App preview: show-dashboard"]');
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    const source = await outerFrame.getAttribute('src');
    if (source === null) throw new Error('Expected the bundled App preview iframe to have a source.');
    expect(new URL(source).origin).not.toBe(foregroundOrigin);
    await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
    const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
    if (appFrame === undefined) throw new Error('Expected the sandbox proxy to create the bundled App srcdoc frame.');
    await expect(appFrame.locator('#view')).toHaveText('packed release dashboard', { timeout: browserTimeout });
    expect(appRequests.some((request) => request.method === 'GET' && /^\/api\/mcp\/apps\/[^/]+$/u.test(request.path))).toBe(false);

    const fallbackClosed = page.waitForResponse((response) => {
      const request = response.request();
      const url = new URL(response.url());
      return request.method() === 'DELETE' && url.origin === foregroundOrigin && /^\/api\/mcp\/apps\/[^/]+$/u.test(url.pathname);
    });
    await page.getByRole('button', { name: 'Close App preview' }).click();
    expect((await fallbackClosed).status()).toBe(200);
    await expect(outerFrame).toBeHidden({ timeout: browserTimeout });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    testFailure = error;
  } finally {
    const serverCleanup = await Promise.allSettled(server === undefined ? [] : [server.close()]);
    const projectCleanup = await Promise.allSettled(project === undefined ? [] : [removeProjectFixture(project.root)]);
    const failedCleanup = [...serverCleanup, ...projectCleanup].find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
