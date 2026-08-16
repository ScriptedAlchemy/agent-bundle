import { execFile as executeFile } from 'node:child_process';
import { access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';
import type { Page } from 'playwright';

import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { startRuntimePlaygroundFixture } from './helpers/runtime-playground-fixture.ts';

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
  '<main data-testid="app-state">waiting</main>',
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
  '</script>',
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
    const pageErrors: Error[] = [];
    const appRequests: AppRouteRequest[] = [];
    const appResponses: AppRouteResponse[] = [];
    const consentSnapshots: unknown[] = [];
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

    await page.goto(`${foregroundOrigin}#mcp`);
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
    await page.getByRole('button', { name: 'Allow call tool' }).click();
    await page.getByRole('button', { name: 'Allow open external link' }).click();
    await page.getByRole('button', { name: 'Allow download file' }).click();
    await page.getByRole('button', { name: 'Allow request display mode' }).click();
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
    await expect.poll(async () => JSON.parse(await appState.textContent() ?? 'null').linkReply, { timeout: browserTimeout }).toEqual({});
    await expect.poll(async () => JSON.parse(await appState.textContent() ?? 'null').downloadReply, { timeout: browserTimeout }).toEqual({});
    await expect.poll(async () => JSON.parse(await appState.textContent() ?? 'null').displayReply, { timeout: browserTimeout }).toEqual({ mode: 'inline' });
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
  const fixture = await startRuntimePlaygroundFixture();
  let clientPage: Page | undefined;
  let clientSurface: Awaited<ReturnType<typeof fixture.openRuntimeClientSurface>> | undefined;
  const appMessages: RuntimeAppMessage[] = [];
  const pageErrors: Error[] = [];
  const artifactMcpSessionRequests: string[] = [];
  const projectEventStreams: string[] = [];
  const runtimeAppLifecycleEvents: RuntimeAppLifecycleEvent[] = [];
  const runtimeAppRequests: RuntimeAppRouteRequest[] = [];
  const runtimeAppResponses: RuntimeAppRouteResponse[] = [];
  const runtimeMcpSessionRequests: string[] = [];
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
    if (url.origin !== fixture.url || !url.pathname.startsWith('/api/runtime/apps')) return;
    void response.json().then((body) => {
      const request = response.request();
      runtimeAppResponses.push({ body: requestBody(request.postData()), headers: request.headers(), method: request.method(), path: url.pathname, response: body });
    }).catch(() => undefined);
  });
  try {
    await page.goto(`${fixture.url}#runtime`);
    await expect(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible({ timeout: 15_000 });
    const runtimeIdentity = page.locator('[data-runtime-provider-session]');
    const runtimeSurface = page.getByLabel('Runtime surface');
    await expect(runtimeIdentity).toHaveAttribute('data-runtime-hmr-ready', 'true', { timeout: 15_000 });
    await runtimeSurface.selectOption('mcp.edit-timeline');
    clientSurface = await fixture.openRuntimeClientSurface('mcp.edit-timeline');
    if (clientSurface === undefined) throw new Error('Runtime client surface was not available.');
    clientPage = await page.context().newPage();
    clientPage.on('pageerror', (error) => pageErrors.push(error));
    const bootstrap = await clientPage.goto(clientSurface.bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(bootstrap?.status()).toBe(200);
    await expect.poll(() => runtimeIdentity.getAttribute('data-runtime-hmr-client-count'), { timeout: 15_000 }).toBe('1');

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
      readonly binding: Readonly<{ readonly id: string; readonly runVector: unknown; readonly serverName: string; readonly sessionId: string; readonly sessionRevision: number }>;
      readonly clientSurface: Readonly<{ readonly bootstrapUrl: string; readonly origin: string }>;
      readonly kind: string;
      readonly profile: Readonly<{ readonly hostContext: unknown; readonly resourceUri: string }>;
      readonly result: Readonly<{ readonly appVisible: unknown; readonly modelVisible: unknown }>;
    }> }>;
    expect(created.preview).toMatchObject({
      binding: { serverName: 'timeline', sessionId: expect.any(String), sessionRevision: expect.any(Number) },
      clientSurface: { bootstrapUrl: expect.any(String), origin: expect.any(String) },
      kind: 'apps',
      profile: { hostContext: { platform: 'web' }, resourceUri: 'ui://rsc-agent-runtime/edit-timeline-v1.html' },
    });
    expect(created.preview.result.appVisible).toMatchObject({
      content: [expect.objectContaining({ type: 'text' })],
      structuredContent: { edits: [], stateVersion: 0 },
    });

    const outerFrame = page.locator('.runtime-stage .mcp-app-preview iframe');
    await expect(outerFrame).toBeVisible({ timeout: 15_000 });
    const runtimeAppFrame = async () => {
      for (const frame of page.frames()) {
        if (await frame.getByRole('heading', { name: 'Runtime edit timeline' }).count() === 1) return frame;
      }
      return undefined;
    };
    await expect.poll(runtimeAppFrame, { timeout: 15_000 }).toBeDefined();
    const appFrame = await runtimeAppFrame();
    if (appFrame === undefined) throw new Error('Runtime App frame was unavailable.');
    const frameOrigin = new URL(appFrame.url()).origin;
    const outerSource = await outerFrame.getAttribute('src');
    const foregroundToken = createdRequest.headers()['x-agent-bundle-session'];
    if (outerSource === null || foregroundToken === undefined) throw new Error('Runtime App foreground transport evidence was unavailable.');
    expect(frameOrigin).toBe(created.preview.clientSurface.origin);
    expect(frameOrigin).not.toBe(fixture.url);
    expect(new URL(created.preview.clientSurface.bootstrapUrl).origin).toBe(frameOrigin);
    expect(outerSource).not.toContain(foregroundToken);
    expect(await appFrame.content()).not.toContain(foregroundToken);

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
        ['ui/initialize request', messageFor(fixture.url, frameOrigin, (message) => message.method === 'ui/initialize')],
        ['ui/initialize result', messageFor(frameOrigin, fixture.url, (message) => {
          const result = message.result;
          return result !== null && typeof result === 'object' && Object.hasOwn(result, 'hostContext');
        })],
        ['ui/notifications/initialized', messageFor(fixture.url, frameOrigin, (message) => message.method === 'ui/notifications/initialized')],
        ['ui/notifications/tool-input', messageFor(frameOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-input')],
        ['ui/notifications/tool-result', messageFor(frameOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-result')],
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
    const toolInput = messageFor(frameOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-input');
    const toolResult = messageFor(frameOrigin, fixture.url, (message) => message.method === 'ui/notifications/tool-result');
    if (toolInput === undefined || toolResult === undefined) throw new Error('Runtime App invocation notifications were unavailable.');
    expect(toolInput.message).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } });
    expect(toolResult.message).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: created.preview.result.appVisible });
    const initialized = messageFor(frameOrigin, fixture.url, (message) => {
      const result = message.result;
      return result !== null && typeof result === 'object' && Object.hasOwn(result, 'hostContext');
    });
    expect((initialized?.message.result as Readonly<{ readonly hostContext?: unknown }> | undefined)?.hostContext)
      .toMatchObject(created.preview.profile.hostContext as Record<string, unknown>);
    expect((initialized?.message.result as Readonly<{ readonly hostCapabilities?: unknown }> | undefined)?.hostCapabilities)
      .toMatchObject({ serverResources: {}, serverTools: {} });

    await appFrame.getByRole('button', { name: 'Refresh' }).click();
    const consentPath = `/api/runtime/apps/${encodeURIComponent(created.preview.binding.id)}/consents`;
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === consentPath), { timeout: 15_000 }).toHaveLength(1);
    const consentCreate = runtimeAppRequests.find((entry) => entry.method === 'POST' && entry.path === consentPath);
    expect(consentCreate?.body).toEqual({
      actionFingerprint: 'runtime-app:call-tool:v1',
      capability: 'call-tool',
      details: { arguments: { limit: 10 }, name: 'render_edit_timeline' },
      scope: 'action',
      summary: 'Call MCP App tool',
    });
    await expect(page.getByRole('dialog', { name: 'Runtime App consent' })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === consentPath), { timeout: 15_000 }).toBeDefined();
    const consentCreated = runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === consentPath);
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

    await page.getByRole('button', { name: 'Allow once' }).click();
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
    await expect.poll(() => runtimeAppRequests.filter((entry) => entry.method === 'POST' && entry.path === operationPath), { timeout: 15_000 }).toHaveLength(1);
    const operation = runtimeAppRequests.find((entry) => entry.method === 'POST' && entry.path === operationPath);
    expect(operation?.body).toEqual({
      arguments: { limit: 10 },
      consentId: grant.authorizationId,
      kind: 'tools/call',
      name: 'render_edit_timeline',
    });
    await expect.poll(() => runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === operationPath), { timeout: 15_000 }).toBeDefined();
    const operated = runtimeAppResponses.find((entry) => entry.method === 'POST' && entry.path === operationPath);
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
    const refreshRequest = messageFor(fixture.url, frameOrigin, (message) => message.method === 'tools/call');
    expect(refreshRequest?.message).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { _meta: { progressToken: 1 }, arguments: { limit: 10 }, name: 'render_edit_timeline' },
    });
    await expect.poll(() => messageFor(frameOrigin, fixture.url, (message) => message.id === 1 && Object.hasOwn(message, 'result')), { timeout: 15_000 }).toBeDefined();
    const refreshResult = messageFor(frameOrigin, fixture.url, (message) => message.id === 1 && Object.hasOwn(message, 'result'));
    expect(refreshResult?.message).toEqual({ jsonrpc: '2.0', id: 1, result: (operationResult as Readonly<{ readonly value: unknown }>).value });
    await expect(appFrame.getByText('State version 0')).toBeVisible();
    await expect(appFrame.getByRole('status')).toHaveText('');

    const sourceFrameHref = appFrame.url();
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
    const teardownAcknowledgementForSource = () => messageFor(fixture.url, frameOrigin, (message) =>
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
      (entry.message as Readonly<Record<string, unknown>>).method === 'ui/initialize').length, { timeout: 15_000 }).toBe(frameOrigin === destinationOrigin ? 2 : 1);

    await page.setViewportSize({ height: 900, width: 390 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), { timeout: 15_000 }).toBe(true);

    expect(artifactMcpSessionRequests).toEqual([]);
    expect(runtimeMcpSessionRequests).toEqual([]);
    expect(projectEventStreams).toEqual(['GET /api/project/events']);
    expect(runtimeCreates()).toHaveLength(2);
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
