import React from 'react';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { ChapterOutline } from '../components/chapter-outline.js';
import { CuratorDocument } from '../components/curator-document.js';
import { IntegrityReport } from '../components/integrity-report.js';
import { MutationReceipt } from '../components/mutation-receipt.js';
import type { ConvertReceipt } from '../conversion.js';
import { defaultOutputOperations, outputOperations } from '../operations/output.js';

const operation = outputOperations(defaultOutputOperations).convert;

export const config = {
  description: 'Plan or apply a verified conversion to one chaptered M4B.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  apply: z.boolean().optional(),
  artwork: z.string().min(1).max(4096).optional(),
  audioBitrate: z.string().min(2).max(32).optional(),
  audioCodec: z.enum(['aac', 'alac']).optional(),
  author: z.string().min(1).max(512),
  engine: z.enum(['audiobook-forge', 'ffmpeg']).optional(),
  forgeAacEncoder: z.string().min(1).max(128).optional(),
  forgeCli: z.string().min(1).max(4096).optional(),
  jobs: z.number().int().min(0).max(256).optional(),
  language: z.string().min(1).max(64).optional(),
  narrator: z.string().min(1).max(512).optional(),
  output: z.string().min(1).max(4096),
  overwrite: z.boolean().optional(),
  receipt: z.string().min(1).max(4096),
  selection: z.string().min(1).max(4096),
  title: z.string().min(1).max(1024),
  year: z.string().min(1).max(64).optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function convert({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ConvertReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned ${receipt.audioMode} output at ${receipt.output}; sources remain unchanged.`
    : `Converted and verified ${receipt.output}; sources remain unchanged.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <MutationReceipt receipt={receipt} />
      <ChapterOutline receipt={receipt} />
      <IntegrityReport receipt={receipt} />
    </CuratorDocument>
  );
}
