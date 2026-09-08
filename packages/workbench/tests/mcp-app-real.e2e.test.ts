import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type PlaywrightOptions } from '@rstest/playwright';

import { agentBundleNodeModules, workbenchNodeModules } from '../../agent-bundle/tests/helpers/workspace-paths.ts';
import { createWorkbenchAssetSource } from '../../agent-bundle/src/dev/workbench-assets.ts';
import { startDevServer } from '../../agent-bundle/src/dev/workbench-server.ts';
import { createProjectFixture, removeProjectFixture } from '../../agent-bundle/tests/helpers/project-fixture.ts';
import { timeScale } from '../../agent-bundle/tests/support/time-scale.ts';
import { browserLaunchOptions, browserTrace, buildWorkbench, workbenchUrl } from './support/workbench-e2e.ts';
import { expectHeading, selectApplicationLeaf } from './support/workbench-acceptance.ts';
import { copyExample } from './support/example-acceptance.ts';
import { inspectWorkbenchSurface } from '../../agent-bundle/src/test/index.ts';
import { applicationLeaves } from '../src/application/application-tree-model.ts';

const workspaceRoot = process.cwd();
const workbenchAssets = join(workspaceRoot, 'packages', 'workbench', 'dist');
const browserTimeout = 8_000 * timeScale;

const e2e = test.extend({
  playwright: {
    launchOptions: browserLaunchOptions,
    contextOptions: { viewport: { height: 900, width: 1440 } },
    trace: browserTrace,
  } satisfies PlaywrightOptions,
});

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
      "  skills: ['src/skills/review'],",
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
    symlink(join(workbenchNodeModules, 'zod'), join(root, 'node_modules', 'zod'), 'dir'),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'views', 'dashboard.css'), '#view { color: rgb(18, 52, 86); font-weight: 700; }\n'),
    writeFile(join(root, 'views', 'dashboard.ts'), [
      "import { createAppClient } from 'agent-bundle/app';",
      "import './dashboard.css';",
      '',
      "const view = document.querySelector('#view')!;",
      "view.textContent = 'connecting';",
      'const client = createAppClient({',
      "  appInfo: { name: 'bundled-app-fixture', version: '1.0.0' },",
      '});',
      'const run = async () => {',
      '  await client.connect();',
      "  view.textContent = 'connected';",
      '  try {',
      "    const called = await client.call('tool:fixture/inner-echo', { message: 'from-compiled-app' });",
      '    view.textContent = JSON.stringify(called);',
      '  } catch (error) {',
      "    view.textContent = error instanceof Error ? error.message : 'call failed';",
      '  }',
      '};',
      'void run();',
      '',
    ].join('\n')),
    writeFile(join(root, 'views', 'shell.html'), '<!doctype html><html><body><main id="view">waiting</main></body></html>\n'),
    writeFile(join(root, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/server';",
      "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
      "import apps from 'agent-bundle/mcp-apps';",
      "import { z } from 'zod';",
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
      "  structuredContent: { source: 'packed-release' },",
      '}));',
      "server.registerTool('inner-echo', { inputSchema: z.object({ message: z.string() }) }, async ({ message }) => ({",
      "  content: [{ text: `Inner echo: ${message}`, type: 'text' }],",
      '  structuredContent: { echo: message },',
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
      "  skills: ['src/skills/review'],",
      "  targets: ['portable'],",
      '});',
      '',
    ].join('\n')),
  ]);
};

/**
 * A conventional App server added to a copy of the `mcp-app` example (#751):
 * its bound tool takes as long as its input says, and the App reports what it
 * hears, so the test can see the input arrive before the outcome and the
 * outcome arrive as a result, an error, or a cancellation.
 */
