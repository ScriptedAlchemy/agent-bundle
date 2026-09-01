import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultOutputOperations, outputOperations } from '../../../operations/output.js';

const operation = outputOperations(defaultOutputOperations).prepare;

export const config = {"annotations":{"destructiveHint":true,"readOnlyHint":false},"description":"Plan an M4B output, or apply the plan only when apply is explicitly true."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
