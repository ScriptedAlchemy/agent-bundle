import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { inventoryHeadline } from '../../../components/headlines.js';
import { InventoryShelf } from '../../../components/library-shelf.js';
import type { InventoryReceipt } from '../../../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).inventory;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Inventory source audio with retained per-file probe evidence.',
  exitCode: 'result',
};
export const inputSchema = z.object({
  source: z.string().min(1).max(4096).describe('Source audio path to inventory.'),
  report: z.string().min(1).max(4096).optional().describe('Optional report destination.'),
  strict: z.boolean().optional().describe('Fail when any source cannot be probed.'),
}).strict();
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as InventoryReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{inventoryHeadline(receipt)}</Agent.Text>
      <InventoryShelf receipt={receipt} />
    </Agent.Result>
  );
}
