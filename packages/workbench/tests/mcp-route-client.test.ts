import { expect, it } from '@rstest/core';

import { ForegroundRouteClient, McpRouteClient } from '../src/mcp/mcp-route-client.ts';

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
