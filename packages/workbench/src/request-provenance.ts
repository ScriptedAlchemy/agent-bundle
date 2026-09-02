import { z } from 'zod';

import type { RequestContextProvenance } from '../../agent-bundle/src/contracts/request-provenance.ts';

const textSchema = z.string().min(1);
const sourceSchema = z.enum(['native', 'receipt', 'derived']);
const unavailableSchema = z.strictObject({
  reason: z.enum(['not-provided', 'unsupported-surface', 'host-omitted', 'unauthenticated']),
  state: z.literal('unavailable'),
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
  session: z.union([availableSessionSchema, unavailableSchema]),
  workspace: z.union([availableWorkspaceSchema, unavailableSchema]),
});

/** Strictly decodes the credential-free request context carried by Workbench routes. */
export const decodeRequestContextProvenance = (value: unknown): RequestContextProvenance | undefined => {
  const parsed = requestContextProvenanceSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : undefined;
};
