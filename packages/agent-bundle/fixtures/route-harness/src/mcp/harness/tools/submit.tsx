import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

/**
 * The operation behind the harness's explicit CLI surface projection (#596):
 * `submit.cli.ts` beside this module projects it onto `<bin> submit`. The
 * structured result echoes the canonical input so the projection levels can
 * prove the CLI grammar and the MCP surface reach the same operation with the
 * same value; the rendered text carries the surface the route observed
 * (`invocation.kind`, `operationId`, `surface`) and the `library-tooling`
 * provider's view of it, which differ per surface by design.
 */
export const config = {
  annotations: { readOnlyHint: false },
  description: 'Submits one command line as lane work and echoes the accepted request.',
  title: 'Submit',
};

export const inputSchema = z.object({
  argv: z.array(z.string()).min(1).describe('The command line to run.'),
  cwd: z.string().min(1).describe('Working directory of the command.'),
  laneKey: z.string().min(1).optional().describe('Lane the work is queued under.'),
  tags: z.array(z.string()).optional().describe('Tags attached to the request.'),
});

export const resultSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  laneKey: z.string().optional(),
  operation: z.literal('submit'),
  tags: z.array(z.string()).optional(),
});

export default async function Submit({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  const value = {
    argv: input.argv,
    cwd: input.cwd,
    ...(input.laneKey === undefined ? {} : { laneKey: input.laneKey }),
    operation: 'submit' as const,
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  };
  const { invocation, providers } = context;
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`submit: ${input.argv.join(' ')}`}</Agent.Text>
      <Agent.Text>{`invocation: ${invocation.kind} ${invocation.operationId ?? '(no operation)'} ${invocation.surface ?? '(no surface)'}`}</Agent.Text>
      <Agent.Text>{`provider: ${JSON.stringify(providers['libraryTooling'])}`}</Agent.Text>
    </Agent.Result>
  );
}
