import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { defaultDiscoveryOperations, discoveryOperations } from '../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).inventory;

export const config = {
  description: 'Probe source audio without changing it.',
  exitCode: 'result',
  positionals: ['source'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  report: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
  strict: z.boolean().optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function inventory({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
