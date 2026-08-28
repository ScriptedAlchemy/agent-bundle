import { execFile as executeFile } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';
import type { Page, WebSocketRoute } from 'playwright';

import { agentBundleNodeModules, workbenchNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';
import { workbenchUrl } from './support/workbench-e2e.ts';

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
  await execFile('pnpm', ['--filter', 'agent-bundle-workbench', 'build'], {
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
  "  post({ id: 'open-link', jsonrpc: '2.0', method: 'ui/open-link', params: { url: 'https://example.test/real-app-link' } });",
  "  post({ id: 'download-file', jsonrpc: '2.0', method: 'ui/download-file', params: { contents: [{ text: 'real-app-download', type: 'text' }] } });",
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
  "  if (message.id === 'open-link' && message.method === undefined) state.linkReply = message.result ?? { error: message.error };",
  "  if (message.id === 'download-file' && message.method === undefined) state.downloadReply = message.result ?? { error: message.error };",
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
    symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
    symlink(join(workbenchNodeModules, 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
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
    symlink(join(agentBundleNodeModules, '@modelcontextprotocol'), join(root, 'node_modules', '@modelcontextprotocol'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'views', 'dashboard.css'), '#view { color: rgb(18, 52, 86); font-weight: 700; }\n'),
    writeFile(join(root, 'views', 'dashboard.ts'), [
      "import './dashboard.css';",
      "document.querySelector('#view')!.textContent = 'packed release dashboard';",
      '',
    ].join('\n')),
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

interface AppRouteResponse extends AppRouteRequest {
  readonly response: unknown;
}

interface RuntimeAppRouteRequest extends AppRouteRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
}

interface RuntimeAppRouteResponse extends RuntimeAppRouteRequest {
  readonly response: unknown;
}

interface RuntimeAppMessage {
  readonly href: string;
  readonly message: unknown;
  readonly senderOrigin: string;
}

type RuntimeAppLifecycleEvent =
  | Readonly<{ readonly kind: 'message'; readonly value: RuntimeAppMessage }>
  | Readonly<{ readonly kind: 'request'; readonly value: RuntimeAppRouteRequest }>;

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
  const browserOpens: string[] = [];
  try {
    await buildWorkbench();
    project = await createProjectFixture();
    await writeRealAppProject(project.root);
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: workbenchAssets }),
      open: false,
      openBrowser: async (url) => { browserOpens.push(url); },
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
    const appResponses: AppRouteResponse[] = [];
    const consentSnapshots: unknown[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== foregroundOrigin || !requestUrl.pathname.startsWith('/api/mcp/apps/')) return;
      appRequests.push({ body: requestBody(request.postData()), path: requestUrl.pathname });
    });
    page.on('response', (response) => {
      const responseUrl = new URL(response.url());
      if (responseUrl.origin !== foregroundOrigin || !responseUrl.pathname.endsWith('/consent')) return;
      void response.json().then((body) => { consentSnapshots.push(body); }).catch(() => undefined);
    });
    page.on('response', (response) => {
      const responseUrl = new URL(response.url());
      if (responseUrl.origin !== foregroundOrigin || !responseUrl.pathname.endsWith('/messages')) return;
      void response.json().then((body) => {
        appResponses.push({ body: requestBody(response.request().postData()), path: responseUrl.pathname, response: body });
      }).catch(() => undefined);
    });

    await page.goto(workbenchUrl(foregroundOrigin, 'mcp'));
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: browserTimeout });
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    const opened = page.waitForResponse((response) =>
      response.url() === `${foregroundOrigin}/api/mcp/sessions` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open MCP session' }).click();
    const openedResponse = await opened;
    const foregroundToken = await openedResponse.request().headerValue('x-agent-bundle-session');
    if (foregroundToken === null) throw new Error('Expected the foreground MCP session request to include its session token.');
    const openedSession = await openedResponse.json() as { readonly session: Readonly<{
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
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'ui/notifications/initialized';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appResponses.find((entry) => {
      const request = (entry.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      const messages = (entry.response as { readonly messages?: readonly { readonly method?: string }[] }).messages;
      return request?.method === 'ui/notifications/initialized' && messages?.some((message) => message.method === 'ui/notifications/tool-result');
    }), { timeout: browserTimeout }).toMatchObject({
      response: { messages: expect.arrayContaining([expect.objectContaining({ method: 'ui/notifications/tool-result' })]) },
    });
    await expect.poll(() => page.frames().find((frame) => frame.url() === 'about:blank')?.getByTestId('app-state').textContent(), {
      timeout: browserTimeout,
    }).toContain('real-sdk-v2');
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'tools/call';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appResponses.find((entry) => {
      const message = (entry.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return message?.method === 'tools/call';
    }), { timeout: browserTimeout }).toMatchObject({ response: { accepted: true, messages: [] } });
    await expect.poll(() => JSON.stringify(consentSnapshots), { timeout: browserTimeout }).toContain('"capability":"call-tool"');
    const consent = page.getByLabel('MCP App consent');
    await expect(consent).toContainText('Tool: inner-echo');
    await expect(consent).toContainText('External link: https://example.test/real-app-link');
    await expect(consent).toContainText('Download 1 file (1: text 17 B).');
    await expect(consent).toContainText('Display mode: inline');
    await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
    const initialAppFrame = page.frames().find((frame) => frame.url() === 'about:blank');
    if (initialAppFrame === undefined) throw new Error('Expected the sandbox proxy to create the App srcdoc frame.');
    const initialAppState = initialAppFrame.getByTestId('app-state');
    await expect(initialAppState).toContainText('real-sdk-v2', { timeout: browserTimeout });
    const consentDecisions = () => consentSnapshots.filter((snapshot) =>
      snapshot !== null && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'approved'));
    const consentDecisionRequests = () => appRequests.filter((request) =>
      request.path.endsWith('/consent') && request.body !== null && typeof request.body === 'object' && Object.hasOwn(request.body, 'approved'));
    const consentDecisionsBeforeCall = consentDecisions().length;
    const consentRequestsBeforeCall = consentDecisionRequests().length;
    const allowCallTool = page.getByRole('button', { name: 'Allow call tool' });
    await expect(allowCallTool).toBeEnabled({ timeout: browserTimeout });
    await allowCallTool.scrollIntoViewIfNeeded();
    await allowCallTool.click();
    await expect.poll(() => consentDecisionRequests().length, { timeout: browserTimeout }).toBe(consentRequestsBeforeCall + 1);
    await expect.poll(() => consentDecisions().length, { timeout: browserTimeout }).toBe(consentDecisionsBeforeCall + 1);
    expect(consentDecisions().at(-1)).toMatchObject({
      approved: true,
      messages: expect.arrayContaining([expect.objectContaining({ id: 'app-tool' })]),
    });
    await expect.poll(async () => JSON.parse(await initialAppState.textContent() ?? 'null').toolReply, { timeout: browserTimeout }).toEqual({
      content: [{ text: 'Inner echo: from-real-sandbox', type: 'text' }],
    });
    const allowOpenLink = page.getByRole('button', { name: 'Allow open external link' });
    await expect(allowOpenLink).toBeEnabled({ timeout: browserTimeout });
    await allowOpenLink.scrollIntoViewIfNeeded();
    await allowOpenLink.click();
    await expect.poll(async () => JSON.parse(await initialAppState.textContent() ?? 'null').linkReply, { timeout: browserTimeout }).toEqual({});
    const allowDownload = page.getByRole('button', { name: 'Allow download file' });
    await expect(allowDownload).toBeEnabled({ timeout: browserTimeout });
    await allowDownload.scrollIntoViewIfNeeded();
    await allowDownload.click();
    await expect.poll(async () => JSON.parse(await initialAppState.textContent() ?? 'null').downloadReply, { timeout: browserTimeout }).toEqual({});
    await expect.poll(async () => JSON.parse(await initialAppState.textContent() ?? 'null').resourceReply, { timeout: browserTimeout }).toMatchObject({
      contents: [{ mimeType: 'text/html;profile=mcp-app', uri: 'ui://fixture/app.html' }],
    });
    const appSnapshot = JSON.parse(await initialAppState.textContent() ?? 'null') as Readonly<Record<string, unknown>>;
    expect(appSnapshot.hostContext).toMatchObject({ availableDisplayModes: ['inline'], displayMode: 'inline' });
    expect(appSnapshot.originalInput).toEqual(originalInput.arguments);
    expect(appSnapshot.originalResult).toEqual(originalResult);
    expect(appSnapshot.toolReply).toEqual({ content: [{ text: 'Inner echo: from-real-sandbox', type: 'text' }] });
    expect(appSnapshot.resourceReply).toMatchObject({ contents: [{ mimeType: 'text/html;profile=mcp-app', uri: 'ui://fixture/app.html' }] });
    const allowDisplayMode = page.getByRole('button', { name: 'Allow request display mode' });
    await expect(allowDisplayMode).toBeEnabled({ timeout: browserTimeout });
    await allowDisplayMode.scrollIntoViewIfNeeded();
    await allowDisplayMode.click();
    await expect.poll(async () => {
      const current = page.frames().find((frame) => frame.url() === 'about:blank');
      return current === undefined ? undefined : JSON.parse(await current.getByTestId('app-state').textContent() ?? 'null').displayReply;
    }, { timeout: browserTimeout }).toEqual({ mode: 'inline' });
    const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
    if (appFrame === undefined) throw new Error('Expected the sandbox proxy to retain the App srcdoc frame.');
    expect(browserOpens).toContain('https://example.test/real-app-link');
    expect(browserOpens.some((url) => url.startsWith('data:application/json;charset=utf-8,'))).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'tools/call';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'ui/open-link';
    }), { timeout: browserTimeout }).toBe(true);
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path.endsWith('/messages') && message?.method === 'ui/download-file';
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
    expect(await appFrame.content()).not.toContain(foregroundToken);

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

