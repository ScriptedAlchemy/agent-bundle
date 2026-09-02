import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

let executions = 0;

export const config = {
  description: 'Records how many times the mutation probe executed.',
  title: 'Mutation probe',
};

export const inputSchema = z.object({
  marker: z.string().optional(),
}).strict();

export const resultSchema = z.object({
  executions: z.number().int().positive(),
  invocation: z.literal('tool'),
  marker: z.string().nullable(),
  operationId: z.string(),
}).strict();

export default async function MutationProbe({
  input,
}: {
  readonly input: z.infer<typeof inputSchema>;
}) {
  executions += 1;
  const context = await agent();
  const result = {
    executions,
    invocation: context.invocation.kind as 'tool',
    marker: input.marker ?? null,
    operationId: context.invocation.operationId!,
  };
  return (
    <Agent.Result value={result}>
      <Agent.Markdown>{`Mutation probe execution ${String(executions)}.`}</Agent.Markdown>
    </Agent.Result>
  );
}
