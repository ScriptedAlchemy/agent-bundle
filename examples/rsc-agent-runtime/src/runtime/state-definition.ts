import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

import type { JsonValue } from './contracts.js';

/**
 * The edit-timeline state, declared once against the framework state kernel
 * (#98). This replaces the example's retired hand-rolled JSONL kernel
 * (`state-file-core.ts`): the framework owns revisions, idempotency
 * replay/conflict, atomicity, exact-revision reads, migrations, and
 * corruption fail-closed behavior; the example declares its schema, events,
 * and pure reducer.
 *
 * The event payload carries exactly the caller-owned semantic fields —
 * host, path, sessionId, toolName — which makes the kernel's whole-payload
 * idempotency identity match the retired kernel's canonical dedupe input.
 * Presentation fields are derived, not stored: `eventId` comes from the
 * committed revision and `recordedAt` from the journal's commit timestamp
 * (see `state-file.ts`), so retries of one native tool event replay cleanly
 * instead of conflicting over generated values.
 */

const nonEmpty = (): z.ZodType<string> => z.string().refine((value) => value.trim() !== '', 'must be non-empty');

export const RecordedEditSchema = z
  .object({
    host: z.enum(['claude', 'codex']),
    path: nonEmpty(),
    sessionId: nonEmpty(),
    toolName: nonEmpty(),
  })
  .strict();

export type RecordedEdit = z.output<typeof RecordedEditSchema>;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const TimelineStateSchema = z
  .object({
    edits: z.array(RecordedEditSchema),
    seed: JsonValueSchema.optional(),
  })
  .strict();

export type EditTimelineState = z.output<typeof TimelineStateSchema>;

const timelineEvents = {
  editRecorded: RecordedEditSchema,
} as const;

export type EditTimelineEvents = typeof timelineEvents;

export const editTimelineDefinition = defineState({
  events: timelineEvents,
  id: 'rsc-agent-runtime/edit-timeline',
  initial: { edits: [] },
  lifetime: 'workspace-durable',
  reduce: (state, event): EditTimelineState => {
    switch (event.name) {
      case 'editRecorded':
        return state.seed === undefined
          ? { edits: [...state.edits, event.payload] }
          : { edits: [...state.edits, event.payload], seed: state.seed };
      default: {
        const unreachable: never = event.name;
        throw new Error(`Unhandled edit-timeline event ${String(unreachable)}`);
      }
    }
  },
  schema: TimelineStateSchema,
});
