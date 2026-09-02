import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { AcousticTrail } from '../../../components/evidence-trail.js';
import type { AcousticReceipt } from '../../../evidence.js';
import { defaultEvidenceOperations, evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).acousticVerify;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Compare a bounded Audible sample with local audio through an optional Audiolocate Python capability.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AcousticReceipt;
  const headline = receipt.verifiedRecording
    ? `Audiolocate matched Audible ${receipt.asin} to the local recording.`
    : `Audiolocate did not match Audible ${receipt.asin}; review is required.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <AcousticTrail receipt={receipt} />
    </CuratorDocument>
  );
}
