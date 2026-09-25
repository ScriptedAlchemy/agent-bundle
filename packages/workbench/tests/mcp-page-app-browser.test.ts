import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';
import { chromium, type Page } from 'playwright';

import { closeServer } from './support/http.ts';
import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';
import { removeTree } from './support/remove-tree.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const pageComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-page.tsx');

type McpPageAppFixtureGlobal = typeof globalThis & {
  readonly __mcpPageAppFixture: {
    readonly stats: () => {
      readonly creates: readonly { readonly request: { readonly previewProfile: string } }[];
      readonly messages: readonly { readonly bindingId: string; readonly message: { readonly method?: string } }[];
    };
  };
};

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
  const sandboxRequests: string[] = [];
  const sandboxRequestWaiters: Array<(url: string) => void> = [];
  const sandbox = createServer((request, response) => {
    const url = request.url ?? '';
    sandboxRequests.push(url);
    for (const waiter of sandboxRequestWaiters.splice(0)) waiter(url);
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
    "const frame = (revision = 1) => ({ allow: '', documentPolicy: { allow: '', approvedPermissions: {}, revision, warnings: [] }, policy: { contentSecurityPolicy: \"default-src 'none'\", iframeAllow: '', permissionsPolicy: 'camera=()' }, referrerPolicy: 'no-referrer', relay: { maxMessageBytes: 4096, maxQueuedMessages: 16 }, sandbox: 'allow-scripts allow-same-origin', src: `${sandboxOrigin}/#mcp-app-preview`, targetOrigin: sandboxOrigin });",
    "const history = [",
    "  { id: 'weather-call', operation: 'callTool', request: { arguments: { city: 'Paris', partial: true }, name: 'weather' }, result: { content: [{ text: 'Sunny', type: 'text' }], structuredContent: { temperature: 22 } }, timing: { completedAt: 2, durationMs: 1, startedAt: 1 } },",
    "  { id: 'wrong-mime-call', operation: 'callTool', request: { arguments: { city: 'Paris' }, name: 'wrong-mime' }, result: { content: [{ text: 'ordinary wrong MIME result', type: 'text' }] }, timing: { completedAt: 4, durationMs: 1, startedAt: 3 } },",
    "  { id: 'legacy-template-call', operation: 'callTool', request: { arguments: { city: 'Paris' }, name: 'legacy-output-template' }, result: { content: [{ text: 'ordinary legacy result', type: 'text' }] }, timing: { completedAt: 6, durationMs: 1, startedAt: 5 } },",
    "];",
    "let model = { activeRequests: {}, catalogs: { prompts: [], resourceTemplates: [], resources: [], tools: [{ name: 'weather' }] }, conciseTrace: [], diagnostics: [], logs: [], phase: 'ready', progress: [], sessionId: 'session-weather', timeline: { droppedThroughSequence: 0, entries: [], lastSequence: 0 } };",
    'const listeners = new Set();',
    'const creates = []; const messages = []; const closes = []; const controllerEvents = [];',
    'let documentRevision = 1;',
    'const emit = () => { for (const listener of listeners) listener(model); };',
    "const profile = (name) => ({ kind: 'apps', profile: name, resourceUri: 'ui://fixture/weather.html', ...(name === 'chatgpt' ? { extensions: { openai: {} } } : {}) });",
    'const appClient = {',
    '  async create(sessionId, request) {',
    '    creates.push({ request, sessionId });',
    "    const bindingId = `binding-${creates.length}`;",
    "    if (request.toolName === 'wrong-mime' || request.toolName === 'legacy-output-template') return { bindingId, profile: { kind: 'fallback', profile: request.previewProfile }, resource: { input: request.input, kind: 'fallback', reason: request.toolName === 'wrong-mime' ? 'unsupported-media-type' : 'legacy-output-template', result: request.result } };",
    '    return { bindingId, frame: frame(), profile: profile(request.previewProfile), resource };',
    '  },',
    "  async consentChallenges(bindingId) { return bindingId === 'binding-1' && documentRevision === 1 ? [{ expiresAt: Date.now() + 30000, id: 'document-geolocation', request: { capability: 'geolocation', details: {}, scope: 'document', summary: 'Allow MCP App geolocation?' } }] : []; },",
    "  async decideConsent(bindingId, challengeId, approved) { if (bindingId !== 'binding-1' || challengeId !== 'document-geolocation' || !approved || documentRevision !== 1) return { approved: false, messages: [], preview: { bindingId, frame: frame(documentRevision), profile: profile('portable'), resource } }; documentRevision = 2; return { approved: true, messages: [], preview: { bindingId, frame: frame(2), profile: profile('portable'), resource } }; },",
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
    "const rootView = createRoot(document.getElementById('root'));",
    "const renderPage = (presentationActive = true) => rootView.render(React.createElement(McpPage, { appPreviewClient: appClient, controller, epochOptions: ['epoch-1'], presentationActive, targetOptions: ['portable'] }));",
    "renderPage();",
    "globalThis.__mcpPageAppFixture = { setActive: (active) => renderPage(active), stats: () => ({ closes: structuredClone(closes), controllerEvents: structuredClone(controllerEvents), creates: structuredClone(creates), messages: structuredClone(messages), sandboxOrigin }), terminateAndClickClose: (phase) => { model = { ...model, phase }; emit(); [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close App preview')?.click(); } };",
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: createWorkbenchFixtureConfig({ distRoot: dist, entry: { page: entry } }),
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
      await removeTree(root);
    },
    /**
     * Resolves with the next sandbox document request the server accepts.
     * Arm it before the action that provokes the load: an iframe's presence in
     * the DOM only proves the element was inserted, not that its document
     * request has reached this server yet.
     */
    nextSandboxRequest: () => new Promise<string>((resolvePromise) => { sandboxRequestWaiters.push(resolvePromise); }),
    outerOrigin,
    root,
    sandboxRequests: () => [...sandboxRequests],
  };
};

