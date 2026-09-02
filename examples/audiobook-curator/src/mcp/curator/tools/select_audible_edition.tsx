import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import type { AudibleSelectionReceipt } from '../../../audible.js';
import { CandidateRanking } from '../../../components/candidate-ranking.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { defaultAudibleOperations, audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleSelect;

export const config = {"annotations":{"readOnlyHint":false},"description":"Record an explicit human-reviewed Audible edition choice from a candidate report."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleSelectionReceipt;
  return (
    <CuratorDocument
      headline={`Recorded human-reviewed Audible candidate ${receipt.candidateNumber}.`}
      receipt={receipt}
    >
      <CandidateRanking receipt={receipt} />
    </CuratorDocument>
  );
}
