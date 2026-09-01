import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultEvidenceOperations, evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).acousticVerify;

export const config = {"annotations":{"openWorldHint":true,"readOnlyHint":false},"description":"Compare a bounded Audible sample with local audio through an optional Audiolocate Python capability."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
