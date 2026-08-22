import { expect, it } from '@rstest/core';

import { ForegroundSessionAuthority } from '../src/foreground-session.ts';
import { McpRouteClient } from '../src/mcp/mcp-route-client.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

it('uses refreshed authority credentials for later MCP requests without reconstruction', async () => {
  const tokens = ['token-a', 'token-b'];
  const authority = new ForegroundSessionAuthority({
    fetch: async () => json({
      instanceId: 'foreground-instance-a',
      origin: 'http://127.0.0.1:4100',
      token: tokens.shift(),
    }),
  });
  const requestTokens: Array<string | null> = [];
  const client = new McpRouteClient({
    authority,
    fetch: (async (_input, init) => {
      requestTokens.push(new Headers(init?.headers).get('x-agent-bundle-session'));
      return json({ prompts: [], resourceTemplates: [], resources: [], tools: [] });
    }) as typeof globalThis.fetch,
  });

  await client.catalog('session-weather');
  await authority.refresh();
  await client.catalog('session-weather');

  expect(requestTokens).toEqual(['token-a', 'token-b']);
});

const invalidSessionBodies: readonly [string, unknown][] = [
  ['a legacy two-field payload', { origin: 'http://127.0.0.1:4100', token: 'foreground-secret' }],
  ['a versioned payload', { instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', schemaVersion: 1, token: 'foreground-secret' }],
  ['an unexpected payload field', { instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100', scope: 'workbench', token: 'foreground-secret' }],
  ['a malformed payload', { instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:4100' }],
];

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
