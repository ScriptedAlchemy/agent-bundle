import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { evidenceOperations } from '../operations/evidence.js';

const operation = evidenceOperations.acousticVerify;

export const config = {
  description: 'Compare one bounded Audible sample with local audio through optional Audiolocate.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  asin: z.string().min(1).max(64),
  attempts: z.number().int().min(1).max(10).optional(),
  audiolocatePython: z.string().min(1).max(4096).optional(),
  chunkSeconds: z.number().int().min(1).max(86_400).optional(),
  file: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
  region: z.enum(['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us']).optional(),
  sampleUrl: z.url().optional(),
  verbose: z.boolean().optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function acousticVerify({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
