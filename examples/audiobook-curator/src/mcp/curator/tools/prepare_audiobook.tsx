import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import { PrepareMutation } from '../../../components/mutation-receipt.js';
import type { PrepareReceipt } from '../../../curator-core.js';
import { outputOperations } from '../../../operations/output.js';

const operation = outputOperations.prepare;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan an M4B output, or apply the plan only when apply is explicitly true.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as PrepareReceipt;
  const headline = receipt.applied
    ? `Prepared audiobook output at ${receipt.output}.`
    : `Planned audiobook output at ${receipt.output}; no media was changed.`;
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{headline}</Agent.Text>
      <PrepareMutation receipt={receipt} />
    </Agent.Result>
  );
}
