import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import type { AudibleSearchReceipt } from '../../../audible.js';
import { SearchRanking } from '../../../components/candidate-ranking.js';
import { audibleSearchHeadline } from '../../../components/headlines.js';
import { audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations.audibleSearch;

export const config = {
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Search Audible regions and return ranked identity evidence requiring human review.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleSearchReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{audibleSearchHeadline(receipt)}</Agent.Text>
      <SearchRanking receipt={receipt} />
    </Agent.Result>
  );
}
