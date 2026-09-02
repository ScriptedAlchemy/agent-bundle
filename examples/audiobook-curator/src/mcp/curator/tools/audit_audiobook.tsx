import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline, chaptersFromAuditReceipt } from '../../../components/chapter-outline.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { integrityAuditHeadline } from '../../../components/headlines.js';
import { IntegrityAuditReport } from '../../../components/integrity-report.js';
import type { IntegrityAuditReceipt } from '../../../integrity-audit.js';
import { defaultOutputOperations, outputOperations } from '../../../operations/output.js';

const operation = outputOperations(defaultOutputOperations).audit;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Validate chapter structure, optional conversion mapping, file/audio hashes, probe facts, and optional full decode.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as IntegrityAuditReceipt;
  return (
    <CuratorDocument
      headline={integrityAuditHeadline(receipt)}
      receipt={receipt}
    >
      <IntegrityAuditReport receipt={receipt} />
      <ChapterOutline chapters={chaptersFromAuditReceipt(receipt)} />
    </CuratorDocument>
  );
}