const writeLifecycleServer = async (root: string): Promise<void> => {
  const server = join(root, 'src', 'mcp', 'lifecycle');
  await Promise.all([mkdir(join(server, 'apps'), { recursive: true }), mkdir(join(server, 'tools'), { recursive: true })]);
  await Promise.all([
    writeFile(join(server, 'apps', 'lifecycle.html'), '<!doctype html><html><body><main id="view">waiting</main></body></html>\n'),
    writeFile(join(server, 'apps', 'lifecycle.ts'), [
      "import type { AppRouteConfig } from 'agent-bundle';",
      "import { createAppClient } from 'agent-bundle/app';",
      '',
      "export const config = { resourceUri: 'ui://lifecycle-fixture/lifecycle.html', template: './lifecycle.html' } satisfies AppRouteConfig;",
      '',
      "const view = document.querySelector('#view')!;",
      "const client = createAppClient({ appInfo: { name: 'lifecycle-app-fixture', version: '1.0.0' } });",
      "client.onToolInput('tool:lifecycle/show-lifecycle', (input) => { view.textContent = `input:${JSON.stringify(input)}`; });",
      "client.onToolResult('tool:lifecycle/show-lifecycle', (result) => { view.textContent = `result:${JSON.stringify(result)}`; });",
      "client.onToolError('tool:lifecycle/show-lifecycle', (error) => { view.textContent = `error:${error.message}`; });",
      "client.onToolCancelled((event) => { view.textContent = `cancelled:${event.reason ?? ''}`; });",
      "void client.connect().then(() => { if (view.textContent === 'waiting') view.textContent = 'connected'; });",
      '',
    ].join('\n')),
    writeFile(join(server, 'tools', 'show-lifecycle.tsx'), [
      "import { Agent } from '@agent-bundle/runtime';",
      "import React from 'react';",
      "import type { ToolConfig, ToolRouteProps } from 'agent-bundle';",
      "import { appResourceUri } from 'agent-bundle/routes';",
      "import { z } from 'zod';",
      '',
      'export const config = {',
      "  _meta: { ui: { resourceUri: appResourceUri('lifecycle') } },",
      "  description: 'Waits as long as it is told, then succeeds or fails on request.',",
      '} satisfies ToolConfig;',
      '',
      'export const inputSchema = z.object({ delayMs: z.number().int().min(0), fail: z.boolean().optional() });',
      'export const resultSchema = z.object({ waited: z.number() });',
      '',
      'export default async function ShowLifecycle({ input }: ToolRouteProps<typeof inputSchema>) {',
      '  await new Promise((resolve) => setTimeout(resolve, input.delayMs));',
      '  return (',
      '    <Agent.Result value={{ waited: input.delayMs }}>',
      '      {input.fail === true',
      '        ? <Agent.Error code="AB9001">Lifecycle failed on request.</Agent.Error>',
      '        : <Agent.Text>{`Lifecycle waited ${String(input.delayMs)}ms.`}</Agent.Text>}',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
  ]);
};

interface AppRouteRequest {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

interface AppRouteResponse extends AppRouteRequest {
  readonly response: unknown;
}

const requestBody = (body: string | null): unknown => {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

e2e('runs a generated SDK-v2 App through the real foreground session and separate-origin sandbox', { timeout: 90_000 * timeScale }, async ({ page }) => {
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
      appRequests.push({ body: requestBody(request.postData()), method: request.method(), path: requestUrl.pathname });
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
        appResponses.push({ body: requestBody(response.request().postData()), method: response.request().method(), path: responseUrl.pathname, response: body });
      }).catch(() => undefined);
    });

    await page.goto(workbenchUrl(foregroundOrigin, '/advanced/protocol'));
    await expectHeading(page, 'MCP playground');
    await page.locator('#mcp-target').selectOption('portable');
    await page.locator('#mcp-server-name').fill('fixture');
    const opened = page.waitForResponse((response) =>
      response.url() === `${foregroundOrigin}/api/mcp/sessions` && response.request().method() === 'POST', { timeout: 30_000 * timeScale });
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
      request.url() === `${foregroundOrigin}/api/mcp/sessions/${openedSession.session.id}/apps` && request.method() === 'POST', { timeout: 30_000 * timeScale });
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
    // The sandbox proxy document owns no scrollbar of its own (#565): its App
    // frame is a block filling the document, so only the App itself scrolls.
    const proxyFrame = page.frames().find((frame) => frame.url().startsWith(sandboxOrigin));
    if (proxyFrame === undefined) throw new Error('Expected the sandbox proxy frame on the sandbox origin.');
    await expect.poll(() => proxyFrame.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflow,
      frameDisplay: getComputedStyle(document.getElementById('app')!).display,
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    })), { timeout: browserTimeout }).toEqual({ bodyOverflow: 'hidden', frameDisplay: 'block', scrolls: false });
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

    const firstClose = page.waitForRequest((request) => request.url().startsWith(`${foregroundOrigin}/api/mcp/apps/`) && request.url().endsWith('/close'), { timeout: 30_000 * timeScale });
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

    const reopenedPreview = page.waitForResponse((response) =>
      response.url() === `${foregroundOrigin}/api/mcp/sessions/${openedSession.session.id}/apps` && response.request().method() === 'POST', { timeout: browserTimeout });
    await page.getByRole('button', { name: 'Open App preview for mcp-page-1' }).click();
    const reopened = await (await reopenedPreview).json() as Readonly<{ readonly preview: Readonly<{ readonly bindingId: string }> }>;
    const reopenedAppPath = `/api/mcp/apps/${encodeURIComponent(reopened.preview.bindingId)}`;
    await expect(outerFrame).toBeVisible({ timeout: browserTimeout });
    // A visible iframe only proves the element mounted. The relay sends the
    // graceful POST …/close only once it has seen the proxy's ready
    // notification; before that, close() releases the binding with a forced
    // DELETE and nothing can acknowledge a teardown. McpAppFrameRelay publishes
    // that state on the iframe, so wait on it directly, then on the reopened
    // App's own `initialized` so the teardown below is acknowledged instead of
    // riding out the force-close timer.
    await expect(outerFrame).toHaveAttribute('data-mcp-app-relay-state', 'ready', { timeout: browserTimeout });
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly method?: string } } | undefined)?.message;
      return request.path === `${reopenedAppPath}/messages` && message?.method === 'ui/notifications/initialized';
    }), { message: 'The reopened App preview never sent ui/notifications/initialized.', timeout: browserTimeout }).toBe(true);
    const closedSession = page.waitForRequest((request) =>
      request.url() === `${foregroundOrigin}/api/mcp/sessions/${openedSession.session.id}` && request.method() === 'DELETE', { timeout: browserTimeout });
    // The session controls sit ~2000 px above the reopened App's cross-origin
    // iframe. Letting click() scroll that far and dispatch in the same breath
    // lets Chromium route the pointer to the frame that used to occupy the
    // point (its hit-test regions update asynchronously), so the click is
    // swallowed under load. Settle the scroll first, then confirm the click
    // landed through the phase transition. The terminal render replaces this
    // button with Reset MCP session, so asserting on the old locator races it.
    const closeSession = page.getByRole('button', { name: 'Close MCP session' });
    await closeSession.scrollIntoViewIfNeeded();
    await expect(closeSession).toBeInViewport({ timeout: browserTimeout });
    await closeSession.click();
    await expect(page.locator('.mcp-page-phase'), 'The Close MCP session click did not start the close action.')
      .toContainText(/Closing|Session closed/u, { timeout: browserTimeout });
    // The first route call the close makes for this binding decides its path.
    // Observing the DELETE too makes a force-close fail here, in milliseconds,
    // instead of waiting out a /close that will never be sent.
    const reopenedClose = () => appRequests.find((request) =>
      (request.method === 'POST' && request.path === `${reopenedAppPath}/close`) || (request.method === 'DELETE' && request.path === reopenedAppPath));
    await expect.poll(reopenedClose, { message: 'Closing the session sent no close request for the reopened App preview.', timeout: browserTimeout }).toBeDefined();
    const secondClose = reopenedClose();
    if (secondClose?.method !== 'POST') {
      throw new Error(`Expected the reopened App preview to close gracefully (POST ${reopenedAppPath}/close); the relay sent ${secondClose === undefined ? 'no close request' : `${secondClose.method} ${secondClose.path}`} instead.`);
    }
    const secondCloseBody = secondClose.body as Readonly<{ readonly id: string }>;
    await expect.poll(() => appRequests.some((request) => {
      const message = (request.body as { readonly message?: { readonly id?: string; readonly result?: unknown } } | undefined)?.message;
      return request.path === `${reopenedAppPath}/messages` && message?.id === secondCloseBody.id && message.result !== undefined;
    }), { message: 'The reopened App preview never acknowledged the graceful teardown.', timeout: browserTimeout }).toBe(true);
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

