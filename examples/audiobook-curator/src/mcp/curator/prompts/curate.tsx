import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { PromptConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { Callout, DataList } from '../../../components/primitives.tsx';

export const config = {
  description: 'Start an evidence-first audiobook curation review.',
} satisfies PromptConfig;
export const inputSchema = z.object({ root: z.string().min(1) }).strict();
export const resultSchema = z.object({
  messages: z.array(z.object({
    content: z.object({ text: z.string(), type: z.literal('text') }).strict(),
    role: z.literal('user'),
  }).strict()),
}).strict();

export default async function Curate({ input }: ToolRouteProps<typeof inputSchema>) {
  const result = {
    messages: [{
      content: {
        text: `Inspect ${input.root} through discover, identify, curate, and verify. Retain evidence and require review before any mutation.`,
        type: 'text' as const,
      },
      role: 'user' as const,
    }],
  };

  return (
    <Agent.Result value={result as JsonValue}>
      <Agent.Text>Curation review prepared.</Agent.Text>
      <DataList fields={[
        { label: 'Root', value: input.root },
        { label: 'Workflow', value: 'discover → identify → curate → verify' },
        { label: 'Expectation', value: 'review before mutation' },
      ]} />
      <Callout tone="review">
        Evidence first: retain source observations and identification evidence before proposing mutations.
      </Callout>
    </Agent.Result>
  );
}
