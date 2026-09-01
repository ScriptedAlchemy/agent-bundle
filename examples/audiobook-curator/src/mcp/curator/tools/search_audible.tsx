import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultAudibleOperations, audibleOperations } from '../../../operations/audible.js';

const operation = audibleOperations(defaultAudibleOperations).audibleSearch;

export const config = {"annotations":{"openWorldHint":true,"readOnlyHint":false},"description":"Search Audible regions and return ranked identity evidence requiring human review."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
