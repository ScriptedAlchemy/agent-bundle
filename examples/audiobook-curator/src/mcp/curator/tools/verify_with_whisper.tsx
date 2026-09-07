import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { WhisperTrail } from '../../../components/evidence-trail.js';
import type { WhisperReceipt } from '../../../evidence.js';
import { evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations.whisperVerify;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Extract and transcribe distributed PCM windows for human language, story, and narrator review.',
  exitCode: 'result',
};
// Inline, not `operation.inputSchema`: the `.cli.ts` projection compiles this grammar statically.
export const inputSchema = z.object({
  author: z.string().max(512).optional(),
  file: z.string().min(1).max(4096),
  language: z.string().min(1).max(64).optional(),
  maxWindows: z.number().int().min(5).max(11).optional(),
  minimumChars: z.number().int().min(1).max(16_384).optional(),
  model: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096).optional(),
  threads: z.number().int().min(1).max(256).optional(),
  title: z.string().max(1024).optional(),
  whisperCli: z.string().min(1).max(4096).optional(),
  windowSeconds: z.number().int().min(1).max(3600).optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as WhisperReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{`Collected ${receipt.usableWindows} usable transcript windows; human identity review is required.`}</Agent.Text>
      <WhisperTrail receipt={receipt} />
    </Agent.Result>
  );
}
