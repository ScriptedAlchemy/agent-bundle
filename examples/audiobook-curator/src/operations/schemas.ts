/**
 * Schema fragments shared by more than one operation module: path and tag
 * bounds, the Audible region enum, the probe receipt shape, and the loose
 * parity-receipt wrapper used to validate rich domain receipts at the
 * operation boundary.
 */
import { z } from 'zod';

export const pathSchema = z.string().min(1).max(4096);

export const audibleRegions = ['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us'] as const;

export const audibleRegionSchema = z.enum(audibleRegions);

export const tagsSchema = z.record(z.string().max(128), z.string().max(4096));

export const probeShape = {
  channels: z.number().nonnegative().optional(),
  codec: z.string(),
  durationSeconds: z.number().nonnegative(),
  format: z.string(),
  sampleRate: z.number().nonnegative().optional(),
  tags: tagsSchema,
};

export const probeSchema = z.object(probeShape).strict();

export const parityReceiptSchema = <T extends { readonly generatedAt: string; readonly mutation: boolean; readonly operation: string }>(
  operation: T['operation'],
): z.ZodType<T> => z.object({
  generatedAt: z.string().min(1),
  mutation: z.boolean(),
  operation: z.literal(operation),
}).catchall(z.json()) as unknown as z.ZodType<T>;
