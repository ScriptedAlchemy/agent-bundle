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
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      host: request.host, input: request.input, previewProfile: request.previewProfile, result: request.result, toolName: request.toolName,
    });
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

  it('lists server-created consent challenges and returns a fresh server snapshot without a grant', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const refreshed = Object.freeze({
      ...preview,
      frame: Object.freeze({
        ...preview.frame,
        allow: 'geolocation',
        documentPolicy: Object.freeze({
          allow: 'geolocation',
          approvedPermissions: Object.freeze({ geolocation: Object.freeze({}) }),
          revision: 2,
          warnings: Object.freeze([]),
        }),
      }),
    });
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (init?.method === 'POST') return json({ approved: true, lifecycle: 'initialized', messages: [], preview: refreshed });
      return json({ challenges: [{ expiresAt: 31_000, id: 'consent-1', request: { capability: 'geolocation', scope: 'document' } }], lifecycle: 'initialized' });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.consentChallenges('binding-weather')).resolves.toEqual([{
      expiresAt: 31_000,
      id: 'consent-1',
      request: { capability: 'geolocation', scope: 'document' },
    }]);
    await expect(client.decideConsent('binding-weather', 'consent-1', true)).resolves.toMatchObject({
      approved: true,
      messages: [],
      preview: { frame: { allow: 'geolocation', documentPolicy: { revision: 2 } } },
    });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toEqual({ approved: true, challengeId: 'consent-1' });
    expect(String(calls[2]?.[1]?.body)).not.toContain('grant-');
  });

  it('closes with a teardown frame then forgets the memory credential before its force-delete fallback', async () => {
    const calls: readonly [string, RequestInit | undefined][] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      (calls as [string, RequestInit | undefined][]).push([String(input), init]);
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      if (init?.method === 'DELETE') return json({ closed: true, lifecycle: 'closed' });
      return json({
        actions: [],
        lifecycle: 'closing',
        message: { id: 'close-1', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} },
      });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.close('binding-weather', { id: 'close-1', reason: 'MCP App frame unmounted.' })).resolves.toEqual({
      lifecycle: 'closing',
      message: { id: 'close-1', jsonrpc: '2.0', method: 'ui/resource-teardown', params: {} },
    });
    await expect(client.forceClose('binding-weather')).resolves.toBe(true);

    expect(calls.map(([path]) => path)).toEqual([
      '/api/project/session',
      '/api/mcp/apps/binding-weather/close',
      '/api/project/session',
      '/api/mcp/apps/binding-weather',
    ]);
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ id: 'close-1', reason: 'MCP App frame unmounted.' });
    expect(calls[3]?.[1]?.method).toBe('DELETE');
  });

  it('preserves a raw App frame that contains an own __proto__ JSON property', async () => {
    const rawFrame = JSON.parse('{"id":"proto-1","jsonrpc":"2.0","result":{"__proto__":{"ordinary":true}}}') as unknown;
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ accepted: true, actions: [], lifecycle: 'initialized', messages: [rawFrame] });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    const result = await client.message('binding-weather', { id: 'proto-1', jsonrpc: '2.0', method: 'ping' });
    const frame = result.messages[0] as Readonly<Record<string, unknown>>;
    const payload = frame.result as Readonly<Record<string, unknown>>;

    expect(Object.hasOwn(payload, '__proto__')).toBe(true);
    expect(payload['__proto__']).toEqual({ ordinary: true });
    expect(Object.getPrototypeOf(payload)).toBeNull();
  });

  it('rejects a preview frame whose proxy target origin is the authenticated foreground origin', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: preview.frame!.targetOrigin, token: 'foreground-secret' });
      return json({ lifecycle: 'created', preview });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.create('session-weather', request)).rejects.toThrow(
      'Foreground MCP App frame must use a distinct proxy origin.',
    );
  });

  it('classifies a malformed successful route body as an invalid route response', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return new Response('{', { headers: { 'content-type': 'application/json' }, status: 200 });
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.message('binding-weather', { id: 'bad-body', jsonrpc: '2.0', method: 'ping' })).rejects.toMatchObject({ code: 'AB8019' });
  });

  it('surfaces a structured non-2xx diagnostic without reclassifying it as a route-shape error', async () => {
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (String(input) === '/api/project/session') return json({ origin: 'http://127.0.0.1:43123', token: 'foreground-secret' });
      return json({ diagnostic: { code: 'AB8022', message: 'MCP App preview is not available.' } }, 404);
    };
    const client = new McpAppClient({ fetch: fetch as typeof globalThis.fetch });

    await expect(client.message('binding-weather', { id: 'not-found', jsonrpc: '2.0', method: 'ping' })).rejects.toMatchObject({
      code: 'AB8022',
      message: 'MCP App preview is not available.',
    });
  });
});
