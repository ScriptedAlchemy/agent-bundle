import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const journalEntrySchema = z.object({
  note: z.string(),
}).strict();

export default defineState({
  events: {
    recorded: journalEntrySchema,
  },
  id: 'route-harness/journal',
  initial: {
    entries: [],
  },
  lifetime: 'workspace-durable',
  reduce: (state, event) => ({
    entries: [...state.entries, event.payload],
  }),
  schema: z.object({
    entries: z.array(journalEntrySchema),
  }).strict(),
});