e2e('renders a compiler-bundled App that calls the host through createAppClient', { timeout: 90_000 * timeScale }, async ({ page }) => {
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

    await page.goto(workbenchUrl(foregroundOrigin, '/advanced/protocol'));
    await expectHeading(page, 'MCP playground');
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
    await expect(outerFrame).toHaveAttribute('data-mcp-app-relay-state', 'ready', { timeout: browserTimeout });
    await expect.poll(() => page.frames().filter((frame) => frame.url() === 'about:blank').length, { timeout: browserTimeout }).toBe(1);
    const appFrame = page.frames().find((frame) => frame.url() === 'about:blank');
    if (appFrame === undefined) throw new Error('Expected the sandbox proxy to create the bundled App srcdoc frame.');
    await expect.poll(() => appRequests.some((request) => request.method === 'POST' && request.path.endsWith('/messages')), {
      timeout: browserTimeout,
    }).toBe(true);
    const consent = page.getByLabel('MCP App consent');
    await expect(consent).toContainText('Tool: inner-echo', { timeout: browserTimeout });
    const allowCallTool = page.getByRole('button', { name: 'Allow call tool' });
    await expect(allowCallTool).toBeEnabled({ timeout: browserTimeout });
    await allowCallTool.click();
    await expect(appFrame.locator('#view')).toHaveText('{"echo":"from-compiled-app"}', { timeout: browserTimeout });
    await expect(appFrame.locator('#view')).toHaveCSS('color', 'rgb(18, 52, 86)', { timeout: browserTimeout });
    await expect(appFrame.locator('#view')).toHaveCSS('font-weight', '700', { timeout: browserTimeout });
    expect(appRequests.some((request) => request.method === 'GET' && /^\/api\/mcp\/apps\/[^/]+$/u.test(request.path))).toBe(false);

    const closed = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.origin === foregroundOrigin && request.url().startsWith(`${foregroundOrigin}/api/mcp/apps/`) && request.url().endsWith('/close');
    }, { timeout: 30_000 * timeScale });
    await page.getByRole('button', { name: 'Close App preview' }).click();
    await closed;
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

