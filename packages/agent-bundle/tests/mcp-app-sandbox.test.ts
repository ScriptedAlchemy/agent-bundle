import { once } from 'node:events';
import { connect } from 'node:net';

import { expect, it } from '@rstest/core';

import {
  createMcpAppDocumentPolicySnapshot,
  createMcpAppSandboxBridge,
  createMcpAppSandboxFrame,
  createMcpAppSandboxProxy,
  deriveMcpAppSandboxPolicy,
} from '../src/dev/mcp-app-sandbox.ts';

const relay = Object.freeze({ maxMessageBytes: 1_024, maxQueuedMessages: 1 });
const proxyEndpoint = Object.freeze({ origin: 'http://127.0.0.1:43124', relay });
const declaration = Object.freeze({
  permissions: Object.freeze({ camera: Object.freeze({}), microphone: Object.freeze({}) }),
});
const consent = Object.freeze({ permissions: Object.freeze({ camera: Object.freeze({}) }) });

const frameFor = () => createMcpAppSandboxFrame({
  consent,
  declaration,
  hostOrigin: 'http://127.0.0.1:43123',
  proxy: proxyEndpoint,
});

const rpcNotification = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  method,
  params,
});

it('serves one immutable, different-origin shell and no MCP or session route', async () => {
  const proxy = await createMcpAppSandboxProxy({
    hostOrigin: 'http://127.0.0.1:43123',
    maxMessageBytes: 1_024,
    maxQueuedMessages: 1,
    port: 0,
  });

  try {
    expect(proxy.origin).not.toBe('http://127.0.0.1:43123');
    expect(proxy.url).toBe(`${proxy.origin}/`);
    expect(proxy.relay).toEqual(relay);

    const [root, query, forbidden] = await Promise.all([
      fetch(proxy.url),
      fetch(`${proxy.url}?resource=untrusted`),
      fetch(`${proxy.origin}/mcp`),
    ]);

    expect(root.status).toBe(200);
    expect(await root.text()).toBe(await query.text());
    expect(root.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(root.headers.get('permissions-policy')).toBeNull();
    expect(forbidden.status).toBe(404);
  } finally {
    await proxy.close();
  }
});

it('derives outer permissions from the declared and explicitly consented capability objects', () => {
  expect(deriveMcpAppSandboxPolicy({
    csp: {
      connectDomains: ['https://api.example.test', 'javascript:alert(1)', 'https://api.example.test'],
      frameDomains: ['https://frames.example.test'],
      resourceDomains: ['https://cdn.example.test', '*'],
    },
    permissions: { camera: {}, microphone: {} },
  }, {
    permissions: { camera: {}, clipboardWrite: {} },
  })).toEqual({
    contentSecurityPolicy: "default-src 'none'; base-uri 'self'; connect-src https://api.example.test; frame-src https://frames.example.test; img-src data: https://cdn.example.test; media-src https://cdn.example.test; font-src https://cdn.example.test; style-src 'unsafe-inline' https://cdn.example.test; script-src 'unsafe-inline' https://cdn.example.test",
    iframeAllow: 'camera',
    permissionsPolicy: 'camera=(self), clipboard-write=(), geolocation=(), microphone=()',
    warnings: [
      { code: 'csp-source-rejected', value: 'javascript:alert(1)' },
      { code: 'csp-wildcard-rejected', value: '*' },
    ],
  });
});

it('fails closed for unsafe CSP sources and freezes document grants into a revisioned policy', () => {
  const csp = {
    connectDomains: ['https://api.weather.example', '*', 'http://127.0.0.1:9000'],
    frameDomains: [],
    redirectDomains: [],
    resourceDomains: [],
  } as const;
  const permissions = {
    camera: {},
    clipboardWrite: {},
    geolocation: {},
    microphone: {},
  } as const;
  const policy = deriveMcpAppSandboxPolicy({ csp, permissions }, {
    permissions: { clipboardWrite: {} },
  });

  expect(policy.contentSecurityPolicy).toContain('connect-src https://api.weather.example');
  expect(policy.permissionsPolicy).toBe(
    'camera=(), clipboard-write=(self), geolocation=(), microphone=()',
  );
  expect(policy.warnings).toEqual([
    { code: 'csp-wildcard-rejected', value: '*' },
    { code: 'csp-source-rejected', value: 'http://127.0.0.1:9000' },
  ]);

  const snapshot = createMcpAppDocumentPolicySnapshot(2, { csp, permissions }, [{
    authorizationId: 'authorization-1',
    bindingId: 'binding-1',
    capability: 'clipboard-write',
    challengeId: 'challenge-1',
    scope: 'document',
  }]);
  expect(snapshot).toEqual({
    allow: 'clipboard-write',
    approvedPermissions: { clipboardWrite: {} },
    revision: 2,
    warnings: policy.warnings,
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.approvedPermissions)).toBe(true);
});

it('uses one proxy relay configuration in the fixed outer frame contract', () => {
  const frame = frameFor();
  expect(frame).toMatchObject({
    allow: 'camera',
    referrerPolicy: 'no-referrer',
    sandbox: 'allow-scripts allow-same-origin',
    targetOrigin: 'http://127.0.0.1:43124',
  });
  expect(frame.relay).toEqual(relay);
  expect(Object.isFrozen(frame.relay)).toBe(true);
  expect(JSON.parse(decodeURIComponent(new URL(frame.src).hash.slice(1)))).toEqual({
    hostOrigin: 'http://127.0.0.1:43123',
    maxMessageBytes: 1_024,
  });
});

it('freezes a validated relay configuration instead of retaining a caller-owned object', () => {
  const mutableRelay = { maxMessageBytes: 1_024, maxQueuedMessages: 1 };
  const frame = createMcpAppSandboxFrame({
    hostOrigin: 'http://127.0.0.1:43123',
    proxy: { origin: 'http://127.0.0.1:43124', relay: mutableRelay },
  });

  mutableRelay.maxMessageBytes = 2;
  mutableRelay.maxQueuedMessages = 2;
  expect(frame.relay).toEqual({ maxMessageBytes: 1_024, maxQueuedMessages: 1 });
  expect(frame.relay).not.toBe(mutableRelay);
  expect(Object.isFrozen(frame.relay)).toBe(true);
});

it('enforces the JSON-RPC proxy lifecycle and holds host traffic until initialized', () => {
  const sent: { message: unknown; targetOrigin: string }[] = [];
  const forwarded: unknown[] = [];
  const proxyWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({ message, targetOrigin });
    },
  };
  const bridge = createMcpAppSandboxBridge({
    frame: frameFor(),
    onMessage: (message) => forwarded.push(message),
    proxyWindow,
  });
  const event = (data: unknown, source: unknown = proxyWindow, origin = 'http://127.0.0.1:43124') => ({ data, origin, source });

  expect(bridge.provideResource({ html: '<p>Hello</p>' })).toBe(false);
  expect(bridge.receive(event(rpcNotification('ui/notifications/sandbox-proxy-ready'), {}))).toBe(false);
  expect(bridge.receive(event(rpcNotification('ui/notifications/sandbox-proxy-ready'), proxyWindow, 'http://127.0.0.1:43124'))).toBe(true);
  expect(bridge.lifecycle).toBe('proxy-ready');

  expect(bridge.provideResource({ html: '<p>Rejected</p>', sandbox: {} as unknown as string })).toBe(false);
  expect(bridge.provideResource({
    csp: { connectDomains: ['https://api.example.test'] },
    html: '<p>Hello</p>',
    permissions: { camera: {} },
    sandbox: 'allow-scripts',
  })).toBe(true);
  expect(bridge.lifecycle).toBe('resource-ready');
  expect(bridge.send(rpcNotification('app/too-large', { value: 'x'.repeat(1_024) }))).toBe(false);
  expect(bridge.send(rpcNotification('app/ping'))).toBe(true);
  expect(bridge.send(rpcNotification('app/second-ping'))).toBe(false);
  expect(bridge.send(rpcNotification('ui/notifications/sandbox-invented'))).toBe(false);
  expect(sent).toEqual([{
    message: rpcNotification('ui/notifications/sandbox-resource-ready', {
      csp: { connectDomains: ['https://api.example.test'] },
      html: '<p>Hello</p>',
      permissions: { camera: {} },
      sandbox: 'allow-scripts',
    }),
    targetOrigin: 'http://127.0.0.1:43124',
  }]);

  expect(bridge.receive(event(rpcNotification('ui/notifications/sandbox-resource-ready')))).toBe(false);
  expect(bridge.receive(event({ id: 'init-1', jsonrpc: '2.0', method: 'ui/initialize', params: {} }))).toBe(true);
  expect(bridge.lifecycle).toBe('initializing');
  expect(forwarded).toEqual([{ id: 'init-1', jsonrpc: '2.0', method: 'ui/initialize', params: {} }]);
  expect(bridge.receive(event(rpcNotification('ui/notifications/initialized')))).toBe(false);
  expect(bridge.send({ id: 'wrong', jsonrpc: '2.0', result: {} })).toBe(false);
  expect(bridge.send({ id: 'init-1', jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } })).toBe(true);
  expect(bridge.lifecycle).toBe('initialize-responded');
  expect(bridge.receive(event(rpcNotification('ui/notifications/initialized')))).toBe(true);
  expect(bridge.lifecycle).toBe('initialized');
  expect(sent).toEqual([
    sent[0],
    {
      message: { id: 'init-1', jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } },
      targetOrigin: 'http://127.0.0.1:43124',
    },
    {
      message: rpcNotification('app/ping'),
      targetOrigin: 'http://127.0.0.1:43124',
    },
  ]);
  expect(bridge.receive(event(rpcNotification('ui/notifications/sandbox-unknown')))).toBe(false);
  expect(bridge.receive(event(rpcNotification('app/pong')))).toBe(true);
  expect(forwarded.at(-1)).toEqual(rpcNotification('app/pong'));

  bridge.close();
  expect(bridge.lifecycle).toBe('closed');
  expect(bridge.send(rpcNotification('app/after-close'))).toBe(false);
});

