// Wire-level regression coverage for issue #43: a real MCP client connects
// over an in-memory transport and the test taps the server transport's send
// to capture the serialized JSON-RPC payload. Listing-level `title` and
// `_meta` must survive registration verbatim, and `annotations` must carry
// exactly the hints the author declared — absent hints stay absent because
// they carry MCP-spec default semantics on the wire. The client-side parsed
// objects rehydrate optional keys as undefined, so only the serialized
// payload proves the byte shape.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import {
  Mcp,
  createRscMcpServer,
  defineOperation,
  defineRscApplication,
} from '../src/index.js';

const widgetResourceUri = 'ui://demo/widget.html';

const searchOperation = defineOperation({
  execute: async () => ({ count: 3, note: undefined }),
  id: 'search',
  inputSchema: z.object({}).strict(),
  mcp: {
    _meta: { ui: { resourceUri: widgetResourceUri } },
    description: 'Unified search across indexers.',
    name: 'search',
    readOnly: true,
    server: 'demo',
    title: 'Search',
  },
  render: (result) => createElement(
    Mcp.Result,
    { structuredContent: result },
    createElement(Mcp.Text, null, `${result.count} results`),
  ),
  resultSchema: z.object({ count: z.number(), note: z.string().optional() }).strict(),
});

const removeOperation = defineOperation({
  execute: async () => ({ removed: true }),
  id: 'remove',
  inputSchema: z.object({}).strict(),
  mcp: {
    description: 'Remove one entry.',
    destructive: true,
    name: 'remove',
    openWorld: false,
    readOnly: false,
    server: 'demo',
  },
  render: (result) => createElement(
    Mcp.Result,
    { structuredContent: result },
    createElement(Mcp.Text, null, 'removed'),
  ),
  resultSchema: z.object({ removed: z.boolean() }).strict(),
});

const contextOperation = defineOperation({
  execute: async (_input, context) => {
    if (context.request === undefined) throw new Error('request context was not installed');
    return {
      actor: context.request.actor,
      host: context.request.host,
      session: context.request.session,
      workspace: context.request.workspace,
    };
  },
  id: 'context',
  inputSchema: z.object({
    host: z.string().optional(),
    session: z.string().optional(),
  }).strict(),
  mcp: {
    description: 'Observe request context.',
    name: 'context',
    readOnly: true,
    server: 'demo',
  },
  render: (result) => createElement(Mcp.Result, { structuredContent: result }),
  resultSchema: z.object({
    actor: z.unknown(),
    host: z.unknown(),
    session: z.unknown(),
    workspace: z.unknown(),
  }).strict(),
});

const application = defineRscApplication({
  name: 'wire-demo',
  operations: [searchOperation, removeOperation, contextOperation],
  version: '1.0.0',
});

interface WireTool {
  readonly _meta?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  readonly name: string;
  readonly title?: string;
}

const openClients: Client[] = [];

/**
 * Connects a real client and returns the serialized JSON-RPC responses the
 * server put on the wire, keyed by request id. Serialization through
 * JSON.stringify mirrors what every real transport does to a message, so
 * undefined-valued keys disappear here exactly as they would on stdio.
 */
const connectClient = async (): Promise<{
  readonly client: Client;
  readonly wireResults: Map<number | string, Record<string, unknown>>;
}> => {
  const server = createRscMcpServer(application, 'demo');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = 'wire-session';
  const wireResults = new Map<number | string, Record<string, unknown>>();
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    const serialized = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
    if (serialized.id !== undefined && serialized.result !== undefined) {
      wireResults.set(serialized.id as number | string, serialized.result as Record<string, unknown>);
    }
    return originalSend(message, options);
  };
  const client = new Client({ name: 'wire-listing-test', version: '0.0.0' });
  openClients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, wireResults };
};

const wireToolListing = async (): Promise<Map<string, WireTool>> => {
  const { client, wireResults } = await connectClient();
  const parsed = await client.listTools();
  expect(parsed.tools).toHaveLength(3);
  const listing = [...wireResults.values()].find((result) => Array.isArray(result.tools));
  const tools = (listing?.tools ?? []) as readonly WireTool[];
  return new Map(tools.map((tool) => [tool.name, tool]));
};

afterAll(async () => {
  await Promise.allSettled(openClients.map((client) => client.close()));
});

describe('createRscMcpServer wire listing', () => {
  it('serves listing title and _meta verbatim on the wire', async () => {
    const tools = await wireToolListing();

    const search = tools.get('search');
    expect(search?.title).toBe('Search');
    expect(search?._meta).toEqual({ ui: { resourceUri: widgetResourceUri } });

    const remove = tools.get('remove');
    expect(remove).toBeDefined();
    expect(Object.hasOwn(remove!, 'title')).toBe(false);
    expect(Object.hasOwn(remove!, '_meta')).toBe(false);
  });

  it('emits exactly the annotation hints the author declared — absent stays absent', async () => {
    const tools = await wireToolListing();

    // The author declared ONLY readOnly — no synthesized destructiveHint /
    // idempotentHint / openWorldHint may appear on the wire.
    expect(tools.get('search')?.annotations).toEqual({ readOnlyHint: true });
    expect(Object.keys(tools.get('search')?.annotations ?? {})).toEqual(['readOnlyHint']);

    expect(tools.get('remove')?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    });
    expect(Object.keys(tools.get('remove')?.annotations ?? {}).sort()).toEqual([
      'destructiveHint',
      'openWorldHint',
      'readOnlyHint',
    ]);
  });

  it('drops undefined structured content fields on the wire, matching SDK serialization', async () => {
    const { client, wireResults } = await connectClient();
    const parsed = await client.callTool({ arguments: {}, name: 'search' });
    expect(parsed.structuredContent).toEqual({ count: 3 });
    const wireCall = [...wireResults.values()].find((result) => result.structuredContent !== undefined);
    expect(wireCall?.structuredContent).toEqual({ count: 3 });
    expect(Object.hasOwn(wireCall?.structuredContent as object, 'note')).toBe(false);
  });

  it('exposes native client and session identity without accepting lookalikes from tool input', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      arguments: { host: 'spoofed-host', session: 'spoofed-session' },
      name: 'context',
    });

    expect(result.structuredContent).toMatchObject({
      actor: { reason: 'not-provided', state: 'unavailable' },
      host: { source: 'native', state: 'available', value: { name: 'wire-listing-test' } },
      session: {
        source: 'native',
        state: 'available',
        value: { sessionId: 'wire-session' },
      },
      workspace: { reason: 'not-provided', state: 'unavailable' },
    });
    expect(result.structuredContent).not.toEqual(expect.objectContaining({
      host: expect.objectContaining({ value: { name: 'spoofed-host' } }),
    }));
    expect(result.structuredContent).not.toEqual(expect.objectContaining({
      session: expect.objectContaining({ value: { sessionId: 'spoofed-session' } }),
    }));
  });
});
