/**
 * Audible catalog-identity operations: `audible-search`, `audible-select`,
 * and `audible-cache`, backed by `../audible.ts`. Ranking is evidence only;
 * `audible-select` records the required human edition choice.
 */
import { z } from 'zod';

import {
  cacheAudibleEdition,
  searchAudible,
  selectAudibleEdition,
  type AudibleCacheReceipt,
  type AudibleSearchReceipt,
  type AudibleSelectionReceipt,
} from '../audible.ts';
import type { CliCommandContext } from '../cli-command.js';
import { readJson, writeReceipt } from '../foundation.ts';
import { audibleRegionSchema, parityReceiptSchema } from './schemas.ts';

const audibleEvidenceSchema = z.object({
  authorMatch: z.boolean(), durationDifferencePercent: z.number().nonnegative().optional(), language: z.string().optional(),
  languageMatch: z.boolean(), narratorMatch: z.boolean(), score: z.number(), strictIdentityMatch: z.boolean(),
  titleMatch: z.boolean(), unabridged: z.boolean(),
}).strict();
const audibleCandidateSchema = z.object({ evidence: audibleEvidenceSchema, region: audibleRegionSchema }).passthrough();
export const audibleSearchResultSchema: z.ZodType<AudibleSearchReceipt> = z.object({
  candidates: z.array(audibleCandidateSchema).max(500),
  errors: z.array(z.object({ error: z.string().max(4096), region: audibleRegionSchema }).strict()).max(10),
  exitCode: z.union([z.literal(0), z.literal(1)]), generatedAt: z.string(), humanReviewRequired: z.literal(true),
  mutation: z.literal(false), operation: z.literal('audible-search'),
  query: z.object({ author: z.string().optional(), durationSeconds: z.number().positive().optional(), narrator: z.string().optional(), title: z.string() }).strict(),
  reviewNote: z.string(),
}).strict() as z.ZodType<AudibleSearchReceipt>;
const audibleSelectResultSchema = parityReceiptSchema<AudibleSelectionReceipt>('audible-select');
const audibleCacheResultSchema = parityReceiptSchema<AudibleCacheReceipt>('audible-cache');

/** Parses the CLI's comma-separated `--regions` list; shared with the routed `audible-search` command. */
export const audibleOperations = Object.freeze({
  audibleSearch: {
    handler: searchAudible,
    id: 'audible-search',
    resultSchema: audibleSearchResultSchema,
  },
  audibleSelect: {
    handler: async (
      input: { readonly candidate: number; readonly candidates: string; readonly note?: string; readonly receipt?: string },
      _context: CliCommandContext,
    ) => {
      const report = audibleSearchResultSchema.parse(await readJson(input.candidates));
      const receipt = selectAudibleEdition(report, {
        candidate: input.candidate,
        candidateReport: input.candidates,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.candidates]);
      return receipt;
    },
    id: 'audible-select',
    resultSchema: audibleSelectResultSchema,
  },
  audibleCache: {
    handler: cacheAudibleEdition,
    id: 'audible-cache',
    resultSchema: audibleCacheResultSchema,
  },
});
