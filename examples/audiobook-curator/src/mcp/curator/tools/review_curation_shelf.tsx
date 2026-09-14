import { Agent, agent } from '@agent-bundle/runtime';
import React from 'react';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import { CurationShelf, ShelfUnavailable } from '../../../components/curation-shelf.js';
import {
  CurationShelfStateSchema,
  type CurationShelfState,
} from '../../../state.js';

const emptyShelf: CurationShelfState = {
  mutations: [],
  selections: [],
};

export const inputSchema = z.object({}).strict();
export const resultSchema = CurationShelfStateSchema;

export default defineTool({
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {},
    "type": "object"
  },
  annotations: { readOnlyHint: true },
  description: 'Review the persisted curation shelf of selected Audible editions and media mutations.',
  inputSchema,
  resultSchema,
}, async () => {
  const state = (await agent()).state;
  if (state === undefined) {
    return (
      <Agent.Result value={emptyShelf}>
        <Agent.Text>Persisted curation shelf unavailable.</Agent.Text>
        <ShelfUnavailable />
      </Agent.Result>
    );
  }
  const shelf = CurationShelfStateSchema.parse((await state.read()).state);
  return (
    <Agent.Result value={shelf}>
      <Agent.Text>Persisted curation shelf ready.</Agent.Text>
      <CurationShelf state={shelf} />
    </Agent.Result>
  );
});
