import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline, chaptersFromConvertReceipt } from '../../../components/chapter-outline.js';
import { convertHeadline } from '../../../components/headlines.js';
import { ConversionIntegrityReport } from '../../../components/integrity-report.js';
import { ConversionMutation } from '../../../components/mutation-receipt.js';
import type { ConvertReceipt } from '../../../conversion.js';
import { outputOperations } from '../../../operations/output.js';

const operation = outputOperations.convert;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan or explicitly apply a verified FFmpeg or Audiobook Forge conversion while preserving sources.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ConvertReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{convertHeadline(receipt)}</Agent.Text>
      <ConversionMutation receipt={receipt} />
      <ChapterOutline chapters={chaptersFromConvertReceipt(receipt)} />
      <ConversionIntegrityReport receipt={receipt} />
    </Agent.Result>
  );
}
