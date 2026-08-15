import { describe, expect, it } from '@rstest/core';

import {
  McpAppClient,
  type McpAppPreviewCreateRequest,
} from '../src/mcp/mcp-app-client.ts';

const request: McpAppPreviewCreateRequest = Object.freeze({
  host: Object.freeze({
    availableDisplayModes: Object.freeze(['inline']),
    containerDimensions: Object.freeze({ height: 400, width: 640 }),
    deviceCapabilities: Object.freeze({}),
    displayMode: 'inline',
    locale: 'en-US',
    platform: 'web',
    safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
    styles: Object.freeze({}),
    theme: 'light',
    timeZone: 'UTC',
    userAgent: 'Agent Bundle Workbench',
  }),
  input: Object.freeze({ city: 'Berlin' }),
  previewProfile: 'portable',
  result: Object.freeze({ content: Object.freeze([]) }),
  toolName: 'weather',
});

const preview = Object.freeze({
  bindingId: 'binding-weather',
  frame: Object.freeze({
    allow: '',
    policy: Object.freeze({
      contentSecurityPolicy: "default-src 'none'",
      iframeAllow: '',
      permissionsPolicy: 'camera=()',
    }),
    referrerPolicy: 'no-referrer',
    relay: Object.freeze({ maxMessageBytes: 4096, maxQueuedMessages: 4 }),
    sandbox: 'allow-scripts allow-same-origin',
    src: 'http://127.0.0.1:43124/#sandbox-configuration',
    targetOrigin: 'http://127.0.0.1:43124',
  }),
  profile: Object.freeze({ kind: 'apps' }),
  resource: Object.freeze({ html: '<main>Weather</main>', kind: 'resource' }),
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

describe('MCP App browser client', () => {
  it('creates a binding-scoped preview without putting the foreground credential in its URL or request payload', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ lifecycle: 'created', preview });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.create('session-weather', request)).resolves.toEqual(preview);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['/api/project/session', { credentials: 'same-origin' }]);
    expect(calls[1]?.[0]).toBe('/api/mcp/sessions/session-weather/apps');
    expect(calls[1]?.[1]).toMatchObject({ method: 'POST' });
    const headers = new Headers(calls[1]?.[1]?.headers);
    expect(headers.get('x-agent-bundle-session')).toBe('foreground-secret');
    expect(String(calls[1]?.[0])).not.toContain('foreground-secret');
    expect(String(calls[1]?.[1]?.body)).not.toContain('foreground-secret');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual(request);
  });

  it('forwards one binding message through the authenticated route and exposes only the returned frames', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({
        accepted: true,
        actions: [],
        lifecycle: 'initialized',
        messages: [{ id: 'ping-1', jsonrpc: '2.0', result: {} }],
      });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });
    const message = Object.freeze({ id: 'ping-1', jsonrpc: '2.0' as const, method: 'ping', params: Object.freeze({}) });

    await expect(client.message('binding-weather', message)).resolves.toEqual({
      accepted: true,
      lifecycle: 'initialized',
      messages: [{ id: 'ping-1', jsonrpc: '2.0', result: {} }],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toBe('/api/mcp/apps/binding-weather/messages');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ message });
  });
});
