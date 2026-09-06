import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { discoveryOperations } from '../operations/discovery.js';

const operation = discoveryOperations.inspect;

export const config = {
  description: 'Inspect a bounded audiobook source tree without changing it.',
  positionals: ['root'],
} satisfies CliRouteConfig;

// The argv projection is compiled statically, so the schema is inline
// literal zod; the bounds match the operation registry's own input schema.
export const inputSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function inspect({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
