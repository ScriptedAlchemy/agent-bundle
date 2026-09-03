import type { CliRouteConfig } from 'agent-bundle';
import { z } from 'zod';

import { identity } from '../lib/identity.ts';

export const config = {
  description: 'Prints the identity agent-bundle/meta resolved to.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  name: z.string(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  version: z.string(),
}).strict();

export default async function version() {
  return { ...identity };
}
