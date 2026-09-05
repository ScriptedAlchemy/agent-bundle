import { describe, expect, it } from '@rstest/core';

import { ForegroundRouteClient, McpRouteClient, McpRouteClientError } from '../src/mcp/mcp-route-client.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

it('uses refreshed authority credentials for later MCP requests without reconstruction', async () => {
  const tokens = ['token-a', 'token-b'];
  const requestTokens: Array<string | null> = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      if (String(input) === '/api/project/session') return json({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        instanceId: 'foreground-instance-a',
        origin: 'http://127.0.0.1:4100',
        token: tokens.shift(),
      });
      requestTokens.push(new Headers(init?.headers).get('x-agent-bundle-session'));
      return json({ prompts: [], resourceTemplates: [], resources: [], tools: [] });
    },
  });
  const client = new McpRouteClient({ foreground });

  await client.catalog('session-weather');
  await foreground.refreshSession();
  await client.catalog('session-weather');

  expect(requestTokens).toEqual(['token-a', 'token-b']);
});

it('keeps an admitted request current across a same-instance foreground refresh', async () => {
  let bootstraps = 0;
  let resolveRequest!: (response: Response) => void;
  let requestDispatched = false;
  const heldRequest = new Promise<Response>((resolve) => { resolveRequest = resolve; });
  const foreground = new ForegroundRouteClient({
    fetch: async (input) => {
      if (String(input) === '/api/project/session') {
        bootstraps += 1;
        return json({
          cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
          instanceId: 'foreground-instance-a',
          origin: 'http://127.0.0.1:4100',
          token: `token-${String(bootstraps)}`,
        });
      }
      requestDispatched = true;
      return heldRequest;
    },
  });
  await foreground.sessionSnapshot();

  const request = foreground.protectedRequest('/api/runtime/runs', { method: 'POST' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(requestDispatched).toBe(true);
  await expect(foreground.refreshSession()).resolves.toMatchObject({
    generation: 0,
    instanceId: 'foreground-instance-a',
    token: 'token-2',
  });
  resolveRequest(json({ runId: 'runtime-run-1' }));

  await expect(request).resolves.toMatchObject({ ok: true, status: 200 });
});

const invalidSessionBodies: readonly [string, unknown][] = [
  ['a legacy two-field payload', { origin: 'http://127.0.0.1:4100', token: 'foreground-secret' }],
  ['a versioned payload', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', schemaVersion: 1, token: 'foreground-secret' }],
  ['an unexpected payload field', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', scope: 'workbench', token: 'foreground-secret' }],
  ['a malformed payload', { cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef', instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100' }],
];

it('advances the foreground generation only when the server instance changes', async () => {
  const sessions: Array<readonly [string, string]> = [
    ['foreground-instance-a', 'token-a'],
    ['foreground-instance-a', 'token-b'],
    ['foreground-instance-b', 'token-c'],
  ];
  const foreground = new ForegroundRouteClient({
    fetch: async () => {
      const next = sessions.shift();
      if (next === undefined) throw new Error('Unexpected foreground bootstrap.');
      return json({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        instanceId: next[0],
        origin: 'http://127.0.0.1:4100',
        token: next[1],
      });
    },
  });

  await expect(foreground.sessionSnapshot()).resolves.toMatchObject({ generation: 0, instanceId: 'foreground-instance-a', token: 'token-a' });
  await expect(foreground.refreshSession()).resolves.toMatchObject({ generation: 0, instanceId: 'foreground-instance-a', token: 'token-b' });
  await expect(foreground.refreshSession()).resolves.toMatchObject({ generation: 1, instanceId: 'foreground-instance-b', token: 'token-c' });
});

it('does not let an older foreground refresh replace a newer session', async () => {
  let calls = 0;
  let resolveOlder: ((response: Response) => void) | undefined;
  const foreground = new ForegroundRouteClient({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return json({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', token: 'token-a',
      });
      if (calls === 2) return await new Promise<Response>((resolve) => { resolveOlder = resolve; });
      return json({
        cookieName: 'agent-bundle-foreground-session-fedcba9876543210fedcba9876543210',
        instanceId: 'foreground-instance-c', origin: 'http://127.0.0.1:4100', token: 'token-c',
      });
    },
  });
  await foreground.sessionSnapshot();
  const older = foreground.refreshSession();
  const newer = await foreground.refreshSession();
  if (resolveOlder === undefined) throw new Error('Expected an older foreground refresh.');
  resolveOlder(json({
    cookieName: 'agent-bundle-foreground-session-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    instanceId: 'foreground-instance-b', origin: 'http://127.0.0.1:4100', token: 'token-b',
  }));

  await expect(older).resolves.toBe(newer);
  await expect(foreground.sessionSnapshot()).resolves.toBe(newer);
});

it('drains a changed foreground instance with the old credential before adopting the new one', async () => {
  let bootstraps = 0;
  const routeTokens: Array<string | null> = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      if (String(input) === '/api/project/session') {
        bootstraps += 1;
        return json({
          cookieName: `agent-bundle-foreground-session-${bootstraps === 1 ? 'a'.repeat(32) : 'b'.repeat(32)}`,
          instanceId: `foreground-instance-${bootstraps === 1 ? 'a' : 'b'}`,
          origin: 'http://127.0.0.1:4100',
          token: `token-${bootstraps === 1 ? 'a' : 'b'}`,
        });
      }
      routeTokens.push(new Headers(init?.headers).get('x-agent-bundle-session'));
      return json({ ok: true });
    },
  });
  const previous = await foreground.sessionSnapshot();

  const next = await foreground.refreshSession({
    beforeAdopt: async (change) => {
      expect(change.previous).toBe(previous);
      expect(change.next.instanceId).toBe('foreground-instance-b');
      await foreground.protectedRequest('/api/cleanup');
      await expect(foreground.sessionSnapshot()).resolves.toBe(previous);
    },
  });
  await foreground.protectedRequest('/api/after-recovery');

  expect(next).toMatchObject({ generation: 1, instanceId: 'foreground-instance-b', token: 'token-b' });
  expect(routeTokens).toEqual(['token-a', 'token-b']);
});

