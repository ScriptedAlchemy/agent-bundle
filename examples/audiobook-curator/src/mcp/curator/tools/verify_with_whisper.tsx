import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { EvidenceTrail } from '../../../components/evidence-trail.js';
import type { WhisperReceipt } from '../../../evidence.js';
import { defaultEvidenceOperations, evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).whisperVerify;

export const config = {"annotations":{"readOnlyHint":false},"description":"Extract and transcribe distributed PCM windows for human language, story, and narrator review."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as WhisperReceipt;
  return (
    <CuratorDocument
      headline={`Collected ${receipt.usableWindows} usable transcript windows; human identity review is required.`}
      receipt={receipt}
    >
      <EvidenceTrail receipt={receipt} />
    </CuratorDocument>
  );
}