type McpPageAppLifecycleStats = Readonly<{
  readonly closes: readonly { readonly bindingId: string; readonly type: 'close' | 'force' }[];
  readonly creates: readonly unknown[];
  readonly messages: readonly { readonly bindingId: string; readonly message: { readonly method?: string } }[];
}>;

/**
 * Event-ordered lifecycle waits for the artifact fixture. Each waits for the
 * fixture's own record of the route call rather than for DOM side effects: an
 * iframe in the DOM says nothing about whether its proxy has loaded, and an
 * iframe gone from the DOM says nothing about which route calls have landed.
 */
const lifecycleWaits = (page: Page) => ({
  /** The proxy loaded, handed the app its resource, and the app completed `ui/initialize`. */
  initialized: (bindingId: string) => page.waitForFunction((id) => (globalThis as typeof globalThis & {
    __mcpPageAppFixture: { stats(): McpPageAppLifecycleStats };
  }).__mcpPageAppFixture.stats().messages.some((entry) => entry.bindingId === id && entry.message.method === 'ui/notifications/initialized'), bindingId),
  /** The page released the binding through exactly one close route call (graceful or forced). */
  closed: (bindingId: string) => page.waitForFunction((id) => (globalThis as typeof globalThis & {
    __mcpPageAppFixture: { stats(): McpPageAppLifecycleStats };
  }).__mcpPageAppFixture.stats().closes.some((entry) => entry.bindingId === id), bindingId),
  stats: (): Promise<McpPageAppLifecycleStats> => page.evaluate(() => (globalThis as typeof globalThis & {
    __mcpPageAppFixture: { stats(): McpPageAppLifecycleStats };
  }).__mcpPageAppFixture.stats()),
});

