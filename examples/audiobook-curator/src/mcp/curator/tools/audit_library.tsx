import { Agent, agent } from '@agent-bundle/runtime';
import React, { Suspense } from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { libraryAuditHeadline } from '../../../components/headlines.js';
import { LibraryAnalysis } from '../../../components/library-analysis.js';
import { AuditFileCards, AuditSummary } from '../../../components/library-shelf.js';
import type { LibraryAuditReceipt } from '../../../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).libraryAudit;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice.',
  exitCode: 'result',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as LibraryAuditReceipt;
  const context = await agent();
  await context.progress.report({
    completed: 0,
    message: 'Analyzing duplicate and multipart groups',
    total: 1,
  });
  return (
    <CuratorDocument
      headline={libraryAuditHeadline(receipt)}
      receipt={receipt}
    >
      <AuditSummary receipt={receipt} />
      <AuditFileCards receipt={receipt} />
      <Suspense fallback={<Agent.Progress completed={0} message="Analyzing duplicate and multipart groups" />}>
        <LibraryAnalysis receipt={receipt} signal={signal} />
      </Suspense>
    </CuratorDocument>
  );
}
