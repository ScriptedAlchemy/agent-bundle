import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { CurationShelf, ShelfUnavailable } from '../components/curation-shelf.js';
import {
  CurationShelfStateSchema,
  type CurationShelfState,
} from '../state.js';

const emptyShelf: CurationShelfState = {
  mutations: [],
  selections: [],
};

export const config = {
  description: 'Show the persisted curation shelf.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();
export const resultSchema = CurationShelfStateSchema;

export default async function Shelf() {
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
}
