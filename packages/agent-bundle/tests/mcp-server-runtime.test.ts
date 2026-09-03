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

describe('generated server teardown', () => {
  const stubs = (noticesClose: () => Promise<void>) => {
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
        await noticesClose();
      },
      observe: async () => ({ kind: 'idle', reason: 'no-subscription', revision: undefined }),
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    };
    return { host, notices, order };
  };

  it('closes the notice signaller before the host that owns the ledger it drains into', async () => {
    // A receipt still owed for a wire-successful send is committed by the
    // signaller's close; the host closes the (shared) store, so it must go
    // second or the drain fails against a closed ledger and the send is lost.
    const { host, notices, order } = stubs(async () => undefined);
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

  it('still closes the host when the signaller close fails', async () => {
    const { host, notices, order } = stubs(async () => {
      throw new Error('drain failed');
    });
    const server = await createGeneratedRouteMcpServer({
      artifactEpoch: 'epoch',
      host,
      notices,
      plugin: { name: 'teardown', version: '0.0.0' },
      routes: {},
    });
    await expect(server.close()).rejects.toThrow('drain failed');
    expect(order).toEqual(['notices', 'host']);
  });
});
