import React from 'react';
import type { PromptConfig, ToolRouteProps } from 'agent-bundle';
import { Agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

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
      content: { text: `Inspect ${input.root}, retain evidence, and require review before mutation.`, type: 'text' as const },
      role: 'user' as const,
    }],
  };
  return (
    <Agent.Result value={result as JsonValue}>
      <Agent.Text>Evidence-first curation prompt ready.</Agent.Text>
    </Agent.Result>
  );
}
