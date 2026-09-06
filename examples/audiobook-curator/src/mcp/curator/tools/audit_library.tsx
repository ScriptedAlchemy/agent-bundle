import { Agent } from '@agent-bundle/runtime';
import React, { Suspense } from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { libraryAuditHeadline } from '../../../components/headlines.js';
import { LibraryAnalysis } from '../../../components/library-analysis.js';
import { AuditFileCards, AuditSummary } from '../../../components/library-shelf.js';
import type { LibraryAuditReceipt } from '../../../library.js';
import { discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations.libraryAudit;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
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
