import { expect, it } from '@rstest/core';

import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { RouteManifestClient } from '../src/routes/route-manifest-client.ts';
import { recordingFetch, response, type RecordedRequest } from './support/recording-fetch.ts';

const manifest = {
  cli: {
    commands: [{
      aliases: ['a'],
      description: 'Audit the library',
      exitCode: 'result',
      options: [{
        choices: ['json', 'text'],
        description: 'Output format',
        key: 'format',
        kind: 'enum',
        option: 'format',
        repeated: false,
        required: false,
      }],
      path: ['library', 'audit'],
      routeId: 'cli:library/audit',
    }],
    mode: 'generated',
    routes: [{
      config: [{ key: 'description', kind: 'string', value: 'Audit the library' }],
      description: 'Audit the library',
      id: 'cli:library/audit',
      kind: 'cli',
      provenance: { kind: 'conventional' },
      source: 'src/cli/library/audit.ts',
    }],
  },
  diagnostics: [{ code: 'AB4800', message: 'Two routes claim the same id.', severity: 'error' }],
  digest: 'd'.repeat(64),
  events: [{
    config: [],
    event: 'afterTool',
    id: 'event:tool/after',
    kind: 'event-route',
    provenance: { kind: 'conventional' },
    source: 'src/events/tool/after.ts',
  }],
  providers: [{ id: 'provider:library', name: 'library', source: 'src/providers/library.ts' }],
  scripts: [{
    config: [],
    id: 'script:convert',
    kind: 'script',
    provenance: { kind: 'conventional' },
    source: 'src/scripts/convert.ts',
  }],
  servers: [{
    id: 'mcp:library',
    mode: 'generated',
    name: 'library',
    routes: [{
      config: [{ key: 'title', kind: 'string', value: 'Echo' }],
      id: 'tool:library/echo',
      inputSchema: {
        additionalProperties: false,
        properties: {
          count: { description: 'Repeat count.', type: 'number' },
          enabled: { default: true, type: 'boolean' },
          format: { enum: ['text', 'json'], type: 'string' },
          tags: { items: { type: 'string' }, type: 'array' },
        },
        required: ['count', 'format'],
        type: 'object',
      },
      kind: 'tool',
      provenance: { kind: 'conventional' },
      serverId: 'mcp:library',
      source: 'src/mcp/library/tools/echo.ts',
    }],
  }],
  state: {
    budgets: {
      resolved: {
        maxCommitMs: 5_000,
        maxEventBytes: 262_144,
        maxRevisions: 100_000,
        maxStateBytes: 1_048_576,
      },
      source: 'defaults',
    },
    driver: 'sqlite',
    durableLocation: '$AGENT_BUNDLE_PLUGIN_ROOT/state (falls back to the artifact root or ./.agent-bundle/state for CLI bins)',
    id: 'library/catalog',
    lifetime: 'workspace-durable',
    notices: ['Generated runtimes co-mount the notice ledger store at the same lifetime.'],
    source: 'src/state.ts',
  },
  sourceRevision: 'r'.repeat(64),
};

const clientFor = (reply: () => Response, calls: RecordedRequest[] = []): RouteManifestClient =>
  new RouteManifestClient({ foreground: new ForegroundRouteClient({ fetch: recordingFetch(calls, reply) }) });

it('reads the compiled manifest over the shared foreground session', async () => {
  const calls: RecordedRequest[] = [];
  const client = clientFor(() => response({ manifest }), calls);

  const decoded = await client.manifest();

  expect(decoded.digest).toBe('d'.repeat(64));
  expect(decoded.servers[0]?.routes[0]?.id).toBe('tool:library/echo');
  expect(decoded.servers[0]?.routes[0]?.inputSchema?.properties.format).toEqual({
    enum: ['text', 'json'],
    type: 'string',
  });
  expect(decoded.cli?.commands?.[0]?.path).toEqual(['library', 'audit']);
  expect(decoded.state).toEqual(manifest.state);
  expect(calls).toEqual([{ method: 'GET', token: 'foreground-token', url: '/api/routes/manifest' }]);
});

