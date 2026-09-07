import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { ChapterOutline, chaptersFromConvertReceipt } from '../../../components/chapter-outline.js';
import { convertHeadline } from '../../../components/headlines.js';
import { ConversionIntegrityReport } from '../../../components/integrity-report.js';
import { ConversionMutation } from '../../../components/mutation-receipt.js';
import type { ConvertReceipt } from '../../../conversion.js';
import { outputOperations } from '../../../operations/output.js';

const operation = outputOperations.convert;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan or explicitly apply a verified FFmpeg or Audiobook Forge conversion while preserving sources.',
};
// The argv projection (`<tool>.cli.ts`) is compiled statically, so the schema
// is inline literal zod mirroring the operation's own input schema.
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
  receipt: z.string().min(1).max(4096).optional(),
  selection: z.string().min(1).max(4096),
  title: z.string().min(1).max(1024),
  year: z.string().min(1).max(64).optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ConvertReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{convertHeadline(receipt)}</Agent.Text>
      <ConversionMutation receipt={receipt} />
      <ChapterOutline chapters={chaptersFromConvertReceipt(receipt)} />
      <ConversionIntegrityReport receipt={receipt} />
    </Agent.Result>
  );
}
