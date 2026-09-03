import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import type { AudibleSearchReceipt } from '../audible.js';
import { SearchRanking } from '../components/candidate-ranking.js';
import { audibleSearchHeadline } from '../components/headlines.js';
import { audibleOperations, audibleRegionList, defaultAudibleOperations } from '../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleSearch;

export const config = {
  description: 'Search and rank Audible identity candidates across reviewed regions.',
  exitCode: 'result',
} satisfies CliRouteConfig;

// Schema keys are the CLI surface (`--duration`, `--regions LIST`); the
// handler maps them onto the operation input's `durationSeconds` and parsed
// region array, preserving the pre-migration option names byte for byte.
export const inputSchema = z.object({
  attempts: z.number().int().min(1).max(10).optional(),
  author: z.string().min(1).max(512).optional(),
  duration: z.number().positive().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  narrator: z.string().min(1).max(512).optional(),
  regions: z.string().min(1).max(64).optional(),
  report: z.string().min(1).max(4096),
  title: z.string().min(1).max(1024),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function audibleSearch({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler({
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    ...(input.author === undefined ? {} : { author: input.author }),
    ...(input.duration === undefined ? {} : { durationSeconds: input.duration }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.narrator === undefined ? {} : { narrator: input.narrator }),
    ...(input.regions === undefined ? {} : { regions: audibleRegionList(input.regions) }),
    report: input.report,
    title: input.title,
  }, { signal }) as AudibleSearchReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{audibleSearchHeadline(receipt)}</Agent.Text>
      <SearchRanking receipt={receipt} />
    </Agent.Result>
  );
}
