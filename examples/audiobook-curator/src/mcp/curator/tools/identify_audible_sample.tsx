import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { IdentifyRanking } from '../../../components/candidate-ranking.js';
import { IdentifyTrail } from '../../../components/evidence-trail.js';
import type { AcousticIdentifyReceipt } from '../../../evidence.js';
import { evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations.acousticIdentify;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Try ranked Audible candidates, retaining skips/errors and stopping at the first acoustic match by default.',
  exitCode: 'result',
};
// The argv projection (`<tool>.cli.ts`) is compiled statically, so the schema
// is inline literal zod mirroring the operation's own input schema.
export const inputSchema = z.object({
  all: z.boolean().optional(),
  attempts: z.number().int().min(1).max(10).optional(),
  candidates: z.string().min(1).max(4096),
  chunkSeconds: z.number().int().min(1).max(86_400).optional(),
  file: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096).optional(),
  top: z.number().int().min(1).max(10).optional(),
  verbose: z.boolean().optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AcousticIdentifyReceipt;
  const headline = receipt.verifiedRecording
    ? `Identified an acoustic match after ${receipt.attempts.length} candidate attempts.`
    : `No acoustic match after ${receipt.attempts.length} candidate attempts.`;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <IdentifyRanking receipt={receipt} />
      <IdentifyTrail receipt={receipt} />
    </Agent.Result>
  );
}
