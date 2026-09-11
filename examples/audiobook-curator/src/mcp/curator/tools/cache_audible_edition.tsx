import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import type { AudibleCacheReceipt } from '../../../audible.js';
import { Callout, DataList } from '../../../components/primitives.js';
import { audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations.audibleCache;

export const config = {
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "asin": {
        "type": "string"
      },
      "attempts": {
        "type": "number"
      },
      "cacheDirectory": {
        "type": "string"
      },
      "receipt": {
        "type": "string"
      },
      "region": {
        "enum": [
          "au",
          "ca",
          "de",
          "es",
          "fr",
          "in",
          "it",
          "jp",
          "uk",
          "us"
        ],
        "type": "string"
      }
    },
    "required": [
      "asin",
      "cacheDirectory"
    ],
    "type": "object"
  },
  annotations: { openWorldHint: true, readOnlyHint: false },
  description: 'Cache a reviewed Audible edition and retained source evidence.',
};
export const inputSchema = z.object({
  asin: z.string().min(1).max(64),
  attempts: z.number().int().min(1).max(10).optional(),
  cacheDirectory: z.string().min(1).max(4096),
  receipt: z.string().min(1).max(4096).optional(),
  region: z.enum(['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us']).optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleCacheReceipt;
  const headline = `Cached Audible ${receipt.region}/${receipt.asin} product evidence${receipt.chapters === undefined ? ' without chapter metadata' : ' with chapter metadata'}.`;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <DataList fields={[
        { label: 'Audible edition', value: `${receipt.region}/${receipt.asin}` },
        { label: 'Product evidence', value: receipt.product },
        ...(receipt.chapters === undefined ? [] : [{ label: 'Chapter evidence', value: receipt.chapters }]),
        ...(receipt.artwork === undefined ? [] : [{ label: 'Artwork evidence', value: receipt.artwork }]),
      ]} />
      {receipt.chapterError === undefined
        ? null
        : <Callout tone="warning">{`Chapter metadata was not cached: ${receipt.chapterError}`}</Callout>}
    </Agent.Result>
  );
}