e2e('opens the real RSC runtime timeline App from provider-owned run evidence', { timeout: 120_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture({
    prepare: async ({ root }) => {
      const definitionSource = join(root, 'src', 'definition.ts');
      const source = await readFile(definitionSource, 'utf8');
      const updated = source.replace(
        "        'ui.prefersBorder': true,",
        "        'ui.prefersBorder': true,\n        ui: { permissions: { camera: {}, clipboardWrite: {} } },",
      );
      if (updated === source) throw new Error('Runtime App fixture did not find the timeline resource metadata.');
      await writeFile(definitionSource, updated);
    },
  });
  let clientPage: Page | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  const clientSurfaceConsole: string[] = [];
  const clientSurfaceResponses: Array<Readonly<{ readonly status: number; readonly url: string }>> = [];
  const clientSurfaceHmrRequests: Array<Readonly<{ readonly headers: Readonly<Record<string, string>>; readonly url: string }>> = [];
  const clientSurfaceSockets: string[] = [];
  const runtimePreviewBootstraps: Array<Readonly<{ readonly status: number; readonly url: string }>> = [];
  const runtimePreviewSockets: string[] = [];
  const runtimePreviewHmrRoutes: WebSocketRoute[] = [];
  const appMessages: RuntimeAppMessage[] = [];
  const browserConsole: string[] = [];
  const pageErrors: Error[] = [];
  const artifactMcpSessionRequests: string[] = [];
  const projectEventStreams: string[] = [];
  const runtimeAppLifecycleEvents: RuntimeAppLifecycleEvent[] = [];
  const runtimeAppRequests: RuntimeAppRouteRequest[] = [];
  const runtimeAppResponses: RuntimeAppRouteResponse[] = [];
  const runtimeMcpSessionRequests: string[] = [];
  const opaqueSandboxRequestFailures: string[] = [];
  const opaqueSandboxRouteHits: string[] = [];
  const opaqueSandboxProbeOrigin = 'https://runtime-app-sandbox-probe.invalid';
  await page.exposeBinding('__recordRuntimeAppMessage', (_source, payload: unknown) => {
    if (payload !== null && typeof payload === 'object') {
      const event = payload as RuntimeAppMessage;
      appMessages.push(event);
      runtimeAppLifecycleEvents.push(Object.freeze({ kind: 'message' as const, value: event }));
    }
  });
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object' || (message as { readonly jsonrpc?: unknown }).jsonrpc !== '2.0') return;
      const record = (globalThis as typeof globalThis & { __recordRuntimeAppMessage?: (payload: unknown) => Promise<void> }).__recordRuntimeAppMessage;
      if (record !== undefined) void record({ href: window.location.href, message, senderOrigin: event.origin });
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => { browserConsole.push(`${message.type()}:${message.text()}`); });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).origin === opaqueSandboxProbeOrigin) {
      opaqueSandboxRequestFailures.push(`${request.url()}:${request.failure()?.errorText ?? 'unknown'}`);
    }
  });
  await page.route(`${opaqueSandboxProbeOrigin}/**`, async (route) => {
    opaqueSandboxRouteHits.push(route.request().url());
    await route.abort();
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/rsbuild-hmr') runtimePreviewSockets.push(socket.url());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== fixture.url) return;
    if (url.pathname.startsWith('/api/mcp/sessions')) artifactMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/project/events') projectEventStreams.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/api/runtime/apps')) {
      const event: RuntimeAppRouteRequest = Object.freeze({ body: requestBody(request.postData()), headers: request.headers(), method: request.method(), path: url.pathname });
      runtimeAppRequests.push(event);
      runtimeAppLifecycleEvents.push(Object.freeze({ kind: 'request' as const, value: event }));
    }
    if (url.pathname.startsWith('/api/runtime/mcp/sessions')) runtimeMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/__agent_bundle_runtime/bootstrap/')) {
      runtimePreviewBootstraps.push(Object.freeze({ status: response.status(), url: response.url() }));
    }
    if (url.origin !== fixture.url || !url.pathname.startsWith('/api/runtime/apps')) return;
    void response.json().then((body) => {
      const request = response.request();
      runtimeAppResponses.push({ body: requestBody(request.postData()), headers: request.headers(), method: request.method(), path: url.pathname, response: body });
    }).catch(() => undefined);
  });
  try {
    await page.goto(workbenchUrl(fixture.url, 'runtime'));
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: 15_000 });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    const runtimeSurface = page.getByLabel('Runtime surface');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: 15_000 });
    await runtimeSurface.selectOption('mcp.edit-timeline');
    clientSurface = await fixture.openRuntimeClientSurface('mcp.edit-timeline');
    if (clientSurface === undefined) throw new Error('Runtime client surface was not available.');
    clientPage = await page.context().newPage();
    clientPage.on('pageerror', (error) => pageErrors.push(error));
    clientPage.on('console', (message) => { clientSurfaceConsole.push(`${message.type()}:${message.text()}`); });
    clientPage.on('request', (request) => {
      if (new URL(request.url()).pathname !== '/rsbuild-hmr') return;
      clientSurfaceHmrRequests.push(Object.freeze({ headers: request.headers(), url: request.url() }));
    });
    clientPage.on('response', (response) => {
      if (clientSurface !== undefined && new URL(response.url()).origin === clientSurface.origin) {
        clientSurfaceResponses.push(Object.freeze({ status: response.status(), url: response.url() }));
      }
    });
    clientPage.on('websocket', (socket) => { clientSurfaceSockets.push(socket.url()); });
    const bootstrap = await clientPage.goto(clientSurface.bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(bootstrap?.status()).toBe(200);
    try {
      await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 3_000 }).toBe('1');
    } catch {
      throw new Error(`Runtime App HMR proxy did not connect: ${JSON.stringify({
        console: clientSurfaceConsole,
        frames: clientPage.frames().map((frame) => frame.url()),
        requests: clientSurfaceHmrRequests,
        responses: clientSurfaceResponses,
        sockets: clientSurfaceSockets,
      })}`);
    }
    expect(clientSurfaceSockets).toEqual([`${clientSurface.origin.replace('http:', 'ws:')}/rsbuild-hmr`]);
    expect(clientSurfaceSockets.every((socket) => new URL(socket).search.length === 0)).toBe(true);
    expect(clientSurfaceHmrRequests.every((request) => new URL(request.url).search.length === 0)).toBe(true);
    await clientPage.close();
    clientPage = undefined;
    await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 3_000 }).toBe('0');
    await page.routeWebSocket((url) => url.pathname === '/rsbuild-hmr', (route) => {
      runtimePreviewHmrRoutes.push(route);
      route.connectToServer();
    });

    await runtimeSurface.selectOption('mcp.render_edit_timeline');
    await page.getByLabel('Runtime target').selectOption('portable');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#runtime-input-raw').fill('{}');
    const createRequest = page.waitForRequest((request) =>
      request.url() === `${fixture.url}/api/runtime/apps` && request.method() === 'POST');
    const createResponse = page.waitForResponse((response) =>
      response.url() === `${fixture.url}/api/runtime/apps` && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const [createdRequest, createdResponse] = await Promise.all([createRequest, createResponse]);
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await expect(history).toHaveCount(1, { timeout: 15_000 });
    const runId = await history.first().getAttribute('data-runtime-run-id');
    const expectedGenerationId = await runtimeIdentity.getAttribute('data-runtime-generation');
    if (runId === null || expectedGenerationId === null) throw new Error('Expected selected Runtime run identity.');
    expect(requestBody(createdRequest.postData())).toEqual({ expectedGenerationId, profileId: 'portable', runId });

    const created = await createdResponse.json() as Readonly<{ readonly preview: Readonly<{
      readonly binding: Readonly<{
        readonly id: string;
        readonly registryRevision: number;
        readonly runVector: Readonly<{ readonly runtimeGenerationId: string; readonly sourceRevision: string; readonly stateVersion: number }>;
        readonly serverName: string;
        readonly sessionId: string;
        readonly sessionRevision: number;
      }>;
      readonly clientSurface: Readonly<{ readonly bootstrapUrl: string; readonly origin: string }>;
      readonly documentPolicy: Readonly<{ readonly approvedPermissions: unknown; readonly revision: number }>;
      readonly kind: string;
      readonly profile: Readonly<{ readonly hostContext: unknown; readonly resourceUri: string }>;
      readonly resource: Readonly<{ readonly permissions: unknown }>;
      readonly result: Readonly<{ readonly appVisible: unknown; readonly modelVisible: unknown }>;
    }> }>;
    expect(created.preview).toMatchObject({
      binding: { serverName: 'timeline', sessionId: expect.any(String), sessionRevision: expect.any(Number) },
      clientSurface: { bootstrapUrl: expect.any(String), origin: expect.any(String) },
      documentPolicy: { approvedPermissions: {}, revision: 1 },
      kind: 'apps',
      profile: { hostContext: { platform: 'web' }, resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
      resource: { permissions: { camera: {}, clipboardWrite: {} } },
    });
    expect(created.preview.result.appVisible).toMatchObject({
      content: [expect.objectContaining({ type: 'text' })],
      structuredContent: { edits: [], stateVersion: 0 },
    });

    const outerFrame = page.locator('.runtime-stage .mcp-app-preview iframe');
    await expect(outerFrame).toBeVisible({ timeout: 15_000 });
    await expect(outerFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect(outerFrame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 15_000 }).toBe('1');
    expect(runtimePreviewSockets).toEqual([`${created.preview.clientSurface.origin.replace('http:', 'ws:')}/rsbuild-hmr`]);
    const runtimeAppFrame = async () => {
      for (const frame of page.frames()) {
        if (await frame.getByRole('heading', { name: 'Runtime edit timeline' }).count() === 1) return frame;
      }
      return undefined;
    };
    await expect.poll(runtimeAppFrame, { timeout: 15_000 }).toBeDefined();
    let appFrame = await runtimeAppFrame();
    if (appFrame === undefined) throw new Error('Runtime App frame was unavailable.');
    let controllerFrame = appFrame.parentFrame();
    if (controllerFrame === null) throw new Error('Runtime App trusted controller frame was unavailable.');
    const controllerShape = await controllerFrame.evaluate(() => {
      const nested = [...document.querySelectorAll('iframe')];
      return Object.freeze({ nestedCount: nested.length, nestedSandbox: nested[0]?.getAttribute('sandbox') ?? undefined });
    });
    const isolation = await appFrame.evaluate(() => {
      const parentDom = (() => {
        try {
          void window.parent.document.documentElement;
          return 'available';
        } catch {
          return 'blocked';
        }
      })();
      const storage = (() => {
        try {
          void window.localStorage.length;
          return 'available';
        } catch {
          return 'blocked';
        }
      })();
      return Object.freeze({ origin: window.origin, parentDom, storage });
    });
    expect({ ...controllerShape, ...isolation }).toEqual({
      nestedCount: 1,
      nestedSandbox: 'allow-scripts',
      origin: 'null',
      parentDom: 'blocked',
      storage: 'blocked',
    });
    const topUrlBeforeOpaqueSandboxProbes = page.url();
    const opaqueSandboxProbes = await appFrame.evaluate(async (probeOrigin) => {
      const blocked = async (operation: () => unknown | Promise<unknown>): Promise<'blocked' | 'available'> => {
        try {
          await operation();
          return 'available';
        } catch {
          return 'blocked';
        }
      };
      const observeElement = async (tagName: 'iframe' | 'img', path: string): Promise<void> => new Promise((resolvePromise) => {
        const element = document.createElement(tagName);
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          element.remove();
          resolvePromise();
        };
        element.addEventListener('error', settle, { once: true });
        element.addEventListener('load', settle, { once: true });
        const timeout = setTimeout(settle, 500);
        if (tagName === 'iframe') (element as HTMLIFrameElement).src = `${probeOrigin}${path}`;
        else (element as HTMLImageElement).src = `${probeOrigin}${path}`;
        document.body.append(element);
      });
      const form = document.createElement('form');
      form.action = `${probeOrigin}/form`;
      form.method = 'get';
      form.target = '_top';
      document.body.append(form);
      const formTopNavigation = (() => {
        try {
          form.submit();
          return 'blocked' as const;
        } catch {
          return 'blocked' as const;
        } finally {
          setTimeout(() => form.remove(), 0);
        }
      })();
      const cookie = (() => {
        try {
          document.cookie = 'runtime-app-sandbox-probe=1';
          return document.cookie.length === 0 ? 'blocked' : 'available';
        } catch {
          return 'blocked';
        }
      })();
      const sessionStorage = (() => {
        try {
          window.sessionStorage.setItem('runtime-app-sandbox-probe', '1');
          window.sessionStorage.removeItem('runtime-app-sandbox-probe');
          return 'available';
        } catch {
          return 'blocked';
        }
      })();
      const indexedDb = await new Promise<'blocked' | 'available'>((resolvePromise) => {
        try {
          const request = indexedDB.open('runtime-app-sandbox-probe');
          request.onerror = () => resolvePromise('blocked');
          request.onsuccess = () => {
            request.result.close();
            indexedDB.deleteDatabase('runtime-app-sandbox-probe');
            resolvePromise('available');
          };
        } catch {
          resolvePromise('blocked');
        }
      });
      const topNavigation = (() => {
        try {
          window.top?.location.assign(`${probeOrigin}/top-navigation`);
          return 'available';
        } catch {
          return 'blocked';
        }
      })();
      const popup = (() => {
        try {
          const opened = window.open(`${probeOrigin}/popup`);
          opened?.close();
          return opened === null ? 'blocked' : 'available';
        } catch {
          return 'blocked';
        }
      })();
      const clipboard = navigator.clipboard === undefined
        ? 'blocked'
        : await blocked(() => navigator.clipboard.writeText('runtime-app-sandbox-probe'));
      const media = navigator.mediaDevices === undefined
        ? 'blocked'
        : await blocked(() => navigator.mediaDevices.getUserMedia({ video: true }));
      const [fetch] = await Promise.all([
        blocked(() => globalThis.fetch(`${probeOrigin}/fetch`)),
        observeElement('iframe', '/frame'),
        observeElement('img', '/image'),
      ]);
      return Object.freeze({ clipboard, cookie, fetch, formTopNavigation, indexedDb, media, popup, sessionStorage, topNavigation });
    }, opaqueSandboxProbeOrigin);
    expect(opaqueSandboxRouteHits).toEqual([]);
    expect(
      opaqueSandboxRequestFailures.some((failure) => failure.includes(opaqueSandboxProbeOrigin)) ||
      browserConsole.some((entry) => entry.includes(opaqueSandboxProbeOrigin) && /content security policy|refused to load/iu.test(entry)),
    ).toBe(true);
    expect(opaqueSandboxProbes).toEqual({
      clipboard: 'blocked',
      cookie: 'blocked',
      fetch: 'blocked',
      formTopNavigation: 'blocked',
      indexedDb: 'blocked',
      media: 'blocked',
      popup: 'blocked',
      sessionStorage: 'blocked',
      topNavigation: 'blocked',
    });
    expect(page.url()).toBe(topUrlBeforeOpaqueSandboxProbes);
    const frameOrigin = new URL(appFrame.url()).origin;
    const controllerOrigin = created.preview.clientSurface.origin;
    const outerSource = await outerFrame.getAttribute('src');
    const foregroundToken = createdRequest.headers()['x-agent-bundle-session'];
    if (outerSource === null || foregroundToken === undefined) throw new Error('Runtime App foreground transport evidence was unavailable.');
    expect(frameOrigin).toBe('null');
    expect(controllerOrigin).not.toBe(fixture.url);
    expect(new URL(created.preview.clientSurface.bootstrapUrl).origin).toBe(controllerOrigin);
    expect(outerSource).not.toContain(foregroundToken);
    expect(await appFrame.content()).not.toContain(foregroundToken);
    const assertOpaqueChild = async (): Promise<void> => {
      const currentFrame = appFrame;
      if (currentFrame === undefined) throw new Error('Runtime App frame was unavailable.');
      const currentController = currentFrame.parentFrame();
      if (currentController === null) throw new Error('Runtime App trusted controller was unavailable.');
      await expect.poll(async () => currentController.evaluate(() => {
        const nested = [...document.querySelectorAll('iframe')];
        return Object.freeze({ nestedCount: nested.length, nestedSandbox: nested[0]?.getAttribute('sandbox') ?? undefined });
      }), { timeout: 15_000 }).toEqual({ nestedCount: 1, nestedSandbox: 'allow-scripts' });
      expect(await currentFrame.evaluate(() => Object.freeze({
        origin: window.origin,
        parentDom: (() => {
          try {
            void window.parent.document.documentElement;
            return 'available';
          } catch {
            return 'blocked';
          }
        })(),
        storage: (() => {
          try {
            void window.localStorage.length;
            return 'available';
          } catch {
            return 'blocked';
          }
        })(),
      }))).toEqual({ origin: 'null', parentDom: 'blocked', storage: 'blocked' });
      expect(await currentFrame.content()).not.toContain(foregroundToken);
    };

    const messageFor = (
      receiverOrigin: string,
      senderOrigin: string,
      matches: (message: Readonly<Record<string, unknown>>) => boolean,
    ): Readonly<{ readonly href: string; readonly message: Readonly<Record<string, unknown>>; readonly senderOrigin: string }> | undefined => {
      const entry = appMessages.find((candidate) => {
        if (new URL(candidate.href).origin !== receiverOrigin || candidate.senderOrigin !== senderOrigin || candidate.message === null || typeof candidate.message !== 'object') {
          return false;
        }
        return matches(candidate.message as Readonly<Record<string, unknown>>);
      });
      return entry === undefined ? undefined : entry as Readonly<{ readonly href: string; readonly message: Readonly<Record<string, unknown>>; readonly senderOrigin: string }>;
    };
    const protocolOrder = (): readonly string[] | undefined => {
      const ordered = [
        ['ui/initialize request', messageFor(fixture.url, controllerOrigin, (message) => message.method === 'ui/initialize')],
        ['ui/initialize result', messageFor(controllerOrigin, fixture.url, (message) => {
          const result = message.result;
          return result !== null && typeof result === 'object' && Object.hasOwn(result, 'hostContext');
        })],
        ['ui/notifications/initialized', messageFor(fixture.url, controllerOrigin, (message) => message.method === 'ui/notifications/initialized')],
        ['ui/notifications/tool-input', messageFor(controllerOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-input')],
        ['ui/notifications/tool-result', messageFor(controllerOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-result')],
      ] as const;
      if (ordered.some(([, entry]) => entry === undefined)) return undefined;
      return ordered
        .map(([name, entry]) => Object.freeze({ index: appMessages.indexOf(entry as typeof appMessages[number]), name }))
        .sort((left, right) => left.index - right.index)
        .map(({ name }) => name);
    };
    await expect.poll(protocolOrder, { timeout: 15_000 }).toEqual([
      'ui/initialize request',
      'ui/initialize result',
      'ui/notifications/initialized',
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ]);
    const toolInput = messageFor(controllerOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-input');
    const toolResult = messageFor(controllerOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-result');
    if (toolInput === undefined || toolResult === undefined) throw new Error('Runtime App invocation notifications were unavailable.');
    expect(toolInput.message).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } });
    expect(toolResult.message).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: created.preview.result.appVisible });
    const initialized = messageFor(controllerOrigin, fixture.url, (message) => {
      const result = message.result;
      return result !== null && typeof result === 'object' && Object.hasOwn(result, 'hostContext');
    });
    expect((initialized?.message.result as Readonly<{ readonly hostContext?: unknown }> | undefined)?.hostContext)
      .toMatchObject(created.preview.profile.hostContext as Record<string, unknown>);
    expect((initialized?.message.result as Readonly<{ readonly hostCapabilities?: unknown }> | undefined)?.hostCapabilities)
      .toMatchObject({ serverResources: {}, serverTools: {} });

    const initializeRequests = () => appMessages.filter((entry) =>
      new URL(entry.href).origin === fixture.url && entry.senderOrigin === controllerOrigin && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/initialize');
    const initializeResults = () => appMessages.filter((entry) => {
      if (new URL(entry.href).origin !== controllerOrigin || entry.senderOrigin !== fixture.url || entry.message === null || typeof entry.message !== 'object') return false;
      const message = entry.message as Readonly<Record<string, unknown>>;
      return message.result !== null && typeof message.result === 'object' && Object.hasOwn(message.result, 'hostContext');
    });
    expect(runtimePreviewHmrRoutes).toHaveLength(1);
    const initialInitializeCount = initializeRequests().length;
    await runtimePreviewHmrRoutes[0]!.close();
    await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 15_000 }).toBe('0');
    await expect.poll(() => runtimePreviewHmrRoutes.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 15_000 }).toBe('1');
    runtimePreviewHmrRoutes[1]!.send(JSON.stringify({ type: 'full-reload' }));
    await expect.poll(() => initializeRequests().length, { timeout: 15_000 }).toBe(initialInitializeCount + 1);
    await expect(outerFrame).toHaveCount(1);
    await expect.poll(() => runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps').length, { timeout: 15_000 }).toBe(1);
    await expect.poll(runtimeAppFrame, { timeout: 15_000 }).toBeDefined();
    appFrame = await runtimeAppFrame();
    if (appFrame === undefined) throw new Error('Runtime App frame did not reinitialize after HMR recovery.');

    const consentPath = `/api/runtime/apps/${encodeURIComponent(created.preview.binding.id)}/consents`;
    const consentRequests = (scope: 'action' | 'document'): readonly RuntimeAppRouteRequest[] => runtimeAppRequests.filter((entry) =>
      entry.method === 'POST' && entry.path === consentPath && entry.body !== null && typeof entry.body === 'object' &&
      (entry.body as Readonly<{ readonly scope?: unknown }>).scope === scope);
    const consentResponses = (scope: 'action' | 'document'): readonly RuntimeAppRouteResponse[] => runtimeAppResponses.filter((entry) =>
      entry.method === 'POST' && entry.path === consentPath && entry.body !== null && typeof entry.body === 'object' &&
      (entry.body as Readonly<{ readonly scope?: unknown }>).scope === scope);
    const documentPermissionControl = page.getByLabel('Runtime App document permissions');
    await expect(documentPermissionControl).toContainText('Declared document permissions are unavailable in this isolated Runtime App surface.');
    await expect(documentPermissionControl).toContainText('Camera unavailable');
    await expect(documentPermissionControl).toContainText('Clipboard write unavailable');
    await expect(documentPermissionControl.getByRole('button')).toHaveCount(0);
    expect(consentRequests('action')).toHaveLength(0);
    expect(consentRequests('document')).toHaveLength(0);
    expect(runtimeAppRequests.filter((entry) => entry.method === 'GET' && entry.path === `/api/runtime/apps/${encodeURIComponent(created.preview.binding.id)}`)).toHaveLength(0);
    expect(runtimePreviewBootstraps).toHaveLength(1);
    expect(runtimeAppRequests.filter((entry) => entry.method === 'DELETE')).toHaveLength(0);
    await expect(outerFrame).toHaveCount(1);
    await expect(outerFrame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    await expect(outerFrame).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(outerFrame).toHaveAttribute('allow', '');
    expect((initializeResults().at(-1)?.message as Readonly<{ readonly result?: unknown }> | undefined)?.result).toMatchObject({
      hostCapabilities: { sandbox: { permissions: {} } },
    });
    controllerFrame = appFrame.parentFrame();
    if (controllerFrame === null) throw new Error('Runtime App trusted controller was unavailable after HMR recovery.');
    await assertOpaqueChild();

    await appFrame.getByRole('button', { name: 'Refresh' }).click();
    try {
      await expect.poll(() => consentRequests('action'), { timeout: 3_000 }).toHaveLength(1);
    } catch {
      throw new Error(`Runtime App call relay did not reach consent: ${JSON.stringify({
        console: browserConsole,
        standalone: await appFrame.evaluate(() => window.parent === window),
        status: await appFrame.getByRole('status').textContent(),
      })}`);
    }
    const consentCreate = consentRequests('action')[0];
    expect(consentCreate?.body).toEqual({
      actionFingerprint: 'runtime-app:call-tool:v1',
      capability: 'call-tool',
      details: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
      scope: 'action',
      summary: 'Call MCP App tool',
    });
    await expect(page.getByRole('dialog', { name: 'Runtime App consent' })).toBeVisible({ timeout: 15_000 });
    const runtimeConsentDialog = page.getByRole('dialog', { name: 'Runtime App consent' });
    const denyRuntimeConsent = runtimeConsentDialog.getByRole('button', { name: 'Deny' });
    const allowRuntimeConsent = runtimeConsentDialog.getByRole('button', { name: 'Allow once' });
    await expect(runtimeConsentDialog).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('.workbench-shell')).toHaveAttribute('inert', '');
    await expect(denyRuntimeConsent).toBeFocused({ timeout: 15_000 });
    await page.keyboard.press('Tab');
    await expect(allowRuntimeConsent).toBeFocused({ timeout: 15_000 });
    await page.keyboard.press('Tab');
    await expect(denyRuntimeConsent).toBeFocused({ timeout: 15_000 });
    await page.keyboard.press('Shift+Tab');
    await expect(allowRuntimeConsent).toBeFocused({ timeout: 15_000 });
    await expect.poll(() => consentResponses('action')).toHaveLength(1);
    const consentCreated = consentResponses('action')[0];
    const challenge = (consentCreated?.response as Readonly<{ readonly challenge?: Readonly<{ readonly id?: unknown }> }> | undefined)?.challenge;
    if (typeof challenge?.id !== 'string') throw new Error('Runtime App consent create response omitted its challenge id.');
    expect(consentCreated?.response).toMatchObject({
      challenge: {
        expiresAt: expect.any(Number),
        id: challenge.id,
        request: {
          actionFingerprint: expect.stringMatching(/^act-[A-Za-z0-9_-]{12}$/u),
          capability: 'call-tool',
          details: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
          scope: 'action',
          summary: 'Allow MCP App call tool?',
        },
      },
      documentPolicy: expect.any(Object),
    });

    await allowRuntimeConsent.click();
    const decisionPath = `${consentPath}/${encodeURIComponent(challenge.id)}`;
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === decisionPath), { timeout: 15_000 }).toHaveLength(1);
    const consentDecision = runtimeAppRequests.find((entry) => entry.method === 'POST' && entry.path === decisionPath);
    expect(consentDecision?.body).toEqual({ decision: 'allow-once' });
    await expect.poll(() => runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === decisionPath), { timeout: 15_000 }).toBeDefined();
    const consentDecided = runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === decisionPath);
    const grant = (consentDecided?.response as Readonly<{ readonly grant?: Readonly<{ readonly authorizationId?: unknown }> }> | undefined)?.grant;
    if (typeof grant?.authorizationId !== 'string') throw new Error('Runtime App consent decision response omitted its authorization identity.');
    expect(consentDecided?.response).toMatchObject({
      documentPolicy: expect.any(Object),
      grant: {
        authorizationId: grant.authorizationId,
        bindingId: created.preview.binding.id,
        capability: 'call-tool',
        challengeId: challenge.id,
        scope: 'action',
      },
    });

    const operationPath = `/api/runtime/apps/${encodeURIComponent(created.preview.binding.id)}/operations`;
    const operationRequests = (kind: string): readonly RuntimeAppRouteRequest[] => runtimeAppRequests.filter((entry) =>
      entry.method === 'POST' && entry.path === operationPath && entry.body !== null && typeof entry.body === 'object' &&
      (entry.body as Readonly<{ readonly kind?: unknown }>).kind === kind);
    const operationResponses = (kind: string): readonly RuntimeAppRouteResponse[] => runtimeAppResponses.filter((entry) =>
      entry.method === 'POST' && entry.path === operationPath && entry.body !== null && typeof entry.body === 'object' &&
      (entry.body as Readonly<{ readonly kind?: unknown }>).kind === kind);
    await expect.poll(() => operationRequests('tools/call'), { timeout: 15_000 }).toHaveLength(1);
    const operation = operationRequests('tools/call')[0];
    expect(operation?.body).toEqual({
      arguments: { limit: 10 },
      consentId: grant.authorizationId,
      kind: 'tools/call',
      name: 'render_edit_timeline',
    });
    await expect.poll(() => operationResponses('tools/call')).toHaveLength(1);
    const operated = operationResponses('tools/call')[0];
    const operationResult = (operated?.response as Readonly<{ readonly result?: unknown }> | undefined)?.result;
    expect(operationResult).toEqual({
      operationId: expect.any(String),
      sessionId: created.preview.binding.sessionId,
      sessionRevision: created.preview.binding.sessionRevision,
      value: {
        content: [{ text: 'Showing 0 recorded edits.', type: 'text' }],
        structuredContent: { edits: [], stateVersion: 0 },
      },
      vector: created.preview.binding.runVector,
    });
    const implementationEvidence = page.getByLabel('Executed by current implementation');
    await expect(implementationEvidence).toBeVisible({ timeout: 15_000 });
    const operationId = (operationResult as Readonly<{ readonly operationId?: unknown }>).operationId;
    if (typeof operationId !== 'string') throw new Error('Runtime App operation result omitted its public operation identity.');
    expect(await implementationEvidence.locator('dd').allTextContents()).toEqual([
      operationId,
      'tools/call',
      'render_edit_timeline',
      created.preview.binding.sessionId,
      String(created.preview.binding.sessionRevision),
      String(created.preview.binding.registryRevision),
      created.preview.binding.runVector.runtimeGenerationId,
      created.preview.binding.runVector.sourceRevision,
      String(created.preview.binding.runVector.stateVersion),
    ]);
    expect((operationResult as Readonly<{ readonly vector: unknown }>).vector).toEqual(created.preview.binding.runVector);
    const refreshRequest = messageFor(fixture.url, controllerOrigin, (message) => message.method === 'tools/call');
    expect(refreshRequest?.message).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { _meta: { progressToken: 1 }, arguments: { limit: 10 }, name: 'render_edit_timeline' },
    });
    await expect.poll(() => messageFor(controllerOrigin, fixture.url, (message) => message.id === 1 && Object.hasOwn(message, 'result')), { timeout: 15_000 }).toBeDefined();
    const refreshResult = messageFor(controllerOrigin, fixture.url, (message) => message.id === 1 && Object.hasOwn(message, 'result'));
    expect(refreshResult?.message).toEqual({ jsonrpc: '2.0', id: 1, result: (operationResult as Readonly<{ readonly value: unknown }>).value });
    await expect(appFrame.getByText('State version 0')).toBeVisible();
    await expect(appFrame.getByRole('status')).toHaveText('');

    // A second real widget request must receive a distinct, server-created
    // challenge.  Denial must stay on the App protocol lane: it cannot reach
    // the binding operation endpoint or update the widget's model state.
    const toolCallRequests = (): readonly RuntimeAppMessage[] => appMessages.filter((entry) =>
      new URL(entry.href).origin === fixture.url && entry.senderOrigin === controllerOrigin && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'tools/call');
    await appFrame.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => consentRequests('action'), { timeout: 15_000 }).toHaveLength(2);
    const deniedConsentCreate = consentRequests('action')[1];
    expect(deniedConsentCreate?.body).toEqual({
      actionFingerprint: 'runtime-app:call-tool:v1',
      capability: 'call-tool',
      details: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
      scope: 'action',
      summary: 'Call MCP App tool',
    });
    await expect.poll(() => consentResponses('action')).toHaveLength(2);
    const deniedConsentCreated = consentResponses('action')[1];
    const deniedChallenge = (deniedConsentCreated?.response as Readonly<{ readonly challenge?: Readonly<{ readonly id?: unknown }> }> | undefined)?.challenge;
    if (typeof deniedChallenge?.id !== 'string') throw new Error('Denied Runtime App consent create response omitted its challenge id.');
    expect(deniedChallenge.id).not.toBe(challenge.id);
    expect(deniedConsentCreated?.response).toMatchObject({
      challenge: {
        id: deniedChallenge.id,
        request: {
          actionFingerprint: expect.stringMatching(/^act-[A-Za-z0-9_-]{12}$/u),
          capability: 'call-tool',
          details: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
          scope: 'action',
        },
      },
    });
    await expect(page.getByRole('dialog', { name: 'Runtime App consent' })).toBeVisible({ timeout: 15_000 });
    await expect(denyRuntimeConsent).toBeFocused({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    const deniedDecisionPath = `${consentPath}/${encodeURIComponent(deniedChallenge.id)}`;
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === deniedDecisionPath), { timeout: 15_000 }).toHaveLength(1);
    expect(runtimeAppRequests.find((entry) => entry.method === 'POST' && entry.path === deniedDecisionPath)?.body).toEqual({ decision: 'deny' });
    await expect.poll(() => runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === deniedDecisionPath), { timeout: 15_000 }).toHaveLength(1);
    const deniedDecision = runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === deniedDecisionPath)?.response;
    expect(deniedDecision).toMatchObject({ documentPolicy: expect.any(Object) });
    expect(deniedDecision).not.toHaveProperty('grant');
    await expect(runtimeConsentDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('.workbench-shell')).not.toHaveAttribute('inert', '');
    await expect(outerFrame).toBeFocused({ timeout: 15_000 });
    await expect.poll(toolCallRequests, { timeout: 15_000 }).toHaveLength(2);
    const deniedToolCall = toolCallRequests()[1];
    const deniedToolCallId = deniedToolCall?.message !== null && typeof deniedToolCall?.message === 'object'
      ? (deniedToolCall.message as Readonly<Record<string, unknown>>).id
      : undefined;
    if (typeof deniedToolCallId !== 'string' && typeof deniedToolCallId !== 'number') throw new Error('Denied Runtime App tool request omitted its JSON-RPC id.');
    await expect.poll(() => messageFor(controllerOrigin, fixture.url, (message) => message.id === deniedToolCallId && Object.hasOwn(message, 'error')), { timeout: 15_000 }).toBeDefined();
    expect(messageFor(controllerOrigin, fixture.url, (message) => message.id === deniedToolCallId && Object.hasOwn(message, 'error'))?.message).toMatchObject({
      error: { code: expect.any(Number), message: expect.any(String) },
      id: deniedToolCallId,
      jsonrpc: '2.0',
    });
    await expect(appFrame.getByRole('status')).toHaveText('Unable to refresh timeline.');
    await expect(appFrame.getByText('State version 0')).toBeVisible();
    expect(operationRequests('tools/call')).toHaveLength(1);
    expect(operationResponses('tools/call')).toHaveLength(1);

    // The first grant was consumed by the successful widget call.  Replaying
    // its captured canonical operation through the authenticated foreground
    // must be rejected before another provider operation or vector result.
    const replayBody = operation?.body;
    if (replayBody === undefined) throw new Error('Successful Runtime App operation did not retain its canonical request body.');
    const replay = await page.evaluate(async ({ body, path, sessionToken }) => {
      const response = await fetch(path, {
        body: JSON.stringify(body),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-agent-bundle-session': sessionToken },
        method: 'POST',
      });
      return Object.freeze({ body: await response.json(), status: response.status });
    }, { body: replayBody, path: operationPath, sessionToken: foregroundToken });
    expect(replay).toEqual({
      body: { diagnostic: { code: 'AB8023', message: 'MCP App operation could not be completed.' } },
      status: 502,
    });
    await expect.poll(() => operationRequests('tools/call')).toHaveLength(2);
    await expect.poll(() => operationResponses('tools/call')).toHaveLength(2);
    expect(operationResponses('tools/call').filter((entry) => {
      const response = entry.response;
      return response !== null && typeof response === 'object' && Object.hasOwn(response, 'result');
    })).toHaveLength(1);

    const resourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';
    const resourceRequestId = 'runtime-resource-read-proof';
    await appFrame.evaluate(({ id, uri }) => {
      window.parent.postMessage({ id, jsonrpc: '2.0', method: 'resources/read', params: { uri } }, '*');
    }, { id: resourceRequestId, uri: resourceUri });
    await expect.poll(() => operationRequests('resources/read'), { timeout: 15_000 }).toHaveLength(1);
    const resourceOperation = operationRequests('resources/read')[0];
    expect(resourceOperation?.body).toEqual({ kind: 'resources/read', uri: resourceUri });
    await expect.poll(() => operationResponses('resources/read'), { timeout: 15_000 }).toHaveLength(1);
    const resourceOperationResult = (operationResponses('resources/read')[0]?.response as Readonly<{ readonly result?: unknown }> | undefined)?.result;
    expect(resourceOperationResult).toMatchObject({
      operationId: expect.any(String),
      sessionId: created.preview.binding.sessionId,
      sessionRevision: created.preview.binding.sessionRevision,
      value: {
        contents: [{
          mimeType: 'text/html;profile=mcp-app',
          text: expect.stringMatching(/^<!doctype html>/iu),
          uri: resourceUri,
        }],
      },
      vector: created.preview.binding.runVector,
    });
    const resourceValue = (resourceOperationResult as Readonly<{ readonly value?: unknown }> | undefined)?.value;
    if (resourceValue === null || typeof resourceValue !== 'object') throw new Error('Runtime App resource operation omitted its result value.');
    const resourceContents = (resourceValue as Readonly<{ readonly contents?: unknown }>).contents;
    if (!Array.isArray(resourceContents) || resourceContents.length !== 1 || resourceContents[0] === null || typeof resourceContents[0] !== 'object') {
      throw new Error('Runtime App resource operation omitted its canonical resource content.');
    }
    const resourceContent = resourceContents[0] as Readonly<{ readonly text?: unknown }>;
    if (typeof resourceContent?.text !== 'string') throw new Error('Runtime App resource operation omitted its canonical HTML.');
    expect(resourceContent.text).not.toContain(foregroundToken);
    const resourceRequest = messageFor(fixture.url, controllerOrigin, (message) => message.id === resourceRequestId && message.method === 'resources/read');
    expect(resourceRequest?.message).toEqual({
      id: resourceRequestId,
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri: resourceUri },
    });
    await expect.poll(() => messageFor(controllerOrigin, fixture.url, (message) => message.id === resourceRequestId && Object.hasOwn(message, 'result')), { timeout: 15_000 }).toBeDefined();
    const resourceResponse = messageFor(controllerOrigin, fixture.url, (message) => message.id === resourceRequestId && Object.hasOwn(message, 'result'));
    expect(resourceResponse?.message).toEqual({
      id: resourceRequestId,
      jsonrpc: '2.0',
      result: (resourceOperationResult as Readonly<{ readonly value: unknown }>).value,
    });
    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests).toEqual([]);
    expect(projectEventStreams).toEqual(['GET /api/project/events']);

    const sourceFrameHref = controllerFrame.url();
    const sourceBindingId = created.preview.binding.id;
    await page.getByRole('button', { name: 'Open in MCP playground' }).click({ timeout: browserTimeout });
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: 15_000 });
    const teardownRequestForSource = (): RuntimeAppMessage | undefined => appMessages.find((entry) =>
      entry.href === sourceFrameHref && entry.senderOrigin === fixture.url && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/resource-teardown');
    await expect.poll(teardownRequestForSource, { timeout: 15_000 }).toBeDefined();
    const teardownRequest = teardownRequestForSource();
    const teardownId = teardownRequest?.message !== null && typeof teardownRequest?.message === 'object'
      ? (teardownRequest.message as Readonly<Record<string, unknown>>).id
      : undefined;
    if (typeof teardownId !== 'string' && typeof teardownId !== 'number') throw new Error('Runtime App teardown request omitted its JSON-RPC id.');
    const teardownAcknowledgementForSource = () => messageFor(fixture.url, controllerOrigin, (message) =>
      message.id === teardownId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
    await expect.poll(teardownAcknowledgementForSource, { timeout: 15_000 }).toBeDefined();
    const teardownAcknowledgement = teardownAcknowledgementForSource();
    expect(teardownAcknowledgement?.message).toEqual({ id: teardownId, jsonrpc: '2.0', result: {} });

    const sourceDeletePath = `/api/runtime/apps/${encodeURIComponent(sourceBindingId)}`;
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'DELETE' && entry.path === sourceDeletePath), { timeout: 15_000 }).toHaveLength(1);
    const sourceDelete = runtimeAppRequests.find((entry) => entry.method === 'DELETE' && entry.path === sourceDeletePath);
    const lifecycleIndex = (kind: RuntimeAppLifecycleEvent['kind'], value: RuntimeAppMessage | RuntimeAppRouteRequest): number =>
      runtimeAppLifecycleEvents.findIndex((entry) => entry.kind === kind && entry.value === value);
    expect(lifecycleIndex('message', teardownRequest!)).toBeGreaterThan(-1);
    expect(lifecycleIndex('message', teardownAcknowledgement!)).toBeGreaterThan(lifecycleIndex('message', teardownRequest!));
    expect(lifecycleIndex('request', sourceDelete!)).toBeGreaterThan(lifecycleIndex('message', teardownAcknowledgement!));
    await expect(outerFrame).toHaveCount(0, { timeout: 15_000 });

    const runtimeCreates = (): readonly RuntimeAppRouteRequest[] => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps');
    await expect.poll(runtimeCreates, { timeout: 15_000 }).toHaveLength(2);
    const destinationCreate = runtimeCreates()[1];
    expect(destinationCreate?.body).toEqual({ expectedGenerationId, profileId: 'portable', runId });
    const sourceDeleteIndex = runtimeAppRequests.indexOf(sourceDelete!);
    const destinationCreateIndex = runtimeAppRequests.indexOf(destinationCreate!);
    expect(sourceDeleteIndex).toBeGreaterThan(-1);
    expect(destinationCreateIndex).toBeGreaterThan(sourceDeleteIndex);
    await expect.poll(() => runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps'), { timeout: 15_000 }).toHaveLength(2);
    const destinationResponse = runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps')[1]?.response as Readonly<{ readonly preview?: Readonly<{
      readonly binding?: Readonly<{ readonly id?: unknown; readonly sessionId?: unknown; readonly sessionRevision?: unknown }>;
      readonly clientSurface?: Readonly<{ readonly origin?: unknown }>;
    }> }> | undefined;
    const destinationBinding = destinationResponse?.preview?.binding;
    const destinationOrigin = destinationResponse?.preview?.clientSurface?.origin;
    if (typeof destinationBinding?.id !== 'string' || typeof destinationBinding.sessionId !== 'string' || typeof destinationBinding.sessionRevision !== 'number' || typeof destinationOrigin !== 'string') {
      throw new Error('Destination Runtime App response omitted its binding authority.');
    }
    expect(destinationBinding).toMatchObject({
      id: expect.any(String),
      sessionId: created.preview.binding.sessionId,
      sessionRevision: created.preview.binding.sessionRevision,
    });
    expect(destinationBinding.id).not.toBe(sourceBindingId);
    await expect(page.locator('.mcp-page-app-preview iframe')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.runtime-stage .mcp-app-preview iframe')).toHaveCount(0);
    await expect.poll(() => appMessages.filter((entry) =>
      new URL(entry.href).origin === fixture.url && entry.senderOrigin === destinationOrigin && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/initialize').length, { timeout: 15_000 }).toBe(controllerOrigin === destinationOrigin ? 2 : 1);

    await page.setViewportSize({ height: 900, width: 390 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), { timeout: 15_000 }).toBe(true);

    const destinationAppFrame = async () => {
      for (const frame of page.frames()) {
        const parent = frame.parentFrame();
        if (parent !== null && new URL(parent.url()).origin === destinationOrigin && await frame.getByRole('heading', { name: 'Runtime edit timeline' }).count() === 1) return frame;
      }
      return undefined;
    };
    await expect.poll(destinationAppFrame, { timeout: 15_000 }).toBeDefined();
    const destinationFrame = await destinationAppFrame();
    if (destinationFrame === undefined) throw new Error('Destination Runtime App frame was unavailable.');
    const destinationController = destinationFrame.parentFrame();
    if (destinationController === null) throw new Error('Destination Runtime App trusted controller frame was unavailable.');
    const destinationFrameHref = destinationController.url();
    const destinationHistory = await page.getByRole('region', { name: 'Invocation history' }).textContent();
    const destinationDeletePath = `/api/runtime/apps/${encodeURIComponent(destinationBinding.id)}`;
    await page.evaluate(() => { window.location.hash = '#overview'; });
    const teardownRequestForDestination = (): RuntimeAppMessage | undefined => appMessages.find((entry) =>
      entry.href === destinationFrameHref && entry.senderOrigin === fixture.url && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/resource-teardown');
    await expect.poll(teardownRequestForDestination, { timeout: 15_000 }).toBeDefined();
    const destinationTeardown = teardownRequestForDestination();
    const destinationTeardownId = destinationTeardown?.message !== null && typeof destinationTeardown?.message === 'object'
      ? (destinationTeardown.message as Readonly<Record<string, unknown>>).id
      : undefined;
    if (typeof destinationTeardownId !== 'string' && typeof destinationTeardownId !== 'number') throw new Error('Destination Runtime App teardown request omitted its JSON-RPC id.');
    const destinationAcknowledgement = () => messageFor(fixture.url, destinationOrigin, (message) =>
      message.id === destinationTeardownId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
    await expect.poll(destinationAcknowledgement, { timeout: 15_000 }).toBeDefined();
    expect(destinationAcknowledgement()?.message).toEqual({ id: destinationTeardownId, jsonrpc: '2.0', result: {} });
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'DELETE' && entry.path === destinationDeletePath), { timeout: 15_000 }).toHaveLength(1);
    const destinationDelete = runtimeAppRequests.find((entry) => entry.method === 'DELETE' && entry.path === destinationDeletePath);
    await expect(page.getByRole('heading', { name: 'Bundle dashboard' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.mcp-page-app-preview iframe')).toHaveCount(0);
    expect(runtimeCreates()).toHaveLength(2);
    await page.evaluate(() => { window.location.hash = '#runtime'; });
    await expect.poll(runtimeCreates, { timeout: 15_000 }).toHaveLength(3);
    const thirdCreate = runtimeCreates()[2];
    expect(thirdCreate?.body).toEqual({ expectedGenerationId, profileId: 'portable', runId });
    expect(lifecycleIndex('message', destinationTeardown!)).toBeGreaterThan(-1);
    expect(lifecycleIndex('message', destinationAcknowledgement()!)).toBeGreaterThan(lifecycleIndex('message', destinationTeardown!));
    expect(lifecycleIndex('request', destinationDelete!)).toBeGreaterThan(lifecycleIndex('message', destinationAcknowledgement()!));
    expect(lifecycleIndex('request', thirdCreate!)).toBeGreaterThan(lifecycleIndex('request', destinationDelete!));
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.mcp-page-app-preview iframe')).toHaveCount(0);
    await expect(page.locator('.runtime-stage .mcp-app-preview iframe')).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps'), { timeout: 15_000 }).toHaveLength(3);
    const thirdResponse = runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps')[2]?.response as Readonly<{ readonly preview?: Readonly<{
      readonly binding?: Readonly<{ readonly id?: unknown; readonly sessionId?: unknown; readonly sessionRevision?: unknown }>;
      readonly clientSurface?: Readonly<{ readonly origin?: unknown }>;
    }> }> | undefined;
    const thirdBinding = thirdResponse?.preview?.binding;
    const thirdOrigin = thirdResponse?.preview?.clientSurface?.origin;
    if (typeof thirdBinding?.id !== 'string' || typeof thirdBinding.sessionId !== 'string' || typeof thirdBinding.sessionRevision !== 'number' || typeof thirdOrigin !== 'string') {
      throw new Error('Third Runtime App response omitted its binding authority.');
    }
    expect(thirdBinding).toMatchObject({ sessionId: created.preview.binding.sessionId, sessionRevision: created.preview.binding.sessionRevision });
    expect(thirdBinding.id).not.toBe(sourceBindingId);
    expect(thirdBinding.id).not.toBe(destinationBinding.id);

    const thirdAppFrame = async () => {
      for (const frame of page.frames()) {
        const parent = frame.parentFrame();
        if (parent !== null && new URL(parent.url()).origin === thirdOrigin && await frame.getByRole('heading', { name: 'Runtime edit timeline' }).count() === 1) return frame;
      }
      return undefined;
    };
    await expect.poll(thirdAppFrame, { timeout: 15_000 }).toBeDefined();
    const thirdFrame = await thirdAppFrame();
    if (thirdFrame === undefined) throw new Error('Third Runtime App frame was unavailable.');
    const thirdController = thirdFrame.parentFrame();
    if (thirdController === null) throw new Error('Third Runtime App trusted controller frame was unavailable.');
    const thirdFrameHref = thirdController.url();
    const thirdDeletePath = `/api/runtime/apps/${encodeURIComponent(thirdBinding.id)}`;
    await page.evaluate(() => { window.location.hash = '#mcp'; });
    const teardownRequestForThird = (): RuntimeAppMessage | undefined => appMessages.find((entry) =>
      entry.href === thirdFrameHref && entry.senderOrigin === fixture.url && entry.message !== null && typeof entry.message === 'object' &&
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/resource-teardown');
    await expect.poll(teardownRequestForThird, { timeout: 15_000 }).toBeDefined();
    const thirdTeardown = teardownRequestForThird();
    const thirdTeardownId = thirdTeardown?.message !== null && typeof thirdTeardown?.message === 'object'
      ? (thirdTeardown.message as Readonly<Record<string, unknown>>).id
      : undefined;
    if (typeof thirdTeardownId !== 'string' && typeof thirdTeardownId !== 'number') throw new Error('Third Runtime App teardown request omitted its JSON-RPC id.');
    const thirdAcknowledgement = () => messageFor(fixture.url, thirdOrigin, (message) =>
      message.id === thirdTeardownId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
    await expect.poll(thirdAcknowledgement, { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'DELETE' && entry.path === thirdDeletePath), { timeout: 15_000 }).toHaveLength(1);
    const thirdDelete = runtimeAppRequests.find((entry) => entry.method === 'DELETE' && entry.path === thirdDeletePath);
    expect(lifecycleIndex('message', thirdAcknowledgement()!)).toBeGreaterThan(lifecycleIndex('message', thirdTeardown!));
    expect(lifecycleIndex('request', thirdDelete!)).toBeGreaterThan(lifecycleIndex('message', thirdAcknowledgement()!));
    await expect(page.getByRole('heading', { name: 'MCP playground' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.runtime-stage .mcp-app-preview iframe')).toHaveCount(0);
    await expect(page.locator('.mcp-page-app-preview iframe')).toHaveCount(0);
    await expect(page.getByLabel('Runtime-bound MCP session')).toContainText(`${created.preview.binding.sessionId} · revision ${created.preview.binding.sessionRevision}`);
    await expect(page.getByRole('region', { name: 'Invocation history' })).toHaveText(destinationHistory ?? '');
    expect(runtimeCreates()).toHaveLength(3);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), { timeout: 15_000 }).toBe(true);

    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests).toEqual([]);
    expect(projectEventStreams).toEqual(['GET /api/project/events']);
    expect(consentRequests('document')).toHaveLength(0);
    expect(runtimeCreates()).toHaveLength(3);
    expect(runtimeAppRequests.filter((entry) => entry.method === 'DELETE' && entry.path === sourceDeletePath)).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally {
    await clientPage?.close();
    await clientSurface?.close();
    await fixture.close();
    await fixture.closed;
    await expect(access(fixture.root)).rejects.toThrow();
  }
});

e2e('keeps Portable, ChatGPT, and Claude simulated App profiles isolated over one real Runtime run', { timeout: 180_000 }, async ({ page }) => {
  const fixture = await startRuntimePlaygroundFixture();
  const appMessages: RuntimeAppMessage[] = [];
  const artifactMcpSessionRequests: string[] = [];
  const pageErrors: Error[] = [];
  const projectEventStreams: string[] = [];
  const runtimeAppRequests: RuntimeAppRouteRequest[] = [];
  const runtimeAppResponses: RuntimeAppRouteResponse[] = [];
  const runtimeMcpSessionRequests: string[] = [];
  await page.exposeBinding('__recordRuntimeProfileMessage', (_source, payload: unknown) => {
    if (payload !== null && typeof payload === 'object') appMessages.push(payload as RuntimeAppMessage);
  });
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object' || (message as { readonly jsonrpc?: unknown }).jsonrpc !== '2.0') return;
      const record = (globalThis as typeof globalThis & { __recordRuntimeProfileMessage?: (payload: unknown) => Promise<void> }).__recordRuntimeProfileMessage;
      if (record !== undefined) void record({ href: window.location.href, message, senderOrigin: event.origin });
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== fixture.url) return;
    if (url.pathname.startsWith('/api/mcp/sessions')) artifactMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/project/events') projectEventStreams.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.startsWith('/api/runtime/apps')) runtimeAppRequests.push(Object.freeze({ body: requestBody(request.postData()), headers: request.headers(), method: request.method(), path: url.pathname }));
    if (url.pathname.startsWith('/api/runtime/mcp/sessions')) runtimeMcpSessionRequests.push(`${request.method()} ${url.pathname}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== fixture.url || !url.pathname.startsWith('/api/runtime/apps')) return;
    void response.json().then((responseBody) => {
      const request = response.request();
      runtimeAppResponses.push(Object.freeze({ body: requestBody(request.postData()), headers: request.headers(), method: request.method(), path: url.pathname, response: responseBody }));
    }).catch(() => undefined);
  });
  try {
    await page.goto(workbenchUrl(fixture.url, 'runtime'));
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: 15_000 });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    const runtimeSurface = page.getByLabel('Runtime surface');
    const runtimeProfile = page.getByLabel('Runtime profile');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: 15_000 });
    await runtimeSurface.selectOption('mcp.render_edit_timeline');
    await page.getByLabel('Runtime target').selectOption('portable');
    await expect(runtimeProfile).toHaveValue('portable');
    await expect(runtimeProfile.locator('option:checked')).toHaveText('Portable MCP Apps · agent-bundle:mcp-apps:2026-01-26 · Simulation');
    await expect(page.locator('.runtime-profile-disclaimer')).toHaveText('Simulated locally — not host certification');
    await page.getByRole('radio', { name: 'Raw JSON' }).check();
    await page.locator('#runtime-input-raw').fill('{}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const history = page.getByRole('region', { name: 'Runtime run history' }).locator('ol > li');
    await expect(history).toHaveCount(1, { timeout: 15_000 });
    const runId = await history.first().getAttribute('data-runtime-run-id');
    const expectedGenerationId = await runtimeIdentity.getAttribute('data-runtime-generation');
    if (runId === null || expectedGenerationId === null) throw new Error('Runtime profile matrix did not expose the selected run authority.');

    const profiles = [
      { id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' },
      { id: 'chatgpt', label: 'ChatGPT Simulation', version: 'agent-bundle:chatgpt-sim:1' },
      { id: 'claude', label: 'Claude Simulation', version: 'agent-bundle:claude-sim:1' },
    ] as const;
    const expectedConfiguration = [
      { configured: true, id: 'extension:claude', key: 'claude', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'claude' },
      { configured: true, id: 'extension:codex', key: 'codex', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'codex' },
      { configured: true, id: 'extension:portable', key: 'portable', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'portable' },
    ] as const;
    const creates = (): readonly RuntimeAppRouteRequest[] => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps');
    const createResponses = (): readonly RuntimeAppRouteResponse[] => runtimeAppResponses.filter((entry) => entry.method === 'POST' && entry.path === '/api/runtime/apps');
    const responseFor = (index: number) => createResponses()[index]?.response as Readonly<{ readonly preview?: Readonly<{
      readonly binding?: Readonly<{ readonly id?: unknown; readonly profileId?: unknown; readonly profileVersion?: unknown; readonly runVector?: unknown; readonly sessionId?: unknown; readonly sessionRevision?: unknown }>;
      readonly clientSurface?: Readonly<{ readonly origin?: unknown }>;
      readonly profile?: Readonly<{ readonly configExtensions?: unknown; readonly descriptor?: unknown }>;
    }> }> | undefined;
    const messageFor = (
      receiverOrigin: string,
      senderOrigin: string,
      matches: (message: Readonly<Record<string, unknown>>) => boolean,
    ): RuntimeAppMessage | undefined => appMessages.find((entry) =>
      new URL(entry.href).origin === receiverOrigin && entry.senderOrigin === senderOrigin && entry.message !== null && typeof entry.message === 'object' &&
      matches(entry.message as Readonly<Record<string, unknown>>));
    const runtimeFrameFor = async (origin: string) => {
      for (const frame of page.frames()) {
        const parent = frame.parentFrame();
        if (parent !== null && new URL(parent.url()).origin === origin && await frame.getByRole('heading', { name: 'Runtime edit timeline' }).count() === 1) return frame;
      }
      return undefined;
    };
    let configurationSnapshot: unknown;
    let previous: Readonly<{ readonly bindingId: string; readonly controllerHref: string; readonly origin: string; readonly runVector: unknown; readonly sessionId: string; readonly sessionRevision: number }> | undefined;

    for (const [index, profile] of profiles.entries()) {
      if (index > 0) {
        const retiring = previous;
        if (retiring === undefined) throw new Error('Runtime profile matrix lost its retiring App authority.');
        await runtimeProfile.selectOption(profile.id);
        await expect(runtimeProfile).toHaveValue(profile.id);
        await expect(runtimeProfile.locator('option:checked')).toHaveText(`${profile.label} · ${profile.version} · Simulation`);
        await expect(page.locator('.runtime-profile-disclaimer')).toHaveText('Simulated locally — not host certification');
        const teardown = () => appMessages.find((entry) =>
          entry.href === retiring.controllerHref && entry.senderOrigin === fixture.url && entry.message !== null && typeof entry.message === 'object' &&
          (entry.message as Readonly<Record<string, unknown>>).method === 'ui/resource-teardown');
        await expect.poll(teardown, { timeout: 15_000 }).toBeDefined();
        const teardownId = teardown()?.message !== null && typeof teardown()?.message === 'object'
          ? (teardown()!.message as Readonly<Record<string, unknown>>).id
          : undefined;
        if (typeof teardownId !== 'string' && typeof teardownId !== 'number') throw new Error('Retiring Runtime App teardown omitted its JSON-RPC id.');
        await expect.poll(() => messageFor(fixture.url, retiring.origin, (message) =>
          message.id === teardownId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))), { timeout: 15_000 }).toBeDefined();
        const deletePath = `/api/runtime/apps/${encodeURIComponent(retiring.bindingId)}`;
        await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'DELETE' && entry.path === deletePath), { timeout: 15_000 }).toHaveLength(1);
        await expect.poll(creates, { timeout: 15_000 }).toHaveLength(index + 1);
        const replacement = creates()[index];
        const retired = runtimeAppRequests.find((entry) => entry.method === 'DELETE' && entry.path === deletePath);
        if (replacement === undefined || retired === undefined) throw new Error('Runtime profile replacement routes were not recorded.');
        expect(runtimeAppRequests.indexOf(retired)).toBeLessThan(runtimeAppRequests.indexOf(replacement));
      }

      await expect.poll(createResponses, { timeout: 15_000 }).toHaveLength(index + 1);
      const create = creates()[index];
      expect(create?.body).toEqual({ expectedGenerationId, profileId: profile.id, runId });
      const snapshot = responseFor(index)?.preview;
      const binding = snapshot?.binding;
      const origin = snapshot?.clientSurface?.origin;
      if (typeof binding?.id !== 'string' || typeof binding.sessionId !== 'string' || typeof binding.sessionRevision !== 'number' || typeof origin !== 'string') {
        throw new Error(`Runtime ${profile.id} profile response omitted its binding authority.`);
      }
      expect(binding).toMatchObject({ profileId: profile.id, profileVersion: profile.version });
      expect(snapshot?.profile?.descriptor).toEqual({ claimsRealHostParity: false, evidence: 'simulated', id: profile.id, label: profile.label, version: profile.version });
      const configuration = snapshot?.profile?.configExtensions;
      if (index === 0) {
        expect(configuration).toEqual({ entries: expectedConfiguration, sourceRevision: expect.any(String) });
        configurationSnapshot = configuration;
      } else {
        expect(configuration).toEqual(configurationSnapshot);
      }
      const sourceRevision = (configuration as Readonly<{ readonly sourceRevision?: unknown }> | undefined)?.sourceRevision;
      if (typeof sourceRevision !== 'string' || sourceRevision.length === 0) throw new Error(`Runtime ${profile.id} configuration inspection omitted its source revision.`);
      if (previous !== undefined) {
        expect(binding.id).not.toBe(previous.bindingId);
        expect(binding.sessionId).toBe(previous.sessionId);
        expect(binding.sessionRevision).toBe(previous.sessionRevision);
        expect(binding.runVector).toEqual(previous.runVector);
      }

      const preview = page.locator('.runtime-stage .mcp-app-preview');
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText(profile.label);
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText(profile.version);
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText('Simulated');
      await expect(preview.getByLabel('Simulated MCP App profile')).toContainText('Not certified for real-host parity');
      const registered = preview.getByLabel('Registered configuration');
      await expect(registered).toContainText(sourceRevision);
      await expect(registered.getByRole('listitem')).toHaveCount(3);
      expect(await registered.getByRole('listitem').nth(0).locator('dd').allTextContents()).toEqual(['claude', 'claude', 'extension:claude', 'config', 'agent-bundle.config.ts']);
      expect(await registered.getByRole('listitem').nth(1).locator('dd').allTextContents()).toEqual(['codex', 'codex', 'extension:codex', 'config', 'agent-bundle.config.ts']);
      expect(await registered.getByRole('listitem').nth(2).locator('dd').allTextContents()).toEqual(['portable', 'portable', 'extension:portable', 'config', 'agent-bundle.config.ts']);
      const registeredText = await registered.textContent() ?? '';
      for (const hidden of ['nativeHooks', 'raw', 'secret', 'token', 'handler', 'providerSessionId', 'stateStoreId', 'value']) {
        expect(registeredText).not.toContain(hidden);
      }

      await expect(page.locator('.runtime-stage .mcp-app-preview iframe')).toHaveCount(1, { timeout: 15_000 });
      await expect.poll(() => runtimeFrameFor(origin), { timeout: 15_000 }).toBeDefined();
      const appFrame = await runtimeFrameFor(origin);
      if (appFrame === undefined) throw new Error(`Runtime ${profile.id} profile App frame was unavailable.`);
      const controller = appFrame.parentFrame();
      if (controller === null) throw new Error(`Runtime ${profile.id} profile trusted controller was unavailable.`);
      const frameShape = await controller.evaluate(() => Object.freeze({
        nestedCount: document.querySelectorAll('iframe').length,
        nestedSandbox: document.querySelector('iframe')?.getAttribute('sandbox') ?? undefined,
      }));
      const controllerGlobals = await controller.evaluate(() => Object.freeze({
        chatgpt: Object.hasOwn(globalThis, 'chatgpt'),
        claude: Object.hasOwn(globalThis, 'claude'),
        codex: Object.hasOwn(globalThis, 'codex'),
        openai: Object.hasOwn(globalThis, 'openai'),
        widgetState: Object.hasOwn(globalThis, '__openai_widget_state__'),
      }));
      const isolation = await appFrame.evaluate(() => Object.freeze({
        chatgpt: Object.hasOwn(globalThis, 'chatgpt'),
        claude: Object.hasOwn(globalThis, 'claude'),
        codex: Object.hasOwn(globalThis, 'codex'),
        openai: Object.hasOwn(globalThis, 'openai'),
        origin: window.origin,
        widgetState: Object.hasOwn(globalThis, '__openai_widget_state__'),
      }));
      expect(frameShape).toEqual({ nestedCount: 1, nestedSandbox: 'allow-scripts' });
      expect(controllerGlobals).toEqual({ chatgpt: false, claude: false, codex: false, openai: false, widgetState: false });
      expect(isolation).toEqual({ chatgpt: false, claude: false, codex: false, openai: false, origin: 'null', widgetState: false });

      const resourceId = `runtime-profile-${profile.id}-resource-read`;
      const operationPath = `/api/runtime/apps/${encodeURIComponent(binding.id)}/operations`;
      await appFrame.evaluate(({ id }) => {
        window.parent.postMessage({ id, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' } }, '*');
      }, { id: resourceId });
      const resourceRequests = (): readonly RuntimeAppRouteRequest[] => runtimeAppRequests.filter((entry) =>
        entry.method === 'POST' && entry.path === operationPath && entry.body !== null && typeof entry.body === 'object' &&
        (entry.body as Readonly<{ readonly kind?: unknown }>).kind === 'resources/read');
      await expect.poll(resourceRequests, { timeout: 15_000 }).toHaveLength(1);
      expect(resourceRequests()[0]?.body).toEqual({ kind: 'resources/read', uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' });
      const resourceResponses = (): readonly RuntimeAppRouteResponse[] => runtimeAppResponses.filter((entry) =>
        entry.method === 'POST' && entry.path === operationPath && entry.body !== null && typeof entry.body === 'object' &&
        (entry.body as Readonly<{ readonly kind?: unknown }>).kind === 'resources/read');
      await expect.poll(resourceResponses, { timeout: 15_000 }).toHaveLength(1);
      expect((resourceResponses()[0]?.response as Readonly<{ readonly result?: unknown }> | undefined)?.result).toMatchObject({
        sessionId: binding.sessionId,
        sessionRevision: binding.sessionRevision,
        value: { contents: [{ mimeType: 'text/html;profile=mcp-app', uri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' }] },
        vector: binding.runVector,
      });
      previous = Object.freeze({ bindingId: binding.id, controllerHref: controller.url(), origin, runVector: binding.runVector, sessionId: binding.sessionId, sessionRevision: binding.sessionRevision });
    }

    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests).toEqual([]);
    expect(projectEventStreams).toEqual(['GET /api/project/events']);
    expect(runtimeAppRequests.filter((entry) => entry.method === 'DELETE')).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  } finally {
    await fixture.close();
    await fixture.closed;
    await expect(access(fixture.root)).rejects.toThrow();
  }
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

    await page.goto(workbenchUrl(foregroundOrigin, 'mcp'));
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
    await expect(appFrame.locator('#view')).toHaveCSS('color', 'rgb(18, 52, 86)', { timeout: browserTimeout });
    await expect(appFrame.locator('#view')).toHaveCSS('font-weight', '700', { timeout: browserTimeout });
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
