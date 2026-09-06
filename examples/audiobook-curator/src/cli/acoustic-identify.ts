import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { evidenceOperations } from '../operations/evidence.js';

const operation = evidenceOperations.acousticIdentify;

export const config = {
  description: 'Try score-ranked, deduplicated Audible candidates and retain per-candidate evidence.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  all: z.boolean().optional(),
  attempts: z.number().int().min(1).max(10).optional(),
  candidates: z.string().min(1).max(4096),
  chunkSeconds: z.number().int().min(1).max(86_400).optional(),
  file: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
  top: z.number().int().min(1).max(10).optional(),
  verbose: z.boolean().optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function acousticIdentify({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
