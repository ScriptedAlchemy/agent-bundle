import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline } from '../../../components/chapter-outline.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { IntegrityReport } from '../../../components/integrity-report.js';
import type { IntegrityAuditReceipt } from '../../../integrity-audit.js';
import { defaultOutputOperations, outputOperations } from '../../../operations/output.js';

const operation = outputOperations(defaultOutputOperations).audit;

export const config = {"annotations":{"readOnlyHint":false},"description":"Validate chapter structure, optional conversion mapping, file/audio hashes, probe facts, and optional full decode.","exitCode":"result"};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as IntegrityAuditReceipt;
  return (
    <CuratorDocument
      headline={`Audited ${receipt.bytes} bytes with SHA-256 ${receipt.sha256}; status is ${receipt.status}.`}
      receipt={receipt}
    >
      <IntegrityReport receipt={receipt} />
      <ChapterOutline receipt={receipt} />
    </CuratorDocument>
  );
}
