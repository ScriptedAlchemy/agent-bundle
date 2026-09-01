import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { defaultMediaMutationOperations, mediaMutationOperations } from '../operations/media-mutation.js';

const operation = mediaMutationOperations(defaultMediaMutationOperations).applyChapters;

export const config = {
  description: 'Plan or apply verified generic or Audible chapter rows without changing encoded audio.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  apply: z.boolean().optional(),
  chapters: z.string().min(1).max(4096),
  file: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function applyChapters({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
