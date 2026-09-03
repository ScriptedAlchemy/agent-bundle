import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { selectionHeadline } from '../../../components/headlines.js';
import { SelectionShelf } from '../../../components/library-shelf.js';
import type { SelectionReceipt } from '../../../library.js';
import { defaultDiscoveryOperations, discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations(defaultDiscoveryOperations).select;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Select strongest source encodings while retaining alternates and duration review evidence.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as SelectionReceipt;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{selectionHeadline(receipt)}</Agent.Text>
      <SelectionShelf receipt={receipt} />
    </Agent.Result>
  );
}
