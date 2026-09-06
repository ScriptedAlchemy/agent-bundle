import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  _meta: { ui: { resourceUri: 'ui://durable-web-surface-fixture/status.html' } },
  description: 'Appends one note to the durable journal and reports every entry.',
  title: 'Record',
};

export const inputSchema = z.object({ note: z.string().min(1) }).strict();

export const resultSchema = z.object({
  entries: z.array(z.object({ note: z.string() }).strict()),
  revision: z.number().int().nonnegative(),
}).strict();

interface JournalState {
  readonly entries: readonly { readonly note: string }[];
}

export default async function Record({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  if (context.state === undefined) throw new TypeError('Journal state is unavailable.');
  // The note is the idempotency key: a replayed note is recorded once.
  await context.state.dispatch('recorded', { note: input.note }, { idempotencyKey: `record:${input.note}` });
  const snapshot = await context.state.read();
  const state = snapshot.state as JournalState;
  const result = { entries: state.entries, revision: snapshot.revision };
  return (
    <Agent.Result value={result}>
      <Agent.Text>{`recorded ${String(state.entries.length)} note(s)`}</Agent.Text>
    </Agent.Result>
  );
}
