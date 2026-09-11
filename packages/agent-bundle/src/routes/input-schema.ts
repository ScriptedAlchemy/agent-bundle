import { z } from 'zod';

import { deepFreeze } from '../core/freeze.ts';
import type { RouteInputSchema } from './types.ts';

const text = z.string().min(1);
const scalarLiteral = z.union([z.boolean(), z.number(), z.string()]);
const metadata = {
  default: z.union([scalarLiteral, z.array(scalarLiteral)]).optional(),
  description: text.optional(),
};
const item = z.union([
  z.strictObject({ type: z.literal('boolean') }),
  z.strictObject({ type: z.literal('number') }),
  z.strictObject({ type: z.literal('string'), enum: z.array(text).optional() }),
]);
const property = z.union([
  z.strictObject({ ...metadata, type: z.literal('boolean') }),
  z.strictObject({ ...metadata, type: z.literal('number') }),
  z.strictObject({ ...metadata, type: z.literal('string'), enum: z.array(text).optional() }),
  z.strictObject({ ...metadata, type: z.literal('array'), items: item }),
]);
const inputMetadata = z.strictObject({
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), property),
  required: z.array(text).optional(),
  type: z.literal('object'),
}).refine((schema) => schema.required?.every((key) => Object.hasOwn(schema.properties, key)) !== false, {
  message: 'required names an undeclared property',
});

/** Data-only input metadata shared by inspection, argv projection, and artifact readers. */
export const parseInputSchema = (value: unknown, location: string): RouteInputSchema => {
  const result = inputMetadata.safeParse(value);
  if (!result.success) throw new TypeError(`${location}: ${result.error.message}`);
  return deepFreeze(result.data);
};

export interface ResolvedSchemaOrigin {
  readonly binding: string;
  readonly module: string;
}

export interface ExtractedInputSchema {
  readonly origin: ResolvedSchemaOrigin;
  readonly schema: RouteInputSchema;
}
