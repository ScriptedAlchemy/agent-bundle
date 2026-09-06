import { Agent, agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolRouteProps } from 'agent-bundle';

import type { AudibleSelectionReceipt } from '../../../audible.js';
import { SelectionRanking } from '../../../components/candidate-ranking.js';
import { CurationShelf, ShelfUnavailable } from '../../../components/curation-shelf.js';
import { audibleOperations } from '../../../operations/audible.js';
import { CurationShelfStateSchema } from '../../../state.js';

const operation = audibleOperations.audibleSelect;

export const config = {
  annotations: { readOnlyHint: false },
  description: 'Record an explicit human-reviewed Audible edition choice from a candidate report.',
};
export const inputSchema = operation.inputSchema;
export const resultSchema = operation.resultSchema;

export default async function Route({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const receipt = await operation.handler(input, { signal }) as AudibleSelectionReceipt;
  const context = await agent();
  const shelf = context.state === undefined
    ? <ShelfUnavailable />
    : (
        <CurationShelf
          state={CurationShelfStateSchema.parse((await context.state.dispatch('editionSelected', {
            asin: String(receipt.selected.asin ?? ''),
            candidateNumber: receipt.candidateNumber,
            region: receipt.selected.region,
            selectedAt: receipt.generatedAt,
            title: String(receipt.selected.title ?? ''),
          }, {
            idempotencyKey: `${context.invocation.id}:curation-shelf:edition-selected`,
          })).state)}
        />
      );
  return (
    <Agent.Result value={receipt}>
      <Agent.Text>{`Recorded human-reviewed Audible candidate ${receipt.candidateNumber}.`}</Agent.Text>
      <SelectionRanking receipt={receipt} />
      {shelf}
    </Agent.Result>
  );
}
