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
