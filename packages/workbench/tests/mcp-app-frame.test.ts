import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';
import { createRsbuild } from '@rsbuild/core';

import { createWorkbenchFixtureConfig } from './support/workbench-fixture-config.ts';
import { browserLaunchOptions } from './support/workbench-e2e.ts';
import { chromium } from 'playwright';

import {
  applyMcpAppFramePolicy,
  McpAppFrame,
  SecureAppRenderer,
} from '../src/mcp/mcp-app-frame.tsx';
import {
  createMcpAppFrameRelay,
  type McpAppFrameIframe,
  type McpAppFrameMessageListener,
  type McpAppFrameRelayRoutes,
  type McpAppFrameWindow,
} from '../../agent-bundle/src/web-host/browser/frame-relay.ts';
import type { McpAppJsonValue, McpAppRelayFrame, McpAppRouteClose, McpAppRouteMessages } from '../src/mcp/mcp-app-client.ts';
import { deferred, eventually } from './support/async.ts';

const frame: McpAppRelayFrame = Object.freeze({
  allow: '',
  policy: Object.freeze({
    contentSecurityPolicy: "default-src 'none'",
    iframeAllow: '',
    permissionsPolicy: 'camera=()',
  }),
  referrerPolicy: 'no-referrer',
  relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 2 }),
  sandbox: 'allow-scripts allow-same-origin',
  src: 'http://127.0.0.1:43124/#sandbox-configuration',
  targetOrigin: 'http://127.0.0.1:43124',
});

const resource = Object.freeze({
  csp: Object.freeze({ connectDomains: Object.freeze(['https://api.example.test']) }),
  html: '<main>Weather</main>',
  kind: 'resource' as const,
  permissions: Object.freeze({ clipboardWrite: Object.freeze({}) }),
});

const messageResult = (messages: readonly McpAppJsonValue[] = [], lifecycle: McpAppRouteMessages['lifecycle'] = 'initialized'): McpAppRouteMessages =>
  Object.freeze({ accepted: true, lifecycle, messages });

const closeResult = (message: McpAppJsonValue | undefined = undefined, lifecycle: McpAppRouteClose['lifecycle'] = 'closing'): McpAppRouteClose =>
  Object.freeze({ ...(message === undefined ? {} : { message }), lifecycle });

const fakeBrowser = (): {
  readonly child: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void };
  readonly emit: (event: Readonly<{ readonly data: unknown; readonly origin: string; readonly source: unknown }>) => void;
  readonly iframe: { readonly contentWindow: { readonly posts: unknown[]; postMessage(message: unknown, targetOrigin: string): void } };
  readonly window: McpAppFrameWindow;
} => {
  const listeners = new Set<McpAppFrameMessageListener>();
  const child = {
    posts: [] as unknown[],
    postMessage(message: unknown, targetOrigin: string): void {
      child.posts.push(Object.freeze({ message, targetOrigin }));
    },
  };
  return {
    child,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    iframe: Object.freeze({ contentWindow: child }),
    window: Object.freeze({
      addEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.add(listener); },
      removeEventListener: (_type: 'message', listener: McpAppFrameMessageListener) => { listeners.delete(listener); },
    }),
  };
};

const proxyReady = (): Readonly<Record<string, unknown>> => Object.freeze({
  jsonrpc: '2.0',
  method: 'ui/notifications/sandbox-proxy-ready',
  params: Object.freeze({}),
});

const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const workbenchSource = join(workspaceRoot, 'packages', 'workbench', 'src');
const secureRendererSource = join(workbenchSource, 'mcp', 'mcp-app-frame.tsx');
const runtimeClientSource = join(workbenchSource, 'mcp', 'mcp-app-client.ts');
const runtimeRouteClientSource = join(workbenchSource, 'mcp', 'mcp-route-client.ts');

