import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { defaultEvidenceOperations, evidenceOperations } from '../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).whisperVerify;

export const config = {
  description: 'Transcribe distributed audiobook windows for human language and identity review.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  author: z.string().max(512).optional(),
  file: z.string().min(1).max(4096),
  language: z.string().min(1).max(64).optional(),
  maxWindows: z.number().int().min(5).max(11).optional(),
  minimumChars: z.number().int().min(1).max(16_384).optional(),
  model: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096),
  threads: z.number().int().min(1).max(256).optional(),
  title: z.string().max(1024).optional(),
  whisperCli: z.string().min(1).max(4096).optional(),
  windowSeconds: z.number().int().min(1).max(3600).optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function whisperVerify({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler(input, { signal });
}
