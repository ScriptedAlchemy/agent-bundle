import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultMediaMutationOperations, mediaMutationOperations } from '../../../operations/media-mutation.js';

const operation = mediaMutationOperations(defaultMediaMutationOperations).applyChapters;

export const config = {"annotations":{"destructiveHint":true,"readOnlyHint":false},"description":"Plan or explicitly apply verified chapter rows while preserving all non-chapter media state."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
