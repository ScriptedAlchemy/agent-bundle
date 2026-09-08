import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Selects catalog entries by id or by query, with nested filters no flag grammar can spell.',
  title: 'Select',
};

// A discriminated union under a nested object: the bounded argv grammar has
// no flag form for it, so the tool's CLI projection takes canonical JSON.
export const inputSchema = z.object({
  filters: z.object({
    minRating: z.number().min(0).max(5).default(0),
    tags: z.array(z.string()).optional(),
  }).default({ minRating: 0 }),
  selection: z.discriminatedUnion('by', [
    z.object({ by: z.literal('id'), id: z.string().min(1) }),
    z.object({ by: z.literal('query'), limit: z.number().int().positive().default(10), query: z.string().min(1) }),
  ]),
});

export const resultSchema = z.object({
  filters: z.object({ minRating: z.number(), tags: z.array(z.string()).optional() }),
  invocation: z.enum(['cli', 'tool']),
  selection: z.union([
    z.object({ by: z.literal('id'), id: z.string() }),
    z.object({ by: z.literal('query'), limit: z.number(), query: z.string() }),
  ]),
});

export default async function Select({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  const value = { filters: input.filters, invocation: context.invocation.kind as 'cli' | 'tool', selection: input.selection };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`select: ${input.selection.by === 'id' ? input.selection.id : input.selection.query}`}</Agent.Text>
    </Agent.Result>
  );
}
