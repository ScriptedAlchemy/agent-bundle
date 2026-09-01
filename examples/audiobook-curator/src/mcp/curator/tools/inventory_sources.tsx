import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { CuratorResult, type CuratorReceipt } from '../../../result.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).inventory;

export const config = {"annotations":{"readOnlyHint":false},"description":"Inventory source audio with retained per-file probe evidence."};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as CuratorReceipt;
  return <CuratorResult receipt={receipt} />;
}