describe('MCP App page browser integration', () => {
  it('runs the modern Apps-v2 preview lifecycle through the page without leaking credentials or sessions', async () => {
    const fixture = await mountedPageFixture();
    const browser = await chromium.launch(browserLaunchOptions);
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    const lifecycle = lifecycleWaits(page);
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
      await lifecycle.initialized('binding-1');
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

      const sandboxRequestsBeforeRemount = fixture.sandboxRequests().length;
      await page.evaluate(() => {
        const trace: string[] = [];
        const snapshot = (): string => {
          const current = document.querySelector('iframe[title^="MCP App preview"]');
          return current === null ? 'none' : `${current.getAttribute('title')}|${current.getAttribute('src')}|${current.getAttribute('data-mcp-app-document-revision')}`;
        };
        const observer = new MutationObserver(() => { trace.push(snapshot()); });
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-mcp-app-document-revision', 'src', 'title'], childList: true, subtree: true });
        trace.push(snapshot());
        Object.assign(globalThis, { __mcpPageRemountTrace: { stop: () => observer.disconnect(), values: () => [...trace] } });
      });
      const remountedDocumentRequest = fixture.nextSandboxRequest();
      await page.getByRole('button', { name: 'Allow geolocation' }).click();
      await page.locator('iframe[title="MCP App preview: weather"][data-mcp-app-document-revision="2"]').waitFor();
      const remountTrace = await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageRemountTrace: { readonly stop: () => void; readonly values: () => readonly string[] } }).__mcpPageRemountTrace.values());
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageRemountTrace: { readonly stop: () => void } }).__mcpPageRemountTrace.stop());
      const blank = remountTrace.findIndex((value) => value.startsWith('MCP App preview reload barrier: weather|about:blank|2'));
      const refreshed = remountTrace.findIndex((value, index) => index > blank && value.startsWith('MCP App preview: weather|') && value.endsWith('|2'));
      expect(blank).toBeGreaterThanOrEqual(0);
      expect(refreshed).toBeGreaterThan(blank);
      // The remounted document's request is a network event that trails the
      // DOM insertion the locator above observed; wait for the server to
      // accept it before asserting exactly one sandbox load.
      expect(await remountedDocumentRequest).toBe('/');
      expect(fixture.sandboxRequests().slice(sandboxRequestsBeforeRemount)).toEqual(['/']);
      // The remounted proxy must reach the app before the graceful teardown
      // below can be acknowledged by it (the initialize count doubles because
      // the refreshed document runs the handshake again).
      await page.waitForFunction(() => (globalThis as McpPageAppFixtureGlobal).__mcpPageAppFixture.stats().messages
        .filter(({ bindingId, message }) => bindingId === 'binding-1' && message.method === 'ui/notifications/initialized').length === 2);

      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { setActive(active: boolean): void } }).__mcpPageAppFixture.setActive(false));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      await lifecycle.closed('binding-1');
      expect((await lifecycle.stats()).closes).toEqual([{ bindingId: 'binding-1', options: expect.any(Object), type: 'close' }]);
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { setActive(active: boolean): void } }).__mcpPageAppFixture.setActive(true));
      expect(await page.getByText('Select a completed tool call below to create an App preview.').count()).toBe(1);

      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();
      // Switching profiles tears the current binding down first; wait for its
      // app to be initialized so the teardown is acknowledged by a proxy that
      // exists, not posted into a document that is still loading.
      await lifecycle.initialized('binding-2');

      await page.selectOption('#mcp-app-profile', 'chatgpt');
      await page.waitForFunction(() => {
        const stats = (globalThis as McpPageAppFixtureGlobal).__mcpPageAppFixture.stats();
        const createIndex = stats.creates.findIndex(({ request }) => request.previewProfile === 'chatgpt');
        return createIndex >= 0 && stats.messages.some(({ bindingId, message }) => bindingId === `binding-${createIndex + 1}` && message.method === 'ui/notifications/initialized');
      });
      expect(await page.getByLabel('MCP App preview', { exact: true }).textContent()).toContain('chatgpt');
      await page.selectOption('#mcp-app-profile', 'claude');
      await page.waitForFunction(() => {
        const stats = (globalThis as McpPageAppFixtureGlobal).__mcpPageAppFixture.stats();
        const createIndex = stats.creates.findIndex(({ request }) => request.previewProfile === 'claude');
        return createIndex >= 0 && stats.messages.some(({ bindingId, message }) => bindingId === `binding-${createIndex + 1}` && message.method === 'ui/notifications/initialized');
      });
      expect(await page.getByLabel('MCP App preview', { exact: true }).textContent()).toContain('claude');

      await page.getByRole('button', { name: 'Close App preview' }).click();
      await lifecycle.closed('binding-4');
      await page.getByRole('button', { name: 'List tools' }).click();
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { controllerEvents: readonly { readonly type: string }[] } } }).__mcpPageAppFixture.stats().controllerEvents.some(({ type }) => type === 'invoke'));

      await page.getByRole('button', { name: 'Open App preview for wrong-mime-call' }).click();
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('unsupported-media-type');
      await page.getByRole('button', { name: 'Close App preview' }).click();
      await lifecycle.closed('binding-5');
      await page.getByRole('button', { name: 'Open App preview for legacy-template-call' }).click();
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('legacy-output-template');
      await page.getByRole('button', { name: 'Close App preview' }).click();
      await lifecycle.closed('binding-6');

      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();
      await lifecycle.initialized('binding-7');
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { terminateAndClickClose(phase: 'error'): void } }).__mcpPageAppFixture.terminateAndClickClose('error'));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      expect(await page.locator('.mcp-page-phase').textContent()).toContain('Session error');
      await lifecycle.closed('binding-7');
      const final = await lifecycle.stats() as McpPageAppLifecycleStats & {
        readonly creates: readonly { readonly request: Readonly<Record<string, unknown>> }[];
      };
      // Every binding the page created was released through exactly one
      // route call, in creation order: the canonical frames gracefully (the
      // app acknowledged its teardown), the frameless fallbacks by force.
      expect(final.creates).toHaveLength(7);
      expect(final.closes.map(({ bindingId, type }) => `${bindingId}:${type}`)).toEqual([
        'binding-1:close', 'binding-2:close', 'binding-3:close', 'binding-4:close', 'binding-5:force', 'binding-6:force', 'binding-7:close',
      ]);
      expect(final.creates.every(({ request }) => !Object.hasOwn(request, 'toolMetadata') && !Object.hasOwn(request, 'resourceUri'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();
      await lifecycle.initialized('binding-1');
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { terminateAndClickClose(phase: 'closed'): void } }).__mcpPageAppFixture.terminateAndClickClose('closed'));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      expect(await page.locator('.mcp-page-phase').textContent()).toContain('Session closed');
      await lifecycle.closed('binding-1');
      expect((await lifecycle.stats()).closes.map(({ bindingId, type }) => `${bindingId}:${type}`)).toEqual(['binding-1:close']);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
      await expect(readdir(fixture.root)).rejects.toThrow();
    }
  }, 45_000);
});
