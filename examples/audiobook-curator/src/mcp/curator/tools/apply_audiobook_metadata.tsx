import { Agent, agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CurationShelf, ShelfUnavailable } from '../../../components/curation-shelf.js';
import { MetadataIntegrityReport } from '../../../components/integrity-report.js';
import { MetadataMutation } from '../../../components/mutation-receipt.js';
import type { MetadataReceipt } from '../../../media-mutation.js';
import { mediaMutationOperations } from '../../../operations/media-mutation.js';
import { CurationShelfStateSchema } from '../../../state.js';

const operation = mediaMutationOperations.applyMetadata;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan or explicitly apply verified catalog metadata and artwork while preserving every audio stream.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as MetadataReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned metadata for ${receipt.file}; audio remains unchanged.`
    : `Applied and verified metadata for ${receipt.file}.`;
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
            idempotencyKey: `${context.invocation.id}:curation-shelf:apply-metadata`,
          })).state)}
        />
      );
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <MetadataMutation receipt={receipt} />
      <MetadataIntegrityReport receipt={receipt} />
      {shelf}
    </Agent.Result>
  );
}
