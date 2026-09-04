import { z } from 'zod';

import type { RequestContextProvenance } from '../../agent-bundle/src/contracts/request-provenance.ts';

const textSchema = z.string().min(1);
const sourceSchema = z.enum(['native', 'receipt', 'derived']);
const unavailableSchema = z.strictObject({
  reason: z.enum([
    'not-provided',
    'unsupported-surface',
    'host-omitted',
    'unauthenticated',
    'no-subagent-events',
    'id-not-resolvable',
    'cloud-agent-no-user-hooks',
    'no-shared-runtime',
  ]),
  state: z.literal('unavailable'),
});
const availableLineageSchema = z.strictObject({
  source: sourceSchema,
  state: z.literal('available'),
  value: z.strictObject({
    conversation: textSchema,
    depth: z.number().int().nonnegative(),
    generation: textSchema.optional(),
    parent: textSchema.optional(),
    resolution: z.enum(['native', 'registry', 'confirmed', 'inferred']),
    root: textSchema,
    subagent: z.strictObject({
      id: textSchema,
      isParallelWorker: z.boolean().optional(),
      toolCallId: textSchema.optional(),
      type: textSchema.optional(),
    }).optional(),
  }),
});
const availableHostSchema = z.strictObject({
  source: sourceSchema,
  state: z.literal('available'),
  value: z.strictObject({ name: textSchema }),
});
const availableSessionSchema = z.strictObject({
  source: sourceSchema,
  state: z.literal('available'),
  value: z.strictObject({ sessionId: textSchema }),
});
const availableActorSchema = z.strictObject({
  source: sourceSchema,
  state: z.literal('available'),
  value: z.strictObject({ id: textSchema }),
});
const availableWorkspaceSchema = z.strictObject({
  source: sourceSchema,
  state: z.literal('available'),
  value: z.strictObject({ root: textSchema }),
});

export const requestContextProvenanceSchema: z.ZodType<RequestContextProvenance> = z.strictObject({
  actor: z.union([availableActorSchema, unavailableSchema]),
  host: z.union([availableHostSchema, unavailableSchema]),
  invocation: z.strictObject({
    hostContractRevision: textSchema.optional(),
    kind: z.enum(['tool', 'event', 'cli', 'script', 'workbench']),
    operationId: textSchema.optional(),
    surface: textSchema.optional(),
  }),
  lineage: z.union([availableLineageSchema, unavailableSchema]),
  session: z.union([availableSessionSchema, unavailableSchema]),
  workspace: z.union([availableWorkspaceSchema, unavailableSchema]),
});
