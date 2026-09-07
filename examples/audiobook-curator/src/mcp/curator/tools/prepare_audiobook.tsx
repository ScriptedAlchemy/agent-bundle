import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { PrepareMutation } from '../../../components/mutation-receipt.js';
import type { PrepareReceipt } from '../../../curator-core.js';
import { outputOperations } from '../../../operations/output.js';

const operation = outputOperations.prepare;

export const config = {
  annotations: { destructiveHint: true, readOnlyHint: false },
  description: 'Plan an M4B output, or apply the plan only when apply is explicitly true.',
};
// The argv projection (`<tool>.cli.ts`) is compiled statically, so the schema
// is inline literal zod mirroring the operation's own input schema.
export const inputSchema = z.object({
  apply: z.boolean().optional(),
  outputName: z.string().min(5).max(204).optional(),
  outputRoot: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
}).strict();
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
