import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { IdentifyRanking } from '../../../components/candidate-ranking.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { IdentifyTrail } from '../../../components/evidence-trail.js';
import type { AcousticIdentifyReceipt } from '../../../evidence.js';
import { defaultEvidenceOperations, evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).acousticIdentify;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Try ranked Audible candidates, retaining skips/errors and stopping at the first acoustic match by default.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AcousticIdentifyReceipt;
  const headline = receipt.verifiedRecording
    ? `Identified an acoustic match after ${receipt.attempts.length} candidate attempts.`
    : `No acoustic match after ${receipt.attempts.length} candidate attempts.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <IdentifyRanking receipt={receipt} />
      <IdentifyTrail receipt={receipt} />
    </CuratorDocument>
  );
}
