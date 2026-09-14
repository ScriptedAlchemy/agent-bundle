import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import { InspectionShelf } from '../../../components/library-shelf.js';
import type { InspectionReceipt } from '../../../curator-core.js';
import { discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations.inspect;

export const inputSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: z.string().min(1).max(4096),
}).strict();
export const resultSchema = operation.resultSchema;

export default defineTool({
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "maxFiles": {
        "type": "number"
      },
      "root": {
        "type": "string"
      }
    },
    "required": [
      "root"
    ],
    "type": "object"
  },
  annotations: { readOnlyHint: true },
  description: 'Inspect a bounded directory tree and report supported audiobook media without changing it.',
  inputSchema,
  resultSchema,
}, async (input, { signal }) => {
  const receipt = await operation.handler(input, { signal }) as InspectionReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{`Inspected ${receipt.files.length} audio files (${receipt.totalBytes} bytes).`}</Agent.Text>
      <InspectionShelf receipt={receipt} />
    </Agent.Result>
  );
});
