import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultOutputOperations, outputOperations } from '../../../operations/output.js';

const operation = outputOperations(defaultOutputOperations).audit;

export const config = {"annotations":{"readOnlyHint":false},"description":"Validate chapter structure, optional conversion mapping, file/audio hashes, probe facts, and optional full decode."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
