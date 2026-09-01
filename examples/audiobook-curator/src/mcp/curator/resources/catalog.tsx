import React from 'react';
import type { ResourceConfig, ToolRouteProps } from 'agent-bundle';
import { Agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Read the audiobook curator workflow catalog.',
  mimeType: 'application/json',
  uri: 'audiobook-curator://catalog',
} satisfies ResourceConfig;
export const inputSchema = z.object({ uri: z.string() }).strict();
export const resultSchema = z.object({
  contents: z.array(z.object({ mimeType: z.literal('application/json'), text: z.string(), uri: z.string() }).strict()),
}).strict();

export default async function Catalog({ input }: ToolRouteProps<typeof inputSchema>) {
  const result = {
    contents: [{
      mimeType: 'application/json' as const,
      text: JSON.stringify({ stages: ['discover', 'identify', 'curate', 'verify'] }),
      uri: input.uri,
    }],
  };
  return (
    <Agent.Result value={result as JsonValue}>
      <Agent.Text>Audiobook curator catalog ready.</Agent.Text>
    </Agent.Result>
  );
}
