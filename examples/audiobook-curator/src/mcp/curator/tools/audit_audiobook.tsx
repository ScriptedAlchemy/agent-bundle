import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { ChapterOutline, chaptersFromAuditReceipt } from '../../../components/chapter-outline.js';
import { integrityAuditHeadline } from '../../../components/headlines.js';
import { IntegrityAuditReport } from '../../../components/integrity-report.js';
import type { IntegrityAuditReceipt } from '../../../integrity-audit.js';
import { outputOperations } from '../../../operations/output.js';

const operation = outputOperations.audit;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Validate chapter structure, optional conversion mapping, file/audio hashes, probe facts, and optional full decode.',
  exitCode: 'result',
};
// The argv projection (`<tool>.cli.ts`) is compiled statically, so the schema
// is inline literal zod mirroring the operation's own input schema.
export const inputSchema = z.object({
  conversionReceipt: z.string().min(1).max(4096).optional(),
  file: z.string().min(1).max(4096),
  fullDecode: z.boolean().optional(),
  receipt: z.string().min(1).max(4096).optional(),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as IntegrityAuditReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{integrityAuditHeadline(receipt)}</Agent.Text>
      <IntegrityAuditReport receipt={receipt} />
      <ChapterOutline chapters={chaptersFromAuditReceipt(receipt)} />
    </Agent.Result>
  );
}
