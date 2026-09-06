import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { mediaMutationOperations } from '../operations/media-mutation.js';

const operation = mediaMutationOperations.applyMetadata;

export const config = {
  description: 'Plan or apply verified Audible metadata and artwork without changing encoded audio.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  apply: z.boolean().optional(),
  artwork: z.string().min(1).max(4096).optional(),
  author: z.string().max(512).optional(),
  file: z.string().min(1).max(4096),
  language: z.string().min(1).max(64).optional(),
  narrator: z.string().max(512).optional(),
  product: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
  title: z.string().max(1024).optional(),
  year: z.string().max(64).optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function applyMetadata({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
