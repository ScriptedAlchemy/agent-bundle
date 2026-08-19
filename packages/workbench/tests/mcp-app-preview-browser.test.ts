import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { chromium } from 'playwright';

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const previewComponent = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-app-preview.tsx');
const runtimeClientSource = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-app-client.ts');
const runtimeRouteClientSource = join(workspaceRoot, 'packages', 'workbench', 'src', 'mcp', 'mcp-route-client.ts');
const vendorRoot = join(workspaceRoot, 'packages', 'workbench', 'src', 'inspector', 'vendor');

const mountedPreviewFixture = async () => {
  const bootstrapRequests: string[] = [];
  const bootstrap = createServer((request, response) => {
    bootstrapRequests.push(request.url ?? '/');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Runtime App</title><main>Runtime App</main>');
  });
  bootstrap.listen(0, '127.0.0.1');
  await once(bootstrap, 'listening');
  const bootstrapAddress = bootstrap.address();
  if (bootstrapAddress === null || typeof bootstrapAddress === 'string') throw new Error('Mounted runtime preview fixture did not receive a bootstrap TCP address.');
  const bootstrapUrl = `http://127.0.0.1:${bootstrapAddress.port}/runtime-bootstrap`;
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-app-preview-'));
  const entry = join(root, 'preview.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { MantineProvider } from '@mantine/core';",
    `import { McpAppPreview } from ${JSON.stringify(previewComponent)};`,
    `import { McpAppClient } from ${JSON.stringify(runtimeClientSource)};`,
    `import { ForegroundRouteClient } from ${JSON.stringify(runtimeRouteClientSource)};`,
    '',
    "const frame = { allow: '', policy: { contentSecurityPolicy: \"default-src 'none'\", iframeAllow: '', permissionsPolicy: 'camera=()' }, referrerPolicy: 'no-referrer', relay: { maxMessageBytes: 4096, maxQueuedMessages: 4 }, sandbox: 'allow-scripts allow-same-origin', src: 'http://127.0.0.1:43124/#mcp-app-preview', targetOrigin: 'http://127.0.0.1:43124' };",
    "const resource = { csp: {}, html: '<main>Forecast</main>', kind: 'resource', permissions: {} };",
    "const profile = { kind: 'apps', profile: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', resourceUri: 'ui://weather/forecast.html' };",
    "const host = { availableDisplayModes: ['inline'], containerDimensions: { height: 480, width: 640 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light', timeZone: 'Etc/UTC', userAgent: 'Agent Bundle Workbench' };",
    "const ready = { bindingId: 'binding-weather', frame, profile, resource };",
    "const fallback = { bindingId: 'binding-weather', profile: { kind: 'fallback', profile: 'portable' }, resource: { input: { city: 'Paris' }, kind: 'fallback', reason: 'invalid-resource', result: { text: 'Sunny' } } };",
    'let settle;',
    'let pending = new Promise((resolve, reject) => { settle = { reject, resolve }; });',
    'const forceClosed = [];',
    "const client = { close: async () => ({ lifecycle: 'closed' }), create: async () => pending, forceClose: async (bindingId) => { forceClosed.push(bindingId); return true; }, message: async () => ({ accepted: true, lifecycle: 'initialized', messages: [] }) };",
    "const frameRelayFactory = () => ({ close: async () => undefined, start: () => true });",
    "const root = createRoot(document.getElementById('root'));",
    "root.render(React.createElement(McpAppPreview, { client, frameRelayFactory, host, input: { city: 'Paris' }, result: { text: 'Sunny' }, sessionId: 'session-weather', title: 'MCP App preview boundary', toolName: 'show-weather' }));",
    "globalThis.__mcpAppPreviewFixture = { reject: () => settle.reject(new Error('preview route failed')), resolve: (kind) => settle.resolve(kind === 'fallback' ? fallback : ready), stats: () => ({ forceClosed: [...forceClosed] }), unmount: () => root.unmount() };",
    '',
    `const runtimeBootstrapUrl = ${JSON.stringify(bootstrapUrl)};`,
    "const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status: 200 });",
    "const initialRuntimePolicy = () => ({ allow: '', approvedPermissions: {}, revision: 1, warnings: [] });",
    "const runtimePreviewFor = (suffix) => { const generation = 'generation-' + suffix; const source = 'source-' + suffix; const sessionId = 'runtime-session-' + suffix; const bindingId = 'runtime-binding-' + suffix; const binding = { definitionDigest: 'definition-' + suffix, evidence: 'simulated', id: bindingId, profileId: 'portable', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', registryRevision: 3, runVector: { runtimeGenerationId: generation, sourceRevision: source, stateVersion: suffix === 'a' ? 1 : 2 }, serverDigest: 'server-' + suffix, serverName: 'weather', sessionId, sessionRevision: suffix === 'a' ? 2 : 3, target: 'weather', transportDigest: 'transport-' + suffix }; const stable = { definitionDigest: binding.definitionDigest, registryRevision: binding.registryRevision, serverDigest: binding.serverDigest, serverName: binding.serverName, sessionId: binding.sessionId, sessionRevision: binding.sessionRevision, target: binding.target, transportDigest: binding.transportDigest }; const metadata = { extensions: { claude: { nativeHooks: 'native-hooks-must-stay-hidden', opaque: 'opaque-value-must-stay-hidden', root: '/private/workspace/agent-bundle.config.ts' }, openai: { opaque: 'unregistered-openai-must-stay-hidden' } }, provenance: {}, raw: {}, standard: {} }; const configExtensions = { entries: [{ configured: true, id: 'extension:claude', key: 'claude', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'claude' }, { configured: true, id: 'extension:codex', key: 'codex', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'codex' }, { configured: true, id: 'extension:portable', key: 'portable', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'portable' }], sourceRevision: source }; return { binding, clientSurface: { bootstrapUrl: runtimeBootstrapUrl, origin: new URL(runtimeBootstrapUrl).origin, webSocketPath: '/rsbuild-hmr' }, documentPolicy: initialRuntimePolicy(), kind: 'apps', metadata: { resource: metadata, result: metadata, tool: metadata }, operations: [], profile: { bootstrap: { kind: 'none' }, configExtensions, descriptor: { claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }, hostContext: { availableDisplayModes: ['inline'], containerDimensions: { height: 720, width: 1024 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light', timeZone: 'UTC', toolInfo: {}, userAgent: 'agent-bundle-runtime-mcp-app/1' }, kind: 'apps', metadata, permissions: { camera: {} }, resourceUri: 'ui://weather/app.html', warnings: [] }, resource: { html: '<main>Weather</main>', permissions: { camera: {} } }, result: { appVisible: { content: [] }, isError: false, modelVisible: {} }, session: { binding: stable, connection: { capabilities: { tools: {} }, protocolEra: 'modern', protocolVersion: '2026-01-26', server: { name: 'weather', version: '1.0.0' } }, state: 'ready' } }; };",
    "let runtimePreview; let runtimeOperationTraces = []; let operationSequence = 0; let heldCreate; let bridgeCloseFailures = 0; let backendCloseFailures = 0; let unregisterThrows = 0; let currentHandle; let suspendedTransition; const runtimeEvents = []; const runtimeIframes = new Set(); const runtimeTrace = [];",
    "const originalSetAttribute = Element.prototype.setAttribute; Element.prototype.setAttribute = function(name, value) { if (this instanceof HTMLIFrameElement && ['allow', 'referrerpolicy', 'sandbox', 'src'].includes(name)) runtimeTrace.push({ name, value: String(value) }); return originalSetAttribute.call(this, name, value); };",
    "const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) { if (node instanceof HTMLIFrameElement) runtimeIframes.add(node); if (node instanceof Element) node.querySelectorAll('iframe').forEach((frame) => runtimeIframes.add(frame)); } }); observer.observe(document.documentElement, { childList: true, subtree: true });",
    "let projectListener; const projectClient = { subscribeEvents: (listener) => { projectListener = listener; return () => { if (projectListener === listener) projectListener = undefined; }; } }; const foreground = new ForegroundRouteClient({ fetch: async (input, init) => { const path = new URL(String(input), location.origin).pathname; if (path === '/api/project/session') return response({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', origin: location.origin, token: 'foreground-secret' }); if (path === '/api/runtime/apps') { const request = JSON.parse(String(init?.body)); runtimeEvents.push('request:' + request.runId + ':' + request.profileId + ':' + request.expectedGenerationId); runtimeEvents.push('create:' + runtimePreview.binding.id); if (heldCreate !== undefined) return heldCreate.promise; return response({ preview: runtimePreview }); } if (path.startsWith('/api/runtime/apps/') && init?.method === 'DELETE') { const bindingId = decodeURIComponent(path.slice('/api/runtime/apps/'.length)); runtimeEvents.push('backend:' + bindingId); if (backendCloseFailures > 0) { backendCloseFailures -= 1; runtimeEvents.push('backend-failed:' + bindingId); throw new Error('backend release failed'); } return response({ closed: true }); } throw new Error('Unexpected runtime fixture request ' + path); } }); const runtime = new McpAppClient({ foreground, projectClient });",
    "const currentDocumentPolicy = runtime.currentDocumentPolicy.bind(runtime); runtime.currentDocumentPolicy = (bindingId) => { runtimeEvents.push('policy:' + bindingId); return currentDocumentPolicy(bindingId); };",
    "const bridge = { addEventListener: () => undefined, close: async () => { runtimeEvents.push('bridge'); }, sendHostContextChange: async () => undefined, sendToolCancelled: async () => undefined, sendToolInput: async () => undefined, sendToolInputPartial: async () => undefined, sendToolResult: async () => undefined, teardownResource: async () => { runtimeEvents.push('renderer'); return {}; } };",
    "const bridgeFactory = Object.assign(() => { runtimeEvents.push('factory'); return bridge; }, { close: async () => { runtimeEvents.push('bridge-factory'); if (bridgeCloseFailures > 0) { bridgeCloseFailures -= 1; runtimeEvents.push('bridge-factory-failed'); throw new Error('bridge release failed'); } } }); const createBridgeFactory = () => bridgeFactory;",
    "const runFor = (preview) => ({ completedAt: '2026-08-16T00:00:01.000Z', id: 'run-' + preview.binding.id, input: { city: 'Paris' }, result: { app: { mcpBinding: { ...preview.session.binding }, resourceUri: 'ui://weather/app.html', surfaceId: 'mcp.edit-weather' }, modelVisible: { temperature: 22 }, trace: [], tree: [] }, startedAt: '2026-08-16T00:00:00.000Z', status: 'succeeded', surfaceId: 'surface-weather', target: 'weather', vector: { ...(preview.binding.runVector.artifactEpochId === undefined ? {} : { artifactEpochId: preview.binding.runVector.artifactEpochId }), runtimeGenerationId: preview.binding.runVector.runtimeGenerationId, sourceRevision: preview.binding.runVector.sourceRevision, stateVersion: preview.binding.runVector.stateVersion } });",
    "const runtimeProfileFor = () => ({ claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }); const surfaceFor = () => ({ fixtures: [], id: 'surface-weather', kind: 'mcp-app', label: 'Weather App', readOnly: false, targets: ['weather'] }); const runtimeSourceFor = (suffix) => { const preview = runtimePreviewFor(suffix); return { preview, profile: runtimeProfileFor(), run: runFor(preview), surface: surfaceFor() }; }; let runtimeSource = runtimeSourceFor('a'); runtimeSource.preview.binding.runVector.artifactEpochId = 'artifact-a'; runtimeSource.run.vector.artifactEpochId = 'artifact-a'; runtimePreview = runtimeSource.preview;",
    "const registrarFor = (name) => (handle) => { if (currentHandle !== undefined) throw new Error('host registrar received a second lifecycle handle'); currentHandle = handle; runtimeEvents.push('register:' + name); return () => { if (currentHandle === handle) currentHandle = undefined; runtimeEvents.push('unregister:' + name); if (unregisterThrows > 0) { unregisterThrows -= 1; throw new Error('host unregister failed'); } }; }; let currentRegistrar = registrarFor('first');",
    "const SuspendedRuntimePreview = ({ preview, suspended }) => { if (!suspended) return null; runtimeEvents.push('suspend:' + preview.binding.id); throw suspendedTransition.promise; }; const runtimeTree = (source, suspended = false) => React.createElement(MantineProvider, null, React.createElement(React.StrictMode, null, React.createElement(React.Suspense, { fallback: null }, React.createElement(React.Fragment, null, React.createElement(McpAppPreview, { client: runtime, createBridgeFactory, kind: 'runtime', operationTraces: runtimeOperationTraces, profile: source.profile, profileId: 'portable', registerLifecycle: currentRegistrar, run: source.run, surface: source.surface, title: 'Runtime MCP App preview boundary' }), React.createElement(SuspendedRuntimePreview, { preview: source.preview, suspended }))))); const mountRuntime = () => root.render(runtimeTree(runtimeSource));",
    "const deferred = () => { let resolve; let reject; const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; }); return { promise, reject, resolve }; };",
    "const operationTrace = (preview, artifactEpochId) => ({ bindingId: preview.binding.id, kind: 'tools/call', name: 'weather', operationId: 'operation-' + (++operationSequence), registryRevision: preview.binding.registryRevision, sessionId: preview.binding.sessionId, sessionRevision: preview.binding.sessionRevision, vector: { ...preview.binding.runVector, ...(artifactEpochId === undefined ? {} : { artifactEpochId }) } }); const publishTrace = (next) => { runtimeOperationTraces = [...runtimeOperationTraces.filter((entry) => entry.bindingId !== next.bindingId), next]; mountRuntime(); }; const appendTrace = (next) => { runtimeOperationTraces = [...runtimeOperationTraces, next]; mountRuntime(); }; globalThis.__mcpRuntimePreviewFixture = { mountRuntime, replace: () => { runtimeSource = runtimeSourceFor('b'); runtimePreview = runtimeSource.preview; mountRuntime(); }, invalidate: () => projectListener?.({ type: 'runtime.event', sequence: 1, payload: { details: { bindingId: runtimePreview.binding.id, reason: 'session-restarted', sessionId: runtimePreview.binding.sessionId, sessionRevision: runtimePreview.binding.sessionRevision, state: 'revoked' }, mcpSessionId: runtimePreview.binding.sessionId, mcpSessionRevision: runtimePreview.binding.sessionRevision, providerSessionId: 'provider-' + runtimePreview.binding.id, type: 'runtime.app.updated' } }), rerender: () => mountRuntime(), publishOperationTrace: () => publishTrace(operationTrace(runtimePreview)), publishOperationTraceWithoutEpoch: () => { const next = operationTrace(runtimePreview); delete next.vector.artifactEpochId; publishTrace(next); }, publishOperationTraceWithWrongEpoch: () => appendTrace(operationTrace(runtimePreview, 'artifact-b')), publishOperationTraceWithUnexpectedEpoch: () => publishTrace(operationTrace(runtimePreview, 'artifact-a')), publishForeignOperationTrace: () => { runtimeOperationTraces = [...runtimeOperationTraces, operationTrace(runtimePreviewFor('foreign'))]; mountRuntime(); }, clearOperationTraces: () => { runtimeOperationTraces = []; mountRuntime(); }, changeRegistrar: () => { currentRegistrar = registrarFor('second'); mountRuntime(); }, hold: () => { runtimeSource = runtimeSourceFor('c'); runtimePreview = runtimeSource.preview; heldCreate = deferred(); mountRuntime(); }, resolveHeld: () => { const held = heldCreate; heldCreate = undefined; held.resolve(response({ preview: runtimePreview })); }, failClose: () => { bridgeCloseFailures = 1; backendCloseFailures = 1; }, throwUnregister: () => { unregisterThrows = 1; }, retryCurrent: () => currentHandle?.close(), mutateCommittedSource: () => { const source = runtimeSource; source.run.id = 'run-mutated'; source.run.input.city = 'Mutated'; source.run.result.modelVisible.temperature = 999; source.run.result.app.resourceUri = 'ui://mutated/app.html'; source.run.result.app.mcpBinding.sessionRevision = 999; source.run.vector.runtimeGenerationId = 'generation-mutated'; source.run.vector.sourceRevision = 'source-mutated'; source.run.vector.stateVersion = 999; source.profile.id = 'claude'; source.profile.version = 'agent-bundle:mcp-apps:mutated'; source.surface.id = 'surface-mutated'; source.surface.targets.push('mutated'); }, beginAbandonedTransition: () => { const source = runtimeSourceFor('transition'); suspendedTransition = deferred(); React.startTransition(() => root.render(runtimeTree(source, true))); }, abandonTransition: () => { root.render(runtimeTree(runtimeSource)); }, stats: () => ({ currentHandle: currentHandle === undefined ? undefined : 'present', events: [...runtimeEvents], iframeNodes: runtimeIframes.size, trace: [...runtimeTrace] }), unmountRuntime: () => root.unmount() };",
    '',
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
          '@inspector/core/json/xMcpHeader.js': join(vendorRoot, 'core', 'json', 'xMcpHeader.ts'),
          '@inspector/core/mcp/fetchTracking.js': join(vendorRoot, 'core', 'mcp', 'fetchTracking.ts'),
          '@inspector/core/mcp/types.js': join(vendorRoot, 'core', 'mcp', 'types.ts'),
          '@inspector/core': join(vendorRoot, 'core'),
          '@mantine/core': join(workspaceRoot, 'node_modules', '@mantine', 'core', 'esm', 'index.mjs'),
          react: join(workspaceRoot, 'node_modules', 'react'),
          'react-dom/client': join(workspaceRoot, 'node_modules', 'react-dom', 'client.js'),
        },
      },
      source: {
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        entry: { preview: entry },
      },
    },
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('preview.html')) throw new Error('Mounted preview fixture did not produce its browser document.');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = join(dist, asset);
    if (relative(dist, file).startsWith('..')) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Mounted preview fixture did not receive a TCP address.');
  return {
    bootstrapRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      await new Promise<void>((resolve, reject) => {
        bootstrap.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      await rm(root, { force: true, recursive: true });
    },
    url: `http://127.0.0.1:${address.port}/preview.html`,
  };
};

