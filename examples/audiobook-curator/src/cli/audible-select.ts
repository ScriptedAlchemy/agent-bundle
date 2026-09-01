import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { audibleOperations, defaultAudibleOperations } from '../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleSelect;

export const config = {
  description: 'Record one explicit human-reviewed Audible edition choice.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  candidate: z.number().int().min(1).max(500),
  candidates: z.string().min(1).max(4096),
  note: z.string().max(4096).optional(),
  receipt: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function audibleSelect({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
