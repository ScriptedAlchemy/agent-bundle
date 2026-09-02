import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import type { AudibleSearchReceipt } from '../../../audible.js';
import { CandidateRanking } from '../../../components/candidate-ranking.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { defaultAudibleOperations, audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleSearch;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Search Audible regions and return ranked identity evidence requiring human review.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleSearchReceipt;
  return (
    <CuratorDocument
      headline={`Ranked ${receipt.candidates.length} Audible candidates across reviewed regions; human selection is required.`}
      receipt={receipt}
    >
      <CandidateRanking receipt={receipt} />
    </CuratorDocument>
  );
}