describe('MCP App preview browser', () => {
  it('mounts the preview in Chrome for ready, error, fallback, unmount-race, and 390px layouts', async () => {
    const fixture = await mountedPreviewFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const browserErrors: string[] = [];
    const responses: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(error.message); });
    page.on('response', (response) => { responses.push(`${response.status()} ${response.url()}`); });
    try {
      const load = async () => {
        await page.goto(fixture.url);
        try {
          await page.waitForFunction(() => '__mcpAppPreviewFixture' in globalThis, undefined, { timeout: 5_000 });
        } catch (error) {
          throw new Error(
            `Mounted preview fixture did not initialize: ${browserErrors.join('\n')} ${responses.join('\n')} ${String(error)}`,
            { cause: error },
          );
        }
      };
      const resolve = async (kind: 'fallback' | 'ready') => {
        await page.evaluate((next) => (globalThis as typeof globalThis & {
          __mcpAppPreviewFixture: { resolve(kind: 'fallback' | 'ready'): void };
        }).__mcpAppPreviewFixture.resolve(next), kind);
      };

      await load();
      await resolve('ready');
      const frame = page.getByTitle('MCP App preview boundary');
      await frame.waitFor();
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(await frame.getAttribute('src')).toBe('http://127.0.0.1:43124/#mcp-app-preview');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await load();
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { reject(): void };
      }).__mcpAppPreviewFixture.reject());
      await page.getByRole('alert').waitFor();
      expect(await page.getByLabel('MCP App fallback').textContent()).toContain('Sunny');

      await load();
      await resolve('fallback');
      await page.getByLabel('MCP App fallback').waitFor();
      expect(await page.locator('iframe').count()).toBe(0);

      await load();
      await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { unmount(): void };
      }).__mcpAppPreviewFixture.unmount());
      await resolve('ready');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { stats(): { forceClosed: readonly string[] } };
      }).__mcpAppPreviewFixture.stats().forceClosed.length === 1);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpAppPreviewFixture: { stats(): { forceClosed: readonly string[] } };
      }).__mcpAppPreviewFixture.stats().forceClosed)).toEqual(['binding-weather']);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 30_000);

  it('keeps one runtime owner across same-authority StrictMode renders and drains the old owner before replacement', async () => {
    const fixture = await mountedPreviewFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(error.message); });
    try {
      await page.goto(fixture.url);
      await page.waitForFunction(() => '__mcpRuntimePreviewFixture' in globalThis, undefined, { timeout: 5_000 });
      const runtime = (method: 'mountRuntime' | 'replace' | 'invalidate' | 'rerender' | 'publishOperationTrace' | 'publishOperationTraceWithoutEpoch' | 'publishOperationTraceWithWrongEpoch' | 'publishOperationTraceWithUnexpectedEpoch' | 'publishForeignOperationTrace' | 'clearOperationTraces' | 'changeRegistrar' | 'hold' | 'resolveHeld' | 'unmountRuntime') => page.evaluate((next) => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: Record<string, () => void>;
      }).__mcpRuntimePreviewFixture[next](), method);
      const stats = () => page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: {
          stats(): { readonly events: readonly string[]; readonly iframeNodes: number; readonly trace: readonly { readonly name: string; readonly value: string }[] };
        };
      }).__mcpRuntimePreviewFixture.stats());
      const lifecycleEvents = (events: readonly string[]) => events.filter((entry) =>
        entry.startsWith('register:') || entry.startsWith('unregister:') || entry.startsWith('create:') || entry === 'factory' || entry === 'bridge' || entry === 'bridge-factory' || entry.startsWith('backend:'),
      );

      await runtime('mountRuntime');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('factory'), undefined, { timeout: 5_000 });

      const initial = await stats();
      expect(initial.events.indexOf('register:first')).toBeGreaterThanOrEqual(0);
      expect(initial.events.indexOf('create:runtime-binding-a')).toBeGreaterThan(initial.events.indexOf('register:first'));
      expect(initial.events.filter((entry) => entry === 'factory')).toHaveLength(1);
      expect(await page.getByRole('alert').allTextContents()).toEqual([]);
      expect(initial.events).not.toContain('bridge');
      expect(initial.events).not.toContain('backend:runtime-binding-a');
      expect(initial.iframeNodes).toBe(1);
      const policyTrace = initial.trace.filter((entry) => ['allow', 'referrerpolicy', 'sandbox', 'src'].includes(entry.name));
      expect(policyTrace.map((entry) => entry.name)).toEqual(['src', 'allow', 'referrerpolicy', 'sandbox', 'src']);
      expect(policyTrace[0]?.value).toBe('about:blank');
      expect(policyTrace.at(-1)?.value).toBeDefined();
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap']);

      const simulatedProfile = page.getByLabel('Simulated MCP App profile');
      expect(await simulatedProfile.isVisible()).toBe(true);
      expect(await simulatedProfile.locator('dd').allTextContents()).toEqual([
        'Portable MCP Apps',
        'agent-bundle:mcp-apps:2026-01-26',
        'Simulated',
        'Not certified for real-host parity',
      ]);
      const registeredConfiguration = page.getByLabel('Registered configuration');
      expect(await registeredConfiguration.isVisible()).toBe(true);
      expect(await registeredConfiguration.textContent()).toContain('Source revision');
      expect(await registeredConfiguration.textContent()).toContain('source-a');
      const registeredRows = registeredConfiguration.getByRole('listitem');
      expect(await registeredRows.count()).toBe(3);
      expect(await registeredRows.nth(0).locator('dd').allTextContents()).toEqual(['claude', 'claude', 'extension:claude', 'config', 'agent-bundle.config.ts']);
      expect(await registeredRows.nth(1).locator('dd').allTextContents()).toEqual(['codex', 'codex', 'extension:codex', 'config', 'agent-bundle.config.ts']);
      expect(await registeredRows.nth(2).locator('dd').allTextContents()).toEqual(['portable', 'portable', 'extension:portable', 'config', 'agent-bundle.config.ts']);
      const runtimePreviewText = await page.locator('body').textContent();
      expect(runtimePreviewText).not.toContain('native-hooks-must-stay-hidden');
      expect(runtimePreviewText).not.toContain('opaque-value-must-stay-hidden');
      expect(runtimePreviewText).not.toContain('unregistered-openai-must-stay-hidden');
      expect(runtimePreviewText).not.toContain('/private/workspace/agent-bundle.config.ts');
      expect(runtimePreviewText).not.toContain('{"configured"');

      const implementationEvidence = page.getByLabel('Executed by current implementation');
      expect(await implementationEvidence.count()).toBe(0);
      const beforeOperationTrace = await stats();
      await runtime('publishOperationTraceWithoutEpoch');
      expect(await implementationEvidence.count()).toBe(0);
      await runtime('publishOperationTrace');
      expect(await implementationEvidence.isVisible()).toBe(true);
      expect(await implementationEvidence.locator('dd').allTextContents()).toEqual([
        'operation-2',
        'tools/call',
        'weather',
        'runtime-session-a',
        '2',
        '3',
        'generation-a',
        'source-a',
        'artifact-a',
        '1',
      ]);
      const traced = await stats();
      expect(lifecycleEvents(traced.events)).toEqual(lifecycleEvents(beforeOperationTrace.events));
      expect(traced.iframeNodes).toBe(beforeOperationTrace.iframeNodes);
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap']);
      await runtime('publishOperationTraceWithWrongEpoch');
      expect(await implementationEvidence.textContent()).toContain('operation-2');
      await runtime('publishOperationTrace');
      expect(await implementationEvidence.textContent()).toContain('operation-4');
      await runtime('publishForeignOperationTrace');
      expect(await implementationEvidence.textContent()).toContain('operation-4');

      await runtime('rerender');
      await page.waitForTimeout(100);
      const same = await stats();
      expect(lifecycleEvents(same.events)).toEqual(lifecycleEvents(initial.events));
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap']);

      await runtime('changeRegistrar');
      await page.waitForTimeout(100);
      expect(lifecycleEvents((await stats()).events)).toEqual(lifecycleEvents(same.events));

      await runtime('invalidate');
      await page.getByRole('alert').filter({ hasText: 'Runtime MCP App session restarted' }).waitFor();
      expect((await stats()).events).not.toContain('backend:runtime-binding-a');
      await runtime('replace');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('create:runtime-binding-b'), undefined, { timeout: 5_000 });
      const replaced = await stats();
      const oldRenderer = replaced.events.indexOf('renderer');
      const oldFactory = replaced.events.indexOf('bridge-factory');
      const newCreate = replaced.events.indexOf('create:runtime-binding-b');
      const oldUnregister = replaced.events.indexOf('unregister:first');
      expect(oldRenderer).toBeGreaterThanOrEqual(0);
      expect(oldFactory).toBeGreaterThan(oldRenderer);
      expect(replaced.events).not.toContain('backend:runtime-binding-a');
      expect(oldUnregister).toBeGreaterThan(oldFactory);
      expect(newCreate).toBeGreaterThan(oldUnregister);
      expect(replaced.events.filter((entry) => entry === 'register:first')).toHaveLength(1);
      expect(replaced.events.filter((entry) => entry === 'register:second')).toHaveLength(1);
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap', '/runtime-bootstrap']);
      expect(await implementationEvidence.count()).toBe(0);
      await runtime('publishOperationTraceWithUnexpectedEpoch');
      expect(await implementationEvidence.count()).toBe(0);
      await runtime('publishOperationTrace');
      expect(await implementationEvidence.textContent()).toContain('runtime-session-b');
      await runtime('clearOperationTraces');
      expect(await implementationEvidence.count()).toBe(0);

      const factoriesBeforeHeldCreate = replaced.events.filter((entry) => entry === 'factory').length;
      await runtime('hold');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('create:runtime-binding-c'), undefined, { timeout: 5_000 });
      await runtime('unmountRuntime');
      await runtime('resolveHeld');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('backend:runtime-binding-c'), undefined, { timeout: 5_000 });
      const held = await stats();
      expect(held.events.filter((entry) => entry === 'factory')).toHaveLength(factoriesBeforeHeldCreate);
      expect(held.events).not.toContain('policy:runtime-binding-c');
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap', '/runtime-bootstrap']);
      expect(held.events.lastIndexOf('unregister:second')).toBeGreaterThan(held.events.lastIndexOf('backend:runtime-binding-c'));
      expect(browserErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);

  it('renders declared runtime document permissions as unavailable without consent or remount', async () => {
    const fixture = await mountedPreviewFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(error.message); });
    try {
      await page.goto(fixture.url);
      await page.waitForFunction(() => '__mcpRuntimePreviewFixture' in globalThis, undefined, { timeout: 5_000 });
      const runtime = (method: 'mountRuntime' | 'unmountRuntime') => page.evaluate((next) => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: Record<string, () => void>;
      }).__mcpRuntimePreviewFixture[next](), method);
      const stats = () => page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: {
          stats(): { readonly events: readonly string[]; readonly trace: readonly { readonly name: string; readonly value: string }[] };
        };
      }).__mcpRuntimePreviewFixture.stats());

      await runtime('mountRuntime');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('factory'), undefined, { timeout: 5_000 });
      const permissionControl = page.getByLabel('Runtime App document permissions');
      await expect(permissionControl.textContent()).resolves.toContain('Declared document permissions are unavailable in this isolated Runtime App surface.');
      await expect(permissionControl.textContent()).resolves.toContain('Camera unavailable');
      expect(await permissionControl.getByRole('button').count()).toBe(0);
      const unavailable = await stats();
      expect(unavailable.events.filter((entry) => entry === 'factory')).toHaveLength(1);
      expect(unavailable.events).not.toContain('backend:runtime-binding-a');
      expect(await page.locator('iframe').count()).toBe(1);

      await runtime('unmountRuntime');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes('backend:runtime-binding-a'), undefined, { timeout: 5_000 });
      const closed = await stats();
      expect(closed.events.lastIndexOf('backend:runtime-binding-a')).toBeGreaterThan(closed.events.lastIndexOf('bridge-factory'));
      expect(browserErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);

  it('retains a failed runtime lifecycle tombstone until its exact host handle retries, and ignores an abandoned concurrent authority', async () => {
    const fixture = await mountedPreviewFixture();
    const browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ viewport: { height: 800, width: 390 } });
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(error.message); });
    try {
      await page.goto(fixture.url);
      await page.waitForFunction(() => '__mcpRuntimePreviewFixture' in globalThis, undefined, { timeout: 5_000 });
      const runtime = (method: 'mountRuntime' | 'replace' | 'failClose' | 'throwUnregister' | 'retryCurrent' | 'mutateCommittedSource' | 'beginAbandonedTransition' | 'abandonTransition' | 'unmountRuntime') => page.evaluate(async (next) => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: Record<string, () => unknown>;
      }).__mcpRuntimePreviewFixture[next](), method);
      const stats = () => page.evaluate(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: {
          stats(): {
            readonly currentHandle: 'present' | undefined;
            readonly events: readonly string[];
            readonly iframeNodes: number;
          };
        };
      }).__mcpRuntimePreviewFixture.stats());
      const waitFor = async (entry: string) => page.waitForFunction((expected) => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.includes(expected), entry, { timeout: 5_000 });

      await runtime('mountRuntime');
      await waitFor('factory');
      const stable = await stats();
      const lifecycleEvents = (events: readonly string[]) => events.filter((entry) =>
        entry.startsWith('register:') || entry.startsWith('unregister:') || entry.startsWith('create:') || entry === 'factory' || entry === 'bridge-factory' || entry.startsWith('backend:'),
      );

      await runtime('beginAbandonedTransition');
      await waitFor('suspend:runtime-binding-transition');
      await runtime('abandonTransition');
      await page.waitForTimeout(100);
      const abandoned = await stats();
      expect(lifecycleEvents(abandoned.events)).toEqual(lifecycleEvents(stable.events));
      expect(abandoned.iframeNodes).toBe(stable.iframeNodes);
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap']);

      await runtime('failClose');
      await runtime('throwUnregister');
      await runtime('replace');
      await waitFor('bridge-factory-failed');
      await waitFor('backend-failed:runtime-binding-a');
      await page.waitForTimeout(100);
      const failedReplacement = await stats();
      expect(failedReplacement.currentHandle).toBe('present');
      expect(failedReplacement.events).not.toContain('register:second');
      expect(failedReplacement.events).not.toContain('create:runtime-binding-b');
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap']);

      await runtime('mutateCommittedSource');
      await runtime('retryCurrent');
      await waitFor('create:runtime-binding-b');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly events: readonly string[] } };
      }).__mcpRuntimePreviewFixture.stats().events.filter((entry) => entry === 'factory').length === 2, undefined, { timeout: 5_000 });
      const retried = await stats();
      expect(retried.events.filter((entry) => entry === 'unregister:first')).toHaveLength(1);
      expect(retried.events.indexOf('create:runtime-binding-b')).toBeGreaterThan(retried.events.indexOf('unregister:first'));
      expect(retried.events.filter((entry) => entry === 'register:first')).toHaveLength(2);
      expect(retried.events.filter((entry) => entry === 'request:run-runtime-binding-b:portable:generation-b')).toHaveLength(1);
      expect(retried.events).not.toContain('request:run-mutated:claude:generation-mutated');
      expect(await page.getByLabel('Runtime App result').textContent()).toContain('Paris');
      expect(await page.getByLabel('Runtime App result').textContent()).toContain('22');
      expect(await page.getByLabel('Runtime App result').textContent()).not.toContain('Mutated');
      expect(await page.getByLabel('Runtime App result').textContent()).not.toContain('999');
      expect(fixture.bootstrapRequests).toEqual(['/runtime-bootstrap', '/runtime-bootstrap']);

      await runtime('failClose');
      await runtime('unmountRuntime');
      await waitFor('backend-failed:runtime-binding-b');
      const failedUnmount = await stats();
      expect(failedUnmount.currentHandle).toBe('present');
      await runtime('retryCurrent');
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __mcpRuntimePreviewFixture: { stats(): { readonly currentHandle: 'present' | undefined } };
      }).__mcpRuntimePreviewFixture.stats().currentHandle === undefined, undefined, { timeout: 5_000 });
      const retriedUnmount = await stats();
      expect(retriedUnmount.events.filter((entry) => entry === 'unregister:first')).toHaveLength(2);
      expect(browserErrors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);
});
