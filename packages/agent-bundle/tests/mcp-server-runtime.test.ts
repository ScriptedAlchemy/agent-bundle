import { unavailable } from '@agent-bundle/runtime';
import type { AgentLineageRegistry, LineageToolCallQuery } from '@agent-bundle/runtime/lineage';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import {
  advertisedOutputSchema,
  createGeneratedRouteMcpServer,
  type GeneratedNoticeDeliveryBinding,
  type GeneratedRouteExecutionHost,
} from '../src/mcp-server-runtime.ts';

/**
 * The MCP specification requires every result of a tool that declares
 * `outputSchema` to carry `structuredContent`, and the projection emits
 * `structuredContent` only for object-valued documents. So the generated
 * server advertises `outputSchema` exactly when the route's `resultSchema`
 * describes an object.
 */
describe('advertisedOutputSchema', () => {
  it('advertises object-rooted result schemas unchanged', () => {
    const plain = z.object({ status: z.literal('ready') }).strict();
    const record = z.record(z.string(), z.unknown());
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), value: z.string() }),
      z.object({ kind: z.literal('b'), count: z.number() }),
    ]);

    expect(advertisedOutputSchema(plain)).toBe(plain);
    expect(advertisedOutputSchema(record)).toBe(record);
    expect(advertisedOutputSchema(union)).toBe(union);
  });

  it('advertises nothing for text-only and non-object result schemas', () => {
    expect(advertisedOutputSchema(z.undefined())).toBeUndefined();
    expect(advertisedOutputSchema(z.void())).toBeUndefined();
    expect(advertisedOutputSchema(z.string())).toBeUndefined();
    expect(advertisedOutputSchema(z.number())).toBeUndefined();
    expect(advertisedOutputSchema(z.array(z.object({ id: z.string() })))).toBeUndefined();
    expect(advertisedOutputSchema(z.union([z.string(), z.object({ id: z.string() })]))).toBeUndefined();
  });

  it('hands a schema that cannot describe itself to the SDK unchanged', () => {
    const opaque = { parse: (value: unknown) => value };
    expect(advertisedOutputSchema(opaque)).toBe(opaque);
  });
});

