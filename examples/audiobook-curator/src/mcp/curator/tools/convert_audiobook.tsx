import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline } from '../../../components/chapter-outline.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { IntegrityReport } from '../../../components/integrity-report.js';
import { MutationReceipt } from '../../../components/mutation-receipt.js';
import type { ConvertReceipt } from '../../../conversion.js';
import { defaultOutputOperations, outputOperations } from '../../../operations/output.js';

const operation = outputOperations(defaultOutputOperations).convert;

export const config = {"annotations":{"destructiveHint":true,"readOnlyHint":false},"description":"Plan or explicitly apply a verified FFmpeg or Audiobook Forge conversion while preserving sources."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ConvertReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned ${receipt.audioMode} output at ${receipt.output}; sources remain unchanged.`
    : `Converted and verified ${receipt.output}; sources remain unchanged.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <MutationReceipt receipt={receipt} />
      <ChapterOutline receipt={receipt} />
      <IntegrityReport receipt={receipt} />
    </CuratorDocument>
  );
}
