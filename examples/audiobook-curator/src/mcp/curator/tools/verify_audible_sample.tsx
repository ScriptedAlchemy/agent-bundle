import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { AcousticTrail } from '../../../components/evidence-trail.js';
import type { AcousticReceipt } from '../../../evidence.js';
import { evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations.acousticVerify;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Compare a bounded Audible sample with local audio through an optional Audiolocate Python capability.',
  exitCode: 'result',
};
export const inputSchema = z.object({
  asin: z.string().min(1).max(64),
  attempts: z.number().int().min(1).max(10).optional(),
  audiolocatePython: z.string().min(1).max(4096).optional(),
  chunkSeconds: z.number().int().min(1).max(86_400).optional(),
  file: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096).optional(),
  region: z.enum(['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us']).optional(),
  sampleUrl: z.url().optional(),
  verbose: z.boolean().optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AcousticReceipt;
  const headline = receipt.verifiedRecording
    ? `Audiolocate matched Audible ${receipt.asin} to the local recording.`
    : `Audiolocate did not match Audible ${receipt.asin}; review is required.`;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <AcousticTrail receipt={receipt} />
    </Agent.Result>
  );
}
