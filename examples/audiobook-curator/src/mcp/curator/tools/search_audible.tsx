import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

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
export const inputSchema = z.object({
  attempts: z.number().int().min(1).max(10).optional(),
  author: z.string().min(1).max(512).optional(),
  durationSeconds: z.number().positive().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  narrator: z.string().min(1).max(512).optional(),
  regions: z.array(z.enum(['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us'])).min(1).max(10).optional(),
  report: z.string().min(1).max(4096).optional(),
  title: z.string().min(1).max(1024),
}).strict();
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