for (const [description, body] of invalidSessionBodies) {
  it(`MCP routes reject ${description} from the foreground session bootstrap`, async () => {
    const routePaths: string[] = [];
    const client = new McpRouteClient({
      fetch: (async (input) => {
        if (String(input) === '/api/project/session') return json(body);
        routePaths.push(String(input));
        return json({ prompts: [], resourceTemplates: [], resources: [], tools: [] });
      }) as typeof globalThis.fetch,
    });

    await expect(client.catalog('session-weather')).rejects.toMatchObject({ code: 'AB8019' });
    expect(routePaths).toEqual([]);
  });
}

const foregroundSession = Object.freeze({
  cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
  instanceId: 'foreground-instance-a',
  origin: 'http://127.0.0.1:4100',
  token: 'foreground-secret',
});

interface RecordedRouteRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
}

const inspectorRouteClient = (respond: (request: RecordedRouteRequest) => Response) => {
  const requests: RecordedRouteRequest[] = [];
  const foreground = new ForegroundRouteClient({
    fetch: async (input, init) => {
      if (String(input) === '/api/project/session') return json(foregroundSession);
      const request: RecordedRouteRequest = {
        body: init?.body,
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
        path: String(input),
      };
      requests.push(request);
      return respond(request);
    },
  });
  return { client: new McpRouteClient({ foreground }), requests };
};

