import React from 'react';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { CuratorDocument } from '../components/curator-document.js';
import { inventoryHeadline } from '../components/headlines.js';
import { InventoryShelf } from '../components/library-shelf.js';
import type { InventoryReceipt } from '../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).inventory;

export const config = {
  description: 'Probe source audio without changing it.',
  exitCode: 'result',
  positionals: ['source'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  report: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
  strict: z.boolean().optional(),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function inventory({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as InventoryReceipt;
  return (
    <CuratorDocument
      headline={inventoryHeadline(receipt)}
      receipt={receipt}
    >
      <InventoryShelf receipt={receipt} />
    </CuratorDocument>
  );
}
