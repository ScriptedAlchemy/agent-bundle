import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Renders a bare valued result so the layout chain around it is observable.',
  title: 'Layout probe',
};

export const inputSchema = z.object({ label: z.string().default('probe') });

export const resultSchema = z.object({ label: z.string() });

export default async function LayoutProbe({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  return (
    <Agent.Result metadata={{ from: 'route' }} value={{ label: input.label }}>
      <Agent.Text>{`probe: ${input.label}`}</Agent.Text>
    </Agent.Result>
  );
}
