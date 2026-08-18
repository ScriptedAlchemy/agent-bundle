import { z } from 'zod';

import { provenanceIdentifierPattern } from '../../agent-bundle/src/eval/provenance.ts';

export const safeIntegerSchema = z.number().refine(Number.isSafeInteger);
export const nonnegativeIntegerSchema = safeIntegerSchema.refine((value) => value >= 0);
export const positiveIntegerSchema = safeIntegerSchema.refine((value) => value >= 1);
export const safeNumberSchema = z.number().refine(Number.isFinite);
export const nonnegativeNumberSchema = safeNumberSchema.refine((value) => value >= 0);
export const probabilitySchema = safeNumberSchema.refine((value) => value >= 0 && value <= 1);
export const provenanceIdentifierSchema = z.string().regex(provenanceIdentifierPattern);
