import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { selectionHeadline } from '../../../components/headlines.js';
import { SelectionShelf } from '../../../components/library-shelf.js';
import type { SelectionReceipt } from '../../../library.js';
import { discoveryOperations } from '../../../operations/discovery.js';

const operation = discoveryOperations.select;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Select strongest source encodings while retaining alternates and duration review evidence.',
};
// The argv projection (`<tool>.cli.ts`) is compiled statically, so the schema
// is inline literal zod mirroring the operation's own input schema.
export const inputSchema = z.object({
  inventory: z.string().min(1).max(4096),
  report: z.string().min(1).max(4096).optional(),
}).strict();
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
