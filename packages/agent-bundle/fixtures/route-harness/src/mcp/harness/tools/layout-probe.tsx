import { defineTool } from 'agent-bundle/routes';
import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const inputSchema = z.object({ label: z.string().default('probe') });

export const resultSchema = z.object({ label: z.string() });

async function LayoutProbe({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  return (
    <Agent.Result metadata={{ from: 'route' }} value={{ label: input.label }}>
      <Agent.Text>{`probe: ${input.label}`}</Agent.Text>
    </Agent.Result>
  );
}

export default defineTool({
inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "label": {
        "type": "string",
        "default": "probe"
      }
    },
    "type": "object"
  },
  annotations: { readOnlyHint: true },
  description: 'Renders a bare valued result so the layout chain around it is observable.',
  title: 'Layout probe',
  inputSchema,
  resultSchema,
}, async (input) => LayoutProbe({ input }));