it('uses an opaque child relay shell with real MCP Apps JSON-RPC notification methods', async () => {
  const proxy = await createMcpAppSandboxProxy({
    hostOrigin: 'http://127.0.0.1:43123',
    maxMessageBytes: 1_024,
    port: 0,
  });
  const frame = createMcpAppSandboxFrame({
    consent,
    declaration,
    hostOrigin: 'http://127.0.0.1:43123',
    proxy,
  });
  try {
    const shell = await fetch(proxy.url).then((response) => response.text());
    expect(shell).toContain('sandbox="allow-scripts"');
    expect(shell).toContain("event.origin !== 'null'");
    expect(shell).toContain('ui/notifications/sandbox-proxy-ready');
    expect(shell).toContain("method.startsWith('ui/notifications/sandbox-')");
    expect(shell).toContain('configuration.maxMessageBytes');
    expect(shell).toContain("Object.hasOwn(params, 'sandbox') && typeof params.sandbox !== 'string'");
    expect(new URL(frame.src).hash).toContain('maxMessageBytes');
  } finally {
    await proxy.close();
  }
});

it('bounds proxy shutdown when an idle client holds a connection open', async () => {
  const proxy = await createMcpAppSandboxProxy({
    closeTimeoutMs: 25,
    hostOrigin: 'http://127.0.0.1:43123',
    port: 0,
  });
  const socket = connect(Number(new URL(proxy.url).port), '127.0.0.1');
  await once(socket, 'connect');
  const socketClosed = once(socket, 'close');

  try {
    const closed = await Promise.race([
      proxy.close().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    expect(closed).toBe(true);
    await socketClosed;
    expect(socket.destroyed).toBe(true);
  } finally {
    socket.destroy();
    await proxy.close();
  }
});
