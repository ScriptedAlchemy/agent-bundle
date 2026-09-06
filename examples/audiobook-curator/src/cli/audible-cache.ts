import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { audibleOperations } from '../operations/audible.js';

const operation = audibleOperations.audibleCache;

export const config = {
  description: 'Cache one reviewed Audible product, chapters, artwork, and source URLs.',
} satisfies CliRouteConfig;

// Schema keys are the CLI surface (`--cache-dir`); the handler maps the key
// onto the operation input's `cacheDirectory`.
export const inputSchema = z.object({
  asin: z.string().min(1).max(64),
  attempts: z.number().int().min(1).max(10).optional(),
  cacheDir: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
  region: z.enum(['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us']).optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function audibleCache({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler({
    asin: input.asin,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    cacheDirectory: input.cacheDir,
    receipt: input.receipt,
    ...(input.region === undefined ? {} : { region: input.region }),
  }, { signal });
}