describe('MCP route client inspector routes', () => {
  const inspectorUrl = 'http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=tok';

  it('reads the Inspector status with the foreground session header', async () => {
    const { client, requests } = inspectorRouteClient(() => json({ status: { state: 'running', url: inspectorUrl } }));

    const status = await client.inspectorStatus();

    expect(status).toEqual({ state: 'running', url: inspectorUrl });
    expect(Object.isFrozen(status)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/inspector/status' });
    expect(requests[0]!.body).toBeUndefined();
    expect(requests[0]!.headers.get('x-agent-bundle-session')).toBe('foreground-secret');
  });

  it('reads a not-running Inspector status without a URL', async () => {
    const { client } = inspectorRouteClient(() => json({ status: { state: 'idle' } }));

    await expect(client.inspectorStatus()).resolves.toEqual({ state: 'idle' });
  });

  const invalidStatusBodies: readonly [string, unknown][] = [
    ['an unknown state', { status: { state: 'bogus' } }],
    ['an unexpected status field', { status: { extra: 1, state: 'idle' } }],
    ['a non-HTTP Inspector URL', { status: { state: 'running', url: 'javascript:alert(1)' } }],
    ['a non-loopback Inspector URL', { status: { state: 'running', url: 'https://inspector.example.com/?MCP_INSPECTOR_API_TOKEN=tok' } }],
    ['an all-interfaces Inspector URL', { status: { state: 'running', url: 'http://0.0.0.0:6274/?MCP_INSPECTOR_API_TOKEN=tok' } }],
    ['an Inspector URL carrying credentials', { status: { state: 'running', url: 'http://user:pass@127.0.0.1:6274/' } }],
    ['a missing status', {}],
  ];

  for (const [description, body] of invalidStatusBodies) {
    it(`rejects an Inspector status response with ${description}`, async () => {
      const { client } = inspectorRouteClient(() => json(body));

      const status = client.inspectorStatus();

      await expect(status).rejects.toBeInstanceOf(McpRouteClientError);
      await expect(status).rejects.toMatchObject({ code: 'AB8019' });
    });
  }

  it('launches the Inspector with an empty JSON object body and the foreground session header', async () => {
    const { client, requests } = inspectorRouteClient(() => json({ url: inspectorUrl }));

    const launched = await client.inspectorLaunch();

    expect(launched).toEqual({ url: inspectorUrl });
    expect(Object.isFrozen(launched)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ body: '{}', method: 'POST', path: '/api/inspector/launch' });
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
    expect(requests[0]!.headers.get('x-agent-bundle-session')).toBe('foreground-secret');
  });

  it('surfaces the server launch diagnostic as a typed MCP route error', async () => {
    const { client } = inspectorRouteClient(() => json({ diagnostic: { code: 'AB8112', message: 'MCP Inspector could not be launched.' } }, 502));

    const launch = client.inspectorLaunch();

    await expect(launch).rejects.toBeInstanceOf(McpRouteClientError);
    await expect(launch).rejects.toMatchObject({ code: 'AB8112', message: 'MCP Inspector could not be launched.' });
  });

  const invalidLaunchBodies: readonly [string, unknown][] = [
    ['a non-HTTP Inspector URL', { url: 'javascript:alert(1)' }],
    ['a non-loopback Inspector URL', { url: 'https://inspector.example.com/?MCP_INSPECTOR_API_TOKEN=tok' }],
    ['an unexpected field', { extra: true, url: inspectorUrl }],
    ['a missing URL', {}],
  ];

  it('accepts every loopback spelling for the Inspector URL', async () => {
    for (const url of ['http://localhost:6274/?MCP_INSPECTOR_API_TOKEN=tok', 'http://[::1]:6274/?MCP_INSPECTOR_API_TOKEN=tok', inspectorUrl]) {
      const { client } = inspectorRouteClient(() => json({ url }));

      await expect(client.inspectorLaunch()).resolves.toEqual({ url });
    }
  });

  for (const [description, body] of invalidLaunchBodies) {
    it(`rejects an Inspector launch response with ${description}`, async () => {
      const { client } = inspectorRouteClient(() => json(body));

      const launch = client.inspectorLaunch();

      await expect(launch).rejects.toBeInstanceOf(McpRouteClientError);
      await expect(launch).rejects.toMatchObject({ code: 'AB8019' });
    });
  }
});
