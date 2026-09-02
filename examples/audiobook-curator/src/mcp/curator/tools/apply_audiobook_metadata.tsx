import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorDocument } from '../../../components/curator-document.js';
import { IntegrityReport } from '../../../components/integrity-report.js';
import { MutationReceipt } from '../../../components/mutation-receipt.js';
import type { MetadataReceipt } from '../../../media-mutation.js';
import { defaultMediaMutationOperations, mediaMutationOperations } from '../../../operations/media-mutation.js';

const operation = mediaMutationOperations(defaultMediaMutationOperations).applyMetadata;

export const config = {"annotations":{"destructiveHint":true,"readOnlyHint":false},"description":"Plan or explicitly apply verified catalog metadata and artwork while preserving every audio stream."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as MetadataReceipt;
  const headline = receipt.status === 'planned'
    ? `Planned metadata for ${receipt.file}; audio remains unchanged.`
    : `Applied and verified metadata for ${receipt.file}.`;
  return (
    <CuratorDocument headline={headline} receipt={receipt}>
      <MutationReceipt receipt={receipt} />
      <IntegrityReport receipt={receipt} />
    </CuratorDocument>
  );
}
