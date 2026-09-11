import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "argv": {
        "description": "The command line to run.",
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "cwd": {
        "type": "string",
        "description": "Working directory of the command."
      },
      "laneKey": {
        "type": "string",
        "description": "Lane the work is queued under."
      },
      "regions": {
        "description": "Regions the work may run in.",
        "items": {
          "enum": [
            "eu",
            "us"
          ],
          "type": "string"
        },
        "type": "array"
      },
      "tags": {
        "description": "Tags attached to the request.",
        "items": {
          "type": "string"
        },
        "type": "array"
      }
    },
    "required": [
      "argv",
      "cwd"
    ],
    "type": "object"
  },
  annotations: { readOnlyHint: false },
  description: 'Submits one command line as lane work and echoes the accepted request.',
  title: 'Submit',
};

export const inputSchema = z.object({
  argv: z.array(z.string()).min(1).describe('The command line to run.'),
  cwd: z.string().min(1).describe('Working directory of the command.'),
  laneKey: z.string().min(1).optional().describe('Lane the work is queued under.'),
  regions: z.array(z.enum(['eu', 'us'])).optional().describe('Regions the work may run in.'),
  tags: z.array(z.string()).optional().describe('Tags attached to the request.'),
});

export const resultSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  laneKey: z.string().optional(),
  operation: z.literal('submit'),
  regions: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export default async function Submit({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  const value = {
    argv: input.argv,
    cwd: input.cwd,
    ...(input.laneKey === undefined ? {} : { laneKey: input.laneKey }),
    operation: 'submit' as const,
    ...(input.regions === undefined ? {} : { regions: input.regions }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  };
  const { invocation } = context;
  const libraryTooling = await context.provider('libraryTooling');
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`submit: ${input.argv.join(' ')}`}</Agent.Text>
      <Agent.Text>{`invocation: ${invocation.kind} ${invocation.operationId ?? '(no operation)'} ${invocation.surface ?? '(no surface)'}`}</Agent.Text>
      <Agent.Text>{`provider: ${JSON.stringify(libraryTooling)}`}</Agent.Text>
    </Agent.Result>
  );
}
