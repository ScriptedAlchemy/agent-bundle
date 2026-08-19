import { expect, it } from '@rstest/core';

import { McpRouteClient } from '../src/mcp/mcp-route-client.ts';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const invalidSessionBodies: readonly [string, unknown][] = [
  ['a versioned payload', { origin: 'http://127.0.0.1:4100', schemaVersion: 1, token: 'foreground-secret' }],
  ['an unexpected payload field', { origin: 'http://127.0.0.1:4100', scope: 'workbench', token: 'foreground-secret' }],
  ['a malformed payload', { origin: 'http://127.0.0.1:4100' }],
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