e2e('runs the App workspace call lifecycle from pending to result, error, and cancellation on an eligible launch (#747, #751)', { timeout: 120_000 * timeScale }, async ({ page }) => {
  let project: Awaited<ReturnType<typeof copyExample>> | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let testFailure: unknown;
  let cleanupFailure: unknown;
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];
  const appRequests: AppRouteRequest[] = [];
  try {
    await buildWorkbench();
    project = await copyExample('mcp-app');
    await writeLifecycleServer(project.root);
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
      if (url.origin !== foregroundOrigin || !url.pathname.startsWith('/api/mcp/')) return;
      appRequests.push({ body: requestBody(request.postData()), method: request.method(), path: `${url.pathname}${url.search}` });
    });
    const failedOperations: string[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (response.status() >= 400 && url.origin === foregroundOrigin) failedOperations.push(`${String(response.status())} ${url.pathname}`);
    });

    const surface = await inspectWorkbenchSurface({ root: project.root });
    const appLeaf = applicationLeaves(surface.application).find((leaf) => leaf.ref.kind === 'app' && leaf.ref.server === 'lifecycle');
    if (appLeaf === undefined) throw new Error('Expected the fixture to publish the lifecycle App leaf.');
    await selectApplicationLeaf(page, foregroundOrigin, appLeaf);

    // #747: the launch list is the dev server's judgement for this server on
    // this build (declared targets grouped by launch identity, installed hosts
    // consulted), not the build's global target digests; the session opens
    // with the chosen launch's representative target.
    const launchSelect = page.getByLabel('Launch');
    await expect(launchSelect).toBeEnabled({ timeout: browserTimeout });
    const launchesRequest = appRequests.find((request) => request.path.startsWith('/api/mcp/launches?'));
    expect(launchesRequest?.path).toContain('serverName=lifecycle');
    await expect(page.locator('.app-session-phase')).toHaveText('ready', { timeout: 30_000 * timeScale });
    const chosenLaunch = await launchSelect.locator('option:checked').textContent();
    expect(chosenLaunch).toContain('portable');
    const openedSession = appRequests.find((request) => request.method === 'POST' && request.path === '/api/mcp/sessions');
    expect(openedSession?.body).toMatchObject({ serverName: 'lifecycle', target: chosenLaunch?.split(' · ')[0] });

    // Each call mounts a fresh preview; the newest App frame is the last one
    // attached, and a closing predecessor may linger for a moment.
    const appText = async (): Promise<string | undefined> => {
      let text: string | undefined;
      for (const frame of page.frames()) {
        if (frame.url() !== 'about:blank') continue;
        try {
          const locator = frame.locator('#view');
          if (await locator.count() === 1) text = await locator.textContent() ?? undefined;
        } catch {
          // The sandbox proxy replaces its inner frame once while installing the App document.
        }
      }
      return text;
    };
    const outcome = page.getByTestId('app-call-outcome');
    const preview = page.locator('iframe[title^="MCP App preview"]');

    // #751 result: the preview mounts while the call is in flight, the App
    // hears its input first, then the one result once the tool finishes.
    await page.getByLabel('delayMs').fill('4000');
    await page.getByRole('button', { name: 'Call tool and preview' }).click();
    await expect(outcome.locator('summary')).toHaveText('Tool call pending', { timeout: browserTimeout });
    await expect(preview).toBeVisible({ timeout: browserTimeout });
    await expect.poll(appText, { timeout: browserTimeout }).toBe('input:{"delayMs":4000}');
    expect(await outcome.locator('summary').textContent()).toBe('Tool call pending');
    await expect(outcome.locator('summary')).toHaveText('Tool result', { timeout: 20_000 * timeScale });
    await expect.poll(appText, { timeout: browserTimeout }).toBe('result:{"waited":4000}');
    const settles = () => appRequests.filter((request) => request.method === 'POST' && request.path.endsWith('/result'));
    expect(settles()).toHaveLength(1);
    expect(settles()[0]?.body).toMatchObject({ result: { structuredContent: { waited: 4000 } } });
    expect(appRequests.filter((request) => request.method === 'POST' && /\/api\/mcp\/sessions\/[^/]+\/apps$/u.test(request.path)).at(-1)?.body).not.toHaveProperty('result');

    // #751 error: a tool error is still the call's one result; the App's
    // error listener sees it.
    await page.getByLabel('delayMs').fill('0');
    await page.getByRole('checkbox', { name: 'fail' }).check();
    await page.getByRole('button', { name: 'Call tool and preview' }).click();
    await expect(outcome.locator('summary')).toHaveText('Tool result', { timeout: browserTimeout });
    await expect.poll(appText, { timeout: browserTimeout }).toBe('error:The opening tool returned an error.');
    expect(settles()).toHaveLength(2);
    await page.getByRole('checkbox', { name: 'fail' }).uncheck();

    // #751 cancel: cancelling the pending call tells the App once and never
    // lets a late result overwrite it.
    await page.getByLabel('delayMs').fill('60000');
    await page.getByRole('button', { name: 'Call tool and preview' }).click();
    await expect.poll(appText, { timeout: browserTimeout }).toBe('input:{"delayMs":60000,"fail":false}');
    await page.getByRole('button', { name: 'Cancel call' }).click();
    await expect(outcome.locator('summary')).toHaveText('Tool call cancelled', { timeout: browserTimeout });
    await expect(outcome).toContainText('Cancelled from the Workbench.');
    await expect.poll(appText, { timeout: browserTimeout }).toBe('cancelled:Cancelled from the Workbench.');
    expect(settles()).toHaveLength(3);
    expect(settles()[2]?.body).toEqual({ cancelled: 'Cancelled from the Workbench.' });
    await expect(page.getByRole('button', { name: 'Call tool and preview' })).toBeEnabled();
    await expect(page.getByRole('alert').filter({ hasText: 'failed' })).toHaveCount(0);
    // The cancelled call is the only failed foreground response: the session
    // route answers the aborted operation with its 502 diagnostic, which Chrome
    // logs as a failed resource load. Nothing else may fail.
    expect(failedOperations).toEqual([expect.stringMatching(/^502 \/api\/mcp\/sessions\/[^/]+\/operations$/u)]);
    expect(consoleErrors).toEqual(['Failed to load resource: the server responded with a status of 502 (Bad Gateway)']);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    testFailure = error;
  } finally {
    const serverCleanup = await Promise.allSettled(server === undefined ? [] : [server.close()]);
    const projectCleanup = await Promise.allSettled(project === undefined ? [] : [project.release()]);
    const failedCleanup = [...serverCleanup, ...projectCleanup].find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') cleanupFailure = failedCleanup.reason;
  }
  if (testFailure !== undefined) throw testFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
});
