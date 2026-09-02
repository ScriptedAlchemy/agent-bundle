import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Records and reads durable route-harness journal entries.',
  title: 'Journal',
};

export const inputSchema = z.object({ note: z.string().optional() }).strict();

export const resultSchema = z.object({
  entries: z.array(z.object({ note: z.string() }).strict()),
  revision: z.number().int().nonnegative(),
}).strict();

interface JournalState {
  readonly entries: readonly { readonly note: string }[];
}

export default async function Journal({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  if (context.state === undefined) throw new TypeError('Journal state is unavailable.');
  if (input.note !== undefined) {
    await context.state.dispatch('recorded', { note: input.note }, {
      idempotencyKey: `journal:${input.note}`,
    });
  }
  const snapshot = await context.state.read();
  const state = snapshot.state as JournalState;
  const result = { entries: state.entries, revision: snapshot.revision };
  return (
    <Agent.Result value={result}>
      <Agent.Markdown>{[
        `# Journal revision ${String(snapshot.revision)}`,
        '',
        ...state.entries.map((entry) => `- ${entry.note}`),
      ].join('\n')}</Agent.Markdown>
    </Agent.Result>
  );
}
