import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = { mimeType: 'text/markdown', title: 'Notes', uri: 'harness://notes' };

export const inputSchema = z.object({ uri: z.string() });

export const resultSchema = z.object({ uri: z.string() });

export default async function Notes({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  return (
    <Agent.Result value={{ uri: input.uri }}>
      <Agent.Markdown>{`# Notes for ${input.uri}`}</Agent.Markdown>
    </Agent.Result>
  );
}
