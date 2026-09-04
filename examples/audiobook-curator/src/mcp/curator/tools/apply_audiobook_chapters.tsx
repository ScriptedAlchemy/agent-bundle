import { Agent, agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { ChapterOutline, chaptersFromApplyReceipt } from '../../../components/chapter-outline.js';
import { CurationShelf, ShelfUnavailable } from '../../../components/curation-shelf.js';
import { ChapterIntegrityReport } from '../../../components/integrity-report.js';
import { ChapterMutation } from '../../../components/mutation-receipt.js';
import type { ChapterReceipt } from '../../../media-mutation.js';
import { defaultMediaMutationOperations, mediaMutationOperations } from '../../../operations/media-mutation.js';
import { CurationShelfStateSchema } from '../../../state.js';

const operation = mediaMutationOperations(defaultMediaMutationOperations).applyChapters;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan or explicitly apply verified chapter rows while preserving all non-chapter media state.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as ChapterReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned ${receipt.chapters.length} chapters for ${receipt.file}.`
    : `Applied and verified ${receipt.chapters.length} chapters for ${receipt.file}.`;
  const context = await agent();
  const shelf = context.state === undefined
    ? <ShelfUnavailable />
    : (
        <CurationShelf
          state={CurationShelfStateSchema.parse((await context.state.dispatch('mutationApplied', {
            appliedAt: receipt.generatedAt,
            file: receipt.file,
            operation: receipt.operation,
            status: receipt.status,
          }, {
            idempotencyKey: `${context.invocation.id}:curation-shelf:apply-chapters`,
          })).state)}
        />
      );
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <ChapterMutation receipt={receipt} />
      <ChapterOutline chapters={chaptersFromApplyReceipt(receipt)} />
      <ChapterIntegrityReport receipt={receipt} />
      {shelf}
    </Agent.Result>
  );
}