const mountedSecureRendererFixture = async () => {
  const bootstrapRequests: string[] = [];
  const bootstrap = createServer((request, response) => {
    bootstrapRequests.push(request.url ?? '/');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Runtime App</title><main>Runtime App</main>');
  });
  bootstrap.listen(0, '127.0.0.1');
  await once(bootstrap, 'listening');
  const bootstrapAddress = bootstrap.address();
  if (bootstrapAddress === null || typeof bootstrapAddress === 'string') throw new Error('Secure renderer bootstrap fixture did not receive a TCP address.');
  const bootstrapUrl = `http://127.0.0.1:${bootstrapAddress.port}/app-bootstrap`;
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-secure-renderer-'));
  const entry = join(root, 'secure-renderer.tsx');
  const dist = join(root, 'dist');
  await writeFile(entry, [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { SecureAppRenderer } from ${JSON.stringify(secureRendererSource)};`,
    `import { McpAppClient } from ${JSON.stringify(runtimeClientSource)};`,
    `import { ForegroundRouteClient } from ${JSON.stringify(runtimeRouteClientSource)};`,
    '',
    `const bootstrapUrl = ${JSON.stringify(bootstrapUrl)};`,
    "const policy = { allow: '', approvedPermissions: {}, revision: 1, warnings: [] };",
    "const metadata = { extensions: { claude: {}, openai: {} }, provenance: {}, raw: {}, standard: {} };",
    "const preview = { binding: { definitionDigest: 'definition-a', evidence: 'simulated', id: 'runtime-binding', profileId: 'portable', profileVersion: 'agent-bundle:mcp-apps:2026-01-26', registryRevision: 3, runVector: { runtimeGenerationId: 'generation-a', sourceRevision: 'source-a', stateVersion: 1 }, serverDigest: 'server-a', serverName: 'weather', sessionId: 'runtime-session-a', sessionRevision: 2, target: 'portable', transportDigest: 'transport-a' }, clientSurface: { bootstrapUrl, origin: new URL(bootstrapUrl).origin }, documentPolicy: policy, kind: 'apps', metadata: { resource: metadata, result: metadata, tool: metadata }, operations: [], profile: { bootstrap: { kind: 'none' }, configExtensions: { entries: [], sourceRevision: 'source-a' }, descriptor: { claimsRealHostParity: false, evidence: 'simulated', id: 'portable', label: 'Portable MCP Apps', version: 'agent-bundle:mcp-apps:2026-01-26' }, hostContext: { availableDisplayModes: ['inline'], containerDimensions: { height: 720, width: 1024 }, deviceCapabilities: {}, displayMode: 'inline', locale: 'en-US', platform: 'web', safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 }, styles: {}, theme: 'light', timeZone: 'UTC', toolInfo: {}, userAgent: 'agent-bundle-runtime-mcp-app/1' }, kind: 'apps', metadata, permissions: { camera: {}, geolocation: {} }, resourceUri: 'ui://weather/app.html', warnings: [] }, resource: { html: '<main>Weather</main>', permissions: { camera: {}, geolocation: {} } }, result: { appVisible: { content: [] }, isError: false, modelVisible: {} }, session: { binding: { definitionDigest: 'definition-a', registryRevision: 3, serverDigest: 'server-a', serverName: 'weather', sessionId: 'runtime-session-a', sessionRevision: 2, target: 'portable', transportDigest: 'transport-a' }, connection: { capabilities: { tools: {} }, protocolEra: 'modern', protocolVersion: '2026-01-26', server: { name: 'weather', version: '1.0.0' } }, state: 'ready' } };",
    "const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status: 200 });",
    "const foreground = new ForegroundRouteClient({ fetch: async (input, init) => { const path = new URL(String(input), location.origin).pathname; if (path === '/api/project/session') return response({ cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: location.origin, token: 'foreground-secret' }); if (path === '/api/runtime/apps') return response({ preview }); if (path === '/api/runtime/apps/runtime-binding' && init?.method === 'DELETE') return response({ closed: true }); throw new Error('Unexpected runtime fixture request ' + path); } }); const runtime = new McpAppClient({ foreground });",
    "const trace = []; const iframeNodes = new Set();",
    "const originalSetAttribute = Element.prototype.setAttribute; Element.prototype.setAttribute = function(name, value) { if (this instanceof HTMLIFrameElement && ['allow', 'referrerpolicy', 'sandbox', 'src'].includes(name)) trace.push({ name, value: String(value) }); return originalSetAttribute.call(this, name, value); };",
    "const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) { if (node instanceof HTMLIFrameElement) iframeNodes.add(node); if (node instanceof Element) node.querySelectorAll('iframe').forEach((frame) => iframeNodes.add(frame)); } }); observer.observe(document.documentElement, { childList: true, subtree: true });",
    "const bridge = { addEventListener: () => undefined, close: async () => undefined, sendHostContextChange: async () => undefined, sendToolCancelled: async () => undefined, sendToolInput: async () => undefined, sendToolInputPartial: async () => undefined, sendToolResult: async () => undefined, teardownResource: async () => ({}) };",
    "let factories = 0; const bridgeFactory = () => { factories += 1; return bridge; }; const tool = { inputSchema: { type: 'object' }, name: 'weather' }; const root = createRoot(document.getElementById('root'));",
    "class Boundary extends React.Component { state = { error: undefined }; static getDerivedStateFromError(error) { return { error: String(error?.message ?? error) }; } render() { return this.state.error ? React.createElement('div', { id: 'policy-error' }, this.state.error) : this.props.children; } }",
    "let trusted; const mount = (candidate, key) => root.render(React.createElement(React.StrictMode, null, React.createElement(Boundary, { key }, React.createElement(SecureAppRenderer, { bindingId: 'runtime-binding', bootstrapUrl, bridgeFactory, documentPolicy: candidate, policyClient: runtime, rendererProps: { tool } }))));",
    "await runtime.createRuntime({ expectedGenerationId: 'generation-a', profileId: 'portable', runId: 'run-a' }); trusted = runtime.currentDocumentPolicy('runtime-binding'); mount(trusted, 'trusted');",
    "globalThis.__secureRendererFixture = { copied: () => mount(Object.freeze({ bindingId: trusted.bindingId, snapshot: trusted.snapshot }), 'copied'), widened: () => mount(Object.freeze({ bindingId: trusted.bindingId, snapshot: Object.freeze({ ...trusted.snapshot, allow: 'camera' }) }), 'widened'), stale: async () => { await runtime.closeRuntime('runtime-binding'); mount(trusted, 'stale'); }, stats: () => ({ factories, iframeNodes: iframeNodes.size, trace: [...trace] }) };",
    '',
  ].join('\n'));
  const rsbuild = await createRsbuild({
    config: createWorkbenchFixtureConfig({ distRoot: dist, entry: { renderer: entry } }),
    cwd: workspaceRoot,
  });
  const build = await rsbuild.build();
  await build.close();
  const assets = await readdir(dist, { recursive: true });
  if (!assets.includes('renderer.html')) throw new Error('Mounted secure renderer fixture did not produce its browser document.');
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
  if (address === null || typeof address === 'string') throw new Error('Mounted secure renderer fixture did not receive a TCP address.');
  return {
    bootstrapRequests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      await new Promise<void>((resolve, reject) => {
        bootstrap.close((error) => error === undefined ? resolve() : reject(error));
      });
      await rm(root, { force: true, recursive: true });
    },
    url: `http://127.0.0.1:${address.port}/renderer.html`,
  };
};

describe('MCP App frame relay', () => {
  it('exposes the distinct secure official AppRenderer boundary', () => {
    expect(typeof SecureAppRenderer).toBe('function');
    expect(typeof applyMcpAppFramePolicy).toBe('function');
  });

  it('rejects an untrusted copied document-policy handle before an AppRenderer can navigate', () => {
    const copiedPolicy = Object.freeze({
      bindingId: 'binding-weather',
      snapshot: Object.freeze({ allow: 'camera', approvedPermissions: Object.freeze({ camera: Object.freeze({}) }), revision: 2, warnings: Object.freeze([]) }),
    });
    const policyClient = Object.freeze({ currentDocumentPolicy: () => copiedPolicy });
    expect(() => renderToStaticMarkup(createElement(SecureAppRenderer, {
      bindingId: 'binding-weather',
      bootstrapUrl: 'https://apps.example.test/bootstrap',
      bridgeFactory: (async () => ({ close: async () => undefined })) as never,
      documentPolicy: copiedPolicy as never,
      policyClient,
      rendererProps: { tool: { inputSchema: { type: 'object' }, name: 'weather' } },
    }))).toThrow('no longer current');
  });

  it('applies the exact server-issued policy to the one outer frame without widening it', () => {
    const attributes = new Map<string, string>();
    const iframe = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    };
    applyMcpAppFramePolicy(iframe as never, Object.freeze({
      bindingId: 'binding-weather',
      snapshot: Object.freeze({ allow: 'camera; microphone', approvedPermissions: Object.freeze({}), revision: 2, warnings: Object.freeze([]) }),
    }) as never);
    expect(Object.fromEntries(attributes)).toEqual({
      allow: 'camera; microphone',
      referrerpolicy: 'no-referrer',
      sandbox: 'allow-scripts allow-same-origin',
    });
  });

  it('accepts only its exact proxy source and origin before providing the canonical resource without an authenticated route call', () => {
    const browser = fakeBrowser();
    const messages: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        messages.push(message);
        return messageResult();
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();

    browser.emit({ data: proxyReady(), origin: 'http://127.0.0.1:43125', source: browser.child });
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: {} });
    expect(browser.child.posts).toEqual([]);
    expect(messages).toEqual([]);

    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    expect(messages).toEqual([]);
    expect(browser.child.posts).toEqual([{
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          allow: '',
          contentSecurityPolicy: "default-src 'none'",
          html: '<main>Weather</main>',
        },
      },
      targetOrigin: 'http://127.0.0.1:43124',
    }]);
  });

  it('provides a valid built App resource without imposing the runtime message-size limit', () => {
    const browser = fakeBrowser();
    const html = `<main>${'x'.repeat(frame.relay.maxMessageBytes)}</main>`;
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-built-app',
      frame,
      iframe: browser.iframe,
      resource: Object.freeze({ html, kind: 'resource' as const }),
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async () => messageResult(),
      },
      window: browser.window,
    });
    relay.start();

    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    expect(browser.child.posts).toEqual([{
      message: {
        jsonrpc: '2.0',
        method: 'ui/notifications/sandbox-resource-ready',
        params: {
          allow: frame.allow,
          contentSecurityPolicy: frame.policy.contentSecurityPolicy,
          html,
        },
      },
      targetOrigin: frame.targetOrigin,
    }]);
  });

  it('forwards valid frames one at a time and returns ordered server frames only to its exact proxy origin', async () => {
    const browser = fakeBrowser();
    const first = deferred<McpAppRouteMessages>();
    const second = deferred<McpAppRouteMessages>();
    const calls: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        calls.push(message);
        return calls.length === 1 ? first.promise : second.promise;
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    const firstRequest = Object.freeze({ id: 'one', jsonrpc: '2.0', method: 'ping', params: Object.freeze({}) });
    const secondRequest = Object.freeze({ id: 'two', jsonrpc: '2.0', method: 'ping', params: Object.freeze({}) });

    browser.emit({ data: firstRequest, origin: frame.targetOrigin, source: browser.child });
    browser.emit({ data: secondRequest, origin: frame.targetOrigin, source: browser.child });
    await eventually(() => calls.length === 1);
    expect(calls).toEqual([firstRequest]);

    first.resolve(messageResult([{ id: 'one', jsonrpc: '2.0', result: { ready: 1 } }]));
    await eventually(() => calls.length === 2);
    expect(calls).toEqual([firstRequest, secondRequest]);
    second.resolve(messageResult([{ id: 'two', jsonrpc: '2.0', result: { ready: 2 } }]));
    await eventually(() => browser.child.posts.length === 3);

    expect(browser.child.posts.slice(1)).toEqual([
      { message: { id: 'one', jsonrpc: '2.0', result: { ready: 1 } }, targetOrigin: frame.targetOrigin },
      { message: { id: 'two', jsonrpc: '2.0', result: { ready: 2 } }, targetOrigin: frame.targetOrigin },
    ]);
  });

  it('delivers an authenticated consent continuation only to its current proxy window', () => {
    const browser = fakeBrowser();
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
      routes: { close: async () => closeResult(), forceClose: async () => true, message: async () => messageResult() },
      window: browser.window,
    });
    relay.start();
    expect(relay.deliverHostMessages([{ id: 'action-1', jsonrpc: '2.0', result: { continued: true } }])).toBe(true);
    expect(browser.child.posts).toEqual([{
      message: { id: 'action-1', jsonrpc: '2.0', result: { continued: true } }, targetOrigin: frame.targetOrigin,
    }]);
    relay.detach();
    expect(relay.deliverHostMessages([{ id: 'late', jsonrpc: '2.0', result: {} }])).toBe(false);
  });

  it('waits for the trusted teardown acknowledgement before releasing the route and never processes further frames', async () => {
    const browser = fakeBrowser();
    const closeCalls: unknown[] = [];
    const messages: unknown[] = [];
    let forceClosed = false;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls.push(options);
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceClosed = true;
        return true;
      },
      message: async (_bindingId, message) => {
        messages.push(message);
        return messageResult([], 'closed');
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 100, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    const closing = relay.close();
    await eventually(() => closeCalls.length === 1);
    const id = (closeCalls[0] as { readonly id: string }).id;
    browser.emit({ data: { id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await closing;

    expect(messages).toEqual([{ id, jsonrpc: '2.0', result: {} }]);
    expect(forceClosed).toBe(false);
    browser.emit({ data: { id: 'late', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child });
    expect(messages).toHaveLength(1);
  });

  // The attribute is what mcp-app-real.e2e waits on before it closes a
  // preview; each transition is published on the event that changes it.
  const publishedRelayStates = (browser: ReturnType<typeof fakeBrowser>): Readonly<{ readonly iframe: McpAppFrameIframe; readonly states: readonly string[] }> => {
    const states: string[] = [];
    return Object.freeze({
      iframe: Object.freeze({
        contentWindow: browser.iframe.contentWindow,
        setAttribute: (name: string, value: string) => {
          expect(name).toBe('data-mcp-app-relay-state');
          states.push(value);
        },
      }),
      states,
    });
  };

  it('publishes loading, ready, closing, and closed on the iframe as the relay moves through a graceful close', async () => {
    const browser = fakeBrowser();
    const published = publishedRelayStates(browser);
    const closeCalls: { readonly id: string }[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls.push(options);
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => true,
      message: async () => messageResult([], 'closed'),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 100, frame, iframe: published.iframe, resource, routes, window: browser.window });
    expect(published.states).toEqual([]);
    expect(relay.start()).toBe(true);
    expect(published.states).toEqual(['loading']);
    expect(relay.start()).toBe(false);
    expect(published.states).toEqual(['loading']);
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(published.states).toEqual(['loading', 'ready']);
    browser.emit({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(published.states).toEqual(['loading', 'ready']);

    const closing = relay.close();
    expect(published.states).toEqual(['loading', 'ready', 'closing']);
    await eventually(() => closeCalls.length === 1);
    expect(published.states).toEqual(['loading', 'ready', 'closing']);
    browser.emit({ data: { id: closeCalls[0]!.id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await closing;
    expect(published.states).toEqual(['loading', 'ready', 'closing', 'closed']);
    await relay.close();
    expect(published.states).toEqual(['loading', 'ready', 'closing', 'closed']);
  });

  it('publishes closing and closed, never ready, around the forced DELETE of a proxy that never signaled readiness', async () => {
    const browser = fakeBrowser();
    const published = publishedRelayStates(browser);
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult();
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult(),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 30_000, frame, iframe: published.iframe, resource, routes, window: browser.window });
    relay.start();
    const closing = relay.close();
    expect(published.states).toEqual(['loading', 'closing']);
    await closing;
    expect(published.states).toEqual(['loading', 'closing', 'closed']);
    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(1);
  });

  it('force-deletes a closing binding when the ready proxy never acknowledges the teardown frame', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceClosed = false;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceClosed = true;
        return true;
      },
      message: async () => messageResult(),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 1, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });

    await relay.close();

    expect(closeCalls).toBe(1);
    expect(forceClosed).toBe(true);
  });

  it('force-deletes immediately, without a teardown handshake or the timer, when the proxy never signaled readiness', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult(),
    };
    // The full 30 s budget: a timer-driven fallback would fail this test.
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 30_000, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();

    await relay.close();

    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(1);
    expect(relay.state).toBe('closed');
    expect(browser.child.posts).toEqual([]);
    // A proxy that reports ready after the close began is a late arrival, not
    // a reopened relay.
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(false);
  });

  it('renders the exact server-issued sandbox URL and no inline document or credential-bearing attribute', () => {
    const markup = renderToStaticMarkup(createElement(McpAppFrame, {
      bindingId: 'binding-weather',
      frame,
      resource,
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async () => messageResult(),
      },
    }));

    expect(markup).toContain('src="http://127.0.0.1:43124/#sandbox-configuration"');
    expect(markup).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).not.toContain('srcdoc=');
    expect(markup).not.toContain('foreground-secret');
  });

  it('rejects binding-id smuggling and oversized frames while bounding queued relay work', async () => {
    const browser = fakeBrowser();
    const first = deferred<McpAppRouteMessages>();
    const calls: unknown[] = [];
    const routes: McpAppFrameRelayRoutes = {
      close: async () => closeResult(),
      forceClose: async () => true,
      message: async (_bindingId, message) => {
        calls.push(message);
        return first.promise;
      },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);

    expect(relay.receive({
      data: { bindingId: 'another-binding', id: 'wrong-binding', jsonrpc: '2.0', method: 'ping' },
      origin: frame.targetOrigin,
      source: browser.child,
    })).toBe(false);
    expect(relay.receive({
      data: { id: 'too-large', jsonrpc: '2.0', method: 'ping', params: { value: 'x'.repeat(frame.relay.maxMessageBytes) } },
      origin: frame.targetOrigin,
      source: browser.child,
    })).toBe(false);
    expect(relay.receive({ data: { id: 'one', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    expect(relay.receive({ data: { id: 'two', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    expect(relay.receive({ data: { id: 'three', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(false);
    await eventually(() => calls.length === 1);
    expect(calls).toEqual([{ id: 'one', jsonrpc: '2.0', method: 'ping' }]);

    first.resolve(messageResult());
  });

  it('rejects nonordinary nested JSON at both proxy boundaries without throwing its message listener', async () => {
    const deep = (): unknown => {
      let value: unknown = Object.freeze({ leaf: true });
      for (let depth = 0; depth < 64; depth += 1) value = Object.freeze({ child: value });
      return value;
    };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const customPrototype = Object.create({ inherited: true });
    customPrototype.value = 'custom';
    const invalidValues: readonly unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => undefined,
      Symbol('untrusted'),
      new Date(),
      customPrototype,
      cyclic,
      deep(),
      Array.from({ length: 4_097 }, () => Object.freeze({})),
    ];

    for (const nested of invalidValues) {
      const browser = fakeBrowser();
      const messages: unknown[] = [];
      const relay = createMcpAppFrameRelay({
        bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
        routes: {
          close: async () => closeResult(),
          forceClose: async () => true,
          message: async (_bindingId, message) => {
            messages.push(message);
            return messageResult();
          },
        },
        window: browser.window,
      });
      relay.start();
      expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);
      const message = Object.freeze({ id: 'invalid', jsonrpc: '2.0' as const, method: 'ping', params: Object.freeze({ nested }) });
      const event = Object.freeze({ data: message, origin: frame.targetOrigin, source: browser.child });

      expect(relay.receive(event)).toBe(false);
      expect(() => browser.emit(event)).not.toThrow();
      expect(relay.deliverHostMessages([message as never])).toBe(false);
      expect(messages).toEqual([]);
    }
  });

  it('preserves null-prototype JSON with an enumerable own __proto__ value at both proxy boundaries', async () => {
    const browser = fakeBrowser();
    const messages: unknown[] = [];
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather', frame, iframe: browser.iframe, resource,
      routes: {
        close: async () => closeResult(),
        forceClose: async () => true,
        message: async (_bindingId, message) => {
          messages.push(message);
          return messageResult();
        },
      },
      window: browser.window,
    });
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', { enumerable: true, value: 'literal-data' });
    const inbound = Object.freeze({ id: 'inbound', jsonrpc: '2.0' as const, method: 'ping', params: payload });
    const outbound = Object.freeze({ id: 'outbound', jsonrpc: '2.0' as const, method: 'ping', params: payload });
    relay.start();
    expect(relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child })).toBe(true);

    expect(relay.receive({ data: inbound, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    await eventually(() => messages.length === 1);
    expect(messages[0]).toBe(inbound);
    expect(relay.deliverHostMessages([outbound as never])).toBe(true);
    const delivered = browser.child.posts.at(-1) as { readonly message: unknown };
    expect(delivered.message).toBe(outbound);
    expect((delivered.message as { readonly params: object }).params).toBe(payload);
  });

  it('always queues its close operation behind already accepted traffic even when normal relay capacity is exhausted', async () => {
    const browser = fakeBrowser();
    const active = deferred<McpAppRouteMessages>();
    let closeCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => true,
      message: async () => active.promise,
    };
    const relay = createMcpAppFrameRelay({
      bindingId: 'binding-weather',
      frame: Object.freeze({ ...frame, relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 1 }) }),
      iframe: browser.iframe,
      resource,
      routes,
      window: browser.window,
    });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'active', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    const closing = relay.close();
    active.resolve(messageResult());
    await closing;

    expect(closeCalls).toBe(1);
  });

  it('makes repeated unmount cleanup a resolved no-op after the route has already closed the binding', async () => {
    const browser = fakeBrowser();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => messageResult([], 'closed'),
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'route-closed', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    await eventually(() => relay.state === 'closed');

    await relay.close();
    await relay.close();

    expect(closeCalls).toBe(0);
    expect(forceCloseCalls).toBe(0);
  });

  it('force-deletes a binding when already accepted relay traffic never settles during unmount cleanup', async () => {
    const browser = fakeBrowser();
    const hung = deferred<McpAppRouteMessages>();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async () => {
        closeCalls += 1;
        return closeResult(undefined, 'closed');
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return true;
      },
      message: async () => hung.promise,
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 5, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    expect(relay.receive({ data: { id: 'hung', jsonrpc: '2.0', method: 'ping' }, origin: frame.targetOrigin, source: browser.child })).toBe(true);
    const closing = relay.close();

    await eventually(() => forceCloseCalls === 1);
    await closing;

    expect(closeCalls).toBe(0);
  });

  it('collapses delivery-failure and timeout fallback into one force-delete attempt', async () => {
    const browser = fakeBrowser();
    const forced = deferred<boolean>();
    let closeCalls = 0;
    let forceCloseCalls = 0;
    const routes: McpAppFrameRelayRoutes = {
      close: async (_bindingId, options) => {
        closeCalls += 1;
        return closeResult({ id: options.id, jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} });
      },
      forceClose: async () => {
        forceCloseCalls += 1;
        return forced.promise;
      },
      message: async () => { throw new Error('teardown acknowledgement was not delivered'); },
    };
    const relay = createMcpAppFrameRelay({ bindingId: 'binding-weather', closeTimeoutMs: 20, frame, iframe: browser.iframe, resource, routes, window: browser.window });
    relay.start();
    relay.receive({ data: proxyReady(), origin: frame.targetOrigin, source: browser.child });
    const closing = relay.close();
    await eventually(() => closeCalls === 1);
    const id = 'mcp-app-frame-close:binding-weather';
    browser.emit({ data: { id, jsonrpc: '2.0', result: {} }, origin: frame.targetOrigin, source: browser.child });
    await eventually(() => forceCloseCalls === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(forceCloseCalls).toBe(1);

    forced.resolve(true);
    await closing;
  });
});

describe('Secure AppRenderer in Chrome', () => {
  it('holds one real iframe at about:blank until policy attributes are applied, then makes one bootstrap request', async () => {
    const fixture = await mountedSecureRendererFixture();
    const browser = await chromium.launch(browserLaunchOptions);
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => { errors.push(error.message); });
    try {
      await page.goto(fixture.url);
      try {
        await page.waitForFunction(() => '__secureRendererFixture' in globalThis, undefined, { timeout: 10_000 });
      } catch (error) {
        throw new Error(`Mounted secure renderer fixture did not initialize: ${errors.join('\n')}`, { cause: error });
      }
      try {
        await page.waitForFunction(() => (globalThis as typeof globalThis & {
          __secureRendererFixture: { stats(): { readonly factories: number; readonly iframeNodes: number } };
        }).__secureRendererFixture.stats().factories === 1, undefined, { timeout: 10_000 });
      } catch (error) {
        const stats = await page.evaluate(() => (globalThis as typeof globalThis & {
          __secureRendererFixture: { stats(): unknown };
        }).__secureRendererFixture.stats());
        const markup = await page.locator('body').innerHTML();
        throw new Error(`Mounted secure renderer bridge did not settle: ${JSON.stringify(stats)} ${errors.join('\n')} ${markup}`, { cause: error });
      }
      await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1, undefined, { timeout: 10_000 });
      await page.waitForFunction(() => (globalThis as typeof globalThis & {
        __secureRendererFixture: { stats(): { readonly trace: readonly Readonly<{ readonly name: string; readonly value: string }>[] } };
      }).__secureRendererFixture.stats().trace.some((entry) => entry.name === 'src' && entry.value.endsWith('/app-bootstrap')), undefined, { timeout: 10_000 });

      const frame = page.locator('iframe');
      expect(await frame.getAttribute('allow')).toBe('');
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      await expect.poll(() => fixture.bootstrapRequests.length).toBe(1);
      expect(fixture.bootstrapRequests).toEqual(['/app-bootstrap']);

      const positive = await page.evaluate(() => (globalThis as typeof globalThis & {
        __secureRendererFixture: { stats(): { readonly factories: number; readonly iframeNodes: number; readonly trace: readonly Readonly<{ readonly name: string; readonly value: string }>[] } };
      }).__secureRendererFixture.stats());
      const blank = positive.trace.findIndex((entry) => entry.name === 'src' && entry.value === 'about:blank');
      const allow = positive.trace.findIndex((entry, index) => index > blank && entry.name === 'allow' && entry.value === '');
      const referrer = positive.trace.findIndex((entry, index) => index > allow && entry.name === 'referrerpolicy' && entry.value === 'no-referrer');
      const sandbox = positive.trace.findIndex((entry, index) => index > referrer && entry.name === 'sandbox' && entry.value === 'allow-scripts allow-same-origin');
      const bootstrap = positive.trace.findIndex((entry, index) => index > sandbox && entry.name === 'src' && entry.value.endsWith('/app-bootstrap'));
      expect(blank).toBeGreaterThanOrEqual(0);
      expect(allow).toBeGreaterThan(blank);
      expect(referrer).toBeGreaterThan(allow);
      expect(sandbox).toBeGreaterThan(referrer);
      expect(bootstrap).toBeGreaterThan(sandbox);
      expect(positive).toMatchObject({ factories: 1, iframeNodes: 1 });

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __secureRendererFixture: { copied(): void };
      }).__secureRendererFixture.copied());
      await page.locator('#policy-error').waitFor();
      expect(await page.locator('iframe').count()).toBe(0);
      expect(fixture.bootstrapRequests).toEqual(['/app-bootstrap']);

      await page.evaluate(() => (globalThis as typeof globalThis & {
        __secureRendererFixture: { widened(): void };
      }).__secureRendererFixture.widened());
      await page.locator('#policy-error').waitFor();
      expect(await page.locator('iframe').count()).toBe(0);
      expect(fixture.bootstrapRequests).toEqual(['/app-bootstrap']);

      await page.evaluate(async () => (globalThis as typeof globalThis & {
        __secureRendererFixture: { stale(): Promise<void> };
      }).__secureRendererFixture.stale());
      await page.locator('#policy-error').waitFor();
      expect(await page.locator('iframe').count()).toBe(0);
      expect(fixture.bootstrapRequests).toEqual(['/app-bootstrap']);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45_000);
});
