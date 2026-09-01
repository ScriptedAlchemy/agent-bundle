import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = { mimeType: 'text/markdown', title: 'Notes', uri: 'harness://notes' };

export const inputSchema = z.object({ uri: z.string() });

/** The generated server returns a resource route's result as the protocol's `ReadResourceResult`. */
export const resultSchema = z.object({
  contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })),
});

export default async function Notes({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const text = `# Notes for ${input.uri}`;
  return (
    <Agent.Result value={{ contents: [{ mimeType: 'text/markdown', text, uri: input.uri }] }}>
      <Agent.Markdown>{text}</Agent.Markdown>
    </Agent.Result>
  );
}
