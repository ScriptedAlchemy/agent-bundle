import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

// Evaluation is observable: harness tests prove the state module is not loaded
// before a rendered-script shell has accepted its argv.
const tally = globalThis as { routeHarnessStateLoads?: number };
tally.routeHarnessStateLoads = (tally.routeHarnessStateLoads ?? 0) + 1;

const journalEntrySchema = z.object({
  note: z.string(),
}).strict();

const lifecyclePhaseSchema = z.enum([
  'queued',
  'running',
  'first-progress',
  'repeated-progress',
  'terminal',
]);

export default defineState({
  budgets: {
    maxEventBytes: 256,
  },
  events: {
    recorded: journalEntrySchema,
    transitioned: z.object({
      payload: z.string().optional(),
      phase: lifecyclePhaseSchema,
    }).strict(),
  },
  id: 'route-harness/journal',
  initial: {
    entries: [],
    lifecycle: {
      history: [],
      phase: 'unknown' as const,
    },
  },
  lifetime: 'workspace-durable',
  reduce: (state, event) => {
    switch (event.name) {
      case 'recorded':
        return {
          ...state,
          entries: [...state.entries, event.payload],
        };
      case 'transitioned':
        return {
          ...state,
          lifecycle: {
            history: [...state.lifecycle.history, event.payload.phase],
            phase: event.payload.phase,
          },
        };
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  },
  schema: z.object({
    entries: z.array(journalEntrySchema),
    lifecycle: z.object({
      history: z.array(lifecyclePhaseSchema),
      phase: z.union([z.literal('unknown'), lifecyclePhaseSchema]),
    }).strict(),
  }).strict(),
});
