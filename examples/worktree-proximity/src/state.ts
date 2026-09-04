import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
/**
 * Where an identity claim came from: `native` is read straight from the host
 * envelope (or a `request.lineage` the runtime resolved natively), `registry`,
 * `inferred`, `confirmed` and `transcript` are the runtime lineage registry's
 * own resolutions (`confirmed` once the host has named every edge to the root;
 * `transcript` read from the host's own rollout file), and `derived` is this
 * application's fallback (`worktree:<root>`).
 */
const provenance = z.enum(['native', 'registry', 'inferred', 'confirmed', 'transcript', 'derived']);

export type IdentityProvenance = z.output<typeof provenance>;

/**
 * Which worktree an actor works in. This is the one fact about an actor the
 * runtime's lineage registry cannot know — the agent tree itself (parent,
 * root, depth, who is alive) is `(await agent()).lineage`, so nothing about
 * it is recorded here.
 */
export const BindingSchema = z
  .object({
    actorId: nonEmpty,
    provenance: z
      .object({
        actorId: provenance,
        worktreeRoot: provenance,
      })
      .strict(),
    worktreeRoot: nonEmpty,
  })
  .strict();

export const ActivitySchema = z
  .object({
    actorId: nonEmpty,
    dependencies: z.array(nonEmpty),
    idempotencyKey: nonEmpty,
    observedAt: nonEmpty,
    paths: z.array(nonEmpty),
    provenance: z
      .object({
        actorId: provenance,
        dependencies: provenance,
        paths: provenance,
      })
      .strict(),
  })
  .strict();

export const EdgeRefusalSchema = z
  .object({
    idempotencyKey: nonEmpty,
    observedAt: nonEmpty,
    reason: nonEmpty,
    sessionId: nonEmpty.optional(),
  })
  .strict();

export const IntentStateSchema = z
  .object({
    activities: z.array(ActivitySchema),
    bindings: z.array(BindingSchema),
    refusals: z.array(EdgeRefusalSchema),
  })
  .strict();

export type Binding = z.output<typeof BindingSchema>;
export type Activity = z.output<typeof ActivitySchema>;
export type IntentState = z.output<typeof IntentStateSchema>;

const actorReleasedSchema = z
  .object({
    actorId: nonEmpty,
    observedAt: nonEmpty,
  })
  .strict();

export const intentEventSchemas = {
  /** An actor was seen working in a worktree; a later binding for the same actor replaces the earlier one. */
  actorBound: BindingSchema,
  /** The actor stopped: its binding and any intent it still held are gone. */
  actorReleased: actorReleasedSchema,
  edgeRefused: EdgeRefusalSchema,
  intentRecorded: ActivitySchema,
} as const;

export type IntentEvents = typeof intentEventSchemas;

export const intentStateDefinition = defineState({
  events: intentEventSchemas,
  id: 'worktree-proximity/intent',
  initial: {
    activities: [],
    bindings: [],
    refusals: [],
  },
  lifetime: 'workspace-durable',
  reduce: (state, event): IntentState => {
    switch (event.name) {
      case 'actorBound':
        return {
          ...state,
          bindings: [
            ...state.bindings.filter((binding) => binding.actorId !== event.payload.actorId),
            event.payload,
          ],
        };
      case 'intentRecorded':
        return {
          ...state,
          activities: [
            ...state.activities.filter((activity) => activity.actorId !== event.payload.actorId),
            event.payload,
          ],
        };
      case 'actorReleased':
        return {
          ...state,
          activities: state.activities.filter((activity) => activity.actorId !== event.payload.actorId),
          bindings: state.bindings.filter((binding) => binding.actorId !== event.payload.actorId),
        };
      case 'edgeRefused':
        return {
          ...state,
          refusals: [...state.refusals, event.payload],
        };
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled intent event ${String(unreachable)}`);
      }
    }
  },
  schema: IntentStateSchema,
  version: 1,
});

export default defineState({
  ...intentStateDefinition,
  id: 'worktree-proximity/intent',
  lifetime: 'workspace-durable',
});
