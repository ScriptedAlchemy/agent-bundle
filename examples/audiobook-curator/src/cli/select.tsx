import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { selectionHeadline } from '../components/headlines.js';
import { SelectionShelf } from '../components/library-shelf.js';
import type { SelectionReceipt } from '../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).select;

export const config = {
  description: 'Choose the strongest source among normalized collisions.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  inventory: z.string().min(1).max(4096),
  report: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function select({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as SelectionReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{selectionHeadline(receipt)}</Agent.Text>
      <SelectionShelf receipt={receipt} />
    </Agent.Result>
  );
}
