import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import { advertisedOutputSchema } from '../src/mcp-server-runtime.ts';

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
