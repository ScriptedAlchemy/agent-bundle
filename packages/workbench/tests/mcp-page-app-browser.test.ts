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
import { workbenchBrowserAliases } from './support/workbench-browser-modules.ts';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const pageComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-page.tsx');
const runtimeClientSource = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-app-client.ts');
const runtimeRouteClientSource = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-route-client.ts');

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

const mountedPageFixture = async (mode: 'artifact' | 'runtime' | 'runtime-direct' = 'artifact') => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-page-app-'));
  const sandboxRequests: string[] = [];
  const sandbox = createServer((request, response) => {
    sandboxRequests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/html' }).end(proxyDocument);
  });
  const sandboxOrigin = await listen(sandbox);
  const entry = join(root, 'page.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { McpPage } from ${JSON.stringify(pageComponent)};`,
    `import { McpAppClient } from ${JSON.stringify(runtimeClientSource)};`,
    `import { ForegroundRouteClient } from ${JSON.stringify(runtimeRouteClientSource)};`,
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
    ...(mode !== 'artifact' ? [
      "const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status: 200 });",
      "const deferred = () => { let resolve; let reject; const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; }); return { promise, reject, resolve }; };",
      `const runtimeBootstrapUrl = ${JSON.stringify(`${sandboxOrigin}/runtime-bootstrap`)};`,
      "const runtimePolicy = { allow: '', approvedPermissions: {}, revision: 1, warnings: [] };",
      "const runtimeBinding = { definitionDigest: 'definition-runtime-weather', evidence: 'simulated', id: 'runtime-binding-weather', profileId: 'portable', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', registryRevision: 4, runVector: { runtimeGenerationId: 'generation-runtime-weather', sourceRevision: 'source-runtime-weather', stateVersion: 1 }, serverDigest: 'server-runtime-weather', serverName: 'runtime-weather', sessionId: 'runtime-session-weather', sessionRevision: 2, target: 'portable', transportDigest: 'transport-runtime-weather' };",
      "const runtimeStableBinding = { definitionDigest: runtimeBinding.definitionDigest, registryRevision: runtimeBinding.registryRevision, serverDigest: runtimeBinding.serverDigest, serverName: runtimeBinding.serverName, sessionId: runtimeBinding.sessionId, sessionRevision: runtimeBinding.sessionRevision, target: runtimeBinding.target, transportDigest: runtimeBinding.transportDigest };",
      "const runtimeMetadata = { extensions: { claude: {}, openai: {} }, provenance: {}, raw: {}, standard: {} };",
      "const runtimeResponseBinding = { ...runtimeStableBinding }; const runtimePreview = { binding: runtimeBinding, clientSurface: { bootstrapUrl: runtimeBootstrapUrl, origin: new URL(runtimeBootstrapUrl).origin, webSocketPath: '/rsbuild-hmr' }, documentPolicy: runtimePolicy, kind: 'apps', metadata: { resource: runtimeMetadata, result: runtimeMetadata, tool: runtimeMetadata }, operations: [], profile: { bootstrap: { kind: 'none' }, configExtensions: { entries: [], sourceRevision: 'source-runtime-weather' }, descriptor: { claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }, hostContext: { availableDisplayModes: ['inline'], containerDimensions: { height: 720, width: 1024 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light', timeZone: 'UTC', toolInfo: {}, userAgent: 'agent-bundle-runtime-mcp-app/1' }, kind: 'apps', metadata: runtimeMetadata, permissions: {}, resourceUri: 'ui://weather/runtime.html', warnings: [] }, resource: { html: '<main>Runtime weather</main>', permissions: {} }, result: { appVisible: { content: [] }, isError: false, modelVisible: {} }, session: { binding: runtimeResponseBinding, connection: { capabilities: { tools: {} }, protocolEra: 'modern', protocolVersion: '2026-01-26', server: { name: 'runtime-weather', version: '1.0.0' } }, state: 'ready' } };",
      "const runtimeRun = { completedAt: '2026-08-16T00:00:01.000Z', id: 'runtime-run-weather', input: { city: 'Paris' }, result: { app: { mcpBinding: runtimeStableBinding, resourceUri: 'ui://weather/runtime.html', surfaceId: 'mcp.edit-weather' }, modelVisible: { temperature: 22 }, trace: [], tree: [] }, startedAt: '2026-08-16T00:00:00.000Z', status: 'succeeded', surfaceId: 'mcp.render-weather', target: 'portable', vector: { runtimeGenerationId: 'generation-runtime-weather', sourceRevision: 'source-runtime-weather', stateVersion: 1 } };",
      "const runtimeProfile = { claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }; const runtimeSurface = { fixtures: [], id: 'mcp.render-weather', kind: 'mcp-app', label: 'Runtime weather', readOnly: false, targets: ['portable'] };",
      "const runtimeEvents = []; let heldCreate = deferred(); let bridgeCloseFailures = 0; let backendCloseFailures = 0; let registeredPreviewClose; const foreground = new ForegroundRouteClient({ fetch: async (input, init) => { const path = new URL(String(input), location.origin).pathname; if (path === '/api/project/session') { runtimeEvents.push('bootstrap'); return response({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: location.origin, token: 'foreground-secret' }); } if (path === '/api/runtime/apps' && init?.method === 'POST') { const request = JSON.parse(String(init?.body)); runtimeEvents.push('create:' + request.runId + ':' + request.profileId + ':' + request.expectedGenerationId); return heldCreate.promise; } if (path.startsWith('/api/runtime/apps/') && init?.method === 'DELETE') { const bindingId = decodeURIComponent(path.slice('/api/runtime/apps/'.length)); runtimeEvents.push('backend:' + bindingId); if (backendCloseFailures > 0) { backendCloseFailures -= 1; runtimeEvents.push('backend-failed:' + bindingId); throw new Error('runtime backend close failed'); } return response({ closed: true }); } throw new Error('Unexpected runtime fixture request ' + path); } }); const runtime = new McpAppClient({ foreground });",
      "let heldBridgeClose; const bridge = { addEventListener: () => undefined, close: async () => { runtimeEvents.push('bridge'); }, sendHostContextChange: async () => undefined, sendToolCancelled: async () => undefined, sendToolInput: async () => undefined, sendToolInputPartial: async () => undefined, sendToolResult: async () => undefined, teardownResource: async () => { runtimeEvents.push('renderer'); return {}; } }; const bridgeFactory = Object.assign(() => { runtimeEvents.push('factory'); return bridge; }, { close: async () => { runtimeEvents.push('bridge-factory'); if (heldBridgeClose !== undefined) { const held = heldBridgeClose; await held.promise; if (heldBridgeClose === held) heldBridgeClose = undefined; } if (bridgeCloseFailures > 0) { bridgeCloseFailures -= 1; runtimeEvents.push('bridge-factory-failed'); throw new Error('runtime bridge close failed'); } } }); const createBridgeFactory = () => bridgeFactory;",
      `const root = createRoot(document.getElementById('root')); root.render(React.createElement(McpPage, { controller, ${mode === 'runtime' ? "initialPreview: { binding: runtimeStableBinding, kind: 'runtime', preview: { kind: 'runtime', profile: runtimeProfile, profileId: 'portable', run: runtimeRun, surface: runtimeSurface } }, " : ''}registerPreviewClose: (close) => { registeredPreviewClose = close; return () => { if (registeredPreviewClose === close) registeredPreviewClose = undefined; }; }, runtimePreviewDependencies: { client: runtime, createBridgeFactory }, source: { binding: runtimeStableBinding, kind: 'runtime' } }));`,
      "globalThis.__mcpPageAppFixture = { beginRegisteredPreviewClose: () => { if (registeredPreviewClose === undefined) return false; void registeredPreviewClose().catch(() => undefined); return true; }, failRuntimeClose: () => { bridgeCloseFailures = 1; backendCloseFailures = 1; }, holdRuntimeClose: () => { heldBridgeClose = deferred(); }, mutateRuntimeInputs: () => { runtimeStableBinding.serverName = 'mutated-runtime-weather'; runtimeStableBinding.sessionRevision = 99; runtimeRun.id = 'mutated-runtime-run'; runtimeRun.input.city = 'Mutated'; runtimeRun.result.app.resourceUri = 'ui://mutated/runtime.html'; runtimeRun.result.app.surfaceId = 'mcp.edit-mutated-weather'; runtimeRun.vector.runtimeGenerationId = 'mutated-runtime-generation'; runtimeRun.surfaceId = 'mcp.render-mutated-weather'; runtimeSurface.id = 'mcp.render-mutated-weather'; model = { ...model }; emit(); }, resolveRuntimeCreate: () => { const current = heldCreate; heldCreate = undefined; current.resolve(response({ preview: runtimePreview })); }, resolveRuntimeClose: () => { const current = heldBridgeClose; heldBridgeClose = undefined; current.resolve(); }, stats: () => ({ closes: structuredClone(closes), controllerEvents: structuredClone(controllerEvents), creates: structuredClone(creates), messages: structuredClone(messages), previewCloseRegistered: registeredPreviewClose !== undefined, runtimeEvents: structuredClone(runtimeEvents), sandboxOrigin }), terminateAndClickClose: (phase) => { model = { ...model, phase }; emit(); [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close App preview')?.click(); }, unmount: () => root.unmount() };",
    ] : [
      "const rootView = createRoot(document.getElementById('root'));",
      "const renderPage = (presentationActive = true) => rootView.render(React.createElement(McpPage, { appPreviewClient: appClient, controller, epochOptions: ['epoch-1'], presentationActive, targetOptions: ['portable'] }));",
      "renderPage();",
      "globalThis.__mcpPageAppFixture = { setActive: (active) => renderPage(active), stats: () => ({ closes: structuredClone(closes), controllerEvents: structuredClone(controllerEvents), creates: structuredClone(creates), messages: structuredClone(messages), sandboxOrigin }), terminateAndClickClose: (phase) => { model = { ...model, phase }; emit(); [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close App preview')?.click(); } };",
    ]),
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
        alias: workbenchBrowserAliases,
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
    sandboxRequests: () => [...sandboxRequests],
  };
};

