import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultEvidenceOperations, evidenceOperations } from '../../../operations/evidence.js';

const operation = evidenceOperations(defaultEvidenceOperations).acousticIdentify;

export const config = {"annotations":{"openWorldHint":true,"readOnlyHint":false},"description":"Try ranked Audible candidates, retaining skips/errors and stopping at the first acoustic match by default."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
