import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ResourceConfig } from 'agent-bundle';
import { z } from 'zod';

import { readinessPolicy } from '../../../readiness-policy.ts';

export const config = {
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "uri": {
        "type": "string"
      }
    },
    "required": [
      "uri"
    ],
    "type": "object"
  },
  description: 'The release rule a service status is judged against.',
  mimeType: 'text/plain',
  title: 'Readiness policy',
  uri: 'policy://mcp-app-example/readiness',
} satisfies ResourceConfig;

export const inputSchema = z.object({ uri: z.string() });

export const resultSchema = z.object({
  contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })),
});

export default async function ReadinessPolicy({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  return (
    <Agent.Result value={{ contents: [{ mimeType: 'text/plain', text: readinessPolicy, uri: input.uri }] }}>
      <Agent.Text>{readinessPolicy}</Agent.Text>
    </Agent.Result>
  );
}
