import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { chromium } from 'playwright';

import { closeServer } from './support/http.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const pageComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-page.tsx');

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('MCP App browser fixture did not receive a TCP address.');
  return `http://127.0.0.1:${address.port}`;
};

const proxyDocument = `<!doctype html>
<main id="sandbox">MCP Apps SDK v2 fixture</main>
<script>
  const send = (message) => parent.postMessage(message, '*');
  addEventListener('message', (event) => {
    const message = event.data;
    if (message?.method === 'ui/notifications/sandbox-resource-ready') {
      document.body.dataset.resource = message.params.html;
      send({ id: 'initialize', jsonrpc: '2.0', method: 'ui/initialize', params: { appCapabilities: { availableDisplayModes: ['inline'] }, appInfo: { name: 'fixture-app', version: '1.0.0' }, protocolVersion: '2026-01-26' } });
      return;
    }
    if (message?.id === 'initialize') {
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
      send({ id: 'app-tool', jsonrpc: '2.0', method: 'tools/call', params: { arguments: { from: 'sandbox' }, name: 'nested-tool' } });
      send({ id: 'resource-read', jsonrpc: '2.0', method: 'resources/read', params: { uri: 'weather://berlin' } });
      send({ id: 'display-mode', jsonrpc: '2.0', method: 'ui/request-display-mode', params: { mode: 'inline' } });
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { data: { event: 'sandbox-initialized' }, level: 'info', logger: 'fixture-app' } });
      return;
    }
    if (typeof message?.id === 'string' && message.id.startsWith('mcp-app-frame-close:')) {
      send({ id: message.id, jsonrpc: '2.0', result: {} });
    }
  });
  send({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' });
</script>`;

const mountedPageFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-page-app-'));
  const sandbox = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(proxyDocument);
  });
  const sandboxOrigin = await listen(sandbox);
  const entry = join(root, 'page.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { McpPage } from ${JSON.stringify(pageComponent)};`,
    '',
    `const sandboxOrigin = ${JSON.stringify(sandboxOrigin)};`,
    "const resource = { csp: {}, html: '<main>Weather resource</main>', kind: 'resource', permissions: {} };",
    "const frame = { allow: '', policy: { contentSecurityPolicy: \"default-src 'none'\", iframeAllow: '', permissionsPolicy: 'camera=()' }, referrerPolicy: 'no-referrer', relay: { maxMessageBytes: 4096, maxQueuedMessages: 16 }, sandbox: 'allow-scripts allow-same-origin', src: `${sandboxOrigin}/#mcp-app-preview`, targetOrigin: sandboxOrigin };",
    "const history = [",
    "  { id: 'weather-call', operation: 'callTool', request: { arguments: { city: 'Paris', partial: true }, name: 'weather' }, result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 22 } }, timing: { completedAt: 2, durationMs: 1, startedAt: 1 } },",
    "  { id: 'wrong-mime-call', operation: 'callTool', request: { arguments: { city: 'Paris' }, name: 'wrong-mime' }, result: { content: [{ text: 'ordinary wrong MIME result', type: 'text' }] }, timing: { completedAt: 4, durationMs: 1, startedAt: 3 } },",
    "  { id: 'legacy-template-call', operation: 'callTool', request: { arguments: { city: 'Paris' }, name: 'legacy-output-template' }, result: { content: [{ text: 'ordinary legacy result', type: 'text' }] }, timing: { completedAt: 6, durationMs: 1, startedAt: 5 } },",
    "];",
    "let model = { activeRequests: {}, catalogs: { prompts: [], resourceTemplates: [], resources: [], tools: [{ name: 'weather' }] }, conciseTrace: [], diagnostics: [], logs: [], phase: 'ready', progress: [], sessionId: 'session-weather', timeline: { droppedThroughSequence: 0, entries: [], lastSequence: 0 } };",
    'const listeners = new Set();',
    'const creates = []; const messages = []; const closes = []; const controllerEvents = [];',
    'const emit = () => { for (const listener of listeners) listener(model); };',
    "const profile = (name) => ({ kind: 'apps', profile: name, resourceUri: 'ui://fixture/weather.html', ...(name === 'chatgpt' ? { extensions: { openai: {} } } : {}) });",
    'const appClient = {',
    '  async create(sessionId, request) {',
    '    creates.push({ request, sessionId });',
    "    const bindingId = `binding-${creates.length}`;",
    "    if (request.toolName === 'wrong-mime' || request.toolName === 'legacy-output-template') return { bindingId, profile: { kind: 'fallback', profile: request.previewProfile }, resource: { input: request.input, kind: 'fallback', reason: request.toolName === 'wrong-mime' ? 'unsupported-media-type' : 'legacy-output-template', result: request.result } };",
    '    return { bindingId, frame, profile: profile(request.previewProfile), resource };',
    '  },',
    '  async message(bindingId, message) {',
    '    messages.push({ bindingId, message });',
    "    if (typeof message.id === 'string' && message.id.startsWith('mcp-app-frame-close:')) return { accepted: true, lifecycle: 'closed', messages: [] };",
    "    if (message.method === 'ui/initialize') return { accepted: true, lifecycle: 'initialized', messages: [{ id: message.id, jsonrpc: '2.0', result: { hostCapabilities: { logging: {} }, hostContext: { availableDisplayModes: ['inline'], displayMode: 'inline', theme: 'light' }, hostInfo: { name: 'fixture-host', version: '1.0.0' }, protocolVersion: '2026-01-26' } }] };",
    "    if (message.method === 'tools/call') return { accepted: true, lifecycle: 'initialized', messages: [{ id: message.id, jsonrpc: '2.0', result: { content: [{ text: 'nested result', type: 'text' }] } }] };",
    "    if (message.method === 'resources/read') return { accepted: true, lifecycle: 'initialized', messages: [{ id: message.id, jsonrpc: '2.0', result: { contents: [{ mimeType: 'text/plain', text: 'nested resource', uri: message.params.uri }] } }] };",
    "    if (message.method === 'ui/request-display-mode') return { accepted: true, lifecycle: 'initialized', messages: [{ id: message.id, jsonrpc: '2.0', result: { mode: 'inline' } }] };",
    "    return { accepted: true, lifecycle: 'initialized', messages: [] };",
    '  },',
    '  async close(bindingId, options) { closes.push({ bindingId, options, type: \'close\' }); return { lifecycle: \'closing\', message: { id: options.id, jsonrpc: \'2.0\', method: \'ui/resource-teardown\' } }; },',
    "  async forceClose(bindingId) { closes.push({ bindingId, type: 'force' }); return true; },",
    '};',
    'const controller = {',
    '  get history() { return history; }, get model() { return model; },',
    '  cancel: () => true,',
    "  async close() { controllerEvents.push({ appCloseCount: closes.length, type: 'close' }); model = { ...model, phase: 'closed' }; emit(); },",
    "  async invoke(input) { controllerEvents.push({ input, type: 'invoke' }); return { content: [] }; },",
    '  async open() { return model; }, async replay(input) { controllerEvents.push({ input, type: \'replay\' }); return { content: [] }; },',
    '  async restart() { controllerEvents.push({ type: \'restart\' }); return model; },',
    '  subscribe(listener) { listeners.add(listener); listener(model); return () => listeners.delete(listener); },',
    '};',
    "createRoot(document.getElementById('root')).render(React.createElement(McpPage, { appPreviewClient: appClient, controller, epochOptions: ['epoch-1'], targetOptions: ['portable'] }));",
    "globalThis.__mcpPageAppFixture = { stats: () => ({ closes: structuredClone(closes), controllerEvents: structuredClone(controllerEvents), creates: structuredClone(creates), messages: structuredClone(messages), sandboxOrigin }), terminateAndClickClose: (phase) => { model = { ...model, phase }; emit(); [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close App preview')?.click(); } };",
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: {
      output: {
        cleanDistPath: false,
        distPath: { css: 'assets', js: 'assets', root: dist },
        filename: { css: '[name].css', js: '[name].js' },
        filenameHash: false,
      },
      plugins: [pluginReact()],
      resolve: {
        alias: {
          react: join(workspaceRoot, 'node_modules', 'react'),
          'react-dom/client': join(workspaceRoot, 'node_modules', 'react-dom', 'client.js'),
        },
      },
      source: {
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        entry: { page: entry },
      },
    },
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('page.html')) throw new Error('MCP App page fixture did not produce its browser document.');
  const outer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'page.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) return response.writeHead(404).end();
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const outerOrigin = await listen(outer);
  return {
    close: async () => {
      await closeServer(outer);
      await closeServer(sandbox);
      await rm(root, { force: true, recursive: true });
    },
    outerOrigin,
    root,
  };
};

