import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { defaultOutputOperations, outputOperations } from '../operations/output.js';

const operation = outputOperations(defaultOutputOperations).audit;

export const config = {
  description: 'Validate metadata, chapters, source mapping, hashes, and optional complete decode.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  conversionReceipt: z.string().min(1).max(4096).optional(),
  file: z.string().min(1).max(4096),
  fullDecode: z.boolean().optional(),
  receipt: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function audit({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
