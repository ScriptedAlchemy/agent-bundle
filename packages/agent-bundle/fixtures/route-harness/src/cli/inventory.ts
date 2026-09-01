import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  aliases: ['inv'],
  description: 'Lists the harness library inventory.',
  positionals: ['shelf'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  format: z.enum(['json', 'text']).default('text'),
  limit: z.number().int().min(1).max(8).optional(),
  shelf: z.string().min(1),
}).strict();

export const resultSchema = z.object({
  format: z.string(),
  shelf: z.string(),
  titles: z.array(z.string()),
}).strict();

const shelves: Readonly<Record<string, readonly string[]>> = {
  fiction: ['Piranesi', 'Solaris'],
  history: ['SPQR'],
};

export default async function inventory({ input }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  await context.progress.report({ completed: 1, message: 'reading inventory', total: 2 });
  const titles = (shelves[input.shelf] ?? []).slice(0, input.limit ?? 8);
  await context.progress.report({ completed: 2, message: 'inventory ready', total: 2 });
  return { format: input.format, shelf: input.shelf, titles: [...titles] };
}
