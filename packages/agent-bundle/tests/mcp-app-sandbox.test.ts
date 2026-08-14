import { expect, it } from '@rstest/core';

import {
  createMcpAppSandboxBridge,
  createMcpAppSandboxProxy,
  deriveMcpAppSandboxPolicy,
} from '../src/dev/mcp-app-sandbox.ts';

it('serves one immutable, different-origin shell and no MCP or session route', async () => {
  const proxy = await createMcpAppSandboxProxy({
    hostOrigin: 'http://127.0.0.1:43123',
    port: 0,
  });

  try {
    expect(proxy.origin).not.toBe('http://127.0.0.1:43123');
    expect(proxy.url).toBe(`${proxy.origin}/`);

    const [root, query, forbidden] = await Promise.all([
      fetch(proxy.url),
      fetch(`${proxy.url}?resource=untrusted`),
      fetch(`${proxy.origin}/mcp`),
    ]);

    expect(root.status).toBe(200);
    expect(await root.text()).toBe(await query.text());
    expect(root.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(root.headers.get('permissions-policy')).toContain('camera=()');
    expect(forbidden.status).toBe(404);
  } finally {
    await proxy.close();
  }
});

it('derives app policy from validated declarations without granting extra sources or permissions', () => {
  expect(deriveMcpAppSandboxPolicy({
    csp: {
      connectDomains: ['https://api.example.test', 'javascript:alert(1)', 'https://api.example.test'],
      resourceDomains: ['https://cdn.example.test', '*'],
      frameDomains: ['https://frames.example.test'],
    },
    permissions: {
      camera: true,
      clipboardWrite: false,
      microphone: true,
    },
  })).toEqual({
    contentSecurityPolicy: "default-src 'none'; base-uri 'none'; connect-src https://api.example.test; frame-src https://frames.example.test; img-src data: https://cdn.example.test; media-src https://cdn.example.test; font-src https://cdn.example.test; style-src 'unsafe-inline' https://cdn.example.test; script-src 'unsafe-inline' https://cdn.example.test",
    permissionsPolicy: 'camera=(self), clipboard-write=(), geolocation=(), microphone=(self)',
  });
});

it('accepts only its proxy source and origin through the ordered sandbox lifecycle', () => {
  const sent: { message: unknown; targetOrigin: string }[] = [];
  const proxyWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({ message, targetOrigin });
    },
  };
  const bridge = createMcpAppSandboxBridge({
    maxMessageBytes: 1_024,
    maxQueuedMessages: 1,
    proxyOrigin: 'http://127.0.0.1:43124',
    proxyWindow,
  });

  expect(bridge.provideResource({
    declaration: { permissions: { camera: true } },
    html: '<p>Hello</p>',
  })).toBe(false);
  expect(bridge.receive({
    data: { type: 'sandbox/ready' },
    origin: 'http://127.0.0.1:43124',
    source: {},
  })).toBe(false);
  expect(bridge.receive({
    data: { type: 'sandbox/initialized' },
    origin: 'http://127.0.0.1:43124',
    source: proxyWindow,
  })).toBe(false);
  expect(bridge.receive({
    data: { type: 'sandbox/ready' },
    origin: 'http://127.0.0.1:43124',
    source: proxyWindow,
  })).toBe(true);
  expect(bridge.lifecycle).toBe('ready');

  expect(bridge.provideResource({
    declaration: { permissions: { camera: true } },
    html: '<p>Hello</p>',
  })).toBe(true);
  expect(bridge.send({ type: 'app/ping' })).toBe(true);
  expect(bridge.send({ type: 'app/second-ping' })).toBe(false);
  expect(bridge.send({ type: 'sandbox/close' })).toBe(false);
  expect(sent).toEqual([{
    message: {
      allow: 'camera',
      contentSecurityPolicy: "default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      html: '<p>Hello</p>',
      type: 'sandbox/resource-ready',
    },
    targetOrigin: 'http://127.0.0.1:43124',
  }]);

  expect(bridge.receive({
    data: { type: 'sandbox/resource-ready' },
    origin: 'http://127.0.0.1:43124',
    source: proxyWindow,
  })).toBe(true);
  expect(bridge.receive({
    data: { type: 'sandbox/initialized' },
    origin: 'http://127.0.0.1:43124',
    source: proxyWindow,
  })).toBe(true);
  expect(bridge.lifecycle).toBe('initialized');
  expect(sent).toEqual([
    {
      message: {
        allow: 'camera',
        contentSecurityPolicy: "default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; img-src data:; media-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        html: '<p>Hello</p>',
        type: 'sandbox/resource-ready',
      },
      targetOrigin: 'http://127.0.0.1:43124',
    },
    {
      message: { type: 'app/ping' },
      targetOrigin: 'http://127.0.0.1:43124',
    },
  ]);

  bridge.close();
  expect(bridge.lifecycle).toBe('closed');
  expect(bridge.send({ type: 'app/after-close' })).toBe(false);
  expect(sent.at(-1)).toEqual({
    message: { type: 'sandbox/close' },
    targetOrigin: 'http://127.0.0.1:43124',
  });
});