describe('MCP App page browser integration', () => {
  it('runs the modern Apps-v2 preview lifecycle through the page without leaking credentials or sessions', async () => {
    const fixture = await mountedPageFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { creates: readonly unknown[] } } }).__mcpPageAppFixture.stats().creates.length === 1);
      const frame = page.getByTitle('MCP App preview: weather');
      await frame.waitFor();
      const frameUrl = new URL((await frame.getAttribute('src'))!);
      expect(frameUrl.origin).not.toBe(fixture.outerOrigin);
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(await frame.contentFrame()?.locator('body').innerText()).not.toContain('foreground-token');
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { messages: readonly { readonly bindingId: string; readonly message: { readonly method?: string } }[] } } }).__mcpPageAppFixture.stats().messages.some(({ bindingId, message }) => bindingId === 'binding-1' && message.method === 'ui/notifications/initialized'));
      const first = await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): unknown } }).__mcpPageAppFixture.stats()) as {
        readonly creates: readonly { readonly request: { readonly host: { readonly displayMode: string; readonly locale: string; readonly theme: string }; readonly input: unknown; readonly previewProfile: string; readonly result: unknown; readonly toolName: string }; readonly sessionId: string }[];
        readonly messages: readonly { readonly message: { readonly method?: string } }[];
      };
      expect(first.creates[0]).toMatchObject({
        request: {
          input: { city: 'Paris', partial: true },
          previewProfile: 'portable',
          result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 22 } },
          toolName: 'weather',
        },
        sessionId: 'session-weather',
      });
      expect(first.creates[0]!.request.host).toMatchObject({ displayMode: 'inline' });
      expect(['light', 'dark']).toContain(first.creates[0]!.request.host.theme);
      expect(first.creates[0]!.request.host.locale.length).toBeGreaterThan(0);
      expect(first.messages.map(({ message }) => message.method)).toEqual(expect.arrayContaining([
        'ui/initialize', 'ui/notifications/initialized', 'tools/call', 'resources/read', 'ui/request-display-mode', 'notifications/message',
      ]));

      await page.selectOption('#mcp-app-profile', 'chatgpt');
      await page.waitForFunction(() => {
        const fixture = (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { creates: readonly { readonly request: { readonly previewProfile: string } }[]; readonly messages: readonly { readonly bindingId: string; readonly message: { readonly method?: string } }[] } } }).__mcpPageAppFixture;
        return fixture.stats().creates.some(({ request }) => request.previewProfile === 'chatgpt') &&
          fixture.stats().messages.some(({ bindingId, message }) => bindingId === 'binding-2' && message.method === 'ui/notifications/initialized');
      });
      expect(await page.getByLabel('MCP App preview', { exact: true }).textContent()).toContain('chatgpt');
      await page.selectOption('#mcp-app-profile', 'claude');
      await page.waitForFunction(() => {
        const fixture = (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { creates: readonly { readonly request: { readonly previewProfile: string } }[]; readonly messages: readonly { readonly bindingId: string; readonly message: { readonly method?: string } }[] } } }).__mcpPageAppFixture;
        return fixture.stats().creates.some(({ request }) => request.previewProfile === 'claude') &&
          fixture.stats().messages.some(({ bindingId, message }) => bindingId === 'binding-3' && message.method === 'ui/notifications/initialized');
      });
      expect(await page.getByLabel('MCP App preview', { exact: true }).textContent()).toContain('claude');

      await page.getByRole('button', { name: 'Close App preview' }).click();
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { closes: readonly unknown[] } } }).__mcpPageAppFixture.stats().closes.length >= 3);
      await page.getByRole('button', { name: 'List tools' }).click();
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { controllerEvents: readonly { readonly type: string }[] } } }).__mcpPageAppFixture.stats().controllerEvents.some(({ type }) => type === 'invoke'));

      await page.getByRole('button', { name: 'Open App preview for wrong-mime-call' }).click();
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('unsupported-media-type');
      await page.getByRole('button', { name: 'Close App preview' }).click();
      await page.getByRole('button', { name: 'Open App preview for legacy-template-call' }).click();
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('legacy-output-template');
      await page.getByRole('button', { name: 'Close App preview' }).click();

      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { terminateAndClickClose(phase: 'error'): void } }).__mcpPageAppFixture.terminateAndClickClose('error'));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      expect(await page.locator('.mcp-page-phase').textContent()).toContain('Session error');
      const final = await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): unknown } }).__mcpPageAppFixture.stats()) as {
        readonly closes: readonly unknown[];
        readonly creates: readonly { readonly request: Readonly<Record<string, unknown>> }[];
      };
      expect(final.closes).toHaveLength(6);
      expect(final.creates.every(({ request }) => !Object.hasOwn(request, 'toolMetadata') && !Object.hasOwn(request, 'resourceUri'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { terminateAndClickClose(phase: 'closed'): void } }).__mcpPageAppFixture.terminateAndClickClose('closed'));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      expect(await page.locator('.mcp-page-phase').textContent()).toContain('Session closed');
      const closedTerminal = await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { closes: readonly unknown[] } } }).__mcpPageAppFixture.stats().closes);
      expect(closedTerminal).toHaveLength(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
      await expect(readdir(fixture.root)).rejects.toThrow();
    }
  }, 45_000);
});