it('preserves projected MCP provenance and confirmation policy', async () => {
  const projected = {
    ...manifest.cli.commands[0],
    mcp: { confirm: true, server: 'library', tool: 'apply' },
    path: ['library', 'apply'],
    routeId: 'tool:library/apply',
  };
  const decoded = await clientFor(() => response({
    manifest: {
      ...manifest,
      cli: { ...manifest.cli, commands: [projected] },
    },
  })).manifest();

  expect(decoded.cli?.commands?.[0]?.mcp).toEqual({
    confirm: true,
    server: 'library',
    tool: 'apply',
  });
});

it('freezes the decoded manifest so no page can mutate compiled route facts', async () => {
  const decoded = await clientFor(() => response({ manifest })).manifest();

  expect(Object.isFrozen(decoded)).toBe(true);
});

it('rejects an unknown field on the manifest wire body', async () => {
  const client = clientFor(() => response({ manifest: { ...manifest, unexpected: true } }));

  await expect(client.manifest()).rejects.toMatchObject({
    code: 'AB8123',
    message: 'Route manifest route returned an invalid response.',
  });
});

it('rejects an unknown field on a compiled route', async () => {
  const client = clientFor(() => response({
    manifest: { ...manifest, scripts: [{ ...manifest.scripts[0], extra: 1 }] },
  }));

  await expect(client.manifest()).rejects.toMatchObject({ code: 'AB8123' });
});

it('rejects an unknown field inside the state catalog', async () => {
  const client = clientFor(() => response({
    manifest: { ...manifest, state: { ...manifest.state, mutable: true } },
  }));

  await expect(client.manifest()).rejects.toMatchObject({
    code: 'AB8123',
    message: 'Route manifest route returned an invalid response.',
  });
});

it('rejects unknown fields at every input-schema level', async () => {
  const route = manifest.servers[0]!.routes[0]!;
  const inputSchema = route.inputSchema!;
  const invalidProperty = {
    ...route,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        count: { ...inputSchema.properties.count, minimum: 1 },
      },
    },
  };
  const invalidItems = {
    ...route,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        tags: { ...inputSchema.properties.tags, items: { format: 'uri', type: 'string' } },
      },
    },
  };
  const invalidRoot = { ...route, inputSchema: { ...inputSchema, title: 'Echo input' } };

  for (const candidate of [invalidProperty, invalidItems, invalidRoot]) {
    const client = clientFor(() => response({
      manifest: {
        ...manifest,
        servers: [{ ...manifest.servers[0], routes: [candidate] }],
      },
    }));
    await expect(client.manifest()).rejects.toMatchObject({ code: 'AB8123' });
  }
});

it('rejects a route kind the compiler cannot emit', async () => {
  const client = clientFor(() => response({
    manifest: { ...manifest, scripts: [{ ...manifest.scripts[0], kind: 'provider' }] },
  }));

  await expect(client.manifest()).rejects.toMatchObject({ code: 'AB8123' });
});

it('rejects a sibling body key beside the manifest', async () => {
  const client = clientFor(() => response({ manifest, status: 'ok' }));

  await expect(client.manifest()).rejects.toMatchObject({ code: 'AB8123' });
});

it('decodes a foreground diagnostic body into a coded client error', async () => {
  const client = clientFor(() => response({
    diagnostic: { code: 'AB8121', message: 'Route manifest is not available.' },
  }, 409));

  await expect(client.manifest()).rejects.toMatchObject({
    code: 'AB8121',
    message: 'Route manifest is not available.',
    status: 409,
  });
});

it('reports a bodyless failure with the transport status', async () => {
  const client = clientFor(() => new Response('', { status: 503 }));

  await expect(client.manifest()).rejects.toMatchObject({
    code: 'AB8123',
    message: 'Route manifest request failed with HTTP 503.',
    status: 503,
  });
});
