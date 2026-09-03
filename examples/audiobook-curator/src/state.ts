import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const shortText = z.string().max(1024);
const timestamp = z.string().max(64);

export const ShelfSelectionSchema = z.object({
  asin: z.string().max(64),
  candidateNumber: z.number().int().min(1).max(500),
  region: z.string().max(16),
  selectedAt: timestamp,
  title: shortText,
}).strict();

export const ShelfMutationSchema = z.object({
  appliedAt: timestamp,
  file: z.string().max(4096),
  operation: z.enum(['apply-metadata', 'apply-chapters']),
  status: z.enum(['applied-verified', 'planned']),
}).strict();

export const CurationShelfStateSchema = z.object({
  mutations: z.array(ShelfMutationSchema),
  selections: z.array(ShelfSelectionSchema),
}).strict();

export type CurationShelfState = z.output<typeof CurationShelfStateSchema>;

export const curationShelfEventSchemas = {
  editionSelected: ShelfSelectionSchema,
  mutationApplied: ShelfMutationSchema,
  shelfCleared: z.object({}).strict(),
} as const;

const initial: CurationShelfState = {
  mutations: [],
  selections: [],
};

export default defineState({
  events: curationShelfEventSchemas,
  id: 'audiobook-curator/shelf',
  initial,
  lifetime: 'workspace-durable',
  reduce: (state, event): CurationShelfState => {
    switch (event.name) {
      case 'editionSelected':
        return {
          ...state,
          selections: [
            ...state.selections.filter((selection) =>
              selection.asin !== event.payload.asin || selection.region !== event.payload.region),
            event.payload,
          ],
        };
      case 'mutationApplied':
        return {
          ...state,
          mutations: [
            ...state.mutations.filter((mutation) =>
              mutation.file !== event.payload.file || mutation.operation !== event.payload.operation),
            event.payload,
          ],
        };
      case 'shelfCleared':
        return initial;
      default: {
        const unhandled: never = event;
        throw new Error(`Unhandled curation shelf event: ${String(unhandled)}`);
      }
    }
  },
  schema: CurationShelfStateSchema,
  version: 1,
});
