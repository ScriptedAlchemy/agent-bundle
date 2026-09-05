import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  description: 'Lists the journal entries the MCP record tool has written.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  entries: z.array(z.object({ note: z.string() }).strict()),
  revision: z.number().int().nonnegative(),
}).strict();

interface JournalState {
  readonly entries: readonly { readonly note: string }[];
}

export default async function entries() {
  const context = await agent();
  if (context.state === undefined) throw new TypeError('Journal state is unavailable.');
  const snapshot = await context.state.read();
  return { entries: (snapshot.state as JournalState).entries, revision: snapshot.revision };
}
