import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  description: 'Reports the request providers a plain command observes.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  keys: z.array(z.string()),
  libraryTooling: z.unknown().optional(),
  processLifetime: z.object({ hits: z.number().int().min(1), instanceId: z.string(), pid: z.number().int() }).strict(),
}).strict();

export default async function inspect(_props: CliRouteProps<typeof inputSchema>) {
  const { providers } = await agent();
  return {
    keys: Object.keys(providers).sort(),
    libraryTooling: providers['libraryTooling'],
    processLifetime: providers['processLifetime'],
  };
}
