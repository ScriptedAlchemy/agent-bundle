import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  description: 'Renders a harness report.',
  positionals: ['topic'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  mode: z.enum(['success', 'render-error', 'invalid-result', 'wait-for-abort']).default('success'),
  topic: z.string().min(1),
}).strict();

export const resultSchema = z.object({
  count: z.number().int().nonnegative(),
  stateMounted: z.literal(true),
  status: z.literal('ready'),
  topic: z.string(),
}).strict();

export default async function Report({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  await context.progress.report({ completed: 1, message: 'preparing report', total: 2 });

  if (input.mode === 'render-error') {
    throw new Error('report render exploded');
  }
  if (input.mode === 'wait-for-abort') {
    await new Promise<void>((_resolve, reject) => {
      const rejectAborted = () => reject(new DOMException('Report render aborted', 'AbortError'));
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener('abort', rejectAborted, { once: true });
    });
  }

  await context.progress.report({ completed: 2, message: 'report ready', total: 2 });
  const value = input.mode === 'invalid-result'
    ? { count: 'two', stateMounted: context.state !== undefined, status: 'ready', topic: input.topic }
    : { count: 2, stateMounted: context.state !== undefined, status: 'ready', topic: input.topic };

  return (
    <Agent.Result value={value}>
      <Agent.Markdown>{`# Report: ${input.topic}\n\nGenerated for ${input.topic}.`}</Agent.Markdown>
      <Agent.Text>items: 2</Agent.Text>
    </Agent.Result>
  );
}
