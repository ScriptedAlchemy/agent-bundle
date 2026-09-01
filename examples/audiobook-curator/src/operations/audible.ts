/**
 * Audible catalog-identity operations: `audible-search`, `audible-select`,
 * and `audible-cache`, backed by `../audible.ts`. Ranking is evidence only;
 * `audible-select` records the required human edition choice.
 */
import { defineCliCommand, type CliCommandContext } from '../cli-command.js';
import { z } from 'zod';

import {
  cacheAudibleEdition,
  searchAudible,
  selectAudibleEdition,
  type AudibleCacheInput,
  type AudibleCacheReceipt,
  type AudibleRegion,
  type AudibleSearchInput,
  type AudibleSearchReceipt,
  type AudibleSelectionReceipt,
} from '../audible.ts';
import { readJson, writeReceipt } from '../foundation.ts';
import { audibleRegions, audibleRegionSchema, parityReceiptSchema, pathSchema } from './schemas.ts';

export interface AudibleOperations {
  readonly audibleCache?: (input: AudibleCacheInput, options: CliCommandContext) => Promise<AudibleCacheReceipt>;
  readonly audibleSearch?: (input: AudibleSearchInput, options: CliCommandContext) => Promise<AudibleSearchReceipt>;
  readonly audibleSelect?: (
    input: { readonly candidate: number; readonly candidates: string; readonly note?: string; readonly receipt?: string },
    options: CliCommandContext,
  ) => Promise<AudibleSelectionReceipt>;
}

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

export const defaultAudibleOperations: Required<AudibleOperations> = {
  audibleCache: (input, options) => cacheAudibleEdition(input, options),
  audibleSearch: (input, options) => searchAudible(input, options),
  audibleSelect: async (input) => {
    const report = audibleSearchResultSchema.parse(await readJson(input.candidates));
    const receipt = selectAudibleEdition(report, {
      candidate: input.candidate,
      candidateReport: input.candidates,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.candidates]);
    return receipt;
  },
};

/** Parses the CLI's comma-separated `--regions` list; shared with the routed `audible-search` command. */
export const audibleRegionList = (value: string): readonly AudibleRegion[] => value.split(',').map((region) => {
  const candidate = region.trim().toLowerCase();
  if (!audibleRegions.includes(candidate as AudibleRegion)) throw new Error(`Unsupported Audible region: ${candidate}.`);
  return candidate as AudibleRegion;
});

export const audibleOperations = (operations: Required<AudibleOperations>) => ({
  audibleSearch: defineCliCommand({
    handler: operations.audibleSearch,
    id: 'audible-search',
    inputSchema: z.object({
      attempts: z.number().int().min(1).max(10).optional(), author: z.string().min(1).max(512).optional(),
      durationSeconds: z.number().positive().optional(), limit: z.number().int().min(1).max(50).optional(),
      narrator: z.string().min(1).max(512).optional(), regions: z.array(audibleRegionSchema).min(1).max(10).optional(),
      report: pathSchema.optional(), title: z.string().min(1).max(1024),
    }).strict(),
    resultSchema: audibleSearchResultSchema,
  }),
  audibleSelect: defineCliCommand({
    handler: operations.audibleSelect,
    id: 'audible-select',
    inputSchema: z.object({ candidate: z.number().int().min(1).max(500), candidates: pathSchema, note: z.string().max(4096).optional(), receipt: pathSchema.optional() }).strict(),
    resultSchema: audibleSelectResultSchema,
  }),
  audibleCache: defineCliCommand({
    handler: operations.audibleCache,
    id: 'audible-cache',
    inputSchema: z.object({
      asin: z.string().min(1).max(64), attempts: z.number().int().min(1).max(10).optional(), cacheDirectory: pathSchema,
      receipt: pathSchema.optional(), region: audibleRegionSchema.optional(),
    }).strict(),
    resultSchema: audibleCacheResultSchema,
  }),
});
