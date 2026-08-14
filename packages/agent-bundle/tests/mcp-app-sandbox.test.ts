import { expect, it } from '@rstest/core';

import {
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