const stubs = (options: {
  readonly noticesClose?: () => Promise<void>;
  readonly observe?: GeneratedNoticeDeliveryBinding['observe'];
} = {}) => {
  const order: string[] = [];
  const host: GeneratedRouteExecutionHost = {
    availability: () => ({ state: 'available' }) as never,
    close: async () => {
      order.push('host');
    },
    execute: async () => {
      throw new Error('not rendered');
    },
    identity: { artifactEpoch: 'epoch', instanceId: 'test' } as never,
    markUnavailable: () => undefined,
  };
  const notices: GeneratedNoticeDeliveryBinding = {
    inboxUri: 'agent-bundle://notices/inbox',
    subscribed: false,
    close: async () => {
      order.push('notices');
      await options.noticesClose?.();
    },
    observe: options.observe ?? (async () => ({ kind: 'idle', reason: 'no-subscription', revision: undefined })),
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
  return { host, notices, order };
};

describe('generated server lineage correlation', () => {
  it('hands the registry the raw tools/call arguments, not the schema-parsed input with defaults applied', async () => {
    // Cursor's hook records the arguments as sent (`tool_input`); a schema default
    // would make `{}` and `{ label: 'probe' }` parse alike and misattribute the
    // omitted-argument call, so the capture must read the wire, not the callback input.
    const queries: LineageToolCallQuery[] = [];
    const lineage: AgentLineageRegistry = {
      observe: async () => unavailable('id-not-resolvable'),
      resolveToolCall: async (query) => {
        queries.push(query);
        return unavailable('id-not-resolvable');
      },
      snapshot: () => ({ nodes: {}, openCalls: [], pendingChildren: [], pendingSpawns: [], seenStarts: [] }),
    };
    const { host } = stubs();
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      lineage,
      plugin: { name: 'raw-arguments', version: '0.0.0' },
      routes: {
        'mcp/raw/tools/probe': {
          config: {},
          id: 'mcp/raw/tools/probe',
          kind: 'tool',
          module: {
            default: () => undefined,
            inputSchema: z.object({ label: z.string().default('probe') }).strict(),
            resultSchema: z.object({ ok: z.boolean() }).strict(),
          },
          name: 'probe',
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cursor-vscode', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ arguments: {}, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      await client.callTool({ arguments: { label: 'probe' }, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      await client.callTool({ arguments: { label: 'other' }, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      expect(queries.map((query) => [Object.hasOwn(query, 'arguments'), query.arguments, query.host, query.toolName])).toEqual([
        [true, {}, 'cursor', 'probe'],
        [true, { label: 'probe' }, 'cursor', 'probe'],
        [true, { label: 'other' }, 'cursor', 'probe'],
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('generated server render completion', () => {
  it('answers a completed render while the inbox observation is still pending on another connection', async () => {
    // The signaller renews a hold for as long as a notification write takes,
    // so a wedged subscriber's wire must not hold a tool response hostage.
    let observations = 0;
    const { host, notices } = stubs({
      observe: () => {
        observations += 1;
        return new Promise(() => undefined);
      },
    });
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      notices,
      plugin: { name: 'pending-observation', version: '0.0.0' },
      routes: {
        'mcp/pending/tools/probe': {
          config: {},
          id: 'mcp/pending/tools/probe',
          kind: 'tool',
          module: {
            default: () => undefined,
            inputSchema: z.object({}).strict(),
            resultSchema: z.object({ ok: z.boolean() }).strict(),
          },
          name: 'probe',
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pending-observation-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // The stub host cannot render, so the call settles as a tool error —
      // promptly, even though the observation it triggered never resolves.
      const result = await client.callTool({ arguments: {}, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      expect(result.isError).toBe(true);
      expect(observations).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('coalesces renders completing behind a pending observation into one follow-up', async () => {
    // Every observation reads the whole ledger, so the renders that complete
    // while a notification write is pending are all covered by one follow-up:
    // a client that stops reading cannot grow a queue of observations.
    const settlers: Array<() => void> = [];
    const { host, notices } = stubs({
      observe: () => new Promise((resolve) => {
        settlers.push(() => {
          resolve({ kind: 'idle', reason: 'nothing-eligible', revision: 1 });
        });
      }),
    });
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      notices,
      plugin: { name: 'coalesced-observation', version: '0.0.0' },
      routes: {
        'mcp/coalesced/tools/probe': {
          config: {},
          id: 'mcp/coalesced/tools/probe',
          kind: 'tool',
          module: {
            default: () => undefined,
            inputSchema: z.object({}).strict(),
            resultSchema: z.object({ ok: z.boolean() }).strict(),
          },
          name: 'probe',
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'coalesced-observation-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      for (let i = 0; i < 5; i += 1) {
        await client.callTool({ arguments: {}, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      }
      // Five completed renders, one observation in flight, one owed.
      expect(settlers).toHaveLength(1);
      settlers[0]!();
      await tick();
      expect(settlers).toHaveLength(2);
      // The single follow-up settles with nothing further owed.
      settlers[1]!();
      await tick();
      expect(settlers).toHaveLength(2);
      // A render after the queue drained starts a fresh observation.
      await client.callTool({ arguments: {}, name: 'probe' }, { signal: AbortSignal.timeout(5_000) });
      expect(settlers).toHaveLength(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('generated server teardown', () => {

  it('closes the notice signaller before the host that owns the ledger it drains into', async () => {
    // A receipt still owed for a wire-successful send is committed by the
    // signaller's close; the host closes the (shared) store, so it must go
    // second or the drain fails against a closed ledger and the send is lost.
    const { host, notices, order } = stubs();
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      notices,
      plugin: { name: 'teardown', version: '0.0.0' },
      routes: {},
    });
    await server.close();
    expect(order).toEqual(['notices', 'host']);
  });

  it('still drains the signaller and closes the host when the event runtime close fails', async () => {
    const { host, notices, order } = stubs();
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      events: {
        allowedTargets: ['claude'],
        artifactEpoch: 'epoch',
        createCanonicalEventProps: (() => {
          throw new Error('not invoked');
        }) as never,
        createEventRuntimeServer: (async () => ({
          close: async () => {
            order.push('events');
            throw new Error('socket teardown failed');
          },
        })) as never,
        endpointId: 'teardown-test',
        projectEventDocument: (() => {
          throw new Error('not invoked');
        }) as never,
        target: 'claude',
      },
      host,
      notices,
      plugin: { name: 'teardown', version: '0.0.0' },
      routes: {},
    });
    await expect(server.close()).rejects.toThrow('socket teardown failed');
    expect(order).toEqual(['events', 'notices', 'host']);
  });

  it('still closes the host and the protocol transport when the signaller close fails', async () => {
    const { host, notices, order } = stubs({
      noticesClose: async () => {
        throw new Error('drain failed');
      },
    });
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      notices,
      plugin: { name: 'teardown', version: '0.0.0' },
      routes: {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'teardown-test', version: '0.0.0' });
    let clientSawClose = false;
    client.onclose = () => {
      clientSawClose = true;
    };
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await expect(server.close()).rejects.toThrow('drain failed');
    expect(order).toEqual(['notices', 'host']);
    // The failed drain did not leave the transport open: the linked client
    // observed the server side close.
    for (let i = 0; i < 100 && !clientSawClose; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(clientSawClose).toBe(true);
    await client.close();
  });
});