describe('MCP App page browser integration', () => {
  it('keeps the committed runtime evidence and preview request unchanged after caller mutation', async () => {
    const fixture = await mountedPageFixture('runtime');
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    type RuntimeStats = Readonly<{ readonly runtimeEvents: readonly string[] }>;
    const stats = (): Promise<RuntimeStats> => page.evaluate(() => (globalThis as typeof globalThis & {
      __mcpPageAppFixture: { stats(): RuntimeStats };
    }).__mcpPageAppFixture.stats());
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.some((event) => event.startsWith('create:')), undefined, { timeout: 5_000 });
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { mutateRuntimeInputs(): void };
      }).__mcpPageAppFixture.mutateRuntimeInputs());
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeCreate(): void };
      }).__mcpPageAppFixture.resolveRuntimeCreate());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('factory'), undefined, { timeout: 5_000 });

      const committed = await stats();
      expect(committed.runtimeEvents).toContain('create:runtime-run-weather:portable:generation-runtime-weather');
      expect(committed.runtimeEvents).not.toContain('create:mutated-runtime-run:portable:mutated-runtime-generation');
      expect(await page.getByLabel('Runtime-bound MCP session').textContent()).toContain('runtime-weather');
      expect(await page.getByLabel('Runtime-bound MCP session').textContent()).not.toContain('mutated-runtime-weather');
      expect(await page.getByLabel('Runtime App result').textContent()).toContain('Paris');
      expect(await page.getByLabel('Runtime App result').textContent()).not.toContain('Mutated');
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);

  it('retains a failed runtime lifecycle behind the registered Page close facade until its exact retry succeeds', async () => {
    const fixture = await mountedPageFixture('runtime');
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    type RuntimeStats = Readonly<{
      readonly controllerEvents: readonly { readonly type: string }[];
      readonly runtimeEvents: readonly string[];
    }>;
    const stats = (): Promise<RuntimeStats> => page.evaluate(() => (globalThis as typeof globalThis & {
      __mcpPageAppFixture: { stats(): RuntimeStats };
    }).__mcpPageAppFixture.stats());
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.some((event) => event.startsWith('create:')), undefined, { timeout: 5_000 }).catch(async (error: unknown) => {
        throw new Error(`Runtime Page fixture did not admit the runtime preview: ${JSON.stringify(await stats())}; ${pageErrors.join('\n')}`, { cause: error });
      });
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeCreate(): void };
      }).__mcpPageAppFixture.resolveRuntimeCreate());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('factory'), undefined, { timeout: 5_000 });
      await page.locator('.mcp-page-app-preview iframe').waitFor({ timeout: 5_000 });

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { failRuntimeClose(): void };
      }).__mcpPageAppFixture.failRuntimeClose());
      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { beginRegisteredPreviewClose(): boolean };
      }).__mcpPageAppFixture.beginRegisteredPreviewClose())).toBe(true);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('backend-failed:runtime-binding-weather'), undefined, { timeout: 5_000 });
      const failed = await stats();
      expect((failed as RuntimeStats & { readonly previewCloseRegistered: boolean }).previewCloseRegistered).toBe(true);
      expect(failed.controllerEvents.filter(({ type }) => type === 'restart')).toEqual([]);
      expect(failed.runtimeEvents.filter((event) => event === 'factory')).toHaveLength(1);
      expect(await page.locator('.mcp-page-app-preview').count()).toBe(1);

      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { beginRegisteredPreviewClose(): boolean };
      }).__mcpPageAppFixture.beginRegisteredPreviewClose())).toBe(true);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.filter((event) => event === 'backend:runtime-binding-weather').length === 2, undefined, { timeout: 5_000 });
      const retried = await stats();
      expect(retried.runtimeEvents.filter((event) => event === 'factory')).toHaveLength(1);
      expect(retried.runtimeEvents.filter((event) => event === 'backend:runtime-binding-weather')).toHaveLength(2);
      expect(await page.locator('.mcp-page-app-preview').count()).toBe(0);
      expect((retried as RuntimeStats & { readonly previewCloseRegistered: boolean }).previewCloseRegistered).toBe(true);
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { unmount(): void };
      }).__mcpPageAppFixture.unmount());
      await page.waitForFunction(() => !(globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): { readonly previewCloseRegistered: boolean } };
      }).__mcpPageAppFixture.stats().previewCloseRegistered, undefined, { timeout: 5_000 });
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);

  it('holds the selected runtime preview behind the registered Page close facade until child cleanup settles', async () => {
    const fixture = await mountedPageFixture('runtime');
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    type RuntimeStats = Readonly<{ readonly previewCloseRegistered: boolean; readonly runtimeEvents: readonly string[] }>;
    const stats = (): Promise<RuntimeStats> => page.evaluate(() => (globalThis as typeof globalThis & {
      __mcpPageAppFixture: { stats(): RuntimeStats };
    }).__mcpPageAppFixture.stats());
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.some((event) => event.startsWith('create:')), undefined, { timeout: 5_000 });
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeCreate(): void };
      }).__mcpPageAppFixture.resolveRuntimeCreate());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('factory'), undefined, { timeout: 5_000 });
      await page.locator('.mcp-page-app-preview iframe').waitFor({ timeout: 5_000 });

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { holdRuntimeClose(): void };
      }).__mcpPageAppFixture.holdRuntimeClose());
      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { beginRegisteredPreviewClose(): boolean };
      }).__mcpPageAppFixture.beginRegisteredPreviewClose())).toBe(true);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('bridge-factory'), undefined, { timeout: 5_000 });
      const held = await stats();
      expect(held.runtimeEvents).not.toContain('backend:runtime-binding-weather');
      expect(held.previewCloseRegistered).toBe(true);
      expect(await page.locator('.mcp-page-app-preview iframe').count()).toBe(1);

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeClose(): void };
      }).__mcpPageAppFixture.resolveRuntimeClose());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('backend:runtime-binding-weather'), undefined, { timeout: 5_000 });
      await page.waitForFunction(() => document.querySelector('.mcp-page-app-preview iframe') === null, undefined, { timeout: 5_000 });
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);

  it('mounts the initial runtime selection through the Page without artifact session admission', async () => {
    const fixture = await mountedPageFixture('runtime');
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    type RuntimeStats = Readonly<{
      readonly controllerEvents: readonly { readonly type: string }[];
      readonly creates: readonly unknown[];
      readonly runtimeEvents: readonly string[];
    }>;
    const stats = (): Promise<RuntimeStats> => page.evaluate(() => (globalThis as typeof globalThis & {
      __mcpPageAppFixture: { stats(): RuntimeStats };
    }).__mcpPageAppFixture.stats());
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.some((event) => event.startsWith('create:')), undefined, { timeout: 5_000 });

      expect(await page.locator('#mcp-epoch').count()).toBe(0);
      expect(await page.getByLabel('Runtime-bound MCP session').textContent()).toContain('runtime-session-weather');
      expect(await page.locator('.mcp-page-app-preview').count()).toBe(1);
      expect((await stats()).creates).toEqual([]);
      expect((await stats()).controllerEvents.filter(({ type }) => type === 'open')).toEqual([]);

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { unmount(): void };
      }).__mcpPageAppFixture.unmount());
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeCreate(): void };
      }).__mcpPageAppFixture.resolveRuntimeCreate());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('backend:runtime-binding-weather'), undefined, { timeout: 5_000 });
      const late = await stats();
      expect(late.runtimeEvents.some((event) => event === 'factory')).toBe(false);
      expect(fixture.sandboxRequests()).toEqual([]);

      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.some((event) => event.startsWith('create:')), undefined, { timeout: 5_000 });
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { resolveRuntimeCreate(): void };
      }).__mcpPageAppFixture.resolveRuntimeCreate());
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpPageAppFixture: { stats(): RuntimeStats };
      }).__mcpPageAppFixture.stats().runtimeEvents.includes('factory'), undefined, { timeout: 5_000 }).catch(async (error: unknown) => {
        throw new Error(`Runtime Page fixture did not construct an official bridge: ${JSON.stringify(await stats())}; ${pageErrors.join('\n')}`, { cause: error });
      });
      await page.locator('.mcp-page-app-preview iframe').waitFor({ timeout: 5_000 });
      expect(await page.locator('.mcp-page-app-preview iframe').count()).toBe(1);
      expect(fixture.sandboxRequests()).toContain('/runtime-bootstrap');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
      await expect(readdir(fixture.root)).rejects.toThrow();
    }
  }, 45_000);

  it('keeps a directly navigated Runtime session without recreating its consumed preview', async () => {
    const fixture = await mountedPageFixture('runtime-direct');
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => { pageErrors.push(error.message); });
    type RuntimeStats = Readonly<{ readonly controllerEvents: readonly { readonly type: string }[]; readonly runtimeEvents: readonly string[] }>;
    const stats = (): Promise<RuntimeStats> => page.evaluate(() => (globalThis as typeof globalThis & {
      __mcpPageAppFixture: { stats(): RuntimeStats };
    }).__mcpPageAppFixture.stats());
    try {
      await page.goto(`${fixture.outerOrigin}/page.html`);
      await page.waitForFunction(() => '__mcpPageAppFixture' in globalThis);
      await page.getByLabel('Runtime-bound MCP session').waitFor({ timeout: 5_000 });

      expect(await page.getByLabel('Runtime-bound MCP session').textContent()).toContain('runtime-session-weather');
      expect(await page.getByText('Runtime App preview is unavailable because its binding evidence is invalid.', { exact: true }).count()).toBe(0);
      expect(await page.locator('.mcp-page-app-preview').count()).toBe(0);
      expect((await stats()).runtimeEvents).toEqual([]);
      expect((await stats()).controllerEvents.filter(({ type }) => type === 'open')).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
      await expect(readdir(fixture.root)).rejects.toThrow();
    }
  }, 45_000);

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
      await page.getByRole('button', { name: 'Allow geolocation' }).click();
      await page.locator('iframe[title="MCP App preview: weather"][data-mcp-app-document-revision="2"]').waitFor();
      const remountTrace = await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageRemountTrace: { readonly stop: () => void; readonly values: () => readonly string[] } }).__mcpPageRemountTrace.values());
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageRemountTrace: { readonly stop: () => void } }).__mcpPageRemountTrace.stop());
      const blank = remountTrace.findIndex((value) => value.startsWith('MCP App preview reload barrier: weather|about:blank|2'));
      const refreshed = remountTrace.findIndex((value, index) => index > blank && value.startsWith('MCP App preview: weather|') && value.endsWith('|2'));
      expect(blank).toBeGreaterThanOrEqual(0);
      expect(refreshed).toBeGreaterThan(blank);
      expect(fixture.sandboxRequests().slice(sandboxRequestsBeforeRemount)).toEqual(['/']);

      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { setActive(active: boolean): void } }).__mcpPageAppFixture.setActive(false));
      await page.waitForFunction(() => document.querySelector('iframe[title="MCP App preview: weather"]') === null);
      await page.waitForFunction(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { stats(): { closes: readonly unknown[] } } }).__mcpPageAppFixture.stats().closes.length === 1);
      await page.evaluate(() => (globalThis as typeof globalThis & { __mcpPageAppFixture: { setActive(active: boolean): void } }).__mcpPageAppFixture.setActive(true));
      expect(await page.getByText('Select a completed tool call below to create an App preview.').count()).toBe(1);

      await page.getByRole('button', { name: 'Open App preview for weather-call' }).click();
      await frame.waitFor();

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
      expect(final.closes).toHaveLength(7);
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
