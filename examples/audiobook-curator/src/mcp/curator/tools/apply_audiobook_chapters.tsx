import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline } from '../../../components/chapter-outline.js';
import { CuratorDocument } from '../../../components/curator-document.js';
import { IntegrityReport } from '../../../components/integrity-report.js';
import { MutationReceipt } from '../../../components/mutation-receipt.js';
import type { ChapterReceipt } from '../../../media-mutation.js';
import { defaultMediaMutationOperations, mediaMutationOperations } from '../../../operations/media-mutation.js';

const operation = mediaMutationOperations(defaultMediaMutationOperations).applyChapters;

export const config = {"annotations":{"destructiveHint":true,"readOnlyHint":false},"description":"Plan or explicitly apply verified chapter rows while preserving all non-chapter media state."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ChapterReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned ${receipt.chapters.length} chapters for ${receipt.file}.`
    : `Applied and verified ${receipt.chapters.length} chapters for ${receipt.file}.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <MutationReceipt receipt={receipt} />
      <ChapterOutline receipt={receipt} />
      <IntegrityReport receipt={receipt} />
    </CuratorDocument>
  );
}
