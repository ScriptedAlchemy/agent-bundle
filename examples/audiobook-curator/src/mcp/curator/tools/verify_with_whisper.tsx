import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { WhisperTrail } from '../../../components/evidence-trail.js';
import type { WhisperReceipt } from '../../../evidence.js';
import { evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations.whisperVerify;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Extract and transcribe distributed PCM windows for human language, story, and narrator review.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
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
