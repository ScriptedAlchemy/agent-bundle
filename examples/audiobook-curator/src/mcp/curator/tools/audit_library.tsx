import { Agent } from '@agent-bundle/runtime';
import React, { Suspense } from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { libraryAuditHeadline } from '../../../components/headlines.js';
import { LibraryAnalysis } from '../../../components/library-analysis.js';
import { AuditFileCards, AuditSummary } from '../../../components/library-shelf.js';
import type { LibraryAuditReceipt } from '../../../library.js';
import { discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations.libraryAudit;

export const config = {
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "concurrency": {
        "type": "number"
      },
      "report": {
        "type": "string"
      },
      "sources": {
        "items": {
          "type": "string"
        },
        "type": "array"
      },
      "strict": {
        "type": "boolean"
      }
    },
    "required": [
      "sources"
    ],
    "type": "object"
  },
  annotations: { readOnlyHint: false },
  description: 'Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice.',
  exitCode: 'result',
};
export const inputSchema = z.object({
  concurrency: z.number().int().min(1).max(8).optional(),
  report: z.string().min(1).max(4096).optional(),
  sources: z.array(z.string().min(1).max(4096)).min(1).max(64),
  strict: z.boolean().optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as LibraryAuditReceipt;
  // The Suspense fallback is the progress surface: the MCP projector turns the
  // streamed `Agent.Progress` node into `notifications/progress` for a client
  // that sent a progress token, so no `progress.report()` repeats the message.
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{libraryAuditHeadline(receipt)}</Agent.Text>
      <AuditSummary receipt={receipt} />
      <AuditFileCards receipt={receipt} />
      <Suspense fallback={<Agent.Progress completed={0} message="Analyzing duplicate and multipart groups" />}>
        <LibraryAnalysis receipt={receipt} signal={signal} />
      </Suspense>
    </Agent.Result>
  );
}
