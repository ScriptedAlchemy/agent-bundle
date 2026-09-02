import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { CurationShelfState } from '../state.js';
import { Callout, DataList } from './primitives.js';

export interface CurationShelfProps {
  readonly state: CurationShelfState;
}

export const CurationShelf = async ({ state }: CurationShelfProps) => (
  <>
    <Agent.Markdown>## Persisted curation shelf</Agent.Markdown>
    {state.selections.length === 0 && state.mutations.length === 0
      ? <Agent.Markdown>The persisted curation shelf is empty.</Agent.Markdown>
      : null}
    {state.selections.length === 0
      ? null
      : (
          <>
            <Agent.Markdown>### Selected Audible editions</Agent.Markdown>
            {state.selections.map((selection) => (
              <React.Fragment key={`${selection.region}:${selection.asin}`}>
                <Agent.Markdown>{`#### ${selection.title}`}</Agent.Markdown>
                <DataList fields={[
                  { label: 'ASIN', value: selection.asin },
                  { label: 'Region', value: selection.region },
                  { label: 'Candidate', value: selection.candidateNumber },
                  { label: 'Selected at', value: selection.selectedAt },
                ]} />
              </React.Fragment>
            ))}
          </>
        )}
    {state.mutations.length === 0
      ? null
      : (
          <>
            <Agent.Markdown>### Media mutations</Agent.Markdown>
            {state.mutations.map((mutation) => (
              <React.Fragment key={`${mutation.file}:${mutation.operation}`}>
                <Agent.Markdown>{`#### ${mutation.file}`}</Agent.Markdown>
                <DataList fields={[
                  { label: 'Operation', value: mutation.operation },
                  { label: 'Status', value: mutation.status },
                  { label: 'Applied at', value: mutation.appliedAt },
                ]} />
              </React.Fragment>
            ))}
          </>
        )}
  </>
);

export const ShelfUnavailable = () => (
  <Callout tone="review">State is not mounted on this invocation surface.</Callout>
);
