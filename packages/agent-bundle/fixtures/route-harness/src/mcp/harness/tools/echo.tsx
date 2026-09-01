import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Echoes one message back with the observed workspace root.',
  title: 'Echo',
};

export const inputSchema = z.object({ message: z.string().optional() });

export const resultSchema = z.object({
  message: z.string(),
  operationId: z.string().nullable(),
  workspace: z.string().nullable(),
});

export default async function Echo({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  await context.progress.report({ completed: 1, message: 'echoing', total: 1 });
  const workspace = context.workspace.state === 'available' ? context.workspace.value.root : null;
  const message = input.message ?? '(no message)';
  return (
    <Agent.Result value={{ message, operationId: context.invocation.operationId ?? null, workspace }}>
      <Agent.Markdown>{`# Echo\n\n${message}`}</Agent.Markdown>
      <Agent.Text>{`workspace: ${workspace ?? 'unavailable'}`}</Agent.Text>
    </Agent.Result>
  );
}
