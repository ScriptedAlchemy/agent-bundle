import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const entrySchema = z.object({ note: z.string() }).strict();

export default defineState({
  events: {
    recorded: entrySchema,
  },
  id: 'durable-web-surface/journal',
  initial: { entries: [] },
  lifetime: 'workspace-durable',
  reduce: (state, event) => ({ entries: [...state.entries, event.payload] }),
  schema: z.object({ entries: z.array(entrySchema) }).strict(),
});
