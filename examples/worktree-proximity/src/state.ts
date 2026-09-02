import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const provenance = z.enum(['native', 'derived']);

export const ActorSchema = z
  .object({
    id: nonEmpty,
    kind: z.enum(['root', 'child']),
    parentSessionId: nonEmpty.optional(),
    provenance: z
      .object({
        id: provenance,
        parentSessionId: provenance.optional(),
        worktreeRoot: provenance.optional(),
      })
      .strict(),
    status: z.enum(['active', 'stopped']),
    worktreeRoot: nonEmpty.optional(),
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

export const TopologyStateSchema = z
  .object({
    activities: z.array(ActivitySchema),
    actors: z.array(ActorSchema),
    refusals: z.array(EdgeRefusalSchema),
  })
  .strict();

export type Actor = z.output<typeof ActorSchema>;
export type Activity = z.output<typeof ActivitySchema>;
export type EdgeRefusal = z.output<typeof EdgeRefusalSchema>;
export type TopologyState = z.output<typeof TopologyStateSchema>;

const actorObservedSchema = ActorSchema.omit({ worktreeRoot: true }).strict();
const actorBoundSchema = z
  .object({
    actorId: nonEmpty,
    provenance,
    worktreeRoot: nonEmpty,
  })
  .strict();
const actorStoppedSchema = z
  .object({
    actorId: nonEmpty,
    observedAt: nonEmpty,
  })
  .strict();

export const topologyEventSchemas = {
  actorBound: actorBoundSchema,
  actorObserved: actorObservedSchema,
  actorStopped: actorStoppedSchema,
  edgeRefused: EdgeRefusalSchema,
  intentRecorded: ActivitySchema,
} as const;

export type TopologyEvents = typeof topologyEventSchemas;

const replaceActor = (
  actors: readonly Actor[],
  actorId: string,
  update: (actor: Actor) => Actor,
): Actor[] => actors.map((actor) => actor.id === actorId ? update(actor) : actor);

export const topologyStateDefinition = defineState({
  events: topologyEventSchemas,
  id: 'worktree-proximity/topology',
  initial: {
    activities: [],
    actors: [],
    refusals: [],
  },
  lifetime: 'workspace-durable',
  reduce: (state, event): TopologyState => {
    switch (event.name) {
      case 'actorObserved': {
        const previous = state.actors.find((actor) => actor.id === event.payload.id);
        const actor = previous === undefined
          ? event.payload
          : {
              ...event.payload,
              ...(previous.worktreeRoot === undefined ? {} : { worktreeRoot: previous.worktreeRoot }),
              provenance: {
                ...event.payload.provenance,
                ...(previous.provenance.worktreeRoot === undefined
                  ? {}
                  : { worktreeRoot: previous.provenance.worktreeRoot }),
              },
            };
        return {
          ...state,
          actors: [...state.actors.filter((candidate) => candidate.id !== actor.id), actor],
        };
      }
      case 'actorBound':
        return {
          ...state,
          actors: replaceActor(state.actors, event.payload.actorId, (actor) => ({
            ...actor,
            provenance: {
              ...actor.provenance,
              worktreeRoot: event.payload.provenance,
            },
            worktreeRoot: event.payload.worktreeRoot,
          })),
        };
      case 'intentRecorded':
        return {
          ...state,
          activities: [
            ...state.activities.filter((activity) => activity.actorId !== event.payload.actorId),
            event.payload,
          ],
        };
      case 'actorStopped':
        return {
          ...state,
          activities: state.activities.filter((activity) => activity.actorId !== event.payload.actorId),
          actors: replaceActor(state.actors, event.payload.actorId, (actor) => ({
            ...actor,
            status: 'stopped',
          })),
        };
      case 'edgeRefused':
        return {
          ...state,
          refusals: [...state.refusals, event.payload],
        };
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled topology event ${String(unreachable)}`);
      }
    }
  },
  schema: TopologyStateSchema,
  version: 1,
});

export default defineState({
  ...topologyStateDefinition,
  id: 'worktree-proximity/topology',
  lifetime: 'workspace-durable',
});
