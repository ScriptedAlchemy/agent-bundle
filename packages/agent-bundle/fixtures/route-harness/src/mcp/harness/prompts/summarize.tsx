import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = { description: 'Summarizes one harness note.', title: 'Summarize' };

export const inputSchema = z.object({ note: z.string() });

/** The generated server returns a prompt route's result as the protocol's `GetPromptResult`. */
export const resultSchema = z.object({
  messages: z.array(z.object({
    content: z.object({ text: z.string(), type: z.literal('text') }),
    role: z.literal('user'),
  })),
});

export default async function Summarize({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const messages = [{ content: { text: `Summarize ${input.note}`, type: 'text' as const }, role: 'user' as const }];
  return (
    <Agent.Result value={{ messages }}>
      <Agent.Text>{`prompt ready for ${input.note}`}</Agent.Text>
    </Agent.Result>
  );
}
